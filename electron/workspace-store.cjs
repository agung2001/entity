/**
 * A workspace is a directory. This module is its only writer.
 *
 *   ~/.entity/workspaces/<id>/
 *     workspace.json   { schema, id, label, kind, createdAt, mcpStrict }
 *     entities/*.md    one file per entity
 *     skills/<name>    symlinks into the harness libraries
 *     mcp.json         the workspace's MCP server pool
 *     machines.json    { schema, attached: ['local', ...] }
 *     runs/*.jsonl     append-only run logs
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

function attachedMachines(dir) {
  const raw = readJson(path.join(dir, 'machines.json'), null)
  const attached = Array.isArray(raw?.attached) ? raw.attached : ['local']
  return [...new Set(attached.map(String))].filter(Boolean)
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

function open(id) {
  const record = withCounts(readRecord(String(id || '')))
  if (!record) throw new Error(`No workspace called "${id}".`)
  return record
}

/* ── machines ─────────────────────────────────────────────────────── */

/** `local` is synthetic and always allowed; the rest must exist in ~/.ssh/config. */
function machineList(record) {
  const attached = attachedMachines(record.path)
  const fleet = localData.readSshHosts()
  const byAlias = new Map()
  for (const host of fleet.hosts) {
    for (const alias of host.aliases) {
      if (!byAlias.has(alias)) byAlias.set(alias, host)
    }
  }

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
      }
    }
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
    }
  })
}

function machines(id) {
  return machineList(open(id))
}

function writeMachines(record, attached) {
  const next = [...new Set(attached.map(String).filter(Boolean))]
  writeJson(path.join(record.path, 'machines.json'), { schema: 1, attached: next })
  const kind = next.some((id) => id !== 'local') ? 'self-hosted' : 'local'
  writeJson(path.join(record.path, 'workspace.json'), {
    schema: 1,
    id: record.id,
    label: record.label,
    kind,
    createdAt: record.createdAt,
    mcpStrict: record.mcpStrict,
  })
  return machines(record.id)
}

function attachMachine({ id, alias }) {
  const record = open(id)
  const target = String(alias || '').trim()
  if (!target) throw new Error('Pick a host to attach.')
  if (target === 'local') return machines(id)
  if (target.startsWith('-')) throw new Error('That is not a host alias.')

  const known = localData
    .readSshHosts()
    .hosts.some((host) => host.alias === target || host.aliases.includes(target))
  if (!known) {
    throw new Error(`${target} is not in ${localData.readSshHosts().displayPath}.`)
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
        { schema: 1, id, label: String(label || id).trim(), kind, createdAt: now, mcpStrict: true },
        null,
        2,
      )}\n`,
      'utf8',
    )
    fs.writeFileSync(
      path.join(staging, 'machines.json'),
      `${JSON.stringify({ schema: 1, attached: chosenMachines }, null, 2)}\n`,
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
  samples,
  machines,
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
