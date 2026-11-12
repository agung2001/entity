/**
 * Every agent-facing write lands here first.
 *
 * `cli.cjs` and (later) an MCP adapter are transports; this module is the only
 * thing that touches `<ws>/` on an agent's behalf. That matters because the
 * caller is a harness process the agent controls: it can pass any string it
 * likes as a name, a path or a body, and it must still not be able to reach
 * outside the workspace that owns it.
 *
 * One line per mutation goes to `<ws>/audit.jsonl`. An entity that rewrites its
 * own instructions is a real event; without the row, nobody can explain why a
 * run behaved differently last Tuesday.
 */
const fs = require('node:fs')
const path = require('node:path')
const workspaces = require('./workspace-store.cjs')
const entities = require('./entity-store.cjs')
const localData = require('./local-data.cjs')
const audit = require('./platform-audit.cjs')
const { tilde } = require('./frontmatter.cjs')

/** An error with a machine-readable code, so the CLI can exit the right way. */
class PlatformError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const FIELDS = new Set(['harness', 'model', 'dir', 'skills', 'mcp'])

/* ── containment ──────────────────────────────────────────────────── */

/**
 * The real path of `target`, or a `denied` error when it is not inside the
 * workspace. The check runs on the **resolved** path, because `entities/x.md`
 * and `../../etc/passwd` are indistinguishable until the filesystem has had its
 * say. `entity-store.safeName` already refuses `..` — this is the second lock,
 * and it is the one that survives a future caller that forgets to use it.
 */
function within(record, target) {
  const root = fs.realpathSync(record.path)
  const parent = path.dirname(target)
  let resolvedParent
  try {
    resolvedParent = fs.realpathSync(parent)
  } catch {
    resolvedParent = path.resolve(parent)
  }
  const full = path.join(resolvedParent, path.basename(target))
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new PlatformError('denied', `${tilde(target)} is outside this workspace.`)
  }
  return full
}

function stamp(file) {
  try {
    const stat = fs.statSync(file)
    return { mtimeMs: stat.mtimeMs, bytes: stat.size }
  } catch {
    return { mtimeMs: 0, bytes: 0 }
  }
}

/** `entity-store.safeName` refuses anything that is not a filename; say so politely. */
function entityName(name) {
  try {
    return entities.safeName(name)
  } catch (error) {
    throw new PlatformError('invalid', String(error?.message || error))
  }
}

/** The entity's file, guaranteed inside this workspace. */
function entityFile(record, name) {
  const safe = entityName(name)
  const file = entities.locate({ workspace: record.id, name: safe })
  within(record, file)
  return file
}

/**
 * `entity-store.write` writes `<entity.name>.md`, taken from frontmatter — so a
 * file whose frontmatter disagrees with its name would silently create a second
 * file. The GUI only saves records it just read, where that cannot happen; the
 * CLI is reachable from a name alone, so it must refuse instead.
 */
function assertNameMatchesFile(entity) {
  if (entity.fileName !== entity.name) {
    throw new PlatformError(
      'invalid',
      `${entity.fileName}.md declares name "${entity.name}". Fix the file before writing through it, or the write would create a second entity.`,
    )
  }
}

function text(value, field) {
  if (typeof value !== 'string') throw new PlatformError('invalid', `${field} must be a string.`)
  return value
}

/* ── verbs ────────────────────────────────────────────────────────── */

const verbs = {
  /* workspace */

  'workspace.get': (record) => ({
    id: record.id,
    label: record.label,
    context: record.context || '',
    mcpStrict: record.mcpStrict,
    path: tilde(record.path),
  }),

  'workspace.setContext': (record, context) => {
    /* trailing newlines are an artifact of `--context-stdin`, not content */
    const body = text(context, 'context').replace(/\s+$/, '')
    workspaces.setContext({ id: record.id, context: body })
    audit.append(record, { verb: 'workspace.setContext', bytes: Buffer.byteLength(body) })
    return { id: record.id, bytes: Buffer.byteLength(body) }
  },

  /* entities */

  'entity.list': (record) =>
    entities.list(record.id).map((entity) => ({
      name: entity.name,
      harness: entity.harness,
      model: entity.model,
      summary: entity.summary,
      ok: entity.ok,
      problems: entity.problems,
    })),

  'entity.get': (record, name) => {
    const file = entityFile(record, name)
    const entity = entities.read(record.id, name)
    if (!entity) throw new PlatformError('not_found', `No entity called "${name}" in this workspace.`)
    return {
      name: entity.name,
      harness: entity.harness,
      model: entity.model,
      dir: entity.dir,
      skills: entity.skills,
      mcp: entity.mcp,
      instructions: entity.instructions,
      rules: entity.rules,
      problems: entity.problems,
      path: tilde(file),
      stamp: stamp(file),
    }
  },

  /**
   * Rewrite the body — the part the harness receives as instructions. The
   * frontmatter is carried through untouched, including keys this app never
   * edits (`entity-store.serialize` already guarantees that).
   *
   * `expect` is optimistic concurrency, not paranoia: an agent editing its own
   * instructions while a person has the file open in `$EDITOR` is the normal
   * case here, and last-write-wins would silently discard the person's work.
   */
  'entity.setInstructions': (record, name, body, expect) => {
    const file = entityFile(record, name)
    const entity = entities.read(record.id, name)
    if (!entity) throw new PlatformError('not_found', `No entity called "${name}" in this workspace.`)
    assertNameMatchesFile(entity)
    text(body, 'body')

    const before = stamp(file)
    if (expect && typeof expect === 'object') {
      const mtimeDrift = expect.mtimeMs != null && Number(expect.mtimeMs) !== before.mtimeMs
      const sizeDrift = expect.bytes != null && Number(expect.bytes) !== before.bytes
      if (mtimeDrift || sizeDrift) {
        throw new PlatformError(
          'conflict',
          `${name}.md changed since you read it. Read it again; do not overwrite.`,
        )
      }
    }

    const previousBytes = Buffer.byteLength(entity.instructions)
    entities.write({ ...entity, instructions: body })
    const after = stamp(file)
    audit.append(record, {
      verb: 'entity.setInstructions',
      target: entity.name,
      previousBytes,
      bytes: Buffer.byteLength(body),
    })
    return { name: entity.name, bytes: Buffer.byteLength(body), previousBytes, stamp: after }
  },

  /** Config only: harness, model, dir, skills, mcp. The body has its own verb. */
  'entity.setFields': (record, name, patch) => {
    const file = entityFile(record, name)
    const entity = entities.read(record.id, name)
    if (!entity) throw new PlatformError('not_found', `No entity called "${name}" in this workspace.`)
    assertNameMatchesFile(entity)
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new PlatformError('invalid', 'patch must be an object.')
    }

    const changed = []
    const next = { ...entity }

    for (const key of Object.keys(patch)) {
      if (!FIELDS.has(key)) {
        throw new PlatformError('invalid', `"${key}" is not a field you can set here (${[...FIELDS].join(', ')}).`)
      }
    }
    if (patch.harness !== undefined) {
      const harness = text(patch.harness, 'harness').trim()
      if (!entities.HARNESSES.includes(harness)) {
        throw new PlatformError('invalid', `harness must be one of ${entities.HARNESSES.join(', ')}.`)
      }
      next.harness = harness
      changed.push('harness')
    }
    if (patch.model !== undefined) {
      next.model = text(patch.model, 'model').trim()
      changed.push('model')
    }
    if (patch.dir !== undefined) {
      next.dir = text(patch.dir, 'dir').trim()
      changed.push('dir')
    }
    if (patch.skills !== undefined) {
      next.skills = normaliseList(patch.skills, 'skills')
      changed.push('skills')
    }
    if (patch.mcp !== undefined) {
      const pool = workspaces.mcp(record.id)
      const wanted = normaliseList(patch.mcp, 'mcp')
      const missing = wanted.filter((server) => !pool.names.includes(server))
      if (missing.length) {
        throw new PlatformError(
          'invalid',
          `Not in this workspace's MCP pool: ${missing.join(', ')}. Available: ${pool.names.join(', ') || '(none)'}.`,
        )
      }
      next.mcp = wanted
      changed.push('mcp')
    }

    entities.write(next)
    audit.append(record, { verb: 'entity.setFields', target: entity.name, fields: changed })
    const saved = entities.read(record.id, entity.name)
    return {
      name: entity.name,
      changed,
      problems: saved?.problems || [],
      stamp: stamp(file),
    }
  },

  /* workspace MCP pool */

  'mcp.list': (record) => {
    const pool = workspaces.mcp(record.id)
    const servers = {}
    for (const [name, entry] of Object.entries(pool.servers)) servers[name] = describeServer(entry)
    return { strict: pool.strict, names: pool.names, servers }
  },

  'mcp.add': (record, name, spec) => {
    const server = normaliseServer(name, spec)
    const pool = workspaces.mcp(record.id)
    if (pool.servers[server.name]) {
      throw new PlatformError('conflict', `"${server.name}" is already in this workspace's MCP pool.`)
    }
    workspaces.writeMcp({ id: record.id, servers: { ...pool.servers, [server.name]: server.entry } })
    audit.append(record, { verb: 'mcp.add', target: server.name })
    return { name: server.name, created: true }
  },

  'mcp.remove': (record, name) => {
    const wanted = String(name || '').trim()
    const pool = workspaces.mcp(record.id)
    if (!pool.servers[wanted]) {
      throw new PlatformError('not_found', `"${wanted}" is not in this workspace's MCP pool.`)
    }
    const servers = { ...pool.servers }
    delete servers[wanted]
    workspaces.writeMcp({ id: record.id, servers })
    /* the pool is a library: removing the entry does not unmount it from an
       entity that still names it, and that entity now reports it as a problem */
    const stillNamedBy = entities
      .list(record.id)
      .filter((entity) => entity.mcp.includes(wanted))
      .map((entity) => entity.name)
    audit.append(record, { verb: 'mcp.remove', target: wanted })
    return { name: wanted, stillNamedBy }
  },

  /* skills: attached to the workspace, resolved from this machine's libraries */

  'skill.list': (record) => ({
    attached: workspaces.skills(record.id).map((skill) => skill.name),
    sources: localSkillNames(),
  }),

  'skill.attach': (record, name, harness) => {
    const attached = workspaces.attachSkill({ id: record.id, name: String(name || ''), harness: String(harness || '') })
    audit.append(record, { verb: 'skill.attach', target: attached.name, harness: attached.harness })
    return attached
  },

  'skill.detach': (record, name) => {
    const result = workspaces.detachSkill({ id: record.id, name: String(name || '') })
    if (!result.removed) {
      throw new PlatformError('not_found', `"${name}" is not attached to this workspace.`)
    }
    audit.append(record, { verb: 'skill.detach', target: String(name || '') })
    return result
  },
}

/* ── input shaping ────────────────────────────────────────────────── */

function normaliseList(value, field) {
  if (value == null) return []
  const list = Array.isArray(value) ? value : String(value).split(',')
  const out = []
  for (const entry of list) {
    const name = String(entry ?? '').trim()
    if (!name) continue
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name) || name.includes('..')) {
      throw new PlatformError('invalid', `${field}: "${name}" is not a name.`)
    }
    if (!out.includes(name)) out.push(name)
  }
  return out
}

/**
 * An MCP server entry this app can actually run. `env` is a list of variable
 * **names** — the workspace file never holds a value, and neither does this
 * response, so an agent cannot read a secret back out of the pool by listing it.
 */
function normaliseServer(name, spec) {
  const serverName = String(name || '').trim()
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(serverName) || serverName.includes('..')) {
    throw new PlatformError('invalid', 'An MCP server name is letters, digits, dots, dashes and underscores.')
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new PlatformError('invalid', 'The server definition must be an object.')
  }

  const entry = {}
  if (spec.command !== undefined) {
    const command = String(spec.command || '').trim()
    if (!command) throw new PlatformError('invalid', 'command cannot be empty.')
    if (/[\n\r]/.test(command)) throw new PlatformError('invalid', 'command must be one line.')
    entry.command = command
  }
  if (spec.url !== undefined) {
    const url = String(spec.url || '').trim()
    if (!/^https?:\/\//.test(url)) throw new PlatformError('invalid', 'url must start with http:// or https://.')
    entry.url = url
  }
  if (!entry.command && !entry.url) {
    throw new PlatformError('invalid', 'A server needs a command or a url.')
  }
  const args = normaliseArgs(spec.args)
  if (args.length) entry.args = args
  const env = normaliseList(spec.env, 'env')
  if (env.length) entry.env = env
  return { name: serverName, entry }
}

function normaliseArgs(value) {
  if (value == null) return []
  const list = Array.isArray(value) ? value : String(value).split(',')
  return list.map((arg) => String(arg ?? '')).filter((arg) => arg.length > 0)
}

function describeServer(entry) {
  return {
    command: entry.command || '',
    url: entry.url || '',
    args: Array.isArray(entry.args) ? entry.args : [],
    /* names, never values — this is the whole reason the field is a list */
    envKeys: Array.isArray(entry.env) ? entry.env : [],
  }
}

function localSkillNames() {
  try {
    return [...new Set(localData.scanSkillLibrary().map((skill) => skill.name))].sort()
  } catch {
    return []
  }
}

/* ── dispatch ─────────────────────────────────────────────────────── */

/**
 * `verbs` is the contract; this is the only entry point. Everything it returns
 * is an envelope, so a caller never has to distinguish "threw" from "refused".
 */
function call(fn, args = {}) {
  const handler = verbs[String(fn || '')]
  if (!handler) return { ok: false, code: 'unknown_verb', error: `Unknown verb "${fn}".` }

  const workspaceId = args?.workspace
  if (!workspaceId) {
    return { ok: false, code: 'invalid', error: 'A workspace id is required.' }
  }

  let record
  try {
    record = workspaces.open(String(workspaceId))
  } catch (error) {
    return { ok: false, code: 'not_found', error: String(error?.message || error) }
  }

  try {
    const { workspace: _ignored, ...rest } = args
    /* verbs are positional in the contract, so the CLI and any future transport
       must pass the same argument names; this keeps `call` honest about it */
    const positional = POSITIONAL[fn] || []
    const values = positional.map((key) => (key in rest ? rest[key] : undefined))
    return { ok: true, data: handler(record, ...values) }
  } catch (error) {
    const code = error instanceof PlatformError ? error.code : 'error'
    return { ok: false, code, error: String(error?.message || error) }
  }
}

/** Named arguments in the order each verb expects them after `record`. */
const POSITIONAL = {
  'entity.get': ['name'],
  'entity.setInstructions': ['name', 'body', 'expect'],
  'entity.setFields': ['name', 'patch'],
  'mcp.add': ['name', 'spec'],
  'mcp.remove': ['name'],
  'skill.attach': ['name', 'harness'],
  'skill.detach': ['name'],
  'workspace.setContext': ['context'],
}

function verbsList() {
  return Object.keys(verbs).sort()
}

module.exports = {
  PlatformError,
  call,
  verbsList,
  within,
  POSITIONAL,
}
