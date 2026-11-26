/**
 * `@habitify:[<habit>:]<date|today|yesterday>` — the habits a day was scheduled,
 * read from Habitify's remote MCP server.
 *
 * **Read-only, by design.** Habitify's server also offers `complete`, `skip`,
 * `fail`, `log` and log-removal. This file calls exactly one tool,
 * `list-habits-by-date`, and nothing else. An agent that can tick a habit off is an
 * agent that can make a week's numbers say something nobody did — the same stance
 * `@youtube-studio:` takes with comment replies. Adding a write here is a decision to
 * reverse, not a gap to fill.
 *
 * The wire protocol is One's verified `habitify/mcp.ts`: Streamable HTTP JSON-RPC to
 * `https://mcp.habitify.me/mcp`, `initialize` → `notifications/initialized` →
 * `tools/call`, with the bearer token, both accepted content types, and the
 * `Mcp-Session-Id` the server hands back. The date argument's key is read from the
 * server's own `inputSchema` (via `tools/list`) rather than guessed, because a tool
 * that renames `date` to `targetDate` would otherwise answer about the wrong day.
 *
 * No email appears in a row, a note, an error or a log line: the account is named by
 * its localpart, which is the same thing the connector card shows.
 */
const MCP_URL = 'https://mcp.habitify.me/mcp'
const PROTOCOL_VERSION = '2025-06-18'
const TIMEOUT_MS = 20_000
/* The one read tool. A renamed upstream tool is this constant, not a hunt. */
const MCP_TOOL = 'list-habits-by-date'
const ROW_CEILING = 12
/* The date key and the catalogue are each worth a short cache: a mention costs two
   handshakes otherwise, and the composer's preview repeats the same ones. */
const SCHEMA_TTL_MS = 5 * 60_000
const DATE_ARG = /^(date|day|targetDate|forDate|on)$/i
const DAY = /^\d{4}-\d{2}-\d{2}$/

const text = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

/* ── the account a mention reads ──────────────────────────────────────────
   Habitify is one account per install, like Clockify's key: the connector id is both
   the account store's key and the token's. */

/** Which localpart to read, from the first (and only) connected account. */
function accountOf() {
  const accounts = require('../../oauth-accounts.cjs').connectedAccounts('habitify')
  const usable = accounts.filter((entry) => entry.hasToken)
  if (!usable.length) {
    throw new Error(
      'No Habitify account is signed in on this machine yet. Connect one on the connector’s page.',
    )
  }
  return usable[0].localpart
}

/** A live access token, through the shared refresh path — one cache, not two. */
async function accessTokenFor(localpart) {
  const { accessToken } = require('../_shared.cjs')
  return accessToken('habitify', localpart)
}

/* ── JSON-RPC over Streamable HTTP ──────────────────────────────────────── */

function parseJson(raw) {
  try {
    const value = JSON.parse(String(raw).trim())
    if (Array.isArray(value)) return { data: value }
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/**
 * A Streamable HTTP reply may be a JSON body or one `data:` line of an SSE stream.
 * Both are accepted here because the server picks, not us.
 */
function parseSse(raw) {
  for (const line of String(raw).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const parsed = parseJson(trimmed.slice(5).trim())
    if (parsed && (parsed.result !== undefined || parsed.error !== undefined)) return parsed
  }
  return null
}

/** A tool answers with prose or with a JSON document inside a text part. */
function parseToolText(raw) {
  const direct = parseJson(raw)
  if (direct) return direct
  const body = String(raw)
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ]) {
    const start = body.indexOf(open)
    const end = body.lastIndexOf(close)
    if (start >= 0 && end > start) {
      const parsed = parseJson(body.slice(start, end + 1))
      if (parsed) return parsed
    }
  }
  return null
}

/** One JSON-RPC call, and the session id the server may hand back with it. */
async function rpc(payload, token, sessionId) {
  let response
  try {
    response = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
        ...(sessionId ? { 'MCP-Protocol-Version': PROTOCOL_VERSION } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new Error('Habitify’s MCP server did not answer within 20 seconds.')
  }
  const raw = await response.text().catch(() => '')
  if (response.status === 401) {
    throw new Error('Habitify rejected this MCP session. Connect the account again on the connector’s page.')
  }
  const body = parseJson(raw) || parseSse(raw) || {}
  if (body.error !== undefined) {
    const said = text(body.error?.message || body.error, 160)
    throw new Error(`Habitify’s MCP server answered ${response.status}${said ? `: ${said}` : '.'}`)
  }
  /* A notification is answered 202 with no body, which is success. */
  if (!response.ok) throw new Error(`Habitify’s MCP server answered ${response.status}.`)
  return { body, sessionId: response.headers.get('mcp-session-id') || sessionId || '' }
}

/** initialize → notifications/initialized. */
async function openSession(token) {
  const init = await rpc(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'entity', version: '1' },
      },
    },
    token,
    '',
  )
  const sessionId = init.sessionId
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, token, sessionId)
  return sessionId
}

let dateArgCache = { at: 0, key: '' }

/**
 * The date argument's key, read from the tool's own `inputSchema`.
 *
 * Cached for five minutes: the handshake costs two round-trips and the schema does
 * not move. A server that renames it is picked up on the next window rather than
 * answering about the wrong day for ever.
 */
async function dateArgFor(token, sessionId) {
  if (dateArgCache.key && Date.now() - dateArgCache.at < SCHEMA_TTL_MS) return dateArgCache.key
  const reply = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, token, sessionId)
  const tools = Array.isArray(reply.body?.result?.tools) ? reply.body.result.tools : []
  const read = tools.find((tool) => tool?.name === MCP_TOOL) || tools.find((tool) => /habit/i.test(String(tool?.name || '')))
  const properties = Object.keys(read?.inputSchema?.properties || {})
  const key =
    properties.find((name) => DATE_ARG.test(name)) || properties.find((name) => /date/i.test(name)) || 'date'
  dateArgCache = { at: Date.now(), key }
  return key
}

/* ── the date a mention asks about ──────────────────────────────────────── */

/**
 * A **civil** date in the machine's own zone, never `toISOString()`.
 *
 * `toISOString().slice(0, 10)` is the UTC day, which is wrong for seven hours of
 * every WIB day — at 06:00 in Jakarta it still says yesterday, and at 23:00 it
 * already says tomorrow. `en-CA` yields `YYYY-MM-DD` directly; `en-US` would need
 * the parts reassembled. Same rule One's Habitify plugin uses, for the same reason.
 */
function civilDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/**
 * `today`, `yesterday`, or a literal `YYYY-MM-DD` — nothing else, no silent guess.
 *
 * `yesterday` shifts by a whole calendar day at noon rather than subtracting 24
 * hours: the noon anchor cannot land on the other side of a DST boundary, so the
 * answer is the previous date and not "23 or 25 hours ago".
 */
function dayOf(raw, now = new Date()) {
  const said = text(raw, 20).toLowerCase()
  if (!said || said === 'today') return civilDay(now)
  if (said === 'yesterday') {
    const yesterday = new Date(now.getTime() - 86_400_000)
    return civilDay(yesterday)
  }
  if (!DAY.test(said)) {
    throw new Error(
      `@habitify: a date is \`today\`, \`yesterday\` or YYYY-MM-DD — “${text(raw, 20)}” is none of those.`,
    )
  }
  return said
}

/* ── the answer ─────────────────────────────────────────────────────────── */

/** The habits in one tools/call answer, tolerating the envelopes the tool wraps them in. */
function habitsOf(body) {
  for (const key of ['data', 'habits', 'items', 'results', 'journal']) {
    const value = body?.[key]
    if (Array.isArray(value)) return value.filter((row) => row && typeof row === 'object')
  }
  return []
}

/** The provider's word for a day: `inprogress` means scheduled and not logged. */
function statusOf(raw) {
  const value = text(raw, 30).toLowerCase()
  if (['completed', 'skipped', 'failed'].includes(value)) return value
  return 'none'
}

/* `sessionId` is the one optional argument: a mention opens its own session, while
   the dashboard walks a week inside one — two round trips per day is a cost a
   seven-day read should not pay seven times. */
async function read(token, day, { limit, sessionId: reuse = '' } = {}) {
  const sessionId = reuse || (await openSession(token))
  const dateArg = await dateArgFor(token, sessionId)
  const reply = await rpc(
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: MCP_TOOL, arguments: { [dateArg]: day } },
    },
    token,
    sessionId,
  )
  const result = reply.body?.result || {}
  const said = (Array.isArray(result.content) ? result.content : [])
    .map((part) => text(part?.text, 400))
    .filter(Boolean)
    .join(' ')
  /* `structuredContent` when the server sends it, otherwise the first text part that
     holds a JSON document. An empty answer is not an error: a day with nothing
     scheduled really is empty. */
  let body = result.structuredContent && typeof result.structuredContent === 'object' ? result.structuredContent : null
  if (!body) {
    for (const part of Array.isArray(result.content) ? result.content : []) {
      const parsed = parseToolText(part?.text)
      if (parsed) {
        body = parsed
        break
      }
    }
  }
  if (result.isError === true) throw new Error(`Habitify’s ${MCP_TOOL} tool reported an error.`)
  return { rows: habitsOf(body || {}), said }
}

/* ── a session that expired mid-week ─────────────────────────────────────
   Habitify ends an MCP session and then answers `404`, or `400` with a JSON-RPC error
   whose message names the session. The dashboard walks a week inside one session, so
   without this one expiry turns every remaining day into an error row. */

/** Whether a failure says "this session is gone" rather than "this day failed". */
function sessionLost(problem) {
  const said = String(problem?.message || problem || '')
  /* A 401 is the grant, not the session: `rpc()` says "rejected this MCP session",
     and re-initializing cannot fix a rejected token — retrying would only spend a
     round trip to be told the same thing again. */
  if (/rejected this mcp session|connect the account again/i.test(said)) return false
  return /\b404\b/.test(said) || /session/i.test(said)
}

/**
 * `read()`, healing an expired session once.
 *
 * Returns the session id it finished on, so a caller walking a week can keep using the
 * new one instead of paying a fresh handshake for every remaining day.
 *
 * ponytail: one retry is the ceiling. A session that expires twice inside the seconds
 * one day's read takes is not an expiry but a server rejecting everything this grant
 * sends, and a retry loop would spend the page's ten-second deadline asking again.
 * Handing the failure back after the second attempt is what makes the day an honest
 * error row.
 */
async function readHealing(token, day, { limit, sessionId: reuse = '' } = {}) {
  let sessionId = reuse || (await openSession(token))
  try {
    return { ...(await read(token, day, { limit, sessionId })), sessionId }
  } catch (problem) {
    if (!sessionLost(problem)) throw problem
    sessionId = await openSession(token)
    return { ...(await read(token, day, { limit, sessionId })), sessionId }
  }
}

/**
 * `@habitify:[<habit>:]<date>`.
 *
 * One habit name before the colon filters the day to that habit; without it, every
 * habit scheduled that day. A date that is not a real day is an error, not today.
 */
async function resolve(ctx, segment, { limit = ROW_CEILING } = {}) {
  const localpart = accountOf()
  const token = await accessTokenFor(localpart)
  /* The grammar puts the date in `query` and, for the two-segment form, the habit
     name in `target`. */
  const day = dayOf(segment?.query)
  const wanted = text(segment?.target, 80)
  const { rows, said } = await read(token, day, { limit: limit + 1 })

  const habits = rows
    .map((row) => ({
      id: text(row.id ?? row.habitId, 64),
      name: text(row.name ?? row.habitName, 120),
      status: statusOf(row.status),
    }))
    .filter((habit) => habit.name)
    .filter((habit) => !wanted || habit.name.toLowerCase().includes(wanted.toLowerCase()))

  /* An exact name is what a person meant; a single hit from a prefix is the same
     intent with less typing. Two prefixes and nothing exact is ambiguous. */
  const exact = habits.filter((habit) => habit.name.toLowerCase() === wanted.toLowerCase())
  const picked = wanted ? (exact.length ? exact : habits) : habits
  if (wanted && !picked.length) {
    throw new Error(
      `@habitify: no habit matching “${wanted}” on ${day}. The names this account has are named in the day's own answer.`,
    )
  }

  const out = picked.slice(0, limit).map((habit) => ({
    id: `${habit.id}:${day}`,
    label: habit.name,
    detail: `${habit.status} · ${day}`,
  }))
  /* The provider's own sentence is the one thing that settles "Habitify shows two
     habits and this turn shows one", so it is carried as a row rather than a
     rounded count. */
  if (said) {
    out.push({ id: `summary:${day}`, label: day, detail: said.slice(0, 200) })
  }
  return out
}

/**
 * The composer's suggestions: the date words, plus what this account already has.
 * Never throws and answers `[]` on any failure — a menu must not go blank because a
 * token expired.
 */
async function preview(fields = [], { limit = 8 } = {}) {
  try {
    const typed = String(fields?.[0] || '').trim().toLowerCase()
    const words = ['today', 'yesterday']
    const matches = words.filter((word) => word.startsWith(typed))
    const rows = matches.map((word) => ({ id: word, label: word, detail: 'date', mention: `@habitify:${word}` }))
    if (typed && !matches.length) {
      const day = dayOf(typed)
      const token = await accessTokenFor(accountOf())
      const { rows: habits } = await read(token, day, { limit: limit + 1 })
      for (const habit of habits) {
        const name = text(habit.name ?? habit.habitName, 120)
        if (!name) continue
        rows.push({
          id: name,
          label: name,
          detail: `${statusOf(habit.status)} · ${day}`,
          mention: `@habitify:${name}:${day}`,
        })
      }
    }
    return rows.slice(0, limit)
  } catch {
    return []
  }
}

module.exports = {
  ROW_CEILING,
  MCP_TOOL,
  civilDay,
  dayOf,
  accessTokenFor,
  openSession,
  read,
  readHealing,
  statusOf,
  resolve,
  preview,
}
