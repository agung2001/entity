/**
 * Connectors: one list, four kinds, two scopes.
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
const catalog = require('./connector-catalog.cjs')
const integrations = require('./integrations-store.cjs')
const manifest = require('./remote-manifest.cjs')
const { tilde } = require('./frontmatter.cjs')

const FILE = 'connectors.json'
const SCHEMA = 1

/**
 * Where a connector's credential lives, in the one sentence every surface prints.
 *
 * One rule, used by `add()` and `install()`: an `mcp` row's binding is the pool
 * file, an account-bearing row's is a consent round-trip, and everything else is
 * the binary on this machine. Written down once so the index and the page cannot
 * disagree — the earlier version wrote the CLI sentence onto every non-mcp row and
 * made the renderer compensate.
 */
const bindingFor = ({ kind, oauth, credential, url }) =>
  kind === 'rss'
    ? text(url, 400) || 'a URL, in this workspace'
    : kind === 'mcp'
      ? 'mcp.json'
      : credential === 'token'
        ? 'a token on this machine'
        : oauth === true
          ? 'oauth · loopback redirect'
          : 'the CLI on this machine'

/* The initial a row wears, from its own label — one glyph, never a product logo. */
const initialOf = (label) => {
  const first = String(label || '').replace(/[^A-Za-z0-9]/g, '')[0]
  return first ? first.toUpperCase() : '·'
}
const text = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

/**
 * `{ argv, okExit }` or null. An argv is what actually runs; anything else is
 * dropped rather than stored as a promise the probe cannot keep.
 */
function normaliseVerify(raw) {
  if (!raw || typeof raw !== 'object') return null
  const argv = Array.isArray(raw.argv)
    ? raw.argv.map((value) => text(value, 120)).filter(Boolean)
    : String(raw.argv || '')
        .split(/\s+/)
        .map((value) => text(value, 120))
        .filter(Boolean)
  if (!argv.length) return null
  const okExit = Number.isFinite(Number(raw.okExit)) ? Number(raw.okExit) : 0
  return { argv, okExit }
}

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
      /* The three the app ships with: they are a definition Entity owns, and the
         row wears their own brand mark. A custom connector has none. */
      builtIn: id,
      kind,
      scope: 'workspace',
      /* The definition travels; the credential does not. YouTrack's token lives in
         this workspace's `mcp.json`, a CLI's in its own store on this machine. */
      binding: kind === 'mcp' ? 'mcp.json' : 'the CLI on this machine',
      mention: catalog.mentionOf(id) || '',
      /* The shipped contract: what this mention produces, and which resolver
         answers it. `null` for a connector nobody ships a resolver for. */
      work: catalog.workOf(id),
      website: catalog.websiteOf(id),
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
    const shipped = catalog.entryOf(name)
    const isParked = Boolean(parked[name])
    /* A loopback URL or a home-directory command answers on this computer only.
       The definition still belongs to the workspace (and travels), so scope stays
       `workspace`; this is the separate fact a person needs before they expect it
       in a remote thread. A server parked *by a sync* already carries the note. */
    const machine = manifest.machineBoundReason(definition)
    rows.push({
      id: name,
      label: adopted?.label || shipped?.label || name,
      initial: initialOf(adopted?.label || shipped?.label || name),
      /* A pool server whose name the catalog ships *is* a built-in: the definition
         in `mcp.json` is its binding, not a row somebody still has to adopt. That
         is what lets it wear its mark and state its origin like Gmail or Drive. */
      builtIn: shipped ? name : '',
      kind: 'mcp',
      scope: 'workspace',
      binding: 'mcp.json',
      mention: adopted?.mention || shipped?.work?.mention || '',
      work: catalog.workOf(name) || null,
      website: catalog.websiteOf(name),
      status: isParked ? 'parked' : 'in the pool',
      statusDetail: String(definition?.url || definition?.command || ''),
      machineLocal: machine,
      machineNote: isParked
        ? String(definition?.__unavailable || '')
        : machine === 'loopback'
          ? 'it only answers on this computer'
          : 'its command lives on this computer',
      /* No connector row *and* no catalog entry means no definition this page
         wrote: it arrived by a teammate's sync, an older add path or a harness
         attach. Shown, adoptable, never silently dropped. */
      managed: Boolean(adopted) || Boolean(shipped),
      unmanaged: !adopted && !shipped,
      editable: true,
    })
  }
  return rows
}

/**
 * One row per server *name*, with every harness that declares it.
 *
 * Three harness files declaring `cua` is one server available in three places,
 * not three servers: the old list showed 13 rows for 8 names and read as
 * duplication. The evidence is kept — `sources` names each file and harness — so
 * `Copy here` copies one definition and the row still says where it came from.
 */
function machineRows() {
  let globals = { groups: [] }
  try {
    globals = mcpStore.globals()
  } catch {
    globals = { groups: [] }
  }
  const byName = new Map()
  for (const group of globals.groups || []) {
    for (const server of group.servers || []) {
      const name = String(server.name || '').trim()
      if (!name) continue
      const file = String(server.configPath || group.files?.[0]?.path || '')
      const hit = byName.get(name)
      const source = {
        harness: group.harness,
        label: group.label,
        file: tilde(file),
        definition: server.definition || null,
      }
      if (hit) {
        /* the same server in a second harness file: keep the first definition
           (they are the same command) and record the additional source */
        if (!hit.sources.some((entry) => entry.file === source.file)) hit.sources.push(source)
        continue
      }
      byName.set(name, {
        id: name,
        label: name,
        initial: initialOf(name),
        builtIn: '',
        kind: 'mcp',
        scope: 'machine',
        binding: file,
        mention: '',
        work: null,
        status: 'found',
        statusDetail: `${group.label} · ${tilde(file)}`,
        /* every harness that declares it, so one row can show three marks */
        sources: [source],
        /* Machine rows are another application's configuration: this page may
           copy one into the workspace and may not edit it in place. */
        managed: false,
        unmanaged: false,
        editable: false,
      })
    }
  }
  return [...byName.values()].sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * Is this connector installed in this workspace?
 *
 * `connectors.json` is the record. But a workspace can hold a working `mcp.json`
 * entry that no index row ever claimed — a teammate's sync, the older add path, a
 * harness attach — and it may be the *only* place a token lives. So the rule is
 * additive, never subtractive:
 *
 *   - an index row installs a connector;
 *   - a definition in `mcp.json` counts as installed even with no row (backfilled
 *     on the next write), so nothing that runs can vanish from the list;
 *   - a catalog entry with neither is **available, not installed**.
 *
 * Without the middle clause this change would make six live servers disappear
 * from a real workspace on the first read.
 */
function installedIds(index, pool) {
  const out = new Set(Object.keys(index.rows || {}))
  for (const name of Object.keys(pool.servers || {})) out.add(name)
  for (const name of Object.keys(pool.disabled || {})) out.add(name)
  return out
}

function list({ workspace } = {}) {
  const record = workspaces.open(workspace)
  const index = readIndex(record)
  let pool = { servers: {}, disabled: {} }
  try {
    pool = workspaces.mcp(record.id)
  } catch {
    pool = { servers: {}, disabled: {} }
  }
  const installed = installedIds(index, pool)

  /* Installed: the catalog's entries where they are installed, plus anything the
     pool holds that no index row claims. A catalog entry is not a row until it is
     installed — that is what the Built-in tab offers. */
  const rows = integrationRows(workspace).filter((row) => installed.has(row.id))
  const poolOnly = poolRows(record, index)

  /* A pool server named like an installed integration row (a YouTrack binding is
     exactly that) is one connector: the pool's own binding becomes its detail. */
  const merged = rows.map((row) => {
    const twin = poolOnly.find((entry) => entry.id === row.id)
    return twin
      ? {
          ...row,
          binding: twin.binding,
          statusDetail: twin.statusDetail,
          status: twin.status,
          machineLocal: twin.machineLocal,
          machineNote: twin.machineNote,
          website: twin.website || row.website,
        }
      : row
  })
  const extras = poolOnly.filter((entry) => !merged.some((row) => row.id === entry.id))

  /* A connector a person added that the catalogue does not ship: its row comes
     from the index alone. Without this, `add()` wrote a row nobody rendered — the
     roster only ever listed catalogue entries and pool servers. */
  const known = new Set([...merged, ...extras].map((row) => row.id))
  const custom = Object.entries(index.rows || {})
    .filter(
      ([id, entry]) =>
        !known.has(id) && (entry.kind === 'cli' || entry.kind === 'rest' || entry.kind === 'rss'),
    )
    .map(([id, entry]) => ({
      id,
      label: entry.label || id,
      initial: initialOf(entry.label || id),
      /* Provenance: a row this index says came from the catalog *is* a built-in,
         and the page says so. Anything else stays a row a person added. */
      builtIn: entry.installedFrom === 'catalog' && catalog.entryOf(id) ? id : '',
      kind: entry.kind,
      scope: 'workspace',
      /* The address an `rss` row was added with — the one kind whose binding is
         its own URL, printed by the pages that read it (`news-store`). */
      url: entry.url || '',
      binding:
        entry.binding ||
        bindingFor({
          kind: entry.kind,
          oauth: entry.oauth === true,
          credential: catalog.entryOf(id)?.credential,
          url: entry.url,
        }),
      /* The shipped syntax, from the catalog — an installed row offers its mention
         exactly when a resolver exists for it. */
      mention: catalog.mentionOf(id) || entry.mention || '',
      summary: catalog.entryOf(id)?.summary || '',
      work: catalog.workOf(id),
      website: catalog.websiteOf(id),
      /* Where this row's credential lives, in the same word the catalog uses —
         `token` for a paste-once API key. Without it an *installed* row and the
         catalog row it came from disagreed about which verbs the page offers:
         the row that can actually save a key was the one that could not name it. */
      credential: catalog.entryOf(id)?.credential || '',
      /* A declared self-report is what makes it answerable at all. */
      binary: entry.binary || '',
      verify: entry.verify || null,
      /* An index row that says `oauth` is the flag the roster reads; anything
         else is a token row and stays absent, never `false`-shaped. */
      oauth: entry.oauth === true,
      tier: entry.tier || '',
      status: entry.kind === 'rss' ? 'installed' : 'not probed',
      /* An account-bearing row has no self-report to declare; its status line is
         the account count, which the renderer fills from the account store. A
         token row says which check it runs, or that it has none. A feed has no
         check at all — it is read by News, not probed here. */
      statusDetail:
        entry.kind === 'rss'
          ? 'a feed URL · read by News'
          : entry.oauth === true
            ? 'no account connected'
            : entry.verify
              ? `${entry.binary || id} ${entry.verify.argv.join(' ')}`
              : 'no verify command',
      managed: true,
      unmanaged: false,
      editable: true,
    }))
  const workspaceRows = [...merged, ...custom, ...extras]

  /* Catalog entries installed nowhere in this workspace: read-only, one verb. */
  const available = catalog
    .INSTALLABLE.filter((id) => !installed.has(id))
    .map((id) => {
      const entry = catalog.entryOf(id)
      return {
        id,
        label: entry.label,
        initial: initialOf(entry.label),
        builtIn: id,
        kind: entry.kind,
        scope: 'workspace',
        /* a catalog entry that carries accounts says so, so the Built-in row can
           brand it and land on the page the same way the sheet's card does */
        oauth: entry.oauth === true,
        credential: entry.credential || '',
        /* The catalog's one-line pitch. Without it the page a person reaches
           *before* installing had only a binding sentence to introduce it, which
           is the one thing they have not decided on yet. */
        summary: entry.summary || '',
        /* The provider a not-yet-installed entry signs in with, and the launcher a
           shipped MCP entry would write. Both are already catalog data; the detail
           page needs them to describe the entry *before* installing it, and the
           renderer must not re-derive either from an id. */
        provider: entry.provider || '',
        launcher: entry.launcher || '',
        binding: bindingFor({
          kind: entry.kind,
          oauth: entry.oauth === true,
          credential: entry.credential,
          /* A feed's binding *is* its address: the pitch should name the URL it
             would install rather than promise “a URL, in this workspace”. */
          url: entry.url,
        }),
        mention: catalog.mentionOf(id) || '',
        work: catalog.workOf(id),
        website: catalog.websiteOf(id),
        status: 'not installed',
        statusDetail: entry.work?.needs || entry.summary || '',
        managed: false,
        unmanaged: false,
        installed: false,
        available: true,
        editable: false,
      }
    })

  const machine = machineRows()
  return {
    rows: workspaceRows,
    available,
    machine,
    counts: {
      workspace: workspaceRows.length,
      machine: machine.length,
      available: available.length,
    },
    unmanaged: workspaceRows.filter((row) => row.unmanaged).length,
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
/**
 * One connector, added by a person.
 *
 * `verify` is stored, not guessed: a `cli` row's honesty is that it can say *why*
 * it is not ready, and only the person knows what its self-report is (`gh auth
 * status` is right for one binary and wrong for the next). Shape:
 * `{ argv: ['auth', 'status'], okExit: 0 }` — an argv and the exit code that means
 * "usable", nothing more. A row without one is `not verified`, never `found`.
 */
function add({ workspace, id, label, kind, scope, command, url, args, env, verify, binary, oauth, tier } = {}) {
  const record = workspaces.open(workspace)
  const name = text(id || label, 60).replace(/[^A-Za-z0-9._-]+/g, '-')
  if (!name) throw new Error('A connector needs a name.')
  /* An `rss` connector is a URL and nothing else: no binary to probe, no server
     to bind, no account to consent. The scheme is checked at this one door
     because a URL is all a feed is, and `news-store` refuses anything else to
     fetch — a `file://` row here would be a promise that store cannot keep. */
  if (kind === 'rss') {
    const feed = text(url, 400)
    if (!feed) throw new Error('An RSS connector needs a URL — that is the whole feed.')
    if (!/^https?:\/\//i.test(feed)) {
      throw new Error('An RSS connector needs an http or https URL — that is the only scheme it reads.')
    }
  }
  /* An `mcp` connector is a *pointer* into `mcp.json`, so the binding is written
     first and the index second (plan §2.3) — an index row without a definition is
     a row the runtime cannot resolve. `validServer` rejects a definition with
     neither a command nor a URL, which is the check that keeps that true. */
  if (kind === 'mcp') {
    const definition = {}
    if (text(url, 400)) definition.url = text(url, 400)
    if (text(command, 200)) definition.command = text(command, 200)
    const list = Array.isArray(args)
      ? args.map((value) => text(value, 200)).filter(Boolean)
      : String(args || '').split('\n').map((value) => text(value, 200)).filter(Boolean)
    if (list.length) definition.args = list
    const names = Array.isArray(env)
      ? env.map((value) => text(value, 80)).filter(Boolean)
      : String(env || '').split(',').map((value) => text(value, 80)).filter(Boolean)
    if (names.length) definition.env = names
    if (!definition.url && !definition.command) {
      throw new Error('An MCP connector needs a command or a URL — that is what the harness runs.')
    }
    const pool = workspaces.mcp(record.id)
    if (pool.servers?.[name] || pool.disabled?.[name]) {
      throw new Error(`This workspace already has a server called "${name}".`)
    }
    workspaces.writeMcp({
      id: record.id,
      servers: { ...(pool.servers || {}), [name]: definition },
      disabled: pool.disabled || {},
    })
  }
  const index = readIndex(record)
  index.rows = {
    ...index.rows,
    [name]: {
      label: text(label, 80) || name,
      kind: ['mcp', 'cli', 'rest', 'rss'].includes(kind) ? kind : 'mcp',
      scope: 'workspace',
      /* A mention is offered only where a resolver exists, and nothing ships one
         for a name a person just typed — so a custom connector carries no syntax
         instead of promising an `@id:` that resolves to silence. */
      mention: '',
      createdAt: new Date().toISOString(),
      /* A row a page creates is a definition; a secret is never part of it. */
      adoptedFrom: scope === 'machine' ? 'machine' : '',
      binding: bindingFor({ kind, oauth, url }),
      /* The feed's address, for the one kind whose binding *is* its address. */
      url: kind === 'rss' ? text(url, 400) : '',
      /* Only a `cli` row has a self-report to declare. */
      binary: kind === 'cli' ? text(binary, 120) : '',
      verify: kind === 'cli' ? normaliseVerify(verify) : null,
      /* An account-bearing connector is a `rest` row whose credential is a
         refresh token, one per account, on this machine. The flag is what the
         roster and the page switch on; it is not a secret and nothing else
         about the row changes. */
      oauth: oauth === true,
      /* How much the accounts of this connector may do. Per workspace on purpose:
         one workspace may want to send mail and another may not. */
      tier: text(tier, 20) || '',
    },
  }
  writeIndex(record, index)
  return list({ workspace })
}

/**
 * Install a catalog entry into this workspace.
 *
 * A definition, never a credential: the index row records the intent, and a `cli`
 * row is done there (the binary and its sign-in are this machine's). An `mcp` entry
 * writes a *placeholder* binding only when the workspace has none — the real one
 * arrives from the docs page or a harness file, and installing must not invent a
 * URL. `verify` is what turns the row from `not probed` into `found`.
 */
function install({ workspace, id } = {}) {
  const record = workspaces.open(workspace)
  const name = text(id, 60)
  const entry = catalog.entryOf(name)
  if (!entry) throw new Error(`No built-in connector called "${name}".`)
  const index = readIndex(record)
  if (index.rows[name]) return list({ workspace })
  /* An `mcp` entry that ships a `launcher` is a workspace-owned program: installing
     it writes the pool definition, because the workspace is where that program
     lives. The path is workspace-relative — `skills/**` syncs, so a definition
     written this way works on the second machine too, and the id comes from the
     record rather than a home directory. Nothing else is invented. */
  const launcher = entry.kind === 'mcp' ? text(entry.launcher, 200) : ''
  if (launcher) {
    const pool = workspaces.mcp(record.id)
    if (!pool.servers?.[name] && !pool.disabled?.[name]) {
      workspaces.writeMcp({
        id: record.id,
        servers: {
          ...(pool.servers || {}),
          [name]: { command: `$HOME/.entity/workspaces/${record.id}/skills/${launcher}` },
        },
        disabled: pool.disabled || {},
      })
    }
  }
  index.rows = {
    ...index.rows,
    [name]: {
      label: entry.label,
      kind: entry.kind,
      scope: 'workspace',
      /* installing an account-bearing connector installs the connector, not an
         account: the row lands with 0 accounts and the page's empty state */
      oauth: entry.oauth === true,
      tier: '',
      /* A feed's address travels with the row: it *is* the connector, and the page
         that reads it (`news-store`) opens the row and finds nothing else. Without
         this, installing a shipped feed wrote a row with no URL — a feed the roster
         listed and the reader skipped. */
      url: entry.kind === 'rss' ? text(entry.url, 400) : '',
      binding: bindingFor({
        kind: entry.kind,
        oauth: entry.oauth === true,
        credential: entry.credential,
        url: entry.url,
      }),
      mention: entry.work?.mention || '',
      createdAt: new Date().toISOString(),
      installedFrom: 'catalog',
    },
  }
  writeIndex(record, index)
  return list({ workspace })
}

/**
 * Uninstall: remove the connector from *this workspace*.
 *
 * The definition goes; a credential does not. A `cli` row's sign-in belongs to the
 * CLI, and an `mcp` row's headers belong to `mcp.json` — which this removes with
 * the binding, because a binding nobody points at is the drift the `unmanaged`
 * state exists to report. The catalog entry returns to the Built-in tab.
 */
function uninstall({ workspace, id } = {}) {
  const record = workspaces.open(workspace)
  const name = text(id, 60)
  if (!name) throw new Error('Which connector should be uninstalled?')
  const index = readIndex(record)
  const row = index.rows[name] || null
  const pool = workspaces.mcp(record.id)
  const binding = Boolean(pool.servers?.[name] || pool.disabled?.[name])
  /* A shipped connector whose binding arrived through `mcp.json` has no index row
     to delete — the pool entry *is* the installation. Without this, the built-in
     row offered `Uninstall` and then refused because `connectors.json` had never
     heard of it. */
  if (!row && !(catalog.entryOf(name) && binding)) {
    throw new Error('That connector is not installed in this workspace.')
  }
  if (row) {
    const next = { ...index.rows }
    delete next[name]
    index.rows = next
    writeIndex(record, index)
  }
  if (binding) {
    const servers = { ...(pool.servers || {}) }
    const disabled = { ...(pool.disabled || {}) }
    delete servers[name]
    delete disabled[name]
    workspaces.writeMcp({ id: record.id, servers, disabled })
  }
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

/**
 * Choose how much one connector's accounts may do.
 *
 * The tier belongs to the connector *in this workspace*, so it is written on the
 * index row: two workspaces can ask the same mailbox for different access, and a
 * person who lowers it to `read` sees that in the card before the next consent.
 * Changing it does not touch a token — the next `Connect`/`Re-consent` asks for
 * the new scope set, and an existing account keeps what it already has until it
 * is re-consented.
 */
function setTier({ workspace, id, tier } = {}) {
  const record = workspaces.open(workspace)
  const name = text(id, 60)
  const next = text(tier, 20)
  if (!name) throw new Error('Which connector should change its access?')
  const index = readIndex(record)
  if (!index.rows[name]) throw new Error('That connector is not installed in this workspace.')
  index.rows = { ...index.rows, [name]: { ...index.rows[name], tier: next } }
  writeIndex(record, index)
  return list({ workspace })
}

/**
 * A connector's **workspace** state: the settings that are not a secret and are not
 * one person's account.
 *
 * Clockify is the first user — its workspace id, IANA timezone and member map belong
 * to the workspace the report is about, so they travel with it under `fields` on the
 * connector's own index row. Nothing in here is a credential, which is why it is a
 * plain read and a plain write with no vault involved.
 *
 * Lynk.id is the second, and it is the same shape one folder deep: which Drive folder
 * the report is read from, what the tab under each product spreadsheet is called, and
 * nothing else. A folder id is not a secret either, but it is emphatically not a
 * constant — one workspace's folder must never serve another's numbers, so it is
 * stored here and folded into the report's cache key.
 */
const FIELD_LIMITS = {
  workspaceId: 60,
  timezone: 60,
  /* Drive ids are base64url-ish: letters, digits, `-` and `_`, no spaces. */
  folderId: 120,
  folderName: 120,
  sheetSuffix: 40,
}

/** The default tab name under a Lynk.id product spreadsheet. */
const DEFAULT_SHEET_SUFFIX = ' - Transactions'

/**
 * How many items one feed may contribute to a read.
 *
 * `ponytail:` one ceiling **per feed**, not per tab or per page: an aggregator that
 * returns 300 items is one row on General, and the number that stops it is the
 * feed's own, so a person can raise the one feed they care about without lifting
 * every other feed's ceiling with it. 500 is the top because a page paginates at
 * 25 and a feed is not a corpus.
 */
const DEFAULT_ITEM_LIMIT = 100
const ITEM_LIMIT_MAX = 500

/**
 * A feed's ceiling, or the default.
 *
 * Read-side, like `folderIdOf`: a stored value that is not an integer in range is
 * dropped here rather than refused, because `fieldsOf` answers a page and a page
 * that cannot read its own limit should show the default, not fail to render. The
 * refusal belongs to `setFields`, which is the moment somebody can still fix it.
 */
function itemLimitOf(row) {
  const raw = Number(row?.fields?.itemLimit)
  if (!Number.isInteger(raw) || raw < 1 || raw > ITEM_LIMIT_MAX) return DEFAULT_ITEM_LIMIT
  return raw
}

/** A Drive folder id, or '' — the shape check `folderId` fields are saved under. */
const folderIdOf = (value) => {
  const id = text(value, FIELD_LIMITS.folderId)
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : ''
}

function fieldsOf({ workspace, id } = {}) {
  const record = workspaces.open(workspace)
  const name = text(id, 60)
  const row = readIndex(record).rows[name] || {}
  const raw = row.fields && typeof row.fields === 'object' ? row.fields : {}
  const members = {}
  if (raw.members && typeof raw.members === 'object') {
    for (const [login, userId] of Object.entries(raw.members)) {
      const key = text(login, 40)
      const value = text(userId, 60)
      if (key && value) members[key] = value
    }
  }
  return {
    workspaceId: text(raw.workspaceId, FIELD_LIMITS.workspaceId),
    timezone: text(raw.timezone, FIELD_LIMITS.timezone),
    members,
    /* A folder id that is not shaped like one is dropped here rather than refused:
       `fieldsOf` answers a page, and a page that cannot read its own folder should
       say “no folder”, not fail to render. `setFields` is where a bad one is an
       error, because that is the moment a person can still fix it. */
    folderId: folderIdOf(raw.folderId),
    folderName: text(raw.folderName, FIELD_LIMITS.folderName),
    sheetSuffix:
      raw.sheetSuffix === undefined ? DEFAULT_SHEET_SUFFIX : text(raw.sheetSuffix, FIELD_LIMITS.sheetSuffix),
    /* An `rss` row's own ceiling. Every row answers the key — the field bag is one
       shape for every connector — and only a feed ever reads it back. */
    itemLimit: itemLimitOf(row),
  }
}

/**
 * Save that state. A key this connector does not know is dropped rather than stored,
 * and an IANA timezone that `Intl` refuses is an error — a wrong zone makes every
 * week boundary wrong, and a silently-kept UTC would answer about the wrong week.
 */
function setFields({ workspace, id, fields } = {}) {
  const record = workspaces.open(workspace)
  const name = text(id, 60)
  if (!name) throw new Error('Which connector should store these fields?')
  const index = readIndex(record)
  if (!index.rows[name]) throw new Error('That connector is not installed in this workspace.')
  const incoming = fields && typeof fields === 'object' ? fields : {}
  const next = {}
  if (incoming.workspaceId !== undefined) next.workspaceId = text(incoming.workspaceId, FIELD_LIMITS.workspaceId)
  if (incoming.timezone !== undefined) {
    const zone = text(incoming.timezone, FIELD_LIMITS.timezone)
    if (zone) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone })
      } catch {
        throw new Error(`“${zone}” is not an IANA timezone, so it was not saved.`)
      }
    }
    next.timezone = zone
  }
  if (incoming.members !== undefined) {
    const members = {}
    if (incoming.members && typeof incoming.members === 'object') {
      for (const [login, userId] of Object.entries(incoming.members)) {
        const key = text(login, 40)
        const value = text(userId, 60)
        if (key && value) members[key] = value
      }
    }
    next.members = members
  }
  /* A folder id is refused when it is present and wrong — a silently truncated one
     would leave a row that looks configured and reads nothing. An empty string is how
     a page forgets the folder, so it is allowed through. */
  if (incoming.folderId !== undefined) {
    const folderId = text(incoming.folderId, FIELD_LIMITS.folderId)
    if (folderId && !/^[A-Za-z0-9_-]+$/.test(folderId)) {
      throw new Error('A Drive folder id is letters, digits, “-” and “_” only, so it was not saved.')
    }
    next.folderId = folderId
  }
  if (incoming.folderName !== undefined) next.folderName = text(incoming.folderName, FIELD_LIMITS.folderName)
  if (incoming.sheetSuffix !== undefined) {
    next.sheetSuffix = text(incoming.sheetSuffix, FIELD_LIMITS.sheetSuffix)
  }
  /* A feed's ceiling is refused when it is present and wrong, the way a folder id
     is: silently rounding 999 down to 500 would show a person a number they did not
     choose and then read by it. An empty field is `0`, which is not a ceiling. */
  if (incoming.itemLimit !== undefined) {
    const limit = Number(incoming.itemLimit)
    if (!Number.isInteger(limit) || limit < 1 || limit > ITEM_LIMIT_MAX) {
      throw new Error(`A feed carries between 1 and ${ITEM_LIMIT_MAX} items per read, so it was not saved.`)
    }
    next.itemLimit = limit
  }
  /* A feed's **address** is a row fact, not a field bag entry: `url` is what
     `news-store` opens the row and reads, and `binding` is what the Definition card
     prints — so both move together, in the same write the ceiling comes through.

     This is the door that makes a shipped feed a *shape* rather than one country:
     `?geo=US` is a different Trends feed, `/r/worldnews/` a different subreddit, and
     neither is a second catalog entry. The scheme is checked here for the same
     reason `add()` checks it: a `file://` row would be a promise `news-store`
     refuses to keep. */
  const rowPatch = {}
  if (incoming.url !== undefined) {
    if (index.rows[name].kind !== 'rss') throw new Error('Only a feed has an address to change.')
    const feed = text(incoming.url, 400)
    if (!/^https?:\/\//i.test(feed)) {
      throw new Error('A feed’s address has to be http or https — that is the only scheme News reads, so it was not saved.')
    }
    rowPatch.url = feed
    rowPatch.binding = feed
  }
  index.rows = {
    ...index.rows,
    [name]: {
      ...index.rows[name],
      ...rowPatch,
      fields: { ...fieldsOf({ workspace, id: name }), ...next },
    },
  }
  writeIndex(record, index)
  return fieldsOf({ workspace, id: name })
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

/**
 * Everything the composer may offer, in its own shape.
 *
 * Gated twice, and both gates are the point:
 *
 *   1. **a shipped resolver** — a mention with nothing behind it is worse than no
 *      mention, so a custom connector contributes no syntax;
 *   2. **installed in this workspace** — the catalog's entry for an uninstalled
 *      connector is a row in the Built-in tab, not a thing you can type. Without
 *      this the composer offered `@orca:` on a workspace that had uninstalled it.
 *
 * With no workspace the answer is the catalog alone: the call is also used where
 * there is no workspace in hand (a test, the palette), and "offered everywhere" is
 * a worse default than "offered where the catalog says it exists".
 */
function mentionKinds({ workspace } = {}) {
  const kinds = catalog.mentionKinds()
  if (!workspace) return kinds
  let installed = null
  try {
    const record = workspaces.open(workspace)
    const index = readIndex(record)
    let pool = { servers: {}, disabled: {} }
    try {
      pool = workspaces.mcp(record.id)
    } catch {
      pool = { servers: {}, disabled: {} }
    }
    installed = installedIds(index, pool)
  } catch {
    installed = null
  }
  if (!installed) return kinds
  /* internal parsers (`@artifact:`, `@thread:`) are not connectors and are never
     gated by installation — they name a workspace object, not a service. */
  return kinds.filter((entry) => !entry.builtIn || installed.has(entry.id))
}

/** Is this connector installed in this workspace? The one question the three gates share. */
function isInstalled({ workspace, id } = {}) {
  try {
    const record = workspaces.open(workspace)
    const index = readIndex(record)
    let pool = { servers: {}, disabled: {} }
    try {
      pool = workspaces.mcp(record.id)
    } catch {
      pool = { servers: {}, disabled: {} }
    }
    return installedIds(index, pool).has(String(id || ''))
  } catch {
    return false
  }
}

module.exports = {
  FILE,
  SCHEMA,
  mentionKinds,
  isInstalled,
  initialOf,
  definitionOf,
  readIndex,
  writeIndex,
  fieldsOf,
  setFields,
  itemLimitOf,
  DEFAULT_ITEM_LIMIT,
  ITEM_LIMIT_MAX,
  list,
  add,
  adopt,
  install,
  uninstall,
  copyFromMachine,
  remove,
  setTier,
}
