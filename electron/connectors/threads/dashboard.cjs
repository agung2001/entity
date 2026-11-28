/**
 * The Threads dashboard's one read: the last 30 days of posts, their counts, and the
 * three rates those counts make.
 *
 * One call to `connector.token.status` and one to this file are the whole tab. The
 * token is read here and never crosses the bridge, every request is a GET, and
 * nothing on this page writes to Threads.
 *
 * **A post whose counts could not be read is not a post with zero views.** The
 * insight call is per post, so one refusal must not become four zeroes in a total —
 * a post that did not answer is left out of the report, and a window where *no* post
 * answered is a refusal with a sentence rather than an empty table.
 */
const {
  text,
  numberOf,
  coded,
  recentPosts,
  postInsights,
  windowSince,
  sumMetrics,
  rates,
} = require('./api.cjs')

/* A dashboard is a slow-moving number, so an answer is held for ten minutes in this
   process — switching tabs back and forth should not spend one insight call per post
   each time — and `force` is the Refresh button and the only thing that skips it. */
const CACHE_MS = 10 * 60_000
const cache = new Map()
/* One key per window, and only two windows exist; the ceiling is here so a long
   session cannot grow the map at all. */
const CACHE_KEYS = 8
/* A month of posts is a list, not an archive: past fifty the insight calls become the
   hourly budget rather than the report. */
const POSTS = 50

const NO_TOKEN =
  'Threads has no access token on this machine yet. Paste one on the connector page.'

function tokenOf() {
  const token = require('../../connector-tokens.cjs').tokenFor('threads')
  if (!token) throw coded('threads-no-token', NO_TOKEN)
  return token
}

/** One post as the report carries it: the post's own text and link, and its counts. */
function rowOf(post, counts) {
  return {
    id: post.id,
    text: text(post.text, 200),
    permalink: post.permalink,
    date: post.timestamp.slice(0, 10),
    views: counts.views,
    likes: counts.likes,
    replies: counts.replies,
    reposts: counts.reposts,
  }
}

async function read({ days = 30, force = false } = {}) {
  const window = Math.max(1, numberOf(days) || 30)
  const key = String(window)
  const hit = cache.get(key)
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.value

  const token = tokenOf()
  const since = windowSince(window)
  const recent = await recentPosts(token, { limit: POSTS })
  /* The window is a filter over the posts the API already returned, newest first:
     Threads' `since` parameter is not honoured by every version of the endpoint, and
     a total about a month therefore cannot depend on it. */
  const inside = recent
    .filter((post) => post.timestamp.slice(0, 10) >= since)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  const counted = await Promise.all(
    inside.map(async (post) => {
      try {
        return rowOf(post, await postInsights(token, post.id))
      } catch {
        return null
      }
    }),
  )
  const posts = counted.filter(Boolean)
  if (!posts.length && inside.length) {
    throw coded(
      'threads-upstream',
      `Threads listed ${inside.length} post${inside.length === 1 ? '' : 's'} in the last ${window} days but refused the counts for every one — the token may not include the insights scope.`,
    )
  }

  const totals = { posts: posts.length, ...sumMetrics(posts) }
  const value = {
    totals,
    rates: rates(posts),
    posts,
    readAt: new Date().toISOString(),
    window: { since, until: new Date().toISOString().slice(0, 10) },
  }
  if (cache.size >= CACHE_KEYS) cache.clear()
  cache.set(key, { at: Date.now(), value })
  return value
}

module.exports = { CACHE_MS, CACHE_KEYS, POSTS, NO_TOKEN, read }
