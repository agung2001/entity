/**
 * `@threads:<account|all>:[posts|replies|insights:]<query|post-id>` — one Threads
 * account, or every connected one: its last 30 days, the replies under those posts,
 * and the three rates the counts add up to.
 *
 * **Read-only, by design.** Threads' API also publishes posts and replies. This file
 * calls three reads and nothing else, and all three are GETs. An agent that can post
 * is an agent that can say something to somebody's audience in their name — adding a
 * write here is a decision to reverse, not a gap to fill.
 *
 * **The scope is first and required**, like every account-bearing connector: `all`
 * for every usable account, or a username. A word that is not an account here is an
 * error naming the accounts that exist, so a typo cannot quietly read the wrong
 * audience.
 *
 * **The reader word is a filter, not a second read.** One 30-day read already holds
 * every count the three readers print, so `@threads:avery:insights` costs the same as
 * `@threads:avery:posts`, and `replies` adds only the replies it fetches. A first word
 * after the account that is not one of the three is the **filter** over the post
 * text, because the likeliest thing to type there is a word from a post.
 *
 * No token appears in a row, a note or an error: the account is named by its username,
 * which is public. What the token does is renew itself, and that is
 * `oauth-accounts.cjs`'s business, not this file's.
 */
const { accessToken, accountScope } = require('../_shared.cjs')
const { text, postReplies } = require('./api.cjs')

const ROW_CEILING = 12
const MAX_PER_SOURCE = 3
const READERS = new Set(['posts', 'replies', 'insights'])
/* A Threads post id is a long decimal — nothing a person types as a word. */
const POST_ID = /^\d{6,}$/

const count = new Intl.NumberFormat('en-gb')
const pct = (rate) => `${(Number(rate) * 100 || 0).toFixed(1)}%`
const day = (iso) => String(iso || '').slice(0, 10)
const excerpt = (value, max = 90) => text(value, max) || '[no text]'

const numbers = (post) =>
  [
    `${count.format(post.views)} views`,
    `${count.format(post.likes)} likes`,
    `${count.format(post.replies)} replies`,
    `${count.format(post.reposts)} reposts`,
  ].join(' · ')

/**
 * The account segment is consumed by the parser; the reader word is still inside
 * `query`, so it is split here — one implementation, used by every reader below.
 */
function splitRead(value) {
  const raw = String(value || '').trim()
  const colon = raw.indexOf(':')
  const word = (colon < 0 ? raw : raw.slice(0, colon)).trim().toLowerCase()
  if (!READERS.has(word)) return { reader: 'posts', query: raw }
  return { reader: word, query: colon < 0 ? '' : raw.slice(colon + 1).trim() }
}

/* ── the rows ──────────────────────────────────────────────────────────── */

/** The account is named in the row only when the mention spans more than one. */
const who = (account, many) => (many ? `@${account} · ` : '')

const postRow = (account, post, many) => ({
  id: post.id,
  label: excerpt(post.text),
  detail: `${who(account, many)}${day(post.date)} · ${numbers(post)}`,
  url: post.permalink,
})

const totalRow = (account, report, many) => ({
  id: `total:${account}`,
  label: `${who(account, many)}${report.totals.posts} post${report.totals.posts === 1 ? '' : 's'} · ${report.window.since} → ${report.window.until}`,
  detail: `${numbers(report.totals)} · like rate ${pct(report.rates.likeRate)} · reply rate ${pct(report.rates.replyRate)}`,
})

/* The report's own eight lines, in the order a person reads them. */
const METRICS = [
  ['posts', 'Posts', (report) => count.format(report.totals.posts)],
  ['views', 'Views', (report) => count.format(report.totals.views)],
  ['likes', 'Likes', (report) => count.format(report.totals.likes)],
  ['replies', 'Replies', (report) => count.format(report.totals.replies)],
  ['reposts', 'Reposts', (report) => count.format(report.totals.reposts)],
  ['like-rate', 'Like rate', (report) => pct(report.rates.likeRate)],
  ['reply-rate', 'Reply rate', (report) => pct(report.rates.replyRate)],
  ['repost-rate', 'Repost rate', (report) => pct(report.rates.repostRate)],
]

/**
 * The eight totals, grouped by metric rather than by account.
 *
 * `@threads:all:insights` over three accounts is eight lines, not twenty-four: a row
 * per metric, naming each account's own figure. Grouping by account instead spent the
 * whole row ceiling on the first account and cut the rest — a number nobody could see
 * is worse than a line with two figures on it.
 */
function insightRows(reports) {
  const many = reports.length > 1
  return METRICS.map(([key, label, value]) => ({
    id: key,
    label,
    detail: reports
      .map(({ account, report }) => (many ? `@${account} ${value(report)}` : value(report)))
      .join(' · '),
  }))
}

/* ── the resolve ───────────────────────────────────────────────────────── */

/**
 * Every reader, over one read per account.
 *
 * Throws when no account could answer — a refusal is a refusal, and an empty row
 * list means what it says: nothing in the window matched. An account whose token the
 * provider rejects is skipped and named on `segment.skipped`, so the turn says one
 * account was left out instead of quietly reading fewer audiences than asked.
 */
async function resolve(ctx, segment, { limit = ROW_CEILING } = {}) {
  const accounts = accountScope('threads', segment.account, 'threads')
  const many = accounts.length > 1
  const { reader, query } = splitRead(segment.query)
  const needle = query.toLowerCase()
  const dashboard = require('./dashboard.cjs')
  const reports = []
  const skipped = []

  for (const account of accounts) {
    try {
      const report = await dashboard.read({ account: account.localpart })
      reports.push({ account: account.localpart, report })
    } catch (error) {
      skipped.push(account.localpart)
      /* The last account failing is the point at which there is nothing to read. */
      if (accounts.length === 1) throw error
    }
  }
  if (!reports.length) {
    throw new Error(
      `@threads:${segment.account}: no account could be read — ${skipped.join(', ')} need a sign-in.`,
    )
  }
  segment.skipped = skipped

  if (reader === 'insights') {
    return insightRows(reports).slice(0, limit)
  }

  if (reader === 'replies') {
    const rows = []
    for (const { account, report } of reports) {
      /* One post by id, or the newest few posts the filter matched — never every
         post in the window: each one is a request per level, and the hour has a
         budget. */
      const posts = POST_ID.test(query)
        ? report.posts.filter((post) => post.id === query).slice(0, 1)
        : report.posts.filter((post) => !needle || post.text.toLowerCase().includes(needle)).slice(0, MAX_PER_SOURCE)
      for (const post of posts) {
        let replies = []
        try {
          replies = await postReplies(await accessToken('threads', account), post.id)
        } catch {
          /* A post the account cannot read its replies for is skipped, not fatal. */
          continue
        }
        for (const reply of replies) {
          rows.push({
            id: reply.id,
            label: excerpt(reply.text, 110),
            detail: [`@${reply.username || 'unknown'}`, day(reply.timestamp), `on ${post.id}`, many ? `in @${account}` : '']
              .filter(Boolean)
              .join(' · '),
            url: post.permalink,
          })
        }
      }
    }
    if (!rows.length) {
      throw new Error(
        `@threads:${segment.account}:replies${query ? `:${query}` : ''} found no reply — ${POST_ID.test(query) ? 'that post has none' : 'the newest matching posts have none'}.`,
      )
    }
    return rows.slice(0, limit)
  }

  const rows = []
  for (const { account, report } of reports) {
    const matched = report.posts.filter(
      (post) =>
        !needle ||
        post.id === query ||
        post.text.toLowerCase().includes(needle) ||
        post.permalink.toLowerCase().includes(needle),
    )
    rows.push(...matched.map((post) => postRow(account, post, many)))
    if (!matched.length && !many) {
      throw new Error(
        needle
          ? `@threads:${account}:posts:${query} matched no post in the last 30 days.`
          : `@threads:${account}:posts found no post in the last 30 days.`,
      )
    }
    if (matched.length) rows.push(totalRow(account, report, many))
  }
  if (!rows.length) throw new Error(`@threads:${segment.account}:posts matched no post in the last 30 days.`)
  return rows.slice(0, limit)
}

/**
 * The composer's suggestions: the accounts this machine holds, then the reader words.
 * Never throws, and never spends a request — a menu must not go blank under the cursor
 * because a token lapsed, and a suggestion list is not worth an API call.
 */
async function preview(fields = [], { limit = 8 } = {}) {
  try {
    const said = String(fields?.[0] || '').trim().toLowerCase()
    const typed = String(fields?.[1] || '').trim().toLowerCase()
    const accounts = require('../../oauth-accounts.cjs')
      .connectedAccounts('threads')
      .filter((entry) => entry.status === 'connected')

    /* One segment typed: the account is what is being chosen. */
    if (fields.length < 2) {
      const rows = accounts
        .filter((entry) => !said || entry.localpart.toLowerCase().includes(said))
        .slice(0, limit)
        .map((entry) => ({
          id: entry.localpart,
          label: entry.localpart,
          detail: 'account',
          mention: `@threads:${entry.localpart}:`,
        }))
      const all = { id: 'all', label: 'all', detail: 'every connected account', mention: '@threads:all:' }
      return (said && !'all'.startsWith(said) ? rows : [...rows, all]).slice(0, limit)
    }

    /* Two segments typed: the reader word, filtered by what is after the account. */
    const readers = [
      { word: 'posts', detail: 'the last 30 days of posts, with their counts' },
      { word: 'insights', detail: 'the 30-day totals and the three rates' },
      { word: 'replies', detail: 'the replies under recent posts' },
    ]
    const rows = readers
      .filter((reader) => !typed || reader.word.startsWith(typed))
      .map((reader) => ({
        id: reader.word,
        label: reader.word,
        detail: reader.detail,
        mention: `@threads:${fields[0]}:${reader.word}`,
      }))
    if (!typed || typed.startsWith('replies')) {
      rows.push({
        id: 'replies:id',
        label: 'replies:',
        detail: 'one post id, for the replies under it',
        mention: `@threads:${fields[0]}:replies:`,
      })
    }
    return rows.slice(0, limit)
  } catch {
    return []
  }
}

module.exports = { ROW_CEILING, MAX_PER_SOURCE, READERS, resolve, preview }
