/**
 * The Threads connector's shared half: the Graph host, the 30-day window, the two
 * upstream reads and the rate maths.
 *
 * Four files in this folder, because a connector has four jobs:
 *
 *   connector.cjs   the descriptor — what this connector is, and `verify()`
 *   mention.cjs     `@threads:[posts|replies|insights:]<query|post-id>`
 *   dashboard.cjs   the 30-day report for the tab
 *   api.cjs         this file: the host, the reads and the arithmetic
 *
 * **The token rides in the query string.** Threads' Graph API authenticates with
 * `?access_token=…`, so a raw URL is a credential: nothing here prints one, and an
 * upstream refusal is reported with the service's own `error.message` (or the HTTP
 * code) and never with the URL it came from.
 *
 * The mention and the tab read the same `sumMetrics()`/`rates()`, so their totals
 * cannot disagree.
 */
const GRAPH = 'https://graph.threads.net/v1.0'
const SITE = 'https://www.threads.net'
const FETCH_TIMEOUT_MS = 20_000
/* The reference implementation stops recursing at five: a Threads reply tree is a
   conversation, and a conversation that keeps answering is a bot loop. */
const DEPTH_CAP = 5
/* One page of replies per node. The Graph API's own default is 25 and it is also
   the point where an answer stops being a list a person reads. */
const PAGE = 25
const METRIC_KEYS = ['views', 'likes', 'replies', 'reposts']

const text = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

const numberOf = (value) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0
}

/* A failure the renderer has to *draw*, not just print: the tab picks its copy from
   the `code`, and a page matching on English would break the first time a sentence
   was reworded. */
function coded(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** Threads' own words for a refusal, or the code it answered with — never the URL,
 *  which carries the token. */
function saidOf(raw, status) {
  try {
    const parsed = JSON.parse(raw)
    const said = parsed?.error?.message
    if (said) return text(said, 300)
  } catch {
    /* a non-JSON error page has no message to quote */
  }
  return `HTTP ${status}`
}

/**
 * One Graph GET.
 *
 * `params` are set before the token so a caller cannot overwrite it, and an empty
 * value is dropped rather than sent as `?limit=` — Graph answers an empty numeric
 * parameter with a 400 about the parameter, which reads as a bug in this file.
 */
async function get(path, token, params = {}) {
  const url = new URL(`${GRAPH}${path}`)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  url.searchParams.set('access_token', String(token || ''))
  let response
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch {
    throw coded('threads-upstream', 'Threads did not answer within 20 seconds.')
  }
  const raw = await response.text().catch(() => '')
  if (!response.ok) throw coded('threads-upstream', saidOf(raw, response.status))
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    throw coded('threads-upstream', 'Threads returned an unreadable payload.')
  }
}

/* ── the two upstream reads ─────────────────────────────────────────────── */

/** The token's own account. The one call that proves a token, and `verify()` uses it. */
async function me(token) {
  const body = await get('/me', token, { fields: 'id,username' })
  return { id: text(body.id, 60), username: text(body.username, 80) }
}

/**
 * The account's recent posts, newest first.
 *
 * `me` is the Graph alias for the token's own user, so this is `/{user_id}/threads`
 * with the id filled in by the service — one call, and no second way to say whose
 * posts these are.
 */
async function recentPosts(token, { limit = PAGE } = {}) {
  const body = await get('/me/threads', token, {
    fields: 'id,text,timestamp,permalink',
    limit: String(limit),
  })
  return (Array.isArray(body.data) ? body.data : [])
    .map((post) => ({
      id: text(post?.id, 60),
      text: text(post?.text, 400),
      timestamp: text(post?.timestamp, 40),
      permalink: text(post?.permalink, 300),
    }))
    .filter((post) => post.id)
}

/** One post's four counts. A metric the answer leaves out is a zero, not a guess. */
async function postInsights(token, id) {
  const body = await get(`/${encodeURIComponent(id)}/insights`, token, {
    metric: METRIC_KEYS.join(','),
  })
  const counts = { views: 0, likes: 0, replies: 0, reposts: 0 }
  for (const row of Array.isArray(body.data) ? body.data : []) {
    const name = text(row?.name, 40)
    if (!METRIC_KEYS.includes(name)) continue
    counts[name] = numberOf(row?.values?.[0]?.value)
  }
  return counts
}

/**
 * Every reply under one post, and the replies under those, to five levels.
 *
 * ponytail: the depth cap is the reference implementation's, but requests are also
 * capped at `MAX_NODES` per call. A busy thread at 25 replies a level is 3 000
 * requests at depth five, and the Graph API allows roughly 250 an hour — the cap
 * keeps one mention from spending the whole hour. Upgrade: the `/replies` endpoint
 * also takes `reverse=false` with paging, so a real walk would page instead of
 * capping.
 */
const MAX_NODES = 12

async function postReplies(token, postId, { depth = DEPTH_CAP } = {}) {
  const rows = []
  const levels = Math.min(Math.max(1, numberOf(depth)), DEPTH_CAP)
  let asked = 0
  const walk = async (id, level) => {
    if (level > levels || asked >= MAX_NODES) return
    asked += 1
    const body = await get(`/${encodeURIComponent(id)}/replies`, token, {
      fields: 'id,text,username,timestamp',
      limit: String(PAGE),
    })
    for (const row of Array.isArray(body.data) ? body.data : []) {
      const reply = {
        id: text(row?.id, 60),
        text: text(row?.text, 300),
        username: text(row?.username, 80),
        timestamp: text(row?.timestamp, 40),
      }
      if (!reply.id) continue
      rows.push(reply)
      await walk(reply.id, level + 1)
    }
  }
  await walk(postId, 1)
  return rows
}

/* ── the window and the arithmetic ──────────────────────────────────────── */

/** The first day of the window, `YYYY-MM-DD`. */
function windowSince(days = 30) {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
}

/** The four totals over a set of posts — a post's own counts, already read. */
function sumMetrics(posts) {
  const totals = { views: 0, likes: 0, replies: 0, reposts: 0 }
  for (const post of Array.isArray(posts) ? posts : []) {
    for (const key of METRIC_KEYS) totals[key] += numberOf(post?.[key])
  }
  return totals
}

/** The three rates, each 0..1. No views is no rate — never a division by zero. */
function rates(posts) {
  const totals = sumMetrics(posts)
  const share = (part) => (totals.views > 0 ? part / totals.views : 0)
  return {
    likeRate: share(totals.likes),
    replyRate: share(totals.replies),
    repostRate: share(totals.reposts),
  }
}

module.exports = {
  SITE,
  GRAPH,
  PAGE,
  DEPTH_CAP,
  FETCH_TIMEOUT_MS,
  METRIC_KEYS,
  text,
  numberOf,
  coded,
  get,
  me,
  recentPosts,
  postInsights,
  postReplies,
  windowSince,
  sumMetrics,
  rates,
}
