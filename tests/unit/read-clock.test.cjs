/**
 * The cache-duration rule, in cases.
 *
 * `DESIGN.md`: "the page prints the rule it follows; never hardcode the duration in
 * copy — a `cached 15 min` label that outlives the constant is a lie about the app's
 * own behaviour, and it was paid for once." That rule used to be eight copies of the
 * same eleven lines across eight dashboards. Now it is one module, and this is what
 * keeps it honest: the words come from the payload, and the unit is the largest one
 * that divides it exactly.
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const { cacheNote, cachedUntil, ttlWords } = require('../../src/connectors/parts/readClock.js')

test('a duration is printed in the largest unit that divides it exactly', () => {
  assert.equal(ttlWords(86_400_000), '1 day')
  assert.equal(ttlWords(2 * 86_400_000), '2 days')
  assert.equal(ttlWords(6 * 3_600_000), '6 hours')
  assert.equal(ttlWords(3_600_000), '1 hour')
  assert.equal(ttlWords(5 * 60_000), '5 minutes')
  assert.equal(ttlWords(60_000), '1 minute')
  /* 90 minutes is not an exact hour, so it stays minutes: rounding it to "2 hours"
     would promise a cache that is not the one the constant describes. */
  assert.equal(ttlWords(90 * 60_000), '90 minutes')
})

test('an unknown duration prints nothing rather than a number it did not earn', () => {
  for (const value of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '']) {
    assert.equal(ttlWords(value), '', `${String(value)} must print no duration`)
  }
})

test('the cache note has two grammars and one fact', () => {
  assert.equal(cacheNote({ cached: true, ttlMs: 86_400_000 }), 'served from the 1 day cache')
  assert.equal(cacheNote({ cached: false, ttlMs: 86_400_000 }), 'cached for 1 day')
  /* The calendar page prints `cached 1 hour`; same fact, its own grammar. */
  assert.equal(cacheNote({ cached: false, ttlMs: 3_600_000, style: 'bare' }), 'cached 1 hour')
  /* Nothing known: no duration is invented. */
  assert.equal(cacheNote({ cached: true, ttlMs: 0 }), 'served from the stored cache')
  assert.equal(cacheNote({ cached: false, ttlMs: 0 }), 'cached')
})

test('when the answer stops being good is the read plus its clock', () => {
  const readAt = '2026-03-02T08:00:00.000Z'
  const until = cachedUntil(readAt, 3_600_000)
  /* One hour after the read, printed in the machine's zone: the *instant* is the
     read plus the TTL, and the words are whatever this clock calls that minute. */
  const expected = new Date(Date.parse(readAt) + 3_600_000)
  const hhmm = `${String(expected.getHours()).padStart(2, '0')}:${String(expected.getMinutes()).padStart(2, '0')}`
  assert.ok(until.endsWith(hhmm), `${until} does not end with ${hhmm}`)
  assert.match(until, /^\d{1,2} [A-Z][a-z]{2}, /, `${until} is not a short date`)
  /* An unread or unbounded answer has no expiry to print. */
  assert.equal(cachedUntil('', 3_600_000), '')
  assert.equal(cachedUntil(readAt, 0), '')
})
