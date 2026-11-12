/**
 * A workspace is a directory. This module is its only writer.
 *
 *   ~/.entity/workspaces/<id>/
 *     workspace.json   { schema, id, label, kind, createdAt, mcpStrict, members }
 *     entities/*.md    one file per entity
 *     skills/<name>    symlinks into the harness libraries
 *     mcp.json         the workspace's MCP server pool
 *     machines/CONFIG  this workspace's ssh_config (Host blocks, IdentityFile)
 *     machines/<host>  a copy of that host's private key, mode 0600
 *     chats/*.json     one conversation per file
 *     runs/*.jsonl     append-only run logs
 *
 * `machines.json` is the previous shape; it is migrated into `machines/CONFIG`
 * the first time an old workspace is opened.
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
const { tilde, expandHome } = require('./frontmatter.cjs')
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

/* ── small file helpers ───────────────────────────────────────────── */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** tmp + rename: a crash cannot truncate a workspace file. */
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
  return value
}

function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, text, 'utf8')
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

  return {
    id: raw.id,
    label: raw.label,
    kind: raw.kind === 'self-hosted' ? 'self-hosted' : 'local',
    createdAt: raw.createdAt || new Date(0).toISOString(),
    mcpStrict: raw.mcpStrict !== false,
    members: normaliseMembers(raw.members),
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
      machines: attachedMachines(record.path).length,
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
    const roster = normaliseMembers(members !== undefined ? members : raw.members)
    if (roster.length && !roster.some((member) => member.role === 'owner')) {
      throw new Error('A workspace needs at least one owner.')
    }
    const next = {
      ...raw,
      schema: 1,
      id: targetId,
      label: name,
      kind: current.kind,
      createdAt: current.createdAt,
      mcpStrict: current.mcpStrict !== false,
      members: roster,
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
  /* An old workspace gets its `machines/CONFIG` on first open. A migration that
     fails (read-only home, odd permissions) must not make the workspace
     unreadable; the legacy list still answers until the next write. */
  try {
    migrateMachines(record)
  } catch {
    /* keep going */
  }
  return record
}

/* ── machines: one ssh config per workspace ───────────────────────── */

/*
 * A workspace carries its own `machines/CONFIG`, in the same grammar as
 * `~/.ssh/config`, plus a copy of each attached host's private key as
 * `machines/<host>` (mode 0600, directory 0700). Two reasons: the hub can show
 * exactly how a host is reached without reading the user's global config, and a
 * later remote runner has one file to read or deploy instead of guessing.
 *
 * `~/.ssh/config` stays the source of truth for which hosts exist. CONFIG is
 * rebuilt from it on every attach and detach, so the two cannot drift. A
 * workspace made before this layout is migrated the first time it is opened:
 * `machines.json` is read once, CONFIG is written, and the old file is kept as
 * `.machines.json.bak`.
 */

const MACHINES_DIR = 'machines'
const MACHINES_CONFIG = 'CONFIG'
const MACHINES_LEGACY = 'machines.json'
const KEY_BYTES_MAX = 256 * 1024

/* The attached list lives in a comment so a host that disappeared from
   ~/.ssh/config still has a place in the file — ssh ignores the line, we read
   it, and the Host blocks below stay the actual configuration. JSON, not commas:
   an alias is a token, and a token can contain a comma. */
const MANIFEST = /^\s*#\s*entity-machines:\s*(.+)$/m

/** An ssh alias is one whitespace-free token; anything else cannot be a Host. */
const SAFE_ALIAS = /^[^\s,:"'`\\#]+$/

function machinesDir(record) {
  return path.join(record.path, MACHINES_DIR)
}

function machinesConfigPath(record) {
  return path.join(machinesDir(record), MACHINES_CONFIG)
}

/** `local` is synthetic and first; the rest keep the order they were attached in. */
function normaliseAttached(list) {
  const out = ['local']
  for (const entry of Array.isArray(list) ? list : []) {
    const id = String(entry || '').trim()
    if (!id || id === 'local' || out.includes(id)) continue
    /* a value that cannot be a Host line must never be written as one */
    if (!SAFE_ALIAS.test(id)) continue
    out.push(id)
  }
  return out
}

/** CONFIG is the list. `machines.json` is read only for pre-CONFIG workspaces. */
function attachedMachines(dir) {
  const config = path.join(dir, MACHINES_DIR, MACHINES_CONFIG)
  if (fs.existsSync(config)) {
    let text = ''
    try {
      text = fs.readFileSync(config, 'utf8')
    } catch {
      /* unreadable: fall back to the Host blocks we can parse */
    }
    const manifest = String(text).match(MANIFEST)
    let declared = []
    if (manifest) {
      try {
        const parsed = JSON.parse(manifest[1].trim())
        if (Array.isArray(parsed)) declared = parsed.map(String)
      } catch {
        /* a hand-edited manifest line is not worth failing a read over */
      }
    }
    /* manifest first (it keeps missing hosts), then any Host block a person
       added by hand — so editing CONFIG directly is not silently ignored */
    const hosts = localData.parseSshHostsFile(config).flatMap((host) => host.aliases)
    return normaliseAttached([...declared, ...hosts])
  }
  const legacy = readJson(path.join(dir, MACHINES_LEGACY), null)
  return normaliseAttached(Array.isArray(legacy?.attached) ? legacy.attached : [])
}

/** An ssh alias is not a safe file name, and CONFIG is reserved on macOS too. */
function keyFileName(alias) {
  const base = String(alias || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 60)
  return base || 'host'
}

/** alias → key file name, unique even where the filesystem ignores case. */
function keyNames(aliases) {
  const used = new Set([MACHINES_CONFIG.toLowerCase()])
  const names = new Map()
  for (const alias of aliases) {
    const base = keyFileName(alias)
    let name = base
    let n = 2
    while (used.has(name.toLowerCase())) name = `${base}-${n++}`
    used.add(name.toLowerCase())
    names.set(alias, name)
  }
  return names
}

function hostIndex(fleet) {
  const byAlias = new Map()
  for (const host of fleet.hosts || []) {
    for (const alias of host.aliases || []) {
      if (!byAlias.has(alias)) byAlias.set(alias, host)
    }
  }
  return byAlias
}

/**
 * The workspace's ssh_config. Only the fields this app understands are written;
 * an Include, a Match block or a ControlPath is deliberately not copied. `keys`
 * maps an alias to the key file that was actually copied, so a host whose key
 * could not be copied gets no IdentityFile line instead of a broken one.
 */
function renderMachineConfig({ label, id, attached, fleet, keys, machinesPath }) {
  const byAlias = hostIndex(fleet)
  const lines = [
    `# Entity workspace: ${label} (${id})`,
    `# Rebuilt from ${fleet.displayPath || '~/.ssh/config'} on every attach or detach.`,
    '# Change the host there, then attach or detach it here to refresh this file.',
    `# entity-machines: ${JSON.stringify(attached)}`,
    '',
  ]
  const entries = []

  for (const alias of attached) {
    if (alias === 'local') continue
    const host = byAlias.get(alias)
    if (!host) {
      lines.push(`# ${alias}: not found in ${fleet.displayPath || '~/.ssh/config'}`, '')
      entries.push({ alias, missing: true })
      continue
    }
    const key = (keys && keys.get(alias)) || ''
    lines.push(`Host ${alias}`)
    if (host.hostName) lines.push(`  HostName ${host.hostName}`)
    if (host.user) lines.push(`  User ${host.user}`)
    if (host.port) lines.push(`  Port ${host.port}`)
    if (host.proxyJump) lines.push(`  ProxyJump ${host.proxyJump}`)
    if (key) {
      lines.push(`  IdentityFile ${path.join(machinesPath, key)}`)
      lines.push('  IdentitiesOnly yes')
    }
    lines.push('')
    entries.push({ alias, missing: false, key, identityFile: host.identityFile || '' })
  }

  return { text: `${lines.join('\n').replace(/\n+$/, '')}\n`, entries }
}

/** Copy one private key beside the workspace config, readable by this user only. */
function copyIdentity(source, target) {
  if (!source) return { copied: false, note: 'no IdentityFile in ~/.ssh/config' }
  const file = expandHome(source)
  let stat = null
  try {
    stat = fs.statSync(file)
  } catch {
    return { copied: false, note: `${source} is not readable` }
  }
  if (!stat.isFile()) return { copied: false, note: `${source} is not a regular file` }
  if (stat.size > KEY_BYTES_MAX) return { copied: false, note: `${source} is too large for a key` }

  const tmp = `${target}.${process.pid}.tmp`
  try {
    fs.copyFileSync(file, tmp)
    fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, target)
    return { copied: true, note: '' }
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* nothing staged */
    }
    return { copied: false, note: `${source} could not be copied: ${error.message}` }
  }
}

/** Key files the previous CONFIG pointed at, so a detach can remove them. */
function previousKeys(configPath) {
  let text = ''
  try {
    text = fs.readFileSync(configPath, 'utf8')
  } catch {
    return []
  }
  return [...text.matchAll(/^\s*IdentityFile\s+(.+)$/gm)].map((match) => match[1].trim())
}

/** `local` is synthetic and always allowed; the rest must exist in ~/.ssh/config. */
function machineList(record) {
  const attached = attachedMachines(record.path)
  const fleet = localData.readSshHosts()
  const byAlias = hostIndex(fleet)
  const names = keyNames(attached.filter((alias) => alias !== 'local'))
  const config = tilde(machinesConfigPath(record))

  return attached.map((id) => {
    if (id === 'local') {
      return {
        id: 'local',
        /* `MacBook.local` is the mDNS name, not what a person calls the machine */
        label: String(fleet.hostname || 'local').replace(/\.local$/i, ''),
        desc: `${os.platform()} ${os.arch()} · this machine`,
        spec: fleet.hostname || 'localhost',
        state: 'online',
        thisMachine: true,
        missing: false,
        source: 'local',
        config,
        key: '',
        keyPresent: false,
        keyNote: '',
      }
    }
    const host = byAlias.get(id)
    if (!host) {
      return {
        id,
        label: id,
        desc: `missing from ${fleet.displayPath}`,
        spec: '',
        state: 'sleep',
        thisMachine: false,
        missing: true,
        source: fleet.displayPath,
        config,
        key: '',
        keyPresent: false,
        keyNote: '',
      }
    }

    const keyName = names.get(id) || ''
    const keyFile = keyName ? path.join(machinesDir(record), keyName) : ''
    const keyPresent = Boolean(keyFile) && fs.existsSync(keyFile)
    /* why there is no local key copy — shown on the card, never guessed at */
    const keyNote = !host.identityFile
      ? 'ssh uses the agent or the default identities'
      : keyPresent
        ? ''
        : `the copy of ${host.identityFile} did not land`

    return {
      id,
      label: host.label,
      desc: host.hostName || id,
      spec: host.spec,
      state: 'idle',
      thisMachine: false,
      missing: false,
      source: host.source,
      aliases: host.aliases,
      config,
      key: keyPresent ? tilde(keyFile) : '',
      keyPresent,
      keyName,
      keyNote,
    }
  })
}

function machines(id) {
  return machineList(open(id))
}

/**
 * Rebuild `machines/CONFIG` (and the key copies) from ~/.ssh/config.
 * Returns the new machine list, which is what every caller hands to the UI.
 */
function writeMachines(record, attached) {
  const next = normaliseAttached(attached)
  const fleet = localData.readSshHosts()
  const dir = machinesDir(record)
  const configPath = machinesConfigPath(record)

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    /* a filesystem without modes still gets the files */
  }

  /* copy first: a key that cannot be copied must not leave an IdentityFile
     line pointing at a file that is not there */
  const names = keyNames(next.filter((alias) => alias !== 'local'))
  const kept = new Map()
  const byAlias = hostIndex(fleet)
  for (const [alias, name] of names) {
    const host = byAlias.get(alias)
    if (!host) continue
    if (copyIdentity(host.identityFile, path.join(dir, name)).copied) {
      kept.set(alias, name)
    }
  }

  const { text } = renderMachineConfig({
    label: record.label,
    id: record.id,
    attached: next,
    fleet,
    keys: kept,
    machinesPath: dir,
  })

  /* drop keys the old config referenced and the new one does not */
  const resolvedDir = path.resolve(dir)
  for (const old of previousKeys(configPath)) {
    const resolved = path.resolve(expandHome(old))
    if (path.dirname(resolved) !== resolvedDir) continue
    const name = path.basename(resolved)
    if ([...kept.values()].includes(name)) continue
    try {
      fs.rmSync(resolved, { force: true })
    } catch {
      /* already gone */
    }
  }

  const tmp = `${configPath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o644 })
  fs.renameSync(tmp, configPath)
  try {
    fs.chmodSync(configPath, 0o644)
  } catch {
    /* best effort */
  }

  const kind = next.some((id) => id !== 'local') ? 'self-hosted' : 'local'
  /* read first: a machine write must not drop fields this module does not own
     (members today, whatever the next step adds tomorrow) */
  const current = readJson(path.join(record.path, 'workspace.json'), {}) || {}
  writeJson(path.join(record.path, 'workspace.json'), {
    ...current,
    schema: 1,
    id: record.id,
    label: record.label,
    kind,
    createdAt: record.createdAt,
    mcpStrict: record.mcpStrict !== false,
  })

  /* one-way: the old list is kept, but nothing reads it again */
  const legacy = path.join(record.path, MACHINES_LEGACY)
  if (fs.existsSync(legacy)) {
    try {
      fs.renameSync(legacy, path.join(record.path, `.${MACHINES_LEGACY}.bak`))
    } catch {
      /* an un-renamable legacy file is not worth failing a write over */
    }
  }

  return machineList(record)
}

/** Pre-CONFIG workspace: read the old list once, write CONFIG, keep a backup. */
function migrateMachines(record) {
  if (fs.existsSync(machinesConfigPath(record))) return false
  if (!fs.existsSync(path.join(record.path, MACHINES_LEGACY))) return false
  writeMachines(record, attachedMachines(record.path))
  return true
}

function attachMachine({ id, alias }) {
  const record = open(id)
  const target = String(alias || '').trim()
  if (!target) throw new Error('Pick a host to attach.')
  if (target === 'local') return machines(id)
  if (target.startsWith('-')) throw new Error('That is not a host alias.')

  const fleet = localData.readSshHosts()
  const known = fleet.hosts.some(
    (host) => host.alias === target || host.aliases.includes(target),
  )
  if (!known) {
    throw new Error(`${target} is not in ${fleet.displayPath}.`)
  }

  const attached = attachedMachines(record.path)
  if (!attached.includes(target)) attached.push(target)
  return writeMachines(record, attached)
}

function detachMachine({ id, alias }) {
  const record = open(id)
  const target = String(alias || '').trim()
  if (target === 'local') throw new Error('The local machine cannot be detached.')
  return writeMachines(
    record,
    attachedMachines(record.path).filter((entry) => entry !== target),
  )
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

function mcp(id) {
  const record = open(id)
  const raw = readJson(mcpPath(record), { schema: 1, servers: {} })
  const servers = raw?.servers && typeof raw.servers === 'object' ? raw.servers : {}
  return {
    schema: 1,
    strict: record.mcpStrict,
    path: tilde(mcpPath(record)),
    servers,
    names: Object.keys(servers).sort(),
  }
}

function writeMcp({ id, servers }) {
  const record = open(id)
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error('Expected an object of server name → definition.')
  }
  for (const [name, entry] of Object.entries(servers)) {
    if (!name.trim()) throw new Error('Every MCP server needs a name.')
    if (!entry || typeof entry !== 'object') {
      throw new Error(`MCP server "${name}" must be an object.`)
    }
    if (!entry.command && !entry.url) {
      throw new Error(`MCP server "${name}" needs a command or a url.`)
    }
    if (entry.env && !Array.isArray(entry.env)) {
      throw new Error(`MCP server "${name}": env is a list of variable names, not values.`)
    }
  }
  writeJson(mcpPath(record), { schema: 1, servers })
  return mcp(id)
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
    const text = `---\nname: ${sample.name}\nharness: ${sample.harness}\nmodel: ${sample.model}\ndir: ${tilde(HOME)}\n${skillsLine}---\n\n${sample.body}`
    fs.writeFileSync(path.join(dir, `${sample.name}.md`), text, 'utf8')
  }
}

function create({
  label,
  machines: attached = ['local'],
  skills: wanted = [],
  seed = false,
  seedEntities: selectedSamples = null,
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
    const chosenMachines = [...new Set(['local', ...attached.map(String)])]
    const kind = chosenMachines.some((entry) => entry !== 'local') ? 'self-hosted' : 'local'

    for (const dir of ['entities', 'skills', 'runs']) {
      fs.mkdirSync(path.join(staging, dir), { recursive: true })
    }
    fs.writeFileSync(
      path.join(staging, 'workspace.json'),
      `${JSON.stringify(
        {
          schema: 1,
          id,
          label: String(label || id).trim(),
          kind,
          createdAt: now,
          mcpStrict: true,
          members: [],
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    /* The same writer attach/detach uses, so a new workspace gets
       `machines/CONFIG` (and key copies) from the first moment. */
    writeMachines(
      { id, label: String(label || id).trim(), path: staging, createdAt: now, mcpStrict: true },
      chosenMachines,
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
  samples,
  machines,
  machinesDir,
  machinesConfigPath,
  renderMachineConfig,
  attachMachine,
  detachMachine,
  skills,
  skillsDir,
  attachSkill,
  detachSkill,
  skillRead,
  mcp,
  writeMcp,
  writeFileAtomic,
  writeJson,
  workspaceDir,
  HARNESS_IDS,
}
