/**
 * A workspace is a directory. This module is its only writer.
 *
 *   ~/.entity/workspaces/<id>/
 *     workspace.json   { schema, id, label, kind, createdAt, mcpStrict, members }
 *     entities/*.md    one file per entity
 *     skills/<name>    symlinks into the harness libraries
 *     mcp.json         the workspace's MCP server pool
 *     machine-facts.json  harness/model snapshots from an explicit ssh test
 *     chats/*.json     one conversation per file
 *     runs/*.jsonl     append-only run logs
 *
 * Machine facts are observations, not credentials. ssh itself is read from the
 * user's ~/.ssh/config; this workspace never stores a key or an ssh config.
 *
 * Nothing here invents a workspace in memory: if the directory is not there, the
 * hub shows setup, because an in-memory workspace looks like success and loses
 * everything on quit.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const localData = require('./local-data.cjs')
const { HARNESSES } = localData
const { tilde } = require('./frontmatter.cjs')
const { SAMPLES, sampleList } = require('./seed.cjs')

const HOME = os.homedir()
/* Tests and dev sandboxes point ENTITY_HOME at a scratch directory; everything
   below derives from it, so nothing else needs to know about the override. */
const ROOT = process.env.ENTITY_HOME
  ? path.resolve(process.env.ENTITY_HOME)
  : path.join(HOME, '.entity')
const WORKSPACES_DIR = path.join(ROOT, 'workspaces')

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const HARNESS_IDS = new Set(HARNESSES.map((h) => h.id).concat(['gemini']))
const MEMBER_ROLES = new Set(['owner', 'admin', 'member'])

function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
}

function assertSlug(id) {
  if (!SLUG.test(String(id || ''))) {
    throw new Error(`"${id}" is not a workspace id (use lowercase letters, digits and dashes).`)
  }
  return String(id)
}

function workspaceDir(id) {
  return path.join(WORKSPACES_DIR, assertSlug(id))
}

/**
 * Membership is a roster kept with the workspace. This build authenticates one
 * account per machine, so a member is a record of who belongs here and what
 * role they hold — not a second sign-in path. Keeping the shape on disk means a
 * later multi-account step does not have to migrate it out of localStorage.
 */
const MEMBERS_FILE = 'members.json'

function normaliseOwner(value) {
  if (!value || typeof value !== 'object') return null
  const email = String(value.email || '').trim()
  const name = String(value.name || '').trim() || (email ? email.split('@')[0] : '')
  if (!email && !name) return null
  return { name, email }
}

function normaliseMembers(value) {
  if (!Array.isArray(value)) return []
  const members = []
  const seen = new Set()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const email = String(entry.email || '').trim()
    const name = String(entry.name || '').trim() || email
    if (!name && !email) continue
    const key = (email || name).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    members.push({
      name,
      email,
      role: MEMBER_ROLES.has(entry.role) ? entry.role : 'member',
    })
  }
  return members
}

function membersFile(dir) {
  return path.join(dir, MEMBERS_FILE)
}

function readMembersFile(dir) {
  const raw = readJson(membersFile(dir), null)
  if (!raw || raw.schema !== 1) return { present: false, owner: null, members: [] }
  return {
    present: true,
    owner: normaliseOwner(raw.owner),
    members: normaliseMembers(raw.members),
  }
}

/** The owner is always a member with the owner role, and only once. */
function bindMembers(owner, members) {
  const creator = normaliseOwner(owner)
  const roster = normaliseMembers(members)
  if (!creator) return { owner: null, members: roster }
  const match = roster.find(
    (entry) =>
      (creator.email && entry.email.toLowerCase() === creator.email.toLowerCase()) ||
      (!creator.email && entry.name.toLowerCase() === creator.name.toLowerCase()),
  )
  if (match) match.role = 'owner'
  else roster.unshift({ ...creator, role: 'owner' })
  return { owner: creator, members: roster }
}

function writeMembersFile(dir, workspaceId, owner, members) {
  const bound = bindMembers(owner, members)
  writeJson(membersFile(dir), {
    schema: 1,
    workspace: String(workspaceId || ''),
    owner: bound.owner,
    members: bound.members,
    updatedAt: new Date().toISOString(),
  })
  return bound
}

/* ── small file helpers ───────────────────────────────────────────── */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** tmp + rename: a crash cannot truncate a workspace file. */
function writeJson(file, value, { mode = 0o644 } = {}) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode })
  fs.renameSync(tmp, file)
  /* mode is only applied when the temp file is created; a rewrite of an older
     file keeps whatever mode it had. The MCP pool can carry a token, so it is
     forced to 0600 every time. */
  try {
    fs.chmodSync(file, mode)
  } catch {
    /* a filesystem without modes */
  }
  return value
}

function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

function writeBinaryAtomic(file, buffer) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, buffer)
  fs.renameSync(tmp, file)
}

/* ── list / open ──────────────────────────────────────────────────── */

function readRecord(id) {
  let dir
  try {
    dir = workspaceDir(id)
  } catch {
    return null
  }
  const raw = readJson(path.join(dir, 'workspace.json'), null)
  if (
    !raw ||
    raw.schema !== 1 ||
    typeof raw.id !== 'string' ||
    typeof raw.label !== 'string'
  ) {
    return null
  }
  if (raw.id !== id) return null
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return null

  const membersDoc = readMembersFile(dir)
  const fallbackOwner = normaliseOwner(raw.owner)
  const fallbackMembers = normaliseMembers(raw.members)
  return {
    id: raw.id,
    label: raw.label,
    /* `remote` is a local clone of a shared workspace (see remote-sync.cjs).
       It still lives in a directory here; the kind only says where changes
       come from and go to. */
    kind: raw.kind === 'remote' ? 'remote' : 'local',
    createdAt: raw.createdAt || new Date(0).toISOString(),
    mcpStrict: raw.mcpStrict !== false,
    /* the workspace-level system prompt: rules that belong to the scope rather
       than to any one entity. Prepended to every entity's own instructions at
       run time (electron/platform-brief.cjs), never merged into their files. */
    context: String(raw.context || ''),
    owner: membersDoc.present ? membersDoc.owner : fallbackOwner,
    members: membersDoc.present ? membersDoc.members : fallbackMembers,
    membersPath: membersDoc.present ? membersFile(dir) : '',
    path: dir,
    displayPath: tilde(dir),
  }
}

function countEntities(dir) {
  try {
    return fs
      .readdirSync(path.join(dir, 'entities'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md')).length
  } catch {
    return 0
  }
}

function countSkills(dir) {
  try {
    return fs.readdirSync(path.join(dir, 'skills')).length
  } catch {
    return 0
  }
}

function withCounts(record) {
  if (!record) return null
  return {
    ...record,
    counts: {
      entities: countEntities(record.path),
      skills: countSkills(record.path),
      machines: countMachineFacts(record.path),
    },
  }
}

function list() {
  let entries
  try {
    entries = fs.readdirSync(WORKSPACES_DIR, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => withCounts(readRecord(entry.name)))
    .filter(Boolean)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
}

function needsSetup() {
  return list().length === 0
}

/**
 * Rename a workspace, move its directory (when the id changes), and/or rewrite
 * the member roster. The id is the directory name, so it is only changed
 * explicitly and only to another valid slug.
 */
function update({ id, label, nextId, members } = {}) {
  const current = open(id)
  const name = String(label ?? current.label).trim()
  if (!name) throw new Error('A workspace needs a name.')

  const wanted = nextId === undefined || nextId === null ? current.id : String(nextId).trim()
  const targetId = wanted ? assertSlug(wanted) : current.id
  if (targetId !== current.id && fs.existsSync(path.join(WORKSPACES_DIR, targetId))) {
    throw new Error(`A workspace with the id "${targetId}" already exists.`)
  }

  const targetPath = path.join(WORKSPACES_DIR, targetId)
  let moved = false
  try {
    if (targetId !== current.id) {
      fs.renameSync(current.path, targetPath)
      moved = true
    }
    const raw = readJson(path.join(targetPath, 'workspace.json'), {}) || {}
    const roster = normaliseMembers(members !== undefined ? members : current.members)
    const bound = writeMembersFile(targetPath, targetId, current.owner, roster)
    const next = {
      ...raw,
      schema: 1,
      id: targetId,
      label: name,
      kind: current.kind,
      createdAt: current.createdAt,
      mcpStrict: current.mcpStrict !== false,
      ...(bound.owner ? { owner: bound.owner } : {}),
      members: bound.members,
    }
    writeJson(path.join(targetPath, 'workspace.json'), next)
  } catch (error) {
    if (moved) {
      try {
        fs.renameSync(targetPath, current.path)
      } catch {
        /* the error below is the one worth reporting */
      }
    }
    throw error
  }

  return withCounts(readRecord(targetId))
}

function open(id) {
  const record = withCounts(readRecord(String(id || '')))
  if (!record) throw new Error(`No workspace called "${id}".`)
  /* Drop the old machines/ config and key copies the first time an old
     workspace is opened. A read-only home must not make the workspace
     unreadable; the cleanup is best effort. */
  try {
    cleanupLegacyMachines(record)
  } catch {
    /* keep going */
  }
  return record
}

/**
 * Backfill the owner on a workspace created by an older build, or an imported
 * bundle that did not carry one. Only the account opening a workspace with no
 * owner can claim it; a recorded owner is never replaced.
 */
function claimOwner({ id, owner } = {}) {
  const record = open(id)
  if (record.owner?.email || record.owner?.name) return record
  const creator = normaliseOwner(owner)
  if (!creator) return record
  const file = path.join(record.path, 'workspace.json')
  const raw = readJson(file, {}) || {}
  const bound = writeMembersFile(record.path, record.id, creator, record.members)
  writeJson(file, {
    ...raw,
    schema: 1,
    id: record.id,
    label: record.label,
    kind: record.kind,
    createdAt: record.createdAt,
    mcpStrict: record.mcpStrict !== false,
    owner: bound.owner,
    members: bound.members,
  })
  return withCounts(readRecord(record.id))
}

/**
 * The workspace-level system prompt.
 *
 * Kept beside `label` in `workspace.json` rather than in a second file: it is
 * scope configuration, it moves with the workspace on export/import, and one
 * file with the workspace's identity is easier to trust than two that can
 * disagree.
 */
function setContext({ id, context } = {}) {
  const record = open(id)
  const file = path.join(record.path, 'workspace.json')
  const raw = readJson(file, {}) || {}
  if (typeof context !== 'string') {
    throw new Error('context must be a string.')
  }
  writeJson(file, {
    ...raw,
    schema: 1,
    id: record.id,
    label: record.label,
    kind: record.kind,
    createdAt: record.createdAt,
    mcpStrict: record.mcpStrict !== false,
    members: record.members,
    context,
  })
  return withCounts(readRecord(record.id))
}

/* ── machine facts: capability snapshots, never credentials ────────── */

/*
 * A workspace remembers what a host can run, not how to become that host.
 * The snapshot is written by `machine-scan.cjs` after an explicit connection
 * test: installed harnesses, their paths, the models each one reports, and the
 * configured default. There is no ssh_config and no private key here — ssh is
 * read from the user's own `~/.ssh/config` and agent at test time.
 *
 * This file is workspace-local. Remote sync deliberately does not carry it:
 * host aliases and CLI inventories describe the machine doing the scan, not a
 * shared project file.
 */
const FACTS_FILE = 'machine-facts.json'
const FACTS_SCHEMA = 1

/* An alias is one whitespace-free token; facts are keyed by it. `local` is the
   synthetic host that always exists. */
const SAFE_ALIAS = /^[^\s,:"'`\\#]+$/

function factsFile(record) {
  return path.join(record.path, FACTS_FILE)
}

function emptyFacts() {
  return { schema: FACTS_SCHEMA, hosts: {}, updatedAt: '' }
}

function readMachineFacts(dir) {
  const raw = readJson(path.join(dir, FACTS_FILE), null)
  if (!raw || raw.schema !== FACTS_SCHEMA || !raw.hosts || typeof raw.hosts !== 'object') {
    return emptyFacts()
  }
  const hosts = {}
  for (const [alias, value] of Object.entries(raw.hosts)) {
    if (alias !== 'local' && !SAFE_ALIAS.test(alias)) continue
    if (!value || typeof value !== 'object') continue
    if (value.alias !== undefined && value.alias !== alias) continue
    hosts[alias] = value
  }
  return {
    schema: FACTS_SCHEMA,
    hosts,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  }
}

function countMachineFacts(dir) {
  return Object.keys(readMachineFacts(dir).hosts).length
}

/** The only machine every workspace has: the one running this process. */
function machines() {
  const hostname = os.hostname()
  return [
    {
      id: 'local',
      label: String(hostname || 'local').replace(/\.local$/i, ''),
      desc: `${os.platform()} ${os.arch()} · this machine`,
      spec: hostname || 'localhost',
      state: 'online',
      thisMachine: true,
      source: 'local',
    },
  ]
}

function machineFacts(id) {
  return readMachineFacts(open(id).path)
}

/** Store one host's snapshot. The caller has already probed the host. */
function saveMachineFacts({ id, alias, facts } = {}) {
  const target = String(alias || '').trim()
  if (target !== 'local' && !SAFE_ALIAS.test(target)) {
    throw new Error(`"${target}" is not a usable host alias.`)
  }
  if (!facts || typeof facts !== 'object') throw new Error('No machine facts to store.')
  const record = open(id)
  const doc = readMachineFacts(record.path)
  doc.hosts[target] = { ...facts, alias: target }
  doc.updatedAt = new Date().toISOString()
  writeJson(factsFile(record), doc)
  return doc
}

function forgetMachineFacts({ id, alias } = {}) {
  const target = String(alias || '').trim()
  const record = open(id)
  const doc = readMachineFacts(record.path)
  if (!Object.prototype.hasOwnProperty.call(doc.hosts, target)) return doc
  delete doc.hosts[target]
  doc.updatedAt = new Date().toISOString()
  writeJson(factsFile(record), doc)
  return doc
}

/**
 * The old attachment layout copied an ssh config and private keys into the
 * workspace. This build removes the feature, so opening an old workspace drops
 * those app-generated files. A host that still matters is in ~/.ssh/config.
 */
function cleanupLegacyMachines(record) {
  const dir = path.join(record.path, 'machines')
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  const legacy = path.join(record.path, 'machines.json')
  if (fs.existsSync(legacy)) fs.rmSync(legacy, { force: true })
}

/* ── skills: symlink, do not copy ─────────────────────────────────── */

function skillsDir(record) {
  return path.join(record.path, 'skills')
}

function skills(id) {
  const record = open(id)
  return localData.scanSkillDir(skillsDir(record), {
    harness: 'workspace',
    harnessLabel: 'Workspace',
    detectHarness: true,
  })
}

/** The library entry a workspace symlink should point at. */
function findLibrarySkill(name, harness) {
  const wanted = String(name || '').toLowerCase()
  const wantedHarness = String(harness || '')
  const sources = localData.skillSources()
  const matches = sources.filter((item) => item.name.toLowerCase() === wanted)
  return (
    matches.find((item) => item.harness === wantedHarness) ||
    matches[0] ||
    null
  )
}

/**
 * One syscall to attach a skill: a symlink into the harness library, so the
 * workspace follows library updates instead of forking them. A filesystem that
 * refuses symlinks (Windows without privilege) gets a copy, marked as such.
 */
function attachSkillTo(dir, name, harness) {
  const source = findLibrarySkill(name, harness)
  if (!source) {
    throw new Error(`No skill called "${name}" in the harness libraries on this machine.`)
  }

  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, source.name)
  let existing = null
  try {
    existing = fs.lstatSync(target)
  } catch {
    /* free name */
  }
  if (existing) {
    throw new Error(`"${source.name}" is already attached to this workspace.`)
  }

  let real
  try {
    real = fs.realpathSync(source.absolutePath)
  } catch {
    real = source.absolutePath
  }

  const tmp = `${target}.${process.pid}.tmp`
  let copied = false
  try {
    fs.symlinkSync(real, tmp)
    fs.renameSync(tmp, target)
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* nothing staged */
    }
    /* EPERM / EACCES / ENOSYS: fall back to a copy on platforms without links */
    if (!['EPERM', 'EACCES', 'ENOSYS', 'EINVAL'].includes(error?.code)) {
      throw new Error(`Could not link ${source.name}: ${error.message}`)
    }
    fs.cpSync(real, target, { recursive: true })
    copied = true
  }

  return { name: source.name, harness: source.harness, copied, path: tilde(target) }
}

function attachSkill({ id, name, harness }) {
  return attachSkillTo(skillsDir(open(id)), name, harness)
}

function detachSkill({ id, name }) {
  const record = open(id)
  const dir = skillsDir(record)
  const wanted = String(name || '')
  let entries = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return { removed: false }
  }
  const match = entries.find((entry) => entry.toLowerCase() === wanted.toLowerCase())
  if (!match) return { removed: false }
  const full = path.join(dir, match)
  let stat = null
  try {
    stat = fs.lstatSync(full)
  } catch {
    return { removed: false }
  }
  if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(full, { recursive: true, force: true })
  else fs.unlinkSync(full)
  return { removed: true }
}

function skillRead({ id, name }) {
  const record = open(id)
  return localData.readWorkspaceSkill(skillsDir(record), name)
}

/* ── MCP pool ─────────────────────────────────────────────────────── */

function mcpPath(record) {
  return path.join(record.path, 'mcp.json')
}

/** A read redacts (`•••`/`***`); a write carrying that placeholder keeps the
    stored value instead of overwriting a credential with bullets. */
function preserveSecrets(existing, incoming) {
  if (!existing || typeof existing !== 'object') return incoming
  const out = { ...incoming }
  for (const field of ['env', 'headers']) {
    if (!out[field] || !existing[field] || Array.isArray(out[field]) || Array.isArray(existing[field])) {
      continue
    }
    const merged = { ...out[field] }
    for (const key of Object.keys(merged)) {
      if ((merged[key] === '•••' || merged[key] === '***') && existing[field][key]) {
        merged[key] = existing[field][key]
      }
    }
    out[field] = merged
  }
  return out
}

function validServer(name, entry) {
  if (!String(name || '').trim()) throw new Error('Every MCP server needs a name.')
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`MCP server "${name}" must be an object.`)
  }
  if (!entry.command && !entry.url) {
    throw new Error(`MCP server "${name}" needs a command or a url.`)
  }
  /* `env` has two accepted shapes: a list of variable names resolved when the
     harness is spawned, or a name → value object copied verbatim from a
     harness config (that is what attaching a working server gives you).
     Values are stored here and never returned by any verb. */
  if (entry.env !== undefined) {
    const env = entry.env
    if (!env || typeof env !== 'object') {
      throw new Error(`MCP server "${name}": env is a map of name → value, or a list of names.`)
    }
    const values = Array.isArray(env) ? env : Object.values(env)
    for (const value of values) {
      if (typeof value !== 'string') {
        throw new Error(`MCP server "${name}": env values must be strings.`)
      }
    }
  }
  if (entry.headers !== undefined) {
    const headers = entry.headers
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
      throw new Error(`MCP server "${name}": headers must be a name → value object.`)
    }
    for (const value of Object.values(headers)) {
      if (typeof value !== 'string') {
        throw new Error(`MCP server "${name}": header values must be strings.`)
      }
    }
  }
  return entry
}

function readMcpRaw(record) {
  const raw = readJson(mcpPath(record), { schema: 1, servers: {} })
  const servers = raw?.servers && typeof raw.servers === 'object' ? raw.servers : {}
  const disabled = raw?.disabled && typeof raw.disabled === 'object' ? raw.disabled : {}
  return { servers, disabled }
}

function mcp(id) {
  const record = open(id)
  const { servers, disabled } = readMcpRaw(record)
  return {
    schema: 1,
    strict: record.mcpStrict,
    path: tilde(mcpPath(record)),
    servers,
    disabled,
    names: Object.keys(servers).sort(),
    disabledNames: Object.keys(disabled).sort(),
  }
}

function writeMcp({ id, servers, disabled }) {
  const record = open(id)
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error('Expected an object of server name → definition.')
  }
  const current = readMcpRaw(record)
  const parked = disabled && typeof disabled === 'object' && !Array.isArray(disabled)
    ? disabled
    : current.disabled
  const keep = (source) => {
    const out = {}
    for (const [name, entry] of Object.entries(source)) {
      out[name] = preserveSecrets(current.servers[name] || current.disabled[name], entry)
      validServer(name, out[name])
    }
    return out
  }
  const nextServers = keep(servers)
  const nextParked = keep(parked)
  writeJson(mcpPath(record), { schema: 1, servers: nextServers, disabled: nextParked }, { mode: 0o600 })
  return mcp(id)
}

/**
 * Enable/disable one server without losing its definition. Disabling moves the
 * definition into `disabled`; enabling moves it back. Global servers that are
 * not in the pool yet can be enabled by sending their definition.
 */
function setMcpEnabled({ id, name, enabled, definition = null }) {
  const record = open(id)
  const key = String(name || '').trim()
  if (!key) throw new Error('An MCP server needs a name.')
  const { servers, disabled } = readMcpRaw(record)
  if (enabled) {
    const entry = disabled[key] || servers[key] || definition
    if (!entry) throw new Error(`No definition for MCP server "${key}".`)
    servers[key] = validServer(key, entry)
    delete disabled[key]
  } else {
    const entry = servers[key] || disabled[key] || definition
    if (entry) {
      disabled[key] = validServer(key, entry)
      delete servers[key]
    }
  }
  writeJson(mcpPath(record), { schema: 1, servers, disabled }, { mode: 0o600 })
  return mcp(id)
}

/* ── manage: export / import / delete ─────────────────────────────── */

/*
 * A workspace bundle is one JSON file. It carries the files that make the
 * workspace mean something — entities, chats, copied skills, MCP — and leaves
 * out the machine-local parts: copied private keys, the generated ssh CONFIG,
 * and run logs. Those are recreated (or deliberately not carried) on import.
 * Skill symlinks are recorded as name + harness and re-linked against this
 * machine's libraries.
 */
const BUNDLE_KIND = 'entity.workspace'
const BUNDLE_SCHEMA = 1
const EXPORT_DIRS = ['entities', 'chats', 'skills', 'artifacts']
const MAX_BUNDLE_FILE = 25 * 1024 * 1024

function bundlePath(value) {
  const rel = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rel.includes('/') && rel !== 'mcp.json') return ''
  const parts = rel.split('/').filter(Boolean)
  if (!parts.length || parts.some((part) => part === '..' || part === '.')) return ''
  if (rel === 'mcp.json') return rel
  if (!EXPORT_DIRS.includes(parts[0])) return ''
  return parts.join('/')
}

function walkBundleFiles(root, rel, out, allowBinary = false) {
  let entries = []
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const child = `${rel}/${entry.name}`
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      walkBundleFiles(root, child, out)
      continue
    }
    if (!entry.isFile()) continue
    let stat
    try {
      stat = fs.statSync(path.join(root, child))
    } catch {
      continue
    }
    if (!stat.isFile() || stat.size > MAX_BUNDLE_FILE) continue
    try {
      const buffer = fs.readFileSync(path.join(root, child))
      if (allowBinary) {
        out[child] = {
          dataUrl: `data:application/octet-stream;base64,${buffer.toString('base64')}`,
        }
        continue
      }
      if (buffer.includes(0)) continue
      out[child] = buffer.toString('utf8')
    } catch {
      /* an unreadable file is not worth failing the export over */
    }
  }
}

function exportedSkills(record) {
  const sources = localData.skillSources()
  const byReal = new Map()
  for (const source of sources) {
    try {
      byReal.set(fs.realpathSync(source.absolutePath), source)
    } catch {
      /* a dangling library entry cannot match a workspace link */
    }
  }

  const out = []
  let entries = []
  try {
    entries = fs.readdirSync(skillsDir(record))
  } catch {
    return out
  }
  for (const name of entries) {
    const full = path.join(skillsDir(record), name)
    let stat
    try {
      stat = fs.lstatSync(full)
    } catch {
      continue
    }
    if (!stat.isSymbolicLink()) continue
    let source = null
    try {
      source = byReal.get(fs.realpathSync(full)) || null
    } catch {
      /* the link target is gone; keep the name so import can report it */
    }
    out.push({ name, harness: source?.harness || '' })
  }
  return out
}

function exportWorkspace({ id } = {}) {
  const record = open(id)
  const raw = readJson(path.join(record.path, 'workspace.json'), {}) || {}
  const files = {}
  for (const dir of EXPORT_DIRS) {
    walkBundleFiles(record.path, dir, files, dir === 'artifacts')
  }
  try {
    const mcp = fs.readFileSync(mcpPath(record), 'utf8')
    if (!mcp.includes('\0') && mcp.length <= MAX_BUNDLE_FILE) files['mcp.json'] = mcp
  } catch {
    /* no pool file yet */
  }

  return {
    schema: BUNDLE_SCHEMA,
    kind: BUNDLE_KIND,
    exportedAt: new Date().toISOString(),
    workspace: {
      label: record.label,
      kind: record.kind,
      createdAt: record.createdAt,
      mcpStrict: record.mcpStrict !== false,
      owner: record.owner,
      members: record.members,
    },
    files,
    skills: exportedSkills(record),
  }
}

function uniqueImportId(label) {
  const base = slugify(label) || 'workspace'
  if (!fs.existsSync(path.join(WORKSPACES_DIR, base))) return base
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`
    if (!fs.existsSync(path.join(WORKSPACES_DIR, candidate))) return candidate
  }
  throw new Error('Could not find a free workspace id for the import.')
}

function importWorkspace({ bundle } = {}) {
  if (!bundle || typeof bundle !== 'object') throw new Error('That is not a workspace bundle.')
  if (bundle.schema !== BUNDLE_SCHEMA || bundle.kind !== BUNDLE_KIND) {
    throw new Error('That file is not an entity workspace bundle.')
  }
  const label = String(bundle.workspace?.label || 'Imported workspace').trim().slice(0, 80) || 'Imported workspace'
  const id = uniqueImportId(label)
  const final = path.join(WORKSPACES_DIR, id)
  fs.mkdirSync(WORKSPACES_DIR, { recursive: true })
  const staging = path.join(WORKSPACES_DIR, `.tmp-import-${id}-${process.pid}`)
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })

  const skipped = []
  try {
    const createdAt = new Date().toISOString()
    const owner = normaliseOwner(bundle.workspace?.owner)
    const members = normaliseMembers(bundle.workspace?.members)
    const bound = writeMembersFile(staging, id, owner, members)
    writeJson(path.join(staging, 'workspace.json'), {
      schema: 1,
      id,
      label,
      kind: 'local',
      createdAt,
      mcpStrict: bundle.workspace?.mcpStrict !== false,
      ...(bound.owner ? { owner: bound.owner } : {}),
      members: bound.members,
    })
    for (const dir of ['entities', 'chats', 'skills', 'runs', 'artifacts']) {
      fs.mkdirSync(path.join(staging, dir), { recursive: true })
    }

    const files = bundle.files && typeof bundle.files === 'object' ? bundle.files : {}
    for (const [rawPath, rawValue] of Object.entries(files)) {
      const rel = bundlePath(rawPath)
      if (!rel || rel === 'workspace.json') continue
      if (typeof rawValue === 'string') {
        if (rawValue.length > MAX_BUNDLE_FILE) {
          skipped.push(`${rel}: file is too large`)
          continue
        }
        writeFileAtomic(path.join(staging, rel), rawValue)
        continue
      }
      if (rawValue && typeof rawValue.dataUrl === 'string') {
        const match = rawValue.dataUrl.match(/^data:[^,]*;base64,([\s\S]*)$/)
        if (!match) {
          skipped.push(`${rel}: unsupported binary entry`)
          continue
        }
        const buffer = Buffer.from(match[1], 'base64')
        if (buffer.length > MAX_BUNDLE_FILE) {
          skipped.push(`${rel}: file is too large`)
          continue
        }
        writeBinaryAtomic(path.join(staging, rel), buffer)
        continue
      }
      skipped.push(`${rel}: unsupported file entry`)
    }
    if (!fs.existsSync(path.join(staging, 'mcp.json'))) {
      writeJson(path.join(staging, 'mcp.json'), { schema: 1, servers: {} })
    }

    const wantedSkills = Array.isArray(bundle.skills) ? bundle.skills : []
    for (const entry of wantedSkills) {
      const name = typeof entry === 'string' ? entry : entry?.name
      const harness = typeof entry === 'string' ? '' : entry?.harness
      if (!name) continue
      try {
        attachSkillTo(path.join(staging, 'skills'), name, harness)
      } catch (error) {
        skipped.push(`${name}: ${error.message}`)
      }
    }

    fs.renameSync(staging, final)
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw error
  }

  return { record: withCounts(readRecord(id)), skipped }
}

function remove({ id } = {}) {
  const record = open(id)
  fs.rmSync(record.path, { recursive: true, force: true })
  return { id: record.id, removed: true }
}

/* ── create: one atomic call ──────────────────────────────────────── */

function seedEntities(staging, attachedSkills, selected) {
  const names = new Set(attachedSkills.map((skill) => skill.name))
  /* null/undefined means "all"; an explicit [] means "none" — the wizard's Clear
     button has to be able to say that. */
  const wanted = Array.isArray(selected) ? new Set(selected.map(String)) : null
  const dir = path.join(staging, 'entities')
  for (const sample of SAMPLES) {
    if (wanted && !wanted.has(sample.name)) continue
    const skills = sample.preferredSkills.filter((skill) => names.has(skill))
    const skillsLine = skills.length ? `skills: ${skills.join(', ')}\n` : ''
    const markLine = ['shape', 'color', 'mood']
      .filter((key) => sample[key])
      .map((key) => `${key}: ${sample[key]}\n`)
      .join('')
    const text = `---\nname: ${sample.name}\nharness: ${sample.harness}\nmodel: ${sample.model}\ndir: ${tilde(HOME)}\n${skillsLine}${markLine}---\n\n${sample.body}`
    fs.writeFileSync(path.join(dir, `${sample.name}.md`), text, 'utf8')
  }
}

function create({
  label,
  skills: wanted = [],
  seed = false,
  seedEntities: selectedSamples = null,
  owner = null,
} = {}) {
  const id = slugify(label)
  if (!id || !SLUG.test(id)) {
    throw new Error('Use a name with letters or digits — the folder is derived from it.')
  }
  const final = path.join(WORKSPACES_DIR, id)
  if (fs.existsSync(final)) {
    throw new Error(`${tilde(final)} already exists. Pick another name.`)
  }

  fs.mkdirSync(WORKSPACES_DIR, { recursive: true })
  const staging = path.join(WORKSPACES_DIR, `.tmp-${id}-${process.pid}`)
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })

  try {
    const now = new Date().toISOString()
    const creator = normaliseOwner(owner)
    const bound = writeMembersFile(staging, id, creator, creator ? [creator] : [])

    for (const dir of ['entities', 'skills', 'runs', 'artifacts']) {
      fs.mkdirSync(path.join(staging, dir), { recursive: true })
    }
    fs.writeFileSync(
      path.join(staging, 'workspace.json'),
      `${JSON.stringify(
        {
          schema: 1,
          id,
          label: String(label || id).trim(),
          kind: 'local',
          createdAt: now,
          mcpStrict: true,
          ...(bound.owner ? { owner: bound.owner } : {}),
          members: bound.members,
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    fs.writeFileSync(
      path.join(staging, 'mcp.json'),
      `${JSON.stringify({ schema: 1, servers: {} }, null, 2)}\n`,
      'utf8',
    )

    /* Skills are linked inside the staging directory, so the rename moves them
       into place with everything else. */
    const linked = []
    for (const entry of wanted) {
      const name = typeof entry === 'string' ? entry : entry?.name
      const harness = typeof entry === 'string' ? '' : entry?.harness
      if (!name) continue
      try {
        linked.push(attachSkillTo(path.join(staging, 'skills'), name, harness))
      } catch (error) {
        if (!/already attached/.test(error.message)) throw error
      }
    }

    if (seed) seedEntities(staging, linked, selectedSamples)

    fs.renameSync(staging, final)
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw error
  }

  return withCounts(readRecord(id))
}

/** What the wizard offers: names and one-liners, never the file bodies. */
function samples() {
  return sampleList()
}

module.exports = {
  ROOT,
  WORKSPACES_DIR,
  HOME,
  slugify,
  list,
  needsSetup,
  open,
  create,
  update,
  setContext,
  claimOwner,
  samples,
  machines,
  machineFacts,
  saveMachineFacts,
  forgetMachineFacts,
  factsFile,
  skills,
  skillsDir,
  attachSkill,
  detachSkill,
  skillRead,
  mcp,
  writeMcp,
  setMcpEnabled,
  exportWorkspace,
  importWorkspace,
  remove,
  writeFileAtomic,
  writeJson,
  workspaceDir,
  HARNESS_IDS,
}
