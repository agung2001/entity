/**
 * The YouTrack dashboard's arithmetic, without a server.
 *
 * The five cases below are the five ways this page can lie while looking right:
 * a `null` read printed as a confident `0`; a team table whose column does not add
 * up to its own foot; an unassigned row nobody counted; a seven-day tile that is
 * really a thirty-day one; a chart with a missing day, which reads as "nothing
 * happened" rather than "not drawn".
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const report = require('../../src/lib/youtrackReport.js').default
const { num, tiles } = require('../../src/lib/youtrackReport.js')

const NOW = Date.parse('2026-11-25T09:00:00Z')
const at = (minusDays) => new Date(NOW - minusDays * 86_400_000).toISOString().slice(0, 10) + ' 09:00:00'
const issue = (id, extra = {}) => ({
  id,
  project: 'DEMO',
  state: 'Submitted',
  priority: 'Normal',
  assignees: [],
  createdAt: at(60),
  updatedAt: at(0),
  resolvedAt: '',
  ...extra,
})
const ME = { login: 'avery', name: 'Avery' }

test('the seats sum to the member rows and issues is the row count', () => {
  const unresolved = [
    issue('DEMO-1', { assignees: ['avery', 'blake'], state: 'In Progress' }),
    issue('DEMO-2', { assignees: ['avery'] }),
    issue('DEMO-3'),
  ]
  const table = report({ unresolved, resolved: [], me: ME }, NOW).team
  assert.equal(table.issues, 3)
  assert.equal(table.rows.length, 2, 'the unassigned issue is nobody a seat')
  assert.equal(table.seatTotal, table.rows.reduce((sum, row) => sum + row.open, 0))
  assert.equal(table.seatTotal, 3, 'avery 2 + blake 1, over two issues')
  assert.deepEqual(table.rows.map((row) => row.login), ['avery', 'blake'], 'busiest seat first')
})

test('an issue with no assignees counts as unassigned, not as a seat', () => {
  const unresolved = [issue('DEMO-4'), issue('DEMO-5', { assignees: ['blake'] })]
  const table = report({ unresolved, resolved: [], me: ME }, NOW).team
  assert.equal(table.unassigned, 1)
  assert.equal(table.rows.length, 1)
  assert.equal(tiles(unresolved, [], ME, NOW).team.find((tile) => tile.key === 'unassigned').value, 1)
})

test('resolved 7 d over the 30-day read counts only the last seven', () => {
  const resolved = [
    issue('DEMO-6', { resolvedAt: at(1) }),
    issue('DEMO-7', { resolvedAt: at(6) }),
    issue('DEMO-8', { resolvedAt: at(9) }),
    issue('DEMO-9', { resolvedAt: at(29) }),
  ]
  const out = report({ unresolved: [], resolved, me: ME }, NOW)
  assert.equal(out.totals.resolved30, 4)
  assert.equal(out.totals.resolved7, 2)
  assert.equal(out.tiles.team.find((tile) => tile.key === 'done7').value, 2)
})

test('a null read prints —, a real zero prints 0', () => {
  const broken = report({ unresolved: null, resolved: [], me: ME }, NOW)
  assert.equal(broken.partial, true)
  assert.equal(num(broken.totals.unresolved), '—')
  assert.equal(broken.tiles.team.find((tile) => tile.key === 'progress').value, null)
  assert.equal(broken.tiles.team.find((tile) => tile.key === 'done7').value, 0, 'read 2 answered')
  assert.equal(num(report({ unresolved: [], resolved: [], me: ME }, NOW).totals.unresolved), '0')
})

test('flow returns seven entries, including the days with nothing in them', () => {
  const unresolved = [issue('DEMO-10', { createdAt: at(0) })]
  const resolved = [issue('DEMO-11', { createdAt: at(2), resolvedAt: at(2) })]
  const days = report({ unresolved, resolved, me: ME }, NOW).flow.days
  assert.equal(days.length, 7)
  assert.equal(days[0].created + days[0].resolved, 0, 'a quiet day is drawn, not dropped')
  assert.equal(days[6].created, 1)
  assert.equal(days[4].created, 1)
  assert.equal(days[4].resolved, 1)
})
