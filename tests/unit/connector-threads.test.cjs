/**
 * Threads' arithmetic: the 30-day window, the four totals and the three rates.
 *
 * The rates are the part that looks right and is off in one direction — a rate is a
 * share of the **views**, so a window with no views has no rate at all. Dividing by a
 * zero there printed `Infinity` and every page that formatted it said `Infinity%`.
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const threads = require('../../electron/connectors/threads/api.cjs')

test('windowSince(30) is the civil date 30 days back', () => {
  const since = threads.windowSince(30)
  assert.match(since, /^\d{4}-\d{2}-\d{2}$/)
  const days = (Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86_400_000
  assert.equal(days, 30)
})

test('no posts adds up to four zeroes, not to nothing', () => {
  assert.deepEqual(threads.sumMetrics([]), { views: 0, likes: 0, replies: 0, reposts: 0 })
  assert.deepEqual(threads.sumMetrics(), { views: 0, likes: 0, replies: 0, reposts: 0 })
})

test('two posts add each count field by field', () => {
  const posts = [
    { views: 100, likes: 10, replies: 2, reposts: 1 },
    { views: 50, likes: 5, replies: 1, reposts: 1 },
  ]
  assert.deepEqual(threads.sumMetrics(posts), { views: 150, likes: 15, replies: 3, reposts: 2 })
  assert.deepEqual(threads.rates(posts), { likeRate: 0.1, replyRate: 0.02, repostRate: 2 / 150 })
})

test('a window with no views has no rate, never Infinity', () => {
  assert.deepEqual(threads.rates([]), { likeRate: 0, replyRate: 0, repostRate: 0 })
  const noViews = threads.rates([{ views: 0, likes: 5, replies: 1, reposts: 1 }])
  assert.deepEqual(noViews, { likeRate: 0, replyRate: 0, repostRate: 0 })
  for (const value of Object.values(noViews)) assert.ok(Number.isFinite(value))
})
