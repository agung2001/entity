/**
 * `@threads:[posts|replies|insights:]<query|post-id>` — the last 30 days of a Threads
 * account: its posts with their counts, the replies under them, and the three rates
 * those counts add up to.
 *
 * **Read-only, by design.** Threads' API also publishes posts and replies. This file
 * calls `recentPosts`, `postInsights` and `postReplies` and nothing else, and all
 * three are GETs. An agent that can post is an agent that can say something to
 * somebody's audience in their name — adding a write here is a decision to reverse,
 * not a gap to fill.
 *
 * **The reader word is a filter, not a second read.** One 30-day read already holds
 * every count the three readers print, so `@threads:insights` costs the same as
 * `@threads:posts` and `@threads:replies` adds only the replies it fetches. A first
 * word that is not one of the three is not an error: it is the filter, because the
 * most likely thing to type after the colon is a word from a post.
 *
 * **There is no account segment**, for the reason `@habitify:` and `@fitbit:` have
 * none: one Threads token per install, so a mention naming an account could never be
 * right on another machine.
 *
 * No token appears in a row, a note or an error: the account is named by its
 * username, which is public.
 */
const api = require('./api.cjs')

const ROW_CEILING = 12
const MAX_PER_SOURCE = 3
const READERS = new Set(['posts', 'replies', 'insights'])
/* A Threads post id is a long decimal — nothing a person types as a word. */
const POST_ID = /^\d{6,}$/
const NO_TOKEN =
  'Threads has no access token on this machine yet. Paste one on the connector page.'

const count = new Intl.NumberFormat('en-gb')
const pct = (rate) => `${(Number(rate) * 100 || 0).toFixed(1)}%`
const day = (iso) => String(iso || '').slice(0, 10)
const excerpt = (value, max = 90) => api.text(value, max) || '[no text]'

const numbers = (post) =>
  [
    `${count.format(post.views)} views`,
    `${count.format(post.likes)} likes`,
    `${count.format(post.replies)} replies`,
    `${count.format(post.reposts)} reposts`,
  ].join(' · ')

const postRow = (post) => ({
  id: post.id,
  label: excerpt(post.text),
  detail: `${day(post.date)} · ${numbers(post)}`,
  url: post.permalink,
})

const totalRow = (report) => ({
  id: 'total',
  label: `${report.totals.posts} post${report.totals.posts === 1 ? '' : 's'} · ${report.window.since} → ${report.window.until}`,
  detail: `${numbers(report.totals)} · like rate ${pct(report.rates.likeRate)} · reply rate ${pct(report.rates.replyRate)}`,
})

/* ── the resolve ───────────────────────────────────────────────────────── */

/**
 * The three readers, over one shared read.
 *
 * Throws for the two things that are refusals rather than empty answers: no token,
 * and a window whose counts Threads refused. An empty row list means what it says —
 * no post in the window matched.
 */
async function resolve(ctx, segment, { limit = ROW_CEILING } = {}) {
  const wanted = api.text(segment?.target, 20).toLowerCase()
  const reader = READERS.has(wanted) ? wanted : 'posts'
  const query = api.text(segment?.query, 120)
  const token = require('../../connector-tokens.cjs').tokenFor('threads')
  if (!token) throw new Error(NO_TOKEN)

  const report = await require('./dashboard.cjs').read({ days: 30 })
  const needle = query.toLowerCase()
  const matched = report.posts.filter(
    (post) =>
      !needle ||
      post.id === query ||
      post.text.toLowerCase().includes(needle) ||
      post.permalink.toLowerCase().includes(needle),
  )

  if (reader === 'insights') {
    const rows = [
      { id: 'posts', label: 'Posts', detail: `${count.format(report.totals.posts)} in ${report.window.since} → ${report.window.until}` },
      { id: 'views', label: 'Views', detail: count.format(report.totals.views) },
      { id: 'likes', label: 'Likes', detail: count.format(report.totals.likes) },
      { id: 'replies', label: 'Replies', detail: count.format(report.totals.replies) },
      { id: 'reposts', label: 'Reposts', detail: count.format(report.totals.reposts) },
      { id: 'like-rate', label: 'Like rate', detail: pct(report.rates.likeRate) },
      { id: 'reply-rate', label: 'Reply rate', detail: pct(report.rates.replyRate) },
      { id: 'repost-rate', label: 'Repost rate', detail: pct(report.rates.repostRate) },
    ]
    return rows.slice(0, limit)
  }

  if (reader === 'replies') {
    /* One post by id, or the newest few posts the filter matched — never every post
       in the window: each one is a request per level, and the hour has a budget. */
    const posts = POST_ID.test(query) ? matched.slice(0, 1) : matched.slice(0, MAX_PER_SOURCE)
    const rows = []
    for (const post of posts) {
      const replies = await api.postReplies(token, post.id)
      for (const reply of replies) {
        rows.push({
          id: reply.id,
          label: excerpt(reply.text, 110),
          detail: [`@${reply.username || 'unknown'}`, day(reply.timestamp), `on ${post.id}`].join(' · '),
          url: post.permalink,
        })
      }
    }
    if (!rows.length) {
      throw new Error(
        posts.length
          ? `@threads:replies:${query || ''} found no reply under ${posts.length === 1 ? 'that post' : `the ${posts.length} newest matching posts`}.`
          : `@threads:replies:${query} matched no post in the last 30 days.`,
      )
    }
    return rows.slice(0, limit)
  }

  const rows = matched.map(postRow)
  if (!rows.length) {
    throw new Error(
      needle
        ? `@threads:posts:${query} matched no post in the last 30 days.`
        : `@threads:posts found no post in the last 30 days.`,
    )
  }
  if (rows.length < limit) rows.push(totalRow(report))
  return rows.slice(0, limit)
}

/**
 * The composer's suggestions: the three reader words and their shape. Never throws,
 * and never spends a request — a menu must not go blank under the cursor because a
 * token expired, and a menu is not worth an insight call per post.
 */
async function preview(fields = [], { limit = 8 } = {}) {
  try {
    const said = String(fields?.[0] || '').trim().toLowerCase()
    const readers = [
      { word: 'posts', detail: 'the last 30 days of posts, with their counts' },
      { word: 'insights', detail: 'the 30-day totals and the three rates' },
      { word: 'replies', detail: 'the replies under recent posts' },
    ]
    const rows = []
    for (const reader of readers) {
      if (said && !reader.word.startsWith(said)) continue
      rows.push({
        id: reader.word,
        label: reader.word,
        detail: reader.detail,
        mention: `@threads:${reader.word}`,
      })
    }
    /* The one shape a person cannot guess from the three words: a post id after the
       reader narrows the replies to that post. */
    if (!said || said.startsWith('replies')) {
      rows.push({
        id: 'replies:id',
        label: 'replies:',
        detail: 'one post id, for the replies under it',
        mention: '@threads:replies:',
      })
    }
    return rows.slice(0, limit)
  } catch {
    return []
  }
}

module.exports = { ROW_CEILING, MAX_PER_SOURCE, READERS, resolve, preview }
