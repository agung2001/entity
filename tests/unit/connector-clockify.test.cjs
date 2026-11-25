/**
 * Clockify's week arithmetic, which is the part that looks right and is off by an
 * hour: a week is seven local midnights, and a week that crosses a DST change is
 * 167 or 169 hours long. Asserted against concrete instants in a zone that is not
 * UTC, because `startUtc` computed in UTC passes every test that only compares it
 * to itself.
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const clockify = require('../../electron/connectors/clockify.cjs')

/* Mon 2026-03-02 → Mon 2026-03-09 in Los Angeles: the week US DST starts, so the
   week is 167 hours (clock forward on Sunday 8 March) and the end offset is PDT. */
test('a week crossing a DST change is 167 hours, not 168', () => {
  const { startUtc, endUtc } = clockify.weekBounds('2026-03-02', 'America/Los_Angeles')
  assert.equal(startUtc, '2026-03-02T08:00:00.000Z')
  assert.equal(endUtc, '2026-03-09T07:00:00.000Z')
  assert.equal(Date.parse(endUtc) - Date.parse(startUtc), 167 * 3_600_000)
})

/* Amsterdam, Mon 2026-03-23 → Mon 2026-03-30: CET (+1) into CEST (+2), 167 hours. */
test('a week crossing the European change ends on the new offset', () => {
  const { startUtc, endUtc } = clockify.weekBounds('2026-03-23', 'Europe/Amsterdam')
  assert.equal(startUtc, '2026-03-22T23:00:00.000Z')
  assert.equal(endUtc, '2026-03-29T22:00:00.000Z')
})

test('the Monday boundary is read in the zone, not on this machine', () => {
  /* 03:00Z on Monday 2 March is still Sunday 19:00 in Los Angeles, so there the
     week in progress is the one that started on 23 February. */
  const now = Date.parse('2026-03-02T03:00:00Z')
  assert.equal(clockify.currentMonday('America/Los_Angeles', now), '2026-02-23')
  assert.equal(clockify.currentMonday('UTC', now), '2026-03-02')
})

test('the DST-forward day is one date, read as a wall clock', () => {
  /* 16:30Z on 8 March is 08:30 on the day the clocks went forward. */
  const noon = Date.parse('2026-03-08T16:30:00Z')
  assert.equal(clockify.zonedDay(noon, 'America/Los_Angeles'), '2026-03-08')
  assert.equal(clockify.zonedDay(Date.parse('2026-03-08T07:30:00Z'), 'America/Los_Angeles'), '2026-03-07')
})

test('a non-Monday week is refused and the message names the rule', () => {
  /* 2026-03-03 is a Tuesday; 2019-12-30 is a Monday before the floor. */
  for (const bad of ['2026-03-03', '2026-03-02x', '2019-12-30', '2999-01-06']) {
    assert.throws(
      () => clockify.validWeek(bad, 'UTC'),
      (error) => /real Monday/.test(error.message) && /YYYY-MM-DD/.test(error.message),
      `${bad} was accepted as a week`,
    )
  }
  assert.equal(clockify.validWeek('2026-03-02', 'America/Los_Angeles'), '2026-03-02')
  assert.equal(clockify.validWeek('this week', 'America/Los_Angeles'), clockify.currentMonday('America/Los_Angeles'))
})
