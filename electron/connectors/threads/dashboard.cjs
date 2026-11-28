/**
 * The Threads dashboard's one read: one account's last 30 days, its counts and the
 * three rates those counts make.
 *
 * **One account per read.** A tab shows one account at a time — the mention is where
 * `all` belongs, because a mention is a question and a tab is a screen — and the
 * account is named by the row the accounts card already holds (`<username>@threads`).
 * The token is minted on this side of the bridge by `oauth-accounts.cjs`, which is the
 * one place that knows how a Threads token renews itself, and it never crosses.
 *
 * **A post whose counts could not be read is not a post with zero views.** The
 * insight call is per post, so one refusal must not become four zeroes in a total — a
 * post that did not answer is left out of the report, and a window where *no* post
 * answered is a refusal with a sentence rather than an empty table.
 */
const { accessToken } = require('../_shared.cjs')
const {
  text,
  numberOf,
  coded,
  recentPosts,
  postInsights,
  windowSince,
  dailySeries,
  sumMetrics,
  rates,
} = require('./api.cjs')

/* A dashboard is a slow-moving number, so an answer is held for ten minutes in this
   process — switching accounts back and forth should not spend one insight call per
   post each time — and `force` is the Refresh button and the only thing that skips
   it. Keyed per account: two accounts share nothing but the arithmetic. */
const CACHE_MS = 10 * 60_000
const cache = new Map()
/* One key per account and window; a handful of accounts is the whole of it. */
const CACHE_KEYS = 8
/* A month of posts is a list, not an archive: past fifty the insight calls become the
   hourly budget rather than the report. */
const POSTS = 50

/* A row with no account is a programming error, not a person's: the pane and the
   mention both always name one. */
function accountOf(value) {
  const name = text(value, 80)
  if (!name) throw coded('threads-no-account', 'Threads needs an account for that read.')
  return name
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

async function read({ account, days = 30, force = false } = {}) {
  const localpart = accountOf(account)
  /* `span` is how many days the read covers; `window` is the two dates it lands on.
     They were both called `window` for one edit, and the module would not parse. */
  const span = Math.max(1, numberOf(days) || 30)
  const key = `${localpart}|${span}`
  const hit = cache.get(key)
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.value

  const token = await accessToken('threads', localpart)
  const since = windowSince(span)
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
      `Threads listed ${inside.length} post${inside.length === 1 ? '' : 's'} for @${localpart} in the last ${span} days but refused the counts for every one — the token may not include the insights scope.`,
    )
  }

  const totals = { posts: posts.length, ...sumMetrics(posts) }
  const window = { since, until: new Date().toISOString().slice(0, 10) }
  const value = {
    account: localpart,
    /* How many posts the read counted, so the tab can print a sentence about a
       window that was read and is empty rather than four zeroes. */
    totals,
    rates: rates(posts),
    posts,
    /* The growth chart's own series: one bucket per day, zero-filled. Computed here
       for the same reason the totals are — a second copy of "which day" in the
       renderer is a second answer. */
    daily: dailySeries(posts, window),
    readAt: new Date().toISOString(),
    window,
  }
  if (cache.size >= CACHE_KEYS) cache.clear()
  cache.set(key, { at: Date.now(), value })
  return value
}

module.exports = { CACHE_MS, CACHE_KEYS, POSTS, accountOf, read }
