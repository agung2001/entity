/**
 * Connectors: one list, three kinds, two scopes.
 *
 * Before this file there were three places to look for "can this workspace reach
 * that service": `~/.entity/integrations.json` (machine-wide switches), the
 * workspace's `mcp.json` (the runtime binding a harness is given) and the harness
 * config files on this machine (`mcp-store`'s 13 sources). One page, three names,
 * and the scope was never stated — which is exactly how a definition people
 * believe they shared turns out to be one laptop's.
 *
 * So this module does not add a fourth store. It **merges** the three into rows
 * that all carry a `scope`, and it writes back through the store that already
 * owns each field:
 *
 *   - a **workspace** connector's definition is the workspace's; it syncs, and
 *     `mcp.json` stays the binding (never renamed, never moved — it is a runtime
 *     contract, not a settings file).
 *   - a **machine** connector is read from a harness file and can only be copied
 *     *into* the workspace. It is machine-owned and read-only here by design.
 *   - a server in the pool with no connector row is `unmanaged`: shown, not
 *     hidden, because that is where a token lives (plan §2.3).
 *
 * `connectors.json` is the index (id, label, kind, scope, mention) — definitions
 * only, no secret ever. The binding stays in `mcp.json` and the token in the
 * CLI's own store, so nothing here can leak a credential by being read.
 */
const fs = require('node:fs')
const path = require('node:path')
const workspaces = require('./workspace-store.cjs')
const mcpStore = require('./mcp-store.cjs')
const integrations = require('./integrations-store.cjs')
const { tilde } = require('./frontmatter.cjs')

const FILE = 'connectors.json'
const SCHEMA = 1

/* The initial a row wears, from its own label — one glyph, never a product logo. */
const initialOf = (label) => {
  const first = String(label || '').replace(/[^A-Za-z0-9]/g, '')[0]
  return first ? first.toUpperCase() : '·'
}
const text = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

function fileOf(record) {
  return path.join(record.path, FILE)
}

/** Missing file reads as an empty index: a workspace that never adopted anything
 *  simply has no rows of its own, which is not an error. */
function readIndex(record) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(record), 'utf8'))
    const rows = raw?.rows && typeof raw.rows === 'object' ? raw.rows : {}
    return { schema: SCHEMA, rows }
  } catch {
    return { schema: SCHEMA, rows: {} }
  }
}

function writeIndex(record, index) {
  const body = `${JSON.stringify({ schema: SCHEMA, rows: index.rows || {} }, null, 2)}\n`
  const staged = `${fileOf(record)}.${process.pid}.tmp`
  fs.writeFileSync(staged, body, 'utf8')
  fs.renameSync(staged, fileOf(record))
}

/* ── the rows ──────────────────────────────────────────────────────── */

/** The three services the composer already offers, as rows of their own. */
function integrationRows(workspace) {
  return (integrations.IDS || []).map((id) => {
    const kind = id === 'youtrack' ? 'mcp' : 'cli'
    const label = { orca: 'Orca', youtrack: 'YouTrack', github: 'GitHub CLI' }[id] || id
    return {
      id,
      label,
      initial: initialOf(label),
      kind,
      scope: 'workspace',
      /* The definition travels; the credential does not. YouTrack's token lives in
         this workspace's `mcp.json`, a CLI's in its own store on this machine. */
      binding: kind === 'mcp' ? 'mcp.json' : 'the CLI on this machine',
      mention: `@${id}:`,
      status: 'not probed',
      statusDetail: '',
      managed: true,
      unmanaged: false,
      editable: true,
    }
  })
}

function poolRows(record, index) {
  let pool = { servers: {}, disabled: {} }
  try {
    pool = workspaces.mcp(record.id)
  } catch {
    pool = { servers: {}, disabled: {} }
  }
  const enabled = pool.servers || {}
  const parked = pool.disabled || {}
  const rows = []
  for (const [name, definition] of [...Object.entries(enabled), ...Object.entries(parked)]) {
    const adopted = index.rows[name]
    const isParked = Boolean(parked[name])
    rows.push({
      id: name,
      label: adopted?.label || name,
      initial: initialOf(adopted?.label || name),
      kind: 'mcp',
      scope: 'workspace',
      binding: 'mcp.json',
      mention: adopted?.mention || '',
      status: isParked ? 'parked' : 'in the pool',
      statusDetail: String(definition?.url || definition?.command || ''),
      /* No connector row means no definition this page wrote: it arrived by a
         teammate's sync, an older add path or a harness attach. Shown, adoptable,
         never silently dropped. */
      managed: Boolean(adopted),
      unmanaged: !adopted,
      editable: Boolean(adopted),
    })
  }
  return rows
}

function machineRows() {
  let globals = { groups: [] }
  try {
    globals = mcpStore.globals()
  } catch {
    globals = { groups: [] }
  }
  const seen = new Set()
  const rows = []
  for (const group of globals.groups || []) {
    for (const server of group.servers || []) {
      const alias = `${group.harness}/${server.name}`
      if (seen.has(alias)) continue
      seen.add(alias)
      const file = String(server.configPath || group.files?.[0]?.path || '')
      rows.push({
        id: alias,
        label: server.name,
        initial: initialOf(server.name),
        kind: 'mcp',
        scope: 'machine',
        binding: file,
        mention: '',
        status: 'found',
        statusDetail: `${group.label} · ${tilde(file)}`,
        /* Machine rows are another application's configuration: this page may
           copy one into the workspace and may not edit it in place. */
        managed: false,
        unmanaged: false,
        editable: false,
      })
    }
  }
  return rows
}

/**
 * Everything one page draws, in one call.
 *
 * `counts` are the filter segment's numbers and they are computed here, from the
 * same rows — a segment that recounts in the view is a segment that can disagree
 * with the list under it.
 */
function list({ workspace } = {}) {
  const record = workspaces.open(workspace)
  const index = readIndex(record)
  let rows = []
  try {
    rows = integrationRows(workspace)
  } catch {
    rows = []
  }
  const pool = poolRows(record, index)
  /* A pool server named like an integration row (a YouTrack binding is exactly
     that) is the same connector: one row, the pool's own binding as its detail. */
  const merged = rows.map((row) => {
    const twin = pool.find((entry) => entry.id === row.id)
    return twin
      ? { ...row, binding: twin.binding, statusDetail: twin.statusDetail, status: twin.status }
      : row
  })
  const extras = pool.filter((entry) => !merged.some((row) => row.id === entry.id))
  const all = [...merged, ...extras, ...machineRows()]
  const counts = {
    workspace: all.filter((row) => row.scope === 'workspace').length,
    machine: all.filter((row) => row.scope === 'machine').length,
  }
  return {
    rows: all,
    counts,
    unmanaged: all.filter((row) => row.unmanaged).length,
    path: tilde(fileOf(record)),
    poolPath: tilde(path.join(record.path, 'mcp.json')),
    /* Stated once, on the page, rather than only in a document. */
    note: 'definitions travel with the workspace; tokens stay on this machine.',
  }
}

/* ── writing ───────────────────────────────────────────────────────── */

/** The definition a harness file describes, in the pool's own shape. */
function definitionOf(server) {
  if (!server) return null
  const value = {}
  if (server.url) value.url = String(server.url)
  if (server.command) value.command = String(server.command)
  if (Array.isArray(server.args) && server.args.length) value.args = server.args.map(String)
  const env = server.env
  if (Array.isArray(env) && env.length) value.env = { ...Object.fromEntries(env.map((key) => [String(key), ''])) }
  else if (env && typeof env === 'object' && Object.keys(env).length) value.env = { ...env }
  if (server.headers && typeof server.headers === 'object' && Object.keys(server.headers).length) {
    value.headers = { ...server.headers }
  }
  if (!value.url && !value.command) return null
  return value
}

/** Every write goes through the store that owns the field, then re-reads. */
function add({ workspace, id, label, kind, scope } = {}) {
  const record = workspaces.open(workspace)
  const name = text(id || label, 60).replace(/[^A-Za-z0-9._-]+/g, '-')
  if (!name) throw new Error('A connector needs a name.')
  const index = readIndex(record)
  index.rows = {
    ...index.rows,
    [name]: {
      label: text(label, 80) || name,
      kind: ['mcp', 'cli', 'rest'].includes(kind) ? kind : 'mcp',
      scope: 'workspace',
      mention: `@${name}:`,
      createdAt: new Date().toISOString(),
      /* A row a page creates is a definition; a secret is never part of it. */
      adoptedFrom: scope === 'machine' ? 'machine' : '',
    },
  }
  writeIndex(record, index)
  return list({ workspace })
}

/** `Adopt`: an unmanaged pool server becomes a connector row. The binding and its
 *  token stay exactly where they are — this writes the index entry only. */
function adopt({ workspace, id } = {}) {
  const record = workspaces.open(workspace)
  const name = text(id, 60)
  if (!name) throw new Error('Which server should be adopted?')
  const index = readIndex(record)
  if (index.rows[name]) return list({ workspace })
  index.rows = {
    ...index.rows,
    [name]: {
      label: name,
      kind: 'mcp',
      scope: 'workspace',
      mention: `@${name}:`,
      createdAt: new Date().toISOString(),
      adoptedFrom: 'pool',
    },
  }
  writeIndex(record, index)
  return list({ workspace })
}

/**
 * `Copy here`: one machine connector's definition becomes this workspace's.
 *
 * An explicit copy, never a link, so the page can say which one a pass will use.
 * Credentials do not travel — the copied definition keeps whatever literal its
 * own file had, and a `${VAR}` reference stays a reference the runtime expands on
 * the machine that runs it. Nothing is written when the copy would overwrite an
 * existing server of the same name.
 */
function copyFromMachine({ workspace, id } = {}) {
  const record = workspaces.open(workspace)
  const alias = text(id, 120)
  const [harness, name] = alias.includes('/') ? alias.split('/') : ['', alias]
  if (!name) throw new Error('Which server should be copied?')
  let found = null
  try {
    for (const group of mcpStore.globals().groups || []) {
      if (harness && group.harness !== harness) continue
      found = (group.servers || []).find((server) => server.name === name) || found
    }
  } catch {
    found = null
  }
  if (!found) throw new Error(`No MCP server called "${name}" on this machine any more.`)
  const pool = workspaces.mcp(record.id)
  if (pool.servers?.[name] || pool.disabled?.[name]) {
    throw new Error(`This workspace already has a server called "${name}". Rename one of them first.`)
  }
  /* One shape, the renderer's (`src/lib/mcp.js` `definitionOf`): a harness file
     hands back flat fields (`name`, `command`, `args`, `env`, `url`, `headers`)
     and the pool stores a definition. Copying the whole object would write
     bookkeeping (`configPath`, `harnessLabel`) into `mcp.json`. */
  const definition = definitionOf(found)
  if (!definition) throw new Error(`"${name}" has neither a command nor a URL on this machine.`)
  workspaces.writeMcp({
    id: record.id,
    servers: { ...(pool.servers || {}), [name]: definition },
    disabled: pool.disabled || {},
  })
  return adopt({ workspace, id: name })
}

/** `Remove`: the index row and, for a workspace connector, its binding. */
function remove({ workspace, id } = {}) {
  const record = workspaces.open(workspace)
  const name = text(id, 60)
  if (!name) throw new Error('Which connector should be removed?')
  const index = readIndex(record)
  const row = index.rows[name] || null
  if (!row) {
    /* A machine row is another app's file: this page may not delete it. */
    throw new Error('That connector is not this workspace\'s to remove.')
  }
  const nextRows = { ...index.rows }
  delete nextRows[name]
  index.rows = nextRows
  writeIndex(record, index)
  const pool = workspaces.mcp(record.id)
  if (row.kind === 'mcp' && pool.servers?.[name]) {
    const servers = { ...(pool.servers || {}) }
    delete servers[name]
    workspaces.writeMcp({ id: record.id, servers, disabled: pool.disabled || {} })
  }
  return list({ workspace })
}

module.exports = {
  FILE,
  SCHEMA,
  initialOf,
  definitionOf,
  readIndex,
  list,
  add,
  adopt,
  copyFromMachine,
  remove,
}
