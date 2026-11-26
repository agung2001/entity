/**
 * What the team's YouTrack holds right now, read over the MCP endpoint this
 * workspace already declares in its own `mcp.json`.
 *
 * Two answers:
 *
 *   probe({ workspace })            can this tab be opened at all, and in whose name
 *   dashboard({ workspace, force }) every unresolved issue, and the resolved last 30 days
 *
 * **No token is ever read out of this module into a reply.** The credential is one
 * header in one file (`servers.youtrack.headers.Authorization`); it is copied into
 * a request and nowhere else. A reply carries the *path* of the header, never its
 * value, and never the file's other headers — which is why a refused tab can say
 * "401 at that line" without putting a bearer in a renderer, a log or a screenshot.
 *
 * **Two reads, not twenty-seven.** YouTrack has no count endpoint, so every number
 * on the tab is computed from rows that already carry `State`, `Priority`,
 * `Assignee`, `project`, `created` and `resolved`. One `#Unresolved` read and one
 * `#Resolved resolved date: …` read carry all of them; summing per-tile queries
 * would cost ~20 round trips to re-derive what these two rows already say.
 *
 * **Every tool call is one of two reads.** `search_issues` and `get_current_user`
 * are the only tools this module can reach — not a filtered list of a bigger one,
 * a literal branch. The pool declares `create_issue`, `update_issue`, `log_work`
 * and their siblings; none of them has a call site here, so no amount of input can
 * reach one.
 *
 * **Five minutes in this process's memory.** A dashboard is a moving number, so the
 * answer is cached per workspace for `CACHE_MS` and nothing is written to disk:
 * a restart reads again, `force` reads again, and the expiry does the rest.
 *
 * ponytail: `search_issues` caps `limit` at 20, so a count *is* a pagination. Read 1
 * alone is ~16 round trips on a 305-issue tracker. That is ~3 s cold and 0 ms
 * cached, which is why the tab paints its chrome first and the cache is warm on a
 * second open — not a spinner over an empty box.
 */
const path = require('node:path')
const workspaces = require('./workspace-store.cjs')

/* One workspace, one entry: the notion of a server called `youtrack` lives in
   `mcp.json`, and the tab's lock reads the same fact. */
const SERVER = 'youtrack'
const HEADER_PATH = `${SERVER}.headers.Authorization`
const PROTOCOL = '2025-06-18'
const CLIENT = { name: 'entity', version: '0.1.0' }

/* `limit` is capped at 20 by the server, so a page is 20 rows whatever is asked. */
const PAGE = 20
/* The hard stop: 60 pages a read. A tracker past this prints `truncated` and the
   tab says so rather than presenting a partial sum as the whole. */
const MAX_ROWS = 1200
/* How far back the resolved column looks. */
const WINDOW_DAYS = 30
/* Five minutes: long enough that flipping tabs costs nothing, short enough that a
   number is not stale by the time somebody acts on it. */
const CACHE_MS = 5 * 60_000
/* A probe is one question on the way to a tab that must not block: 8 s. A read is
   twenty-six of them: 12 s each, and the tab has already painted by then. */
const PROBE_TIMEOUT_MS = 8_000
const READ_TIMEOUT_MS = 12_000
/* Pages in flight. Two is measured, not guessed: six serial pages cost ~1.5 s and
   the same six in flight cost ~0.6 s, while sixteen at once is *slower* than
   serial — this server does not reward a burst. */
const CONCURRENCY = 2

/** `answer` per workspace, in this process only. */
const cache = new Map()

const DAY_MS = 86_400_000

const dayOf = (date) => date.toISOString().slice(0, 10)

function windowOf(now = Date.now()) {
  const until = new Date(now)
  const since = new Date(now - WINDOW_DAYS * DAY_MS)
  return { days: WINDOW_DAYS, since: dayOf(since), until: dayOf(until) }
}

/**
 * The definition this workspace holds, resolved once per call.
 *
 * `mcp(id)` hands back the pool as it is on disk — headers included — because the
 * main process is where a request is built. Nothing from `headers` travels back
 * out of `probe`/`dashboard`; only `HEADER_PATH` does.
 */
function definitionOf(id) {
  const record = workspaces.open(id)
  const pool = workspaces.mcp(id)
  const server = pool.servers?.[SERVER] || null
  const url = String(server?.url || '').trim()
  const headers =
    server?.headers && typeof server.headers === 'object' && !Array.isArray(server.headers)
      ? Object.fromEntries(
          Object.entries(server.headers).filter(([, value]) => typeof value === 'string'),
        )
      : {}
  let host = ''
  try {
    host = new URL(url).host
  } catch {
    host = ''
  }
  return {
    file: path.join(record.path, 'mcp.json'),
    server,
    url,
    headers,
    host,
  }
}

/** `HTTP <status>` is the whole sentence a person needs; the body is the server's. */
class Refusal extends Error {
  constructor(status, body) {
    super(`HTTP ${status}${body ? `: ${body}` : ''}`)
    this.status = status
    this.body = body
  }
}

/**
 * One Streamable-HTTP JSON-RPC session against the pool's own endpoint.
 *
 * Same shape as `mcp-tools.cjs`'s `httpSession` — the auth headers verbatim, the
 * MCP session id echoed back, SSE or JSON depending on what the server answers —
 * because a probe without the pool's bearer would report "no tools" for a server a
 * harness can use perfectly. The protocol version is the newer one: this endpoint
 * negotiates `2025-06-18`, and a stale version is a downgrade nobody asked for.
 */
async function session(definition, work, timeoutMs) {
  let id = ''

  const request = async (method, params) => {
    const notify = method.startsWith('notifications/')
    const payload = { jsonrpc: '2.0', method, ...(params ? { params } : {}) }
    if (!notify) payload.id = (request._next = (request._next || 0) + 1)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(definition.url, {
        method: 'POST',
        headers: {
          ...definition.headers,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(id ? { 'Mcp-Session-Id': id } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      id = response.headers.get('mcp-session-id') || id
      const text = await response.text()
      if (response.status === 401 || response.status === 403) {
        throw new Refusal(response.status, text.slice(0, 200))
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
      }
      const messages = parsePayload(text, response.headers.get('content-type'))
      if (notify) return null
      const reply = messages.find((entry) => entry.id === payload.id)
      if (!reply) throw new Error('The server sent no JSON-RPC response.')
      if (reply.error) throw new Error(reply.error.message || 'The MCP request failed.')
      return reply.result
    } finally {
      clearTimeout(timer)
    }
  }

  await request('initialize', {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: CLIENT,
  })
  await request('notifications/initialized').catch(() => {})
  return work({ request })
}

function parsePayload(text, contentType) {
  if (String(contentType || '').includes('text/event-stream')) {
    const messages = []
    for (const block of String(text).split(/\n\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n')
      if (!data) continue
      try {
        messages.push(JSON.parse(data))
      } catch {
        /* an SSE comment or a partial frame */
      }
    }
    return messages
  }
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

/** Which of the five sentences a failure earns. Order matters: a refusal is a
 *  refusal before it is a timeout, and a DNS failure is offline before it is
 *  anything else. */
function stateOf(error) {
  if (error instanceof Refusal) return 'refused'
  if (error?.name === 'AbortError') return 'timeout'
  const code = String(error?.cause?.code || error?.code || '')
  if (['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return 'offline'
  }
  /* `fetch failed` with no code is still the network: the tab's banner says so
     rather than blaming the token for a dropped connection. */
  if (/fetch failed|network|getaddrinfo/i.test(String(error?.message || ''))) return 'offline'
  return 'offline'
}

function messageOf(state, error, timeoutMs, definition) {
  if (state === 'timeout') {
    return `${definition.host || 'The server'} did not answer in ${Math.round(timeoutMs / 1000)} s.`
  }
  if (state === 'refused') {
    return `${definition.host || 'The server'} refused the token — ${error.status}.`
  }
  return `Could not reach ${definition.host || 'the server'}: ${String(error?.message || error)}`
}

/** The lock's answer, asked once on mount so the tab can unlock before any count
 *  is fetched. `tools` is a count, not a list: the pool declares writes and this
 *  module must not be the place that names them. */
async function probe({ workspace } = {}) {
  const definition = definitionOf(workspace)
  const checkedAt = new Date().toISOString()
  const base = {
    state: 'missing',
    host: definition.host,
    file: definition.file,
    headerPath: HEADER_PATH,
    status: 0,
    message: '',
    login: '',
    name: '',
    tools: 0,
    checkedAt,
  }

  if (!definition.server || !definition.url) {
    return {
      ...base,
      message: `Dashboard needs a \`${SERVER}\` entry with a \`url\` in this workspace's \`mcp.json\`. The pool has ${definition.server ? 'one with no url' : 'none'}.`,
    }
  }

  try {
    return await session(
      definition,
      async ({ request }) => {
        /* The tools first: a server that answers `initialize` and declares no
           `search_issues` is not a dashboard, and saying so here is cheaper than
           discovering it on the first page of a read. */
        const listed = await request('tools/list', {})
        const tools = Array.isArray(listed?.tools) ? listed.tools : []
        if (!tools.some((tool) => tool?.name === 'search_issues')) {
          return {
            ...base,
            state: 'missing',
            message: `The endpoint answered, but declares no \`search_issues\` tool.`,
          }
        }
        /* Whose seat the token is: the "you" band is `for: me`, and `me` in
           YouTrack is the account behind the token, not the Entity user. */
        let login = ''
        let name = ''
        try {
          const me = await request('tools/call', { name: 'get_current_user', arguments: {} })
          const who = payloadOf(me)
          login = String(who?.login || '')
          name = String(who?.name || '')
        } catch {
          /* A token that may read issues but not name itself still unlocks the
             tab; the "you" band then says it cannot name the seat. */
        }
        /* One row: the cheapest proof that this token may actually read issues.
           `initialize` answering is not the same permission. */
        await request('tools/call', {
          name: 'search_issues',
          arguments: { query: '#Unresolved', limit: 1, offset: 0, customFieldsToReturn: FIELDS },
        })
        return { ...base, state: 'ok', status: 200, login, name, tools: tools.length }
      },
      PROBE_TIMEOUT_MS,
    )
  } catch (error) {
    const state = stateOf(error)
    return {
      ...base,
      state,
      status: Number(error?.status) || 0,
      message: messageOf(state, error, PROBE_TIMEOUT_MS, definition),
    }
  }
}

/** What `search_issues` needs in a reply for every number on the tab to be
 *  computable locally. Asking for fewer fields is asking for a second read. */
const FIELDS = ['Type', 'State', 'Priority', 'Assignee']

/** The tool's own envelope: `result.content[0].text` is a JSON string, and a tool
 *  that failed still answers 200 — `isError` is the only place that says so. */
function payloadOf(result) {
  if (result?.isError) {
    const text = result?.content?.[0]?.text
    throw new Error(String(text || 'The tool reported an error.').slice(0, 200))
  }
  const text = result?.content?.[0]?.text
  if (typeof text !== 'string') throw new Error('The tool returned no text payload.')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('The tool returned a payload that is not JSON.')
  }
}

/** `Assignee` arrives as a comma-joined string of logins, `[]` when empty, and —
 *  on a server that changes its mind — as objects. All three become logins. */
function assigneeList(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',')
  const out = []
  for (const entry of raw) {
    const login =
      typeof entry === 'string' ? entry.trim() : String(entry?.login || entry?.name || '').trim()
    if (login && login !== '[]') out.push(login)
  }
  return out
}

/** A row, cut to the eleven facts the tab reads. Everything else the tool sends
 *  stays in the main process. */
function rowOf(issue) {
  const fields = issue?.customFields && typeof issue.customFields === 'object' ? issue.customFields : {}
  return {
    id: String(issue?.id || ''),
    url: String(issue?.url || ''),
    summary: String(issue?.summary || ''),
    project: String(issue?.project || ''),
    reporter: String(issue?.reporter || ''),
    createdAt: String(issue?.createdAt || ''),
    updatedAt: String(issue?.updatedAt || ''),
    resolvedAt: issue?.resolvedAt ? String(issue.resolvedAt) : '',
    type: String(fields.Type || ''),
    state: String(fields.State || ''),
    priority: String(fields.Priority || ''),
    assignees: assigneeList(fields.Assignee),
  }
}

/**
 * One query, every page. `hasNextPage` decides whether to ask again and
 * `nextPageOffset` says where; the loop stops at `MAX_ROWS` and reports it.
 *
 * Ids are deduped: a tracker that changes under a paginated read can hand the same
 * issue back on two pages, and a count that double-counted one issue would be
 * wrong by exactly the amount nobody can see.
 */
async function readAll(call, query) {
  const rows = []
  const seen = new Set()
  const inFlight = new Set()
  let pages = 0
  let truncated = false
  let failure = null
  /* The frontier is the offset no answer has covered yet; the pump keeps
     `CONCURRENCY` pages in the air behind it. It overshoots by at most one page at
     the end, where an offset past the last row answers with an empty page and
     `hasNextPage: false` — which is the stop signal, not an error. */
  let frontier = 0
  let more = true
  let done = false

  const pump = () => {
    while (!done && more && inFlight.size < CONCURRENCY) {
      const offset = frontier
      frontier += PAGE
      const task = Promise.resolve()
        .then(() =>
          call({
            name: 'search_issues',
            arguments: { query, limit: PAGE, offset, customFieldsToReturn: FIELDS },
          }),
        )
        .then(payloadOf)
        .then((page) => {
          pages += 1
          const issues = Array.isArray(page?.issuesPage) ? page.issuesPage : []
          for (const issue of issues) {
            const row = rowOf(issue)
            if (!row.id || seen.has(row.id)) continue
            seen.add(row.id)
            rows.push(row)
          }
          if (rows.length >= MAX_ROWS) {
            /* The ceiling was reached: the rows in hand are real, the set is not
               whole, and the tab says so instead of summing it. */
            truncated = Boolean(page?.hasNextPage) || issues.length > 0
            done = true
            return
          }
          if (!page?.hasNextPage) {
            more = false
            return
          }
          const next = Number(page?.nextPageOffset)
          if (Number.isFinite(next) && next >= frontier) frontier = next
        })
        /* Swallowed here, re-thrown below: a rejection nobody awaited is a warning
           in the log and a half-read dashboard that looks complete. */
        .catch((error) => {
          failure = failure || error
          done = true
        })
        .finally(() => inFlight.delete(task))
      inFlight.add(task)
    }
  }

  pump()
  while (inFlight.size) {
    await Promise.race([...inFlight])
    pump()
  }
  if (failure) throw failure

  return { rows, pages, truncated }
}

/**
 * Both reads, side by side, with one of them allowed to fail.
 *
 * The unresolved read carries every tile but two; the resolved read carries the
 * other two and both "done" columns. A tracker that answers the first and times
 * out on the second is a *partial* tab — the tiles derived from the first are
 * real, the rest print `—` — never an empty box.
 */
async function readBoth(definition, timeoutMs) {
  const window = windowOf()
  const unresolvedQuery = '#Unresolved'
  const resolvedQuery = `#Resolved resolved date: ${window.since} .. ${window.until}`
  const queries = { unresolved: unresolvedQuery, resolved: resolvedQuery }
  const empty = { rows: null, pages: 0, truncated: false }
  /* Every tool call, counted where it is made. The reads card prints this rather
     than "2 reads": a count on this server *is* a pagination. */
  let calls = 0

  const answer = await session(
    definition,
    async ({ request }) => {
      const mine = async () => {
        try {
          calls += 1
          const who = payloadOf(
            await request('tools/call', { name: 'get_current_user', arguments: {} }),
          )
          return { login: String(who?.login || ''), name: String(who?.name || '') }
        } catch {
          /* A token that may read issues but not name itself still fills the tab;
             the "you" band then says it cannot name the seat. */
          return null
        }
      }
      const read = (query) =>
        readAll(
          async (payload) => {
            calls += 1
            return request('tools/call', payload)
          },
          query,
        ).catch((error) => ({ error }))

      const [me, first, second] = await Promise.all([
        mine(),
        read(unresolvedQuery),
        read(resolvedQuery),
      ])
      return { me, first, second }
    },
    timeoutMs,
  ).catch((error) => ({ error: error || new Error('The session did not open.') }))

  if (answer.error) {
    /* The session itself never opened, so neither read made it: one state for the
       whole tab, and the pane draws its refused panel from it. */
    const state = stateOf(answer.error)
    return {
      state,
      status: Number(answer.error?.status) || 0,
      message: messageOf(state, answer.error, timeoutMs, definition),
      window,
      me: null,
      unresolved: null,
      resolved: null,
      truncated: { unresolved: false, resolved: false },
      calls,
      errors: [{ read: 'both', state, message: String(answer.error?.message || answer.error) }],
      queries,
    }
  }

  const errors = []
  const settle = (name, value) => {
    if (value?.error) {
      errors.push({
        read: name,
        state: stateOf(value.error),
        /* The code the tracker itself sent, carried out of the read so the pane's
           refused panel can print 401, 403 or whatever else without guessing. */
        status: Number(value.error?.status) || 0,
        message: String(value.error?.message || value.error),
      })
      return empty
    }
    return value
  }
  const first = settle('unresolved', answer.first)
  const second = settle('resolved', answer.second)

  /* One read down is a *partial* tab, not a broken one: the tiles the other read
     carries render, the rest print `—`. Both down keeps the failure's own class so
     the pane can say "refused — 401" instead of the generic sentence. */
  const both = first.rows === null && second.rows === null
  const state = both ? errors[0]?.state || 'offline' : 'ok'

  return {
    state,
    /* This read's own code. `0` when the failure had none (a dropped connection has
       no HTTP status), which the pane turns into its 401 fallback. */
    status: both ? Number(errors[0]?.status) || 0 : 200,
    message: both ? errors[0]?.message || '' : '',
    window,
    me: answer.me,
    unresolved: first.rows,
    resolved: second.rows,
    truncated: { unresolved: first.truncated, resolved: second.truncated },
    calls,
    errors,
    queries,
  }
}

/**
 * The tab's data. Cached per workspace for `CACHE_MS`; `force` is the Refresh
 * button and nothing else.
 *
 * The reply carries `file` and `headerPath` and never the header itself — a
 * screenshot of a refused tab must not be a leaked token.
 */
async function dashboard({ workspace, force } = {}) {
  const definition = definitionOf(workspace)
  const readAt = new Date().toISOString()
  const base = {
    state: 'missing',
    host: definition.host,
    file: definition.file,
    headerPath: HEADER_PATH,
    status: 0,
    message: '',
    readAt,
    cached: false,
    cacheTtlMs: CACHE_MS,
    window: windowOf(),
    me: null,
    unresolved: null,
    resolved: null,
    truncated: { unresolved: false, resolved: false },
    calls: 0,
    errors: [],
  }

  if (!definition.server || !definition.url) {
    return {
      ...base,
      message: `Dashboard needs a \`${SERVER}\` entry with a \`url\` in this workspace's \`mcp.json\`.`,
    }
  }

  const key = String(workspace)
  const held = cache.get(key)
  if (!force && held && Date.now() - held.at < CACHE_MS) {
    return { ...held.answer, cached: true, readAt: held.answer.readAt, cacheTtlMs: CACHE_MS }
  }

  const answer = await readBoth(definition, READ_TIMEOUT_MS)
  const full = { ...base, ...answer, readAt }

  /* A failed read is not cached: the next open should try again rather than serve
     a refusal that a replaced token already fixed. */
  if (answer.state === 'ok') cache.set(key, { at: Date.now(), answer: full })
  else cache.delete(key)

  return full
}

/** The cache, dropped: a workspace switch must not paint one tracker's numbers into
 *  another's page. */
function forget(workspace) {
  if (workspace === undefined) cache.clear()
  else cache.delete(String(workspace))
}

module.exports = {
  probe,
  dashboard,
  /* The cache, dropped. A test wants a clean read; nothing on the page calls it. */
  forget,
}
