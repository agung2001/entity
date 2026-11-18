/**
 * Chat retention (ENTITY-20) — the rule that archives a silent thread, and the
 * rule that finally empties the archive.
 *
 * These pin the things that are easy to get subtly wrong and expensive to notice:
 * ② counts days **in the archive** (not silence), so the death line is
 * `archiveAfter + deleteAfter`; the protections hold a thread back from the pass
 * that would otherwise take it; a pass is idempotent, so a scheduler that runs
 * every thirty minutes cannot re-stamp an archive date; and a thread with a turn
 * in flight is never touched.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-retention-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('../../electron/workspace-store.cjs')
const entities = require('../../electron/entity-store.cjs')
const chats = require('../../electron/chat-store.cjs')
const retention = require('../../electron/retention-store.cjs')

const DAY = 24 * 60 * 60 * 1000
let seq = 0

/** One workspace with a set of threads described in days of silence. */
function workspaceWith(threads) {
  const workspace = workspaces.create({ label: `retention-${++seq}` })
  entities.scaffold({ workspace: workspace.id, name: 'chief-of-staff', harness: 'pi' })
  const record = workspaces.open(workspace.id)
  const dir = path.join(record.path, 'chats')
  fs.mkdirSync(dir, { recursive: true })
  const now = Date.now()
  for (const thread of threads) {
    const at = new Date(now - thread.silence * DAY).toISOString()
    const id = `t_${thread.name}`
    const doc = {
      schema: 1,
      id,
      entity: 'chief-of-staff',
      machine: 'local',
      harness: 'pi',
      title: `${thread.name} thread`,
      createdAt: at,
      updatedAt: at,
      messages: [
        { who: 'me', text: `ask ${thread.name}`, at },
        { who: 'agent', text: 'done', at },
      ],
    }
    if (thread.pinned) doc.pinned = true
    if (thread.inArchive !== undefined) {
      doc.archived = true
      doc.archivedAt = new Date(now - thread.inArchive * DAY).toISOString()
    }
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(doc, null, 2))
  }
  return { workspace, record, file: (name) => path.join(dir, `t_${name}.json`) }
}

const ids = (rows) => rows.map((row) => row.id).sort()

test('the thresholds are two different clocks, and the death line is their sum', () => {
  const { workspace } = workspaceWith([
    { name: 'recent', silence: 2 },
    { name: 'silent', silence: 40 },
    { name: 'young-archive', silence: 60, inArchive: 10 },
    { name: 'old-archive', silence: 400, inArchive: 200 },
  ])

  const state = retention.analyse({ workspace: workspace.id })
  assert.equal(state.thresholds.archiveAfterDays, 30)
  assert.equal(state.thresholds.deleteAfterDays, 180)
  /* ② counts days in the archive, so a thread that goes silent today dies at 210 */
  assert.equal(state.thresholds.deathDays, 210)

  /* an active thread past ① is archived; an archived one past ② is deleted, and a
     400-day-silent thread that was archived 200 days ago is the second kind */
  assert.deepEqual(ids(state.forecast.list), ['t_old-archive', 't_silent'])
  assert.equal(state.forecast.archive.threads, 1)
  assert.equal(state.forecast.delete.threads, 1)
  /* "young-archive" is archived but only 10 days in: ② does not reach it */
  assert.equal(
    state.legend.keep.threads + state.legend.arch.threads + state.legend.del.threads,
    4,
  )
  assert.equal(state.legend.del.threads, 1)
})

test('a unit is a multiplier, and Never is the unit that turns a rule off', () => {
  const { workspace } = workspaceWith([{ name: 'silent', silence: 40 }])

  retention.save({ workspace: workspace.id, patch: { archiveAfter: { n: 2, unit: 'weeks' } } })
  assert.equal(retention.analyse({ workspace: workspace.id }).thresholds.archiveAfterDays, 14)
  assert.equal(retention.analyse({ workspace: workspace.id }).forecast.archive.threads, 1)

  retention.save({ workspace: workspace.id, patch: { archiveAfter: { n: 0, unit: 'never' } } })
  const off = retention.analyse({ workspace: workspace.id })
  assert.equal(off.thresholds.archiveAfterDays, 0)
  /* nothing is archived on its own, so a 40-day thread is simply kept */
  assert.equal(off.forecast.archive.threads, 0)
  assert.equal(off.legend.keep.threads, 1)

  /* a value that makes no sense is clamped rather than stored */
  retention.save({ workspace: workspace.id, patch: { archiveAfter: { n: -3, unit: 'days' } } })
  assert.equal(retention.analyse({ workspace: workspace.id }).thresholds.archiveAfterDays, 0)
})

test('each protection holds its own threads back, and says how many', () => {
  const { workspace } = workspaceWith([
    { name: 'pinned', silence: 50, pinned: true },
    { name: 'plain', silence: 50 },
    { name: 'doomed-artifact', silence: 300, inArchive: 200 },
    { name: 'doomed-plain', silence: 300, inArchive: 200 },
  ])

  const state = retention.analyse({ workspace: workspace.id })
  /* the pinned thread is silent past ① but is never archived */
  assert.deepEqual(ids(state.forecast.list), [
    't_doomed-artifact',
    't_doomed-plain',
    't_plain',
  ])
  assert.equal(state.forecast.held.pinned, 1)

  /* ③ is "never delete a thread that saved an artifact" — with no artifacts on
     the shelf both doomed threads are deletable */
  assert.equal(state.forecast.delete.threads, 2)

  retention.save({ workspace: workspace.id, patch: { protectPinned: false } })
  assert.equal(retention.analyse({ workspace: workspace.id }).forecast.archive.threads, 2)
})

test('a pass archives and deletes exactly the forecast, and running it twice is a no-op', () => {
  const { workspace, file } = workspaceWith([
    { name: 'fresh', silence: 1 },
    { name: 'silent', silence: 45 },
    { name: 'archived-fresh', silence: 50, inArchive: 5 },
    { name: 'archived-old', silence: 400, inArchive: 200 },
  ])

  const before = retention.analyse({ workspace: workspace.id })
  assert.equal(before.forecast.archive.threads, 1)
  assert.equal(before.forecast.delete.threads, 1)

  const dry = retention.run({ workspace: workspace.id, dryRun: true })
  assert.deepEqual(dry.archived, ['t_silent'])
  assert.deepEqual(dry.deleted, ['t_archived-old'])
  /* a dry run writes nothing */
  assert.equal(JSON.parse(fs.readFileSync(file('silent'), 'utf8')).archived, undefined)

  const pass = retention.run({ workspace: workspace.id })
  assert.deepEqual(pass.archived, ['t_silent'])
  assert.deepEqual(pass.deleted, ['t_archived-old'])
  assert.equal(fs.existsSync(file('archived-old')), false)

  const archived = JSON.parse(fs.readFileSync(file('silent'), 'utf8'))
  assert.equal(archived.archived, true)
  assert.ok(archived.archivedAt)
  /* the thread that was already in the archive keeps the date it went in */
  assert.ok(
    JSON.parse(fs.readFileSync(file('archived-fresh'), 'utf8')).archivedAt,
    'archived-fresh was never touched',
  )

  /* the scheduler runs every thirty minutes: a second pass must find nothing */
  const again = retention.run({ workspace: workspace.id })
  assert.deepEqual(again.archived, [])
  assert.deepEqual(again.deleted, [])
  assert.equal(
    JSON.parse(fs.readFileSync(file('silent'), 'utf8')).archivedAt,
    archived.archivedAt,
    're-running never re-stamps the archive date',
  )

  /* and each pass is recorded, so the card can say when it last ran and what it
     did — the second run reports the truth about itself (nothing) */
  assert.ok(pass.state.last.at)
  assert.equal(pass.state.last.archived, 1)
  assert.equal(pass.state.last.deleted, 1)
  const after = retention.analyse({ workspace: workspace.id })
  assert.equal(after.last.archived, 0)
  assert.equal(after.last.deleted, 0)
  assert.equal(after.last.error, '')
})

test('③ keeps a doomed thread that saved an artifact, and only then', () => {
  const { workspace, record, file } = workspaceWith([
    { name: 'saved', silence: 300, inArchive: 200 },
    { name: 'empty', silence: 300, inArchive: 200 },
  ])

  /* a real file on the shelf, named by the turn that wrote it — the same
     evidence rule the transcript's chips use */
  const dir = path.join(record.path, 'artifacts', 'notes')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'keep.md'), '# keep me\n')
  const doc = JSON.parse(fs.readFileSync(file('saved'), 'utf8'))
  doc.messages[1].text = 'Wrote artifact://notes/keep.md for you.'
  fs.writeFileSync(file('saved'), JSON.stringify(doc, null, 2))

  const guarded = retention.analyse({ workspace: workspace.id })
  assert.equal(guarded.forecast.held.artifact, 1)
  assert.equal(guarded.forecast.delete.threads, 1, 'only the thread with no artifact is doomed')
  /* a held thread is not in tonight's list: the pass is not going to touch it */
  assert.deepEqual(ids(guarded.forecast.list), ['t_empty'])
  /* The chart is the rule, the forecast is the pass: both doomed threads sit past
     the line, and only one of them is actually removed. */
  assert.equal(guarded.legend.del.threads, 2, 'the legend describes the axis')
  assert.equal(guarded.legend.arch.threads, 0)

  /* the guard is a switch, not a law: turning it off puts the thread back in */
  retention.save({ workspace: workspace.id, patch: { protectArtifacts: false } })
  const loose = retention.analyse({ workspace: workspace.id })
  assert.equal(loose.forecast.delete.threads, 2)
  assert.equal(loose.forecast.held.artifact, 0)

  /* and the pass honours the switch it was given */
  const pass = retention.run({ workspace: workspace.id })
  assert.deepEqual(pass.deleted.sort(), ['t_empty', 't_saved'])
})

test('one schedule drives both cards, and a chat cadence starts no artifact clock', () => {
  const { workspace, record } = workspaceWith([{ name: 'quiet', silence: 1 }])
  assert.equal(
    retention.analyse({ workspace: workspace.id }).sharedSchedule,
    false,
    'a workspace with no artifact rule is still scheduling this machine alone',
  )

  retention.save({ workspace: workspace.id, patch: { archiveEvery: 'week', archiveBy: '04:30' } })

  const shared = JSON.parse(fs.readFileSync(path.join(record.path, 'workspace.json'), 'utf8')).artifactRetention
  assert.equal(shared.archiveEvery, 'week')
  assert.equal(shared.archiveBy, '04:30')
  assert.equal(shared.last?.createdAt || '', '', 'a chat cadence does not opt the artifact sweep in')
  assert.equal(retention.read({ workspace: workspace.id }).archiveEvery, 'week')
  assert.equal(retention.analyse({ workspace: workspace.id }).sharedSchedule, true)
})

test('a schedule is a cadence plus a deadline, and a missed one is late', () => {
  const { workspace } = workspaceWith([{ name: 'quiet', silence: 1 }])
  const now = new Date('2026-06-10T10:00:00')

  retention.save({ workspace: workspace.id, patch: { archiveEvery: 'day', archiveBy: '03:00' } })
  const daily = retention.scheduleInfo('archive', retention.read({ workspace: workspace.id, now }), now)
  assert.equal(daily.automatic, true)
  assert.equal(daily.by, '03:00')
  /* the rule was created "now", so the first deadline is a day later at 03:00 */
  assert.equal(daily.late, false)
  assert.equal(new Date(daily.dueAt).getHours(), 3)

  retention.save({ workspace: workspace.id, patch: { archiveEvery: 'manual' } })
  const manual = retention.scheduleInfo('archive', retention.read({ workspace: workspace.id, now }), now)
  assert.equal(manual.automatic, false)
  assert.equal(manual.late, false)
  assert.equal(manual.dueAt, '')
})

test('a deadline that passed while the app was shut comes due at the next launch', () => {
  const { workspace, record } = workspaceWith([{ name: 'quiet', silence: 1 }])
  const created = new Date('2026-06-01T09:00:00')
  retention.save({ workspace: workspace.id, patch: { archiveEvery: 'day', archiveBy: '03:00' } })

  /* rewrite the stamp the way an app that has been closed since June 1st would */
  const file = retention.settingsFile(record)
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  doc.last.createdAt = created.toISOString()
  fs.writeFileSync(file, JSON.stringify(doc, null, 2))

  const now = new Date('2026-06-10T10:00:00')
  const due = retention.scheduleInfo('archive', retention.read({ workspace: workspace.id, now }), now)
  assert.equal(due.late, true, 'nine days later, the pass is owed')
  assert.equal(new Date(due.dueAt).getDate(), 2, 'the deadline it missed was June 2nd 03:00')
})

test('the tick only sweeps a workspace whose rule was looked at', () => {
  const touched = workspaceWith([{ name: 'silent', silence: 400 }])
  const untouched = workspaceWith([{ name: 'silent', silence: 400 }])

  /* a workspace with no rule file has not opted in */
  fs.rmSync(retention.settingsFile(untouched.record), { force: true })
  const quiet = retention.read({ workspace: touched.workspace.id, now: new Date() })
  assert.ok(quiet.last.createdAt)

  /* backdate the archive stamp so the pass is due */
  const file = retention.settingsFile(touched.record)
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  doc.last.createdAt = new Date(Date.now() - 3 * DAY).toISOString()
  fs.writeFileSync(file, JSON.stringify(doc, null, 2))
  fs.rmSync(retention.settingsFile(untouched.record), { force: true })

  retention.tick({ now: new Date() })

  assert.equal(
    JSON.parse(fs.readFileSync(path.join(touched.record.path, 'chats', 't_silent.json'), 'utf8')).archived,
    true,
    'the opted-in workspace was swept',
  )
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(untouched.record.path, 'chats', 't_silent.json'), 'utf8')).archived,
    undefined,
    'a workspace nobody opened was left alone',
  )
})

test('the bands cover every age, and a band never straddles two thresholds', () => {
  const { workspace } = workspaceWith([
    { name: 'a', silence: 0 },
    { name: 'b', silence: 6 },
    { name: 'c', silence: 7 },
    { name: 'd', silence: 900 },
  ])
  const state = retention.analyse({ workspace: workspace.id })
  const total = state.bands.reduce((sum, band) => sum + band.threads, 0)
  assert.equal(total, 4, 'every thread lands in exactly one band')
  assert.equal(state.bands[0].threads, 2, '0 and 6 share the first band')
  assert.equal(state.bands[1].threads, 1, '7 opens the second band')
  assert.equal(state.bands[13].threads, 1, 'the last band is open-ended')
  /* a thread older than the last tick is still counted, not dropped */
  assert.equal(state.bands[13].from, 540)
})
