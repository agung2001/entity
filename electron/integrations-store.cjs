/**
 * Which third-party services the composer may mention, and what each one costs.
 *
 *   ~/.entity/integrations.json      { orca, youtrack, github } → { enabled }
 *   <workspace>/mcp.json             YouTrack's token — where the MCP runtime
 *                                    already reads it, not a second store
 *
 * The file shape is the opposite of `harness-store.cjs`: there a missing key
 * means *on*, because the file predates the preference and Entity needs one
 * harness to offer. Here a missing key means **off** — a service nobody asked
 * for is not offered, and installing the app never opts anyone in.
 *
 * Three different things sit behind one switch, so a probe answers what the
 * switch actually controls for each: a local CLI found on PATH (orca, gh) or a
 * remote MCP server whose credential lives in the workspace pool (youtrack).
 * `list()` never throws — one broken binary must not hide the other two — but it
 * does hand back the real reason, because "no projects" and "orca cannot run"
 * look identical in a list that swallows the error.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const workspaces = require('./workspace-store.cjs')
const harnesses = require('./harness-store.cjs')
const mentionRef = require('./mention-ref.cjs')
const mcpTools = require('./mcp-tools.cjs')
const { tilde } = require('./frontmatter.cjs')

/* `ENTITY_HOME` first, exactly like workspace-store and auth-store: the E2E
   profile points it at a scratch directory, and a test must never write the
   developer's real `~/.entity`. */
const ROOT = process.env.ENTITY_HOME
  ? path.resolve(process.env.ENTITY_HOME)
  : path.join(os.homedir(), '.entity')
const CONFIG = path.join(ROOT, 'integrations.json')

const IDS = ['orca', 'youtrack', 'github']
const LABELS = { orca: 'Orca CLI', youtrack: 'YouTrack', github: 'GitHub CLI' }
/* the literal binary or server name — the mono id, never a product name */
const ID_TEXT = { orca: 'orca', youtrack: 'youtrack', github: 'gh' }
const TOKENS = { orca: '@orca:', youtrack: '@youtrack:', github: '@github:' }
/* only the remote server needs a credential before the switch means anything */
const CREDENTIAL = { orca: 'none', youtrack: 'required', github: 'none' }

const PROBE_TIMEOUT_MS = 4000
/* How many facts a probe reports back. Enough to recognise the thing (a project
   list, an identity and its scopes), short enough to read on one line. */
const SAMPLE_LIMIT = 6
const VERIFY_LIMIT = 5
const VERIFY_TTL = 60_000
/* a repository list, a signed-in CLI and a YouTrack token are not facts that
   change between two visits to a settings page */
const PROBE_TTL = 5 * 60_000

/* ── the preference file ─────────────────────────────────────────── */

/** Missing file or missing key = off, and an unreadable file reads as off too:
    offering a service nobody switched on is the worse of the two failures. */
function readConfig() {
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
  } catch {
    raw = null
  }
  const out = {}
  for (const id of IDS) {
    out[id] = { enabled: raw?.[id]?.enabled === true }
  }
  return out
}

function writeConfig(value) {
  const tmp = `${CONFIG}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(CONFIG), { recursive: true })
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, CONFIG)
  } catch (error) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* nothing was staged */
    }
    throw new Error(
      `${tilde(CONFIG)} is not writable (${String(error?.message || error)}). Nothing changed.`,
    )
  }
  return value
}

/* ── probes ─────────────────────────────────────────────────────── */

function run(bin, args) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          error,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        })
      },
    )
  })
}

/** The last real line a failed CLI printed. On this machine `orca --version`
    exits 1 and puts its complaint on **stdout**, not stderr, so both are read. */
function reasonOf(result) {
  const printed = `${result.stderr || ''}\n${result.stdout || ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (printed.length) return printed[printed.length - 1].slice(0, 200)
  if (result.error?.code === 'ENOENT') return 'not found on PATH'
  return String(result.error?.message || result.error || 'unknown error').slice(0, 200)
}

/**
 * Orca: the path `mention-ref` would spawn, probed instead of assumed. Reuses
 * that module's resolver (a path set on the connector's page, `ENTITY_ORCA_BIN`,
 * the app's own install, the user's bin, then PATH) rather than duplicating it, so
 * the page and the `@orca:` mention can never disagree.
 */
async function probeOrca() {
  const wanted = mentionRef.orcaBinary()
  const found = path.isAbsolute(wanted) ? wanted : harnesses.which(String(wanted || 'orca'))
  if (!found) {
    return { usable: false, word: 'not on PATH', detail: 'orca', path: '', problem: '' }
  }
  const version = await run(found, ['--version'])
  if (version.error) {
    /* installed, but it cannot answer — a symlink whose app is gone. This is the
       case `sources()` used to swallow as "no projects"; the page says it. */
    const reason = reasonOf(version)
    return { usable: false, word: 'not runnable', detail: reason, path: found, problem: reason }
  }
  const listing = await run(found, ['repo', 'list', '--json'])
  if (listing.error) {
    const reason = reasonOf(listing)
    return { usable: false, word: 'not runnable', detail: reason, path: found, problem: reason }
  }
  let repos = []
  try {
    const parsed = JSON.parse(listing.stdout)
    repos = parsed?.result?.repos || parsed?.repos || []
  } catch {
    const reason = 'orca repo list did not return JSON.'
    return { usable: false, word: 'not runnable', detail: reason, path: found, problem: reason }
  }
  const count = repos.length
  const names = repos.map((repo) => repo.displayName || path.basename(String(repo.path || '')) || repo.id)
  return {
    usable: true,
    word: 'found',
    detail: `${count} ${count === 1 ? 'project' : 'projects'}`,
    /* What the row shows: the projects themselves, not a count. A number answers
       "is it alive"; the list answers "is this the Orca I think it is", and it is
       the same list `@orca:` offers. */
    samples: names.slice(0, SAMPLE_LIMIT),
    total: count,
    samplesLabel: 'projects',
    path: found,
    problem: '',
    version: version.stdout.trim().split(/\r?\n/)[0],
  }
}

async function probeGithub() {
  const bin = harnesses.which('gh')
  if (!bin) {
    return { usable: false, word: 'not on PATH', detail: 'gh', path: '', problem: '' }
  }
  const version = await run(bin, ['--version'])
  if (version.error) {
    const reason = reasonOf(version)
    return { usable: false, word: 'not runnable', detail: reason, path: bin, problem: reason }
  }
  const release = (version.stdout.match(/\b(\d+\.\d+\.\d+)\b/) || [])[1] || ''
  const who = `gh${release ? ` ${release}` : ''}`
  const auth = await run(bin, ['auth', 'status'])
  if (auth.error) {
    return {
      usable: false,
      word: 'not signed in',
      detail: `${who} found, not signed in`,
      path: bin,
      problem: reasonOf(auth),
      version: release,
    }
  }
  /* `auth status` says a token exists; it does not say whom it belongs to. One
     read of `/user` does, and the owner plus the scopes is the only answer that
     tells a person whether *this* is the account they meant. Bounded: 4s, and a
     failure here never fails the probe — the token is still usable. */
  const user = await run(bin, ['api', 'user', '--jq', '.login'])
  const scopes = (auth.stdout.match(/Token scopes:\s*(.+)/) || [])[1] || ''
  const login = String(user.stdout || '').trim()
  const granted = scopes
    .split(/[,\s]+/)
    .map((scope) => scope.replace(/['"]/g, '').trim())
    .filter(Boolean)
    .slice(0, SAMPLE_LIMIT)
  return {
    usable: true,
    word: 'found',
    detail: login ? `${who} · @${login}` : `${who} · signed in`,
    /* `@login` is the identity; the scopes are what the token may touch. Both are
       short, both are facts a person can check against what they expect. */
    samples: [login ? `@${login}` : '', ...granted].filter(Boolean),
    total: granted.length + (login ? 1 : 0),
    samplesLabel: login ? `@${login}` : 'granted',
    path: bin,
    problem: '',
    version: release,
  }
}


/** `<ws>/mcp.json` is the credential store: `servers.youtrack.headers.Authorization`.
    Only presence and the host leave this module — never the value. */
function youtrackCredential(workspace) {
  if (!workspace) return { hasCredential: false, host: '', url: '' }
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(mcpPath(workspace), 'utf8'))
  } catch {
    raw = null
  }
  const server = raw?.servers?.youtrack || raw?.disabled?.youtrack || null
  const header = server?.headers?.Authorization || server?.headers?.authorization || ''
  const url = String(server?.url || '')
  let host = ''
  try {
    host = url ? new URL(url).host : ''
  } catch {
    host = url.replace(/^[a-z]+:\/\//i, '').split('/')[0]
  }
  return { hasCredential: Boolean(String(header || '').trim()), host, url }
}

function mcpPath(workspace) {
  return path.join(workspaces.workspaceDir(workspace), 'mcp.json')
}

/** A verify reads issues through the pool as it is on disk *now*, which is what
    makes it a verify of the token rather than of the caller's intent. */
async function verifyYoutrack(workspace) {
  const result = await mcpTools.callTool({
    workspace,
    server: 'youtrack',
    tool: 'search_issues',
    arguments: { query: '', limit: VERIFY_LIMIT },
  })
  const rows = result?.data?.issuesPage || []
  return { count: rows.length }
}

const verified = new Map()

function cacheKey(workspace, id) {
  return `${workspace || ''}:${id}`
}

async function probeYoutrack(workspace, { force = false } = {}) {
  const { hasCredential, host } = youtrackCredential(workspace)
  if (!hasCredential) {
    return {
      usable: false,
      word: 'off',
      detail: 'no permanent token',
      path: host,
      problem: '',
      hasCredential: false,
      host,
    }
  }
  /* The verify is the only honest answer to "connected": a stored token that
     the server rejects is not a working integration. */
  const key = cacheKey(workspace, 'youtrack')
  const hit = verified.get(key)
  if (!force && hit && Date.now() - hit.at < VERIFY_TTL) {
    return { ...hit.value, hasCredential: true, host }
  }
  try {
    const { count } = await verifyYoutrack(workspace)
    const value = {
      usable: true,
      word: 'connected',
      detail: `${count} ${count === 1 ? 'issue searched' : 'issues searched'}`,
      path: host,
      problem: '',
      /* the endpoint (where the token points) and what the search covered */
      samples: [host, count ? `${count} ${count === 1 ? 'issue' : 'issues'} answered` : 'no issues matched'].filter(Boolean),
      total: count,
      samplesLabel: 'answered',
    }
    verified.set(key, { at: Date.now(), value })
    return { ...value, hasCredential: true, host }
  } catch (error) {
    const reason = String(error?.message || error).slice(0, 200)
    return {
      usable: false,
      word: 'off',
      detail: `token rejected — ${reason}`,
      path: host,
      problem: reason,
      hasCredential: true,
      host,
    }
  }
}

/* ── rows ───────────────────────────────────────────────────────── */

function rowOf(id, enabled, probe) {
  /* The leading word answers "can I @ this right now": a switched-off row reads
     `off`, and a switched-on row with a broken binary reads exactly what is
     wrong (`not runnable`, `not signed in`) rather than pretending to be off. */
  return {
    id,
    label: LABELS[id],
    idText: ID_TEXT[id],
    token: TOKENS[id],
    enabled: Boolean(enabled),
    credential: CREDENTIAL[id],
    hasCredential: Boolean(probe.hasCredential),
    /* whether anything exists at all, so the page can tell "nothing installed"
       from "installed and switched off" without spawning a binary */
    installed: Boolean(probe.installed),
    status: String(probe.word || 'off'),
    detail: String(probe.detail || ''),
    path: String(probe.path || ''),
    problem: String(probe.problem || ''),
    available: Boolean(enabled && probe.usable),
    /* What the probe actually saw — the projects, the identity and its scopes,
       the endpoint. A count says it is alive; this says it is the right one. */
    samples: Array.isArray(probe.samples) ? probe.samples : [],
    total: Number.isFinite(probe.total) ? probe.total : null,
    samplesLabel: String(probe.samplesLabel || ''),
  }
}

/** Present-but-not-asked. A stat per binary, no spawn: the empty note has to be
    able to say "nothing is installed here" without probing anything. */
function installedWithoutProbing(id, workspace) {
  if (id === 'youtrack') return youtrackCredential(workspace).hasCredential
  if (id === 'github') return Boolean(harnesses.which('gh'))
  /* Orca can be named on its own page, so its binary is not always a PATH lookup:
     ask the same resolver the mention uses, then stat what it answered. */
  const wanted = mentionRef.orcaBinary()
  return path.isAbsolute(wanted) ? fs.existsSync(wanted) : Boolean(harnesses.which(wanted))
}

/**
 * The list, in two parts, because the two parts cost wildly different things.
 *
 * `list` is the switches: one small file on disk and one `stat` per binary, and
 * it answers in a millisecond. The *probe* is what a row's status line needs —
 * `orca repo list --json`, `gh auth status`, a YouTrack search through the MCP
 * pool — and each one is a spawn or a network round trip with a four-second
 * ceiling. Asking for all three in one response made the page wait for the
 * slowest integration before it could paint a single row.
 *
 * So the rows land first and the probe lands second. `probe` is cached per
 * workspace for `PROBE_TTL`, because a repository list and a signed-in CLI do
 * not change between two visits to a settings page; `Refresh` passes
 * `force: true` and pays for them again.
 */
async function list({ workspace } = {}) {
  const config = readConfig()
  const rows = IDS.map((id) => {
    const enabled = config[id].enabled === true
    const credential = id === 'youtrack' ? youtrackCredential(workspace) : null
    /* The row says `not probed` until `integrations.probe` answers, and the one
       thing known without spawning anything is whether a token exists. `off`
       would be a different claim — that the service was asked and said no. */
    const probe = {
      usable: false,
      word: 'not probed',
      detail:
        credential === null
          ? ''
          : credential.hasCredential
            ? `token stored${credential.host ? ` · ${credential.host}` : ''}`
            : 'no permanent token',
      path: credential?.host || '',
      problem: '',
      hasCredential: credential?.hasCredential,
      installed: installedWithoutProbing(id, workspace),
    }
    return rowOf(id, enabled, probe)
  })
  return {
    rows,
    enabledCount: rows.filter((row) => row.enabled).length,
    total: IDS.length,
    cached: false,
  }
}

const probes = new Map()

function probeKey(workspace) {
  return String(workspace || '')
}

/** One status probe, or the cached answer for this workspace. */
async function probeOne(id, workspace, { force = false } = {}) {
  if (id === 'youtrack') return probeYoutrack(workspace, { force })
  if (id === 'github') return probeGithub()
  return probeOrca()
}

/**
 * The status line for every integration, from cache when it is fresh.
 *
 * All three are asked, whatever their switch says: the sentence a row needs is
 * "is orca runnable", and a switched-off row that cannot say is a row nobody
 * can fix. The cost was never the probe itself — it is one spawn each and it is
 * cached here for minutes — it was the page blocking on it before painting.
 */
async function probe({ workspace, force = false } = {}) {
  const key = probeKey(workspace)
  const hit = probes.get(key)
  if (!force && hit && Date.now() - hit.at < PROBE_TTL) return { ...hit.value, cached: true }

  const config = readConfig()
  const rows = IDS.map((id) => {
    const credential = id === 'youtrack' ? youtrackCredential(workspace) : null
    return {
      id,
      enabled: config[id].enabled === true,
      value: {
        usable: false,
        word: 'not probed',
        detail: '',
        path: credential?.host || '',
        problem: '',
        hasCredential: credential?.hasCredential,
      },
    }
  })

  /* three spawns and a pool call concurrently: the answer takes as long as the
     slowest one, not the sum */
  await Promise.all(
    rows.map(async (row) => {
      try {
        const value = await probeOne(row.id, workspace, { force })
        const credential = row.id === 'youtrack' ? youtrackCredential(workspace) : null
        row.value = {
          ...value,
          /* the row's own copy of "a token exists", so the switch can say why it
             will not flip */
          hasCredential: credential ? credential.hasCredential : value.hasCredential,
          installed: installedWithoutProbing(row.id, workspace),
        }
      } catch (error) {
        /* one broken probe is a row, never a page error */
        const reason = String(error?.message || error).slice(0, 200)
        row.value = {
          usable: false,
          word: 'not runnable',
          detail: reason,
          path: '',
          problem: reason,
          installed: installedWithoutProbing(row.id, workspace),
        }
      }
    }),
  )

  const answer = {
    rows: rows.map((row) => rowOf(row.id, row.enabled, row.value)),
    enabledCount: rows.filter((row) => row.enabled).length,
    total: IDS.length,
    at: Date.now(),
    cached: false,
  }
  probes.set(key, { at: Date.now(), value: answer })
  return answer
}

/** The switches alone, with no probe and no file read beyond the config: what a
    composer's `@` menu needs to know before it offers a kind. */
function enabled() {
  const config = readConfig()
  return Object.fromEntries(IDS.map((id) => [id, config[id].enabled === true]))
}

/**
 * The switch. A refusal the page has to act on carries `credential-missing` as
 * the first word of its message, because the call table hands the renderer a
 * string and nothing else: the page opens the token panel instead of painting a
 * write failure over a preference that was never written.
 */
async function setEnabled({ workspace, id, enabled } = {}) {
  const key = String(id || '')
  if (!IDS.includes(key)) throw new Error(`Unknown integration "${key}".`)
  const wanted = Boolean(enabled)
  if (key === 'youtrack' && wanted && !youtrackCredential(workspace).hasCredential) {
    throw new Error(
      'credential-missing · YouTrack needs a permanent token before it can be switched on.',
    )
  }
  const config = readConfig()
  const next = { ...config, [key]: { enabled: wanted } }
  writeConfig(next)
  /* The switch moved. The other rows are still true, so only this one is asked
     again and the cached answer is patched in place: a switch answers in a
     click, not in three spawns. */
  const cache = probeKey(workspace)
  const row = rowOf(key, wanted, {
    ...(await probeOne(key, workspace).catch((error) => {
      const reason = String(error?.message || error).slice(0, 200)
      return { usable: false, word: 'not runnable', detail: reason, path: '', problem: reason }
    })),
    installed: installedWithoutProbing(key, workspace),
    hasCredential: key === 'youtrack' ? youtrackCredential(workspace).hasCredential : undefined,
  })
  const hit = probes.get(cache)
  if (hit) {
    const value = { ...hit.value, rows: hit.value.rows.map((entry) => (entry.id === key ? row : entry)) }
    value.enabledCount = value.rows.filter((entry) => entry.enabled).length
    probes.set(cache, { at: Date.now(), value })
  }
  return row
}

function readMcp(workspace) {
  try {
    return JSON.parse(fs.readFileSync(mcpPath(workspace), 'utf8'))
  } catch {
    return null
  }
}

function writeMcpText(workspace, text) {
  const file = mcpPath(workspace)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch (error) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* nothing was staged */
    }
    throw new Error(
      `${tilde(file)} is not writable (${String(error?.message || error)}). Nothing changed.`,
    )
  }
}

/**
 * Write YouTrack's token where the MCP runtime already reads it, then prove it.
 *
 * Every other key in `mcp.json` is kept: this is an edit of one server, not a
 * rewrite of the pool. A failed verify restores the file byte for byte, because
 * a token that does not work is worse than no token — the next `@youtrack:`
 * would fail instead of the panel.
 */
async function saveCredential({ workspace, id, token, host } = {}) {
  const key = String(id || '')
  if (!workspace) throw new Error('A credential belongs to a workspace.')
  if (key !== 'youtrack') throw new Error(`${LABELS[key] || key} needs no stored credential.`)
  const secret = String(token || '').trim()
  if (!secret) throw new Error('A permanent token is required.')

  const file = mcpPath(workspace)
  let original = null
  try {
    original = fs.readFileSync(file, 'utf8')
  } catch {
    original = null
  }
  const current = readMcp(workspace) || { schema: 1, servers: {}, disabled: {} }
  const existing = current?.servers?.youtrack || {}
  const url = String(host || existing.url || '').trim()
  if (!url) throw new Error('A YouTrack endpoint URL is required.')
  const header = /^bearer /i.test(secret) ? secret : `Bearer ${secret}`
  const servers = { ...(current.servers || {}) }
  servers.youtrack = {
    ...existing,
    url,
    headers: { ...(existing.headers || {}), Authorization: header },
  }
  const next = { ...current, servers }
  writeMcpText(workspace, `${JSON.stringify(next, null, 2)}\n`)

  try {
    const { count } = await verifyYoutrack(workspace)
    verified.delete(cacheKey(workspace, 'youtrack'))
    probes.delete(probeKey(workspace))
    const state = await probe({ workspace, force: true })
    return {
      row: state.rows.find((row) => row.id === 'youtrack') || null,
      issues: count,
      host: youtrackCredential(workspace).host,
    }
  } catch (error) {
    if (original === null) {
      try {
        fs.unlinkSync(file)
      } catch {
        /* the write already failed loudly if this cannot be undone */
      }
    } else {
      writeMcpText(workspace, original)
    }
    verified.delete(cacheKey(workspace, 'youtrack'))
    const reason = String(error?.message || error)
    throw new Error(
      /\b401\b/.test(reason)
        ? 'YouTrack rejected this token (401). Nothing was saved.'
        : `Could not verify this token — ${reason.slice(0, 200)}. Nothing was saved.`,
    )
  }
}

/** The same verify, read-only: no file is written, so nothing can be lost. */
/**
 * One `cli` connector that is not one of the three the app ships.
 *
 * The person told us what its self-report is (`verify.argv`) and what exit code
 * means usable, so this runs exactly that and reports the last line the binary
 * printed. Nothing is inferred from the name: a binary called `gh` on someone
 * else's machine is not GitHub's CLI.
 */
async function testDeclared(bin, verify) {
  const found = path.isAbsolute(bin) ? bin : harnesses.which(bin)
  if (!found) return { ok: false, usable: false, word: 'not on PATH', detail: bin, problem: '' }
  const args = Array.isArray(verify?.argv) ? verify.argv : []
  const wanted = Number.isFinite(Number(verify?.okExit)) ? Number(verify.okExit) : 0
  const result = await run(found, args)
  const printed = `${result.stdout || ''}\n${result.stderr || ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const code = result.error?.code === undefined ? 0 : result.error.code
  if (result.error && code !== wanted) {
    return {
      ok: false,
      usable: false,
      word: 'not ready',
      detail: `${bin} ${args.join(' ')} exited ${code}`,
      problem: reasonOf(result),
      path: found,
    }
  }
  return {
    ok: true,
    usable: true,
    word: 'found',
    detail: printed[printed.length - 1] || `${bin} answered`,
    path: found,
    problem: '',
    samples: printed.slice(0, SAMPLE_LIMIT),
    total: printed.length,
    samplesLabel: 'reported',
  }
}

async function test({ workspace, id, verify, binary } = {}) {
  const key = String(id || '')
  if (key === 'youtrack') {
    const { count } = await verifyYoutrack(workspace)
    const { host, hasCredential } = youtrackCredential(workspace)
    return {
      ok: true,
      host,
      hasCredential,
      detail: `${host || 'youtrack'} · ${count} ${count === 1 ? 'issue searched' : 'issues searched'}`,
      /* the endpoint and what the search covered — the two facts that make
         "connected" checkable rather than a green word */
      samples: [host, count ? `${count} ${count === 1 ? 'issue' : 'issues'} answered` : 'no issues matched'].filter(Boolean),
      total: count,
      samplesLabel: 'answered',
    }
  }
  if (key === 'github') return { ok: true, ...(await probeGithub()) }
  if (key === 'orca') return { ok: true, ...(await probeOrca()) }
  /* A connector the app does not ship: its own declared self-report, or nothing.
     Falling through to "unknown integration" was the bug — every custom `cli` row
     could not be tested at all. */
  if (verify) return testDeclared(binary || key, verify)
  /* The three shipped ids threw above; anything else is a connector with no
     declared self-report, and saying so is the whole answer. */
  if (IDS.includes(key)) throw new Error(`Unknown integration "${key}".`)
  throw new Error(`"${key}" has no verify command, so there is nothing to ask it. Add one on its page.`)
}

module.exports = {
  CONFIG,
  ROOT,
  IDS,
  testDeclared,
  enabled,
  list,
  probe,
  setEnabled,
  saveCredential,
  test,
}
