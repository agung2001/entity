/**
 * The dashboard file, read as data.
 *
 * One module owns every decision the band and the page make from a file, so
 * these tests are the contract: a newer schema keeps its panels and says why, a
 * figure with no source does not render, a failed source is quoted verbatim, the
 * band is capped at four and absent without a snapshot, and the ring stays 90.
 */
const assert = require('node:assert/strict')
const test = require('node:test')

const load = () => import('../../src/lib/dashboard.js')

const NOW = new Date('2025-05-05T08:00:00Z')

function fixture(extra = {}) {
  return {
    kind: 'entity.dashboard',
    v: 2,
    title: 'Workspace pulse',
    producer: { entity: 'pulse' },
    schedule: { cadence: 'daily', at: '06:30', grace: '2h', enabled: true },
    layout: [
      { id: 'sprint', kind: 'stat', span: 'third' },
      { id: 'done', kind: 'series', span: 'third' },
      { id: 'hours', kind: 'progress', span: 'third' },
      { id: 'issues', kind: 'table', span: 'half' },
      { id: 'reviews', kind: 'stat', span: 'half' },
      { id: 'ring', kind: 'note', span: 'half' },
    ],
    snapshot: {
      at: '2025-05-05T06:31:12Z',
      run: 'r_1',
      sources: [
        { id: 'tracker', label: 'tracker', status: 'ok', asOf: '2025-05-05T06:31:00Z', durationMs: 4100 },
        { id: 'gh', label: 'gh', status: 'failed', error: 'gh: not authenticated on this machine.' },
      ],
      panels: [
        { id: 'sprint', kind: 'stat', span: 'third', value: 17, unit: 'open', delta: '−4 since Monday', tone: 'up', evidence: [{ label: 'tracker', value: 'my open issues' }] },
        { id: 'done', kind: 'series', span: 'third', value: 23, points: [3, 5, 9], evidence: [{ label: 'tracker' }] },
        { id: 'hours', kind: 'progress', span: 'third', value: 31.5, total: 40, evidence: [{ label: 'tracker' }] },
        { id: 'issues', kind: 'table', span: 'half', columns: [{ label: 'id' }, { label: 'title' }], rows: [['A-1', 'One']], evidence: [{ label: 'tracker' }] },
        { id: 'reviews', kind: 'stat', span: 'half', source: 'gh', value: 3, evidence: [{ label: 'gh', value: 'waiting reviews' }] },
        { id: 'ring', kind: 'note', span: 'half', note: 'ring keeps 90 passes', evidence: [{ label: 'tracker' }] },
      ],
    },
    history: [{ at: '2025-05-05T06:31:12Z', values: { 'sprint.open': 17 }, durationMs: 11300, cost: 0.04 }],
    ...extra,
  }
}

test('a newer schema or an unknown kind keeps every panel and says why', async () => {
  const { parseDashboard, UNSUPPORTED_SENTENCE } = await load()
  const newer = parseDashboard(fixture({ v: 3 }), { now: NOW })
  assert.equal(newer.state, 'unsupported')
  assert.equal(newer.panels.length, 6, 'a newer file still holds its places')
  for (const panel of newer.panels) {
    assert.equal(panel.state, 'unsupported')
    assert.equal(panel.sentence, UNSUPPORTED_SENTENCE)
  }
  const wrong = parseDashboard(fixture({ kind: 'entity.notADashboard' }), { now: NOW })
  assert.equal(wrong.state, 'unsupported')
  assert.ok(wrong.panels.every((panel) => panel.state === 'unsupported'))
  /* not JSON, not an object: one sentence, never a blank card */
  assert.equal(parseDashboard('{oops', { now: NOW }).state, 'unsupported')
  assert.equal(parseDashboard(null, { now: NOW }).panels.length, 0)
})

test('a panel with no evidence is dropped, not drawn unsourced', async () => {
  const { parseDashboard } = await load()
  const doc = fixture()
  doc.snapshot.panels.push({ id: 'ghost', kind: 'stat', value: 99, span: 'half' })
  doc.snapshot.panels.push({ id: 'chart', kind: 'donut', evidence: [{ label: 'tracker' }] })
  const parsed = parseDashboard(doc, { now: NOW })
  assert.deepEqual(parsed.panels.map((panel) => panel.id), ['sprint', 'done', 'hours', 'issues', 'reviews', 'ring', 'chart'])
  const unknown = parsed.panels.find((panel) => panel.id === 'chart')
  assert.equal(unknown.kind, 'unsupported')
  assert.equal(unknown.state, 'unsupported')
})

test('a failed source keeps the producer sentence and turns its panel failed', async () => {
  const { parseDashboard } = await load()
  const parsed = parseDashboard(fixture(), { now: NOW })
  const failed = parsed.panels.find((panel) => panel.id === 'reviews')
  assert.equal(failed.state, 'failed')
  assert.equal(failed.error, 'gh: not authenticated on this machine.')
  /* the rest of the document is unaffected by one bad source */
  assert.equal(parsed.state, 'fresh')
  assert.equal(parsed.panels.find((panel) => panel.id === 'sprint').state, 'fresh')
})

test('the band is at most four panels, in layout order, and empty without a snapshot', async () => {
  const { parseDashboard, bandPanels, spanColumns, freshness } = await load()
  const parsed = parseDashboard(fixture(), { now: NOW })
  assert.deepEqual(bandPanels(parsed).map((panel) => panel.id), ['sprint', 'done', 'hours', 'issues'])
  assert.deepEqual(bandPanels(parseDashboard(fixture({ snapshot: null }), { now: NOW })), [])
  assert.equal(parseDashboard(fixture({ snapshot: null }), { now: NOW }).state, 'never')
  assert.deepEqual([spanColumns('third'), spanColumns('half'), spanColumns('full')], [2, 3, 6])
  /* past grace is `stale`, and the stamp says how old it is */
  const stale = freshness('2025-05-04T03:00:00Z', '2h', NOW)
  assert.equal(stale.state, 'stale')
  assert.match(stale.asOfLabel, /^as of yesterday /)
  assert.equal(stale.ageLabel, '29 h old')
})

test('a fully failed snapshot invents no zero and quotes one source', async () => {
  const { parseDashboard } = await load()
  const doc = fixture()
  doc.snapshot.sources = [{ id: 'gh', label: 'gh', status: 'failed', error: 'gh: not authenticated on this machine.' }]
  const parsed = parseDashboard(doc, { now: NOW })
  assert.equal(parsed.state, 'failed')
  assert.equal(parsed.sentence, 'gh: not authenticated on this machine.')
})

test('the history ring keeps the last ninety passes', async () => {
  const { pushHistory, MAX_HISTORY, parseDashboard } = await load()
  let ring = []
  for (let i = 0; i < MAX_HISTORY + 5; i += 1) ring = pushHistory(ring, { at: `pass-${i}` })
  assert.equal(ring.length, MAX_HISTORY)
  assert.equal(ring[0].at, 'pass-5')
  assert.equal(ring.at(-1).at, `pass-${MAX_HISTORY + 4}`)
  /* a file that already carries more than 90 is trimmed on read, not trusted */
  const doc = fixture({ history: Array.from({ length: 120 }, (_, i) => ({ at: `p${i}` })) })
  assert.equal(parseDashboard(doc, { now: NOW }).history.length, MAX_HISTORY)
})

/* One id, one path: the writer and the reader resolve the same root. A dashboard
   is produced by an entity, not shared by a person, so it has no scope claim —
   which means the shelf's own adoption moves it, and every later read has to
   follow it there. */
test('a written dashboard is found again after the shelf adopts its root', () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  process.env.ENTITY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-dashboard-root-'))
  const workspaces = require('../../electron/workspace-store.cjs')
  const artifacts = require('../../electron/artifact-store.cjs')
  const store = require('../../electron/dashboard-store.cjs')
  const workspace = workspaces.create({ label: 'demo-workspace' }).id
  const doc = fixture()
  const written = store.write({ workspace, id: 'probe', doc })
  const first = store.read({ workspace, id: 'probe.dashboard' })
  artifacts.adoptUnclaimed(workspaces.open(workspace))
  const again = store.read({ workspace, id: 'probe.dashboard' })
  const row = artifacts.list({ workspace }).items.find((item) => item.id === 'probe.dashboard')
  const listed = store.list({ workspace }).items.find((item) => item.id === 'probe.dashboard')
  /* one path, and it is the root the read prefers rather than the shared tree */
  assert.equal(written.path, first.path)
  assert.equal(again.path, first.path)
  assert.equal(row.scope, 'personal')
  assert.equal(listed.scope, row.scope)
  assert.equal(listed.hasSnapshot, true)
})
