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

test('a pasted token goes through the provider that declares it, and nowhere else', () => {
  /* `adopt` is the door a paste-once provider opens. The refusal paths are what this
     checks: a connector whose accounts are added by a consent screen says so and
     writes nothing, and an empty paste never reaches the identity read. */
  const accounts = require('../../electron/oauth-accounts.cjs')
  return Promise.all([
    accounts.adopt({ connector: 'gmail', token: 'anything' }).then((answer) => {
      assert.equal(answer.ok, false)
      assert.equal(answer.code, 'no_paste')
    }),
    accounts.adopt({ connector: 'threads' }).then(
      () => assert.fail('an empty token was accepted'),
      (error) => assert.match(error.message, /Paste a Threads access token first/),
    ),
  ])
})

test('the growth series is one bucket per day, zero-filled, and only the window', () => {
  const posts = [
    { date: '2026-11-26', views: 100, likes: 5, replies: 1, reposts: 0 },
    { date: '2026-11-26', views: 50, likes: 2, replies: 0, reposts: 1 },
    { date: '2026-11-28', views: 30, likes: 1, replies: 3, reposts: 0 },
    /* outside the window: a bar chart about November must not count October */
    { date: '2026-10-01', views: 999, likes: 9, replies: 9, reposts: 9 },
  ]
  const series = threads.dailySeries(posts, { since: '2026-11-25', until: '2026-11-28' })
  assert.equal(series.length, 4, 'a day with no post is a bucket, not a gap')
  assert.deepEqual(
    series.map((row) => row.date),
    ['2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28'],
  )
  assert.deepEqual(series[0], { date: '2026-11-25', posts: 0, views: 0, likes: 0, replies: 0, reposts: 0 })
  assert.deepEqual(series[1], { date: '2026-11-26', posts: 2, views: 150, likes: 7, replies: 1, reposts: 1 })
  assert.equal(series.reduce((sum, row) => sum + row.views, 0), 180)
  assert.deepEqual(threads.dailySeries([], {}), [], 'a window with no ends has no days')
})
