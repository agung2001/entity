/**
 * Chat retention — when a thread archives itself, and when it is gone.
 *
 * ENTITY-18 gave a thread a reversible middle state. This is the rule that puts
 * threads there without a click, and the rule that finally empties it. The shape
 * is deliberately the same as the artifacts shelf (ENTITY-16): two thresholds
 * drawn on one histogram, a cadence plus a deadline per pass, three protections,
 * and a forecast of what the next pass actually costs.
 *
 * Three rules are load-bearing:
 *
 *   1. **The two thresholds are different clocks.** ① counts silence since the
 *      thread's last message. ② counts days *in the archive* — so a thread that
 *      goes silent today dies at `archiveAfter + deleteAfter` days of silence,
 *      and moving ① moves both lines. Copy that says "delete after 180 days"
 *      while the line sits at 210 is the most likely bug in this feature.
 *   2. **The schedule is a cadence and a deadline, not an hour.** The app is open
 *      all day and shut at night, so a fixed wall-clock hour is a time nothing
 *      runs at. `every day by 03:00` means "at most one day behind, and not
 *      before 03:00"; a deadline missed while the machine was shut is caught by
 *      the boot tick (`START_DELAY_MS`), which is why the copy says "or at the
 *      next launch".
 *   3. **Nothing irreversible happens without a threshold in front of it.** The
 *      archive is reversible and gets no protection from a confirm; the delete is
 *      `fs.rmSync` and therefore honours every protection, and only ever touches
 *      threads that are *already archived*.
 *
 * The thresholds live in the workspace (`<ws>/retention.json`). The **schedule**
 * is shared with the artifact shelf's rule in `workspace.json`: one workspace has
 * one sweep schedule, and both cards read it. The executor choice does not apply
 * here — chats never sync, so every machine sweeps its own at that schedule.
 */
const fs = require('node:fs')
const path = require('node:path')
const workspaces = require('./workspace-store.cjs')
const chats = require('./chat-store.cjs')

const FILE = 'retention.json'
const SCHEMA = 1
const DAY_MS = 24 * 60 * 60 * 1000
const START_DELAY_MS = 60_000
const INTERVAL_MS = 30 * 60_000
const MAX_DAYS = 3650

/** `manual` is the store's own word for "only when I ask" (backup-store MODES). */
const EVERY = ['day', 'week', 'month', 'manual']
const EVERY_INFO = [
  { id: 'day', label: 'every day', days: 1, desc: 'One pass a day.' },
  { id: 'week', label: 'every week', days: 7, desc: 'One pass a week.' },
  { id: 'month', label: 'every month', days: 30, desc: 'One pass a month.' },
  { id: 'manual', label: 'only when I ask', days: 0, desc: 'No automatic pass.' },
]
const EVERY_DAYS = { day: 1, week: 7, month: 30 }
const UNIT_DAYS = { days: 1, weeks: 7, months: 30 }
const UNITS = ['days', 'weeks', 'months', 'never']

/* The chart's 14 bands, oldest last. A band is cut on its lower edge, so a thread
   belongs to exactly one column and no bar straddles two regions. */
const BANDS = [
  [0, 7],
  [7, 14],
  [14, 21],
  [21, 30],
  [30, 45],
  [45, 60],
  [60, 90],
  [90, 120],
  [120, 180],
  [180, 240],
  [240, 300],
  [300, 365],
  [365, 540],
  [540, Infinity],
]

const DEFAULTS = {
  schema: SCHEMA,
  archiveAfter: { n: 30, unit: 'days' },
  deleteAfter: { n: 180, unit: 'days' },
  archiveEvery: 'day',
  archiveBy: '03:00',
  deleteEvery: 'week',
  deleteBy: '03:00',
  protectPinned: true,
  protectRunning: true,
  protectArtifacts: true,
  last: { at: '', createdAt: '', archiveAt: '', deleteAt: '', archived: 0, deleted: 0, error: '' },
}

/* ── small helpers ─────────────────────────────────────────────────── */

const timeOf = (value) => {
  const ms = new Date(String(value || '')).getTime()
  return Number.isFinite(ms) ? ms : 0
}

const clampDays = (value, fallback) => {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(MAX_DAYS, Math.max(0, n))
}

const validClock = (value) =>
  /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(value || '')) ? String(value) : ''

/** Days of silence, floored, never negative. `null` for a thread with no clock. */
const daysBetween = (thenMs, nowMs) => {
  if (!thenMs) return 0
  return Math.max(0, Math.floor((nowMs - thenMs) / DAY_MS))
}

function settingsFile(record) {
  return path.join(record.path, FILE)
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
  return value
}

/** `<ws>/chats/*.json` → the raw byte size of the transcript. */
function bytesOf(record, id) {
  try {
    return fs.statSync(path.join(record.path, 'chats', `${id}.json`)).size
  } catch {
    return 0
  }
}

/* ── the threshold pair ───────────────────────────────────────────── */

/** `{ n: 30, unit: 'days' }` → 30 days. `never` → 0, which reads as "off". */
function daysOf(pair, fallback) {
  if (!pair || typeof pair !== 'object') return fallback
  const unit = UNITS.includes(pair.unit) ? pair.unit : 'days'
  if (unit === 'never') return 0
  const n = clampDays(pair.n, 0)
  return Math.min(MAX_DAYS, n * UNIT_DAYS[unit])
}

function pairOf(raw, fallback) {
  const unit = UNITS.includes(raw?.unit) ? raw.unit : fallback.unit
  return { n: unit === 'never' ? 0 : clampDays(raw?.n, fallback.n), unit }
}

function normalise(raw = {}) {
  const every = (value, fallback) => (EVERY.includes(value) ? value : fallback)
  return {
    schema: SCHEMA,
    archiveAfter: pairOf(raw.archiveAfter, DEFAULTS.archiveAfter),
    deleteAfter: pairOf(raw.deleteAfter, DEFAULTS.deleteAfter),
    archiveEvery: every(raw.archiveEvery, DEFAULTS.archiveEvery),
    archiveBy: validClock(raw.archiveBy) || DEFAULTS.archiveBy,
    deleteEvery: every(raw.deleteEvery, DEFAULTS.deleteEvery),
    deleteBy: validClock(raw.deleteBy) || DEFAULTS.deleteBy,
    protectPinned: raw.protectPinned === undefined ? true : Boolean(raw.protectPinned),
    protectRunning: raw.protectRunning === undefined ? true : Boolean(raw.protectRunning),
    protectArtifacts: raw.protectArtifacts === undefined ? true : Boolean(raw.protectArtifacts),
    last: {
      /* `at` is a pass that happened. `createdAt` is when the rule started, which
         is the clock the first deadline is measured from — a card that says "last
         pass just now" before any pass has run is the lie this field prevents. */
      at: String(raw.last?.at || ''),
      createdAt: String(raw.last?.createdAt || ''),
      archiveAt: String(raw.last?.archiveAt || ''),
      deleteAt: String(raw.last?.deleteAt || ''),
      archived: Number(raw.last?.archived) || 0,
      deleted: Number(raw.last?.deleted) || 0,
      error: String(raw.last?.error || ''),
    },
  }
}

/**
 * Read one workspace's rule.
 *
 * A workspace that has never been opened on this tab has no file. The first read
 * **writes the defaults**, which is what starts the clock: without a `last` stamp
 * the first pass on a fresh install would archive every old thread at once. Until
 * a member visits the tab, the sweep leaves the workspace alone.
 */
/** The four schedule fields one workspace has, on both cards. */
const SHARED = ['archiveEvery', 'archiveBy', 'deleteEvery', 'deleteBy']

/**
 * The shared schedule, overlaid on a rule read from disk.
 *
 * The artifact rule in `workspace.json` owns it (it is the one whose executor has
 * to know when to wake), so a change made on either card applies to both. An
 * older workspace with only `retention.json` keeps its own value until one is
 * written.
 */
function withSharedSchedule(record, settings) {
  const shared = record.artifactRetention
  if (!shared || typeof shared !== 'object') return settings
  const every = (value, fallback) => (EVERY.includes(value) ? value : fallback)
  return {
    ...settings,
    archiveEvery: every(shared.archiveEvery, settings.archiveEvery),
    archiveBy: validClock(shared.archiveBy) || settings.archiveBy,
    deleteEvery: every(shared.deleteEvery, settings.deleteEvery),
    deleteBy: validClock(shared.deleteBy) || settings.deleteBy,
  }
}

function read({ workspace, now = new Date() } = {}) {
  const record = workspaces.open(workspace)
  const file = settingsFile(record)
  const raw = readJson(file)
  if (raw && typeof raw === 'object') {
    const settings = normalise(raw)
    /* A file written before `createdAt` existed carried the creation time in
       `at`. That stamp was never a pass, so it moves to the field that only
       describes when the rule started. */
    if (!settings.last.createdAt && settings.last.at) {
      settings.last.createdAt = settings.last.at
      settings.last.at = ''
    }
    return withSharedSchedule(record, settings)
  }
  const seeded = normalise({
    ...DEFAULTS,
    last: { createdAt: new Date(now).toISOString(), archived: 0, deleted: 0 },
  })
  writeJson(file, seeded)
  return withSharedSchedule(record, seeded)
}

/** Patch one workspace's rule. Values are validated here, not in the view. */
function save({ workspace, patch = {}, now = new Date() } = {}) {
  const record = workspaces.open(workspace)
  const current = read({ workspace, now })
  const next = normalise({ ...current, ...patch, last: current.last })
  if (patch.archiveAfter) next.archiveAfter = pairOf(patch.archiveAfter, current.archiveAfter)
  if (patch.deleteAfter) next.deleteAfter = pairOf(patch.deleteAfter, current.deleteAfter)

  /* The schedule belongs to the workspace, not to this copy of the rule: write
     it where the artifact card reads it, and leave that rule's clock alone so a
     chat cadence never opts the artifact sweep in. */
  const schedule = {}
  for (const key of SHARED) if (key in patch) schedule[key] = next[key]
  if (Object.keys(schedule).length) {
    const base =
      record.artifactRetention && typeof record.artifactRetention === 'object'
        ? record.artifactRetention
        : {}
    workspaces.setArtifactRetention({ id: record.id, artifactRetention: { ...base, ...schedule } })
  }

  writeJson(settingsFile(record), next)
  return withSharedSchedule(workspaces.open(workspace), next)
}

/* ── when a pass is due ───────────────────────────────────────────── */

function atClock(date, clock) {
  const [hour, minute] = String(clock || '03:00')
    .split(':')
    .map((part) => Number(part) || 0)
  const next = new Date(date)
  next.setHours(hour, minute, 0, 0)
  return next
}

/**
 * The cadence plus the deadline.
 *
 * `late` is the only thing the tick reads: the interval has elapsed **and** the
 * deadline has passed (possibly while the app was shut). `dueAt` is the deadline
 * the next pass waits for, which is what the card prints as "by 03:00 tonight, or
 * at the next launch".
 */
function scheduleInfo(kind, settings, now = new Date()) {
  const every = kind === 'delete' ? settings.deleteEvery : settings.archiveEvery
  const by = kind === 'delete' ? settings.deleteBy : settings.archiveBy
  if (every === 'manual') {
    return { every, by: '', automatic: false, late: false, dueAt: '' }
  }
  const span = EVERY_DAYS[every] || 1
  const lastAt = kind === 'delete' ? settings.last.deleteAt : settings.last.archiveAt
  const base = lastAt ? timeOf(lastAt) : timeOf(settings.last.createdAt) || 0
  /* An interval that starts now: the earliest deadline is one span after the last
     pass (or after the rule was created), on the clock the member chose. */
  const earliest = new Date(base + span * DAY_MS)
  const dueAt = atClock(earliest, by)
  const deadline = new Date(dueAt)
  /* "every day by 03:00" means one pass per day, at the first 03:00 that is at
     least a day after the previous one — not 03:00 every day regardless. */
  return {
    every,
    by,
    automatic: true,
    late: now.getTime() >= deadline.getTime(),
    dueAt: deadline.toISOString(),
  }
}

/* ── the picture ──────────────────────────────────────────────────── */

/**
 * One thread, as the rule sees it.
 *
 * `outcome` is what happens to it *now*: `keep`, `arch` (archived, or will be),
 * `del` (archived and past ②). A protection downgrades `arch`/`del` to `keep`, so
 * the chart, the legend and the forecast cannot disagree — they are one object.
 */
function rowFor(thread, { arc, del, protect, artifacts, now }) {
  const lastMs = timeOf(thread.last?.at) || timeOf(thread.updatedAt) || timeOf(thread.createdAt)
  const silence = daysBetween(lastMs, now)
  const inArchive = thread.archived ? daysBetween(timeOf(thread.archivedAt), now) : 0
  const bytes = thread.bytes || 0
  const row = {
    id: thread.id,
    title: thread.title || thread.preview || thread.id,
    entity: thread.entity || '',
    bytes,
    silence,
    inArchive,
    archived: Boolean(thread.archived),
    pinned: Boolean(thread.pinned),
    working: Boolean(thread.working),
    artifacts: artifacts.files.get(thread.id) || 0,
    /* Where it stays if nothing happens to it: an archived thread belongs to the
       archive even when a protection is holding it back from the delete line. */
    outcome: thread.archived ? 'arch' : 'keep',
    /* The rule's own verdict, ignoring the protections. The chart, the legend and
       the two rule effects read this one — they describe the axis. Tonight's pass
       reads `outcome`, which is the same question with the switches applied. */
    region: thread.archived ? 'arch' : 'keep',
    held: '',
    reason: '',
  }

  if (row.archived) {
    if (del <= 0) {
      row.reason = 'the archive is never emptied'
      return row
    }
    if (inArchive >= del) {
      row.region = 'del'
      if (protect.artifacts && row.artifacts > 0) {
        row.held = 'artifact'
        row.reason = `saved ${row.artifacts} artifact${row.artifacts === 1 ? '' : 's'}`
        return row
      }
      if (protect.pinned && row.pinned) {
        row.held = 'pinned'
        row.reason = 'pinned by hand'
        return row
      }
      if (row.working) {
        /* never remove a thread a turn is writing to, switch or no switch */
        row.held = 'running'
        row.reason = 'a turn is still running'
        return row
      }
      row.outcome = 'del'
      row.reason = `${row.inArchive} days in the archive`
      return row
    }
    row.outcome = 'arch'
    row.reason = `${row.inArchive} of ${del} days in the archive`
    return row
  }

  if (arc <= 0) {
    row.reason = 'the rail archives nothing on its own'
    return row
  }
  if (silence < arc) {
    row.reason = `${silence} of ${arc} days silent`
    return row
  }
  row.region = 'arch'
  if (protect.pinned && row.pinned) {
    row.held = 'pinned'
    row.reason = 'pinned by hand'
    return row
  }
  if (protect.running && row.working) {
    row.held = 'running'
    row.reason = 'a turn is still running'
    return row
  }
  row.outcome = 'arch'
  row.reason = `${silence} days silent`
  return row
}

/**
 * Everything the card draws, in one call.
 *
 * The pass runs inside this process against the same list, so the forecast and
 * the sweep cannot drift: `analyse()` is the pass's own view, computed without
 * writing anything.
 */
function evaluate({ workspace, now = new Date() } = {}) {
  const record = workspaces.open(workspace)
  const settings = read({ workspace, now })
  const arc = daysOf(settings.archiveAfter, 30)
  const del = daysOf(settings.deleteAfter, 180)
  const protect = {
    pinned: settings.protectPinned,
    running: settings.protectRunning,
    artifacts: settings.protectArtifacts,
  }
  const nowMs = new Date(now).getTime()

  let summaries = []
  try {
    summaries = chats.list({ workspace })
  } catch {
    summaries = []
  }
  const artifacts = chats.threadsWithArtifacts({ workspace })
  const rows = summaries.map((thread) =>
    rowFor(
      { ...thread, bytes: bytesOf(record, thread.id) },
      { arc, del, protect, artifacts, now: nowMs },
    ),
  )

  const legend = {
    keep: { threads: 0, bytes: 0 },
    arch: { threads: 0, bytes: 0 },
    del: { threads: 0, bytes: 0 },
  }
  /* The legend describes the chart — which side of the two lines a thread is on —
     so it ignores the protections: a held thread is still past the line. The
     forecast is the one that says what the pass will actually do. */
  for (const row of rows) {
    const bucket = legend[row.region]
    bucket.threads += 1
    bucket.bytes += row.bytes
  }

  const bands = BANDS.map(([from, to]) => {
    const inBand = rows.filter((row) => row.silence >= from && row.silence < to)
    const keep = inBand.filter((row) => row.region === 'keep').length
    const arch = inBand.filter((row) => row.region === 'arch').length
    const del = inBand.filter((row) => row.region === 'del').length
    /* One column per band, one colour: a band whose threads do not all share an
       outcome takes the colour of the majority (ties go to the more severe one,
       so a doomed thread is never hidden). Painting by *silence* instead would
       claim a 540-day band is deleted while the thread in it is still active —
       the axis is silence, the colour is what happens to it. */
    const region = del && del >= arch && del >= keep ? 'del' : arch && arch >= keep ? 'arch' : 'keep'
    return {
      from,
      to: Number.isFinite(to) ? to : from + 1,
      threads: inBand.length,
      bytes: inBand.reduce((sum, row) => sum + row.bytes, 0),
      keep,
      arch,
      del,
      region,
    }
  })

  /* What tonight's pass touches. An archive candidate must be active and silent
     past ①; a delete candidate must already be in the archive past ②. */
  const archiveCandidates = rows.filter((row) => !row.archived && row.outcome === 'arch')
  const deleteCandidates = rows.filter((row) => row.archived && row.outcome === 'del')
  const held = { pinned: 0, running: 0, artifact: 0, artifactFiles: 0 }
  for (const row of rows) {
    if (!row.held) continue
    held[row.held] += 1
    if (row.held === 'artifact') held.artifactFiles += row.artifacts
  }

  const active = rows.filter((row) => !row.archived).length
  const archived = rows.length - active
  const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0)
  const largest5 = [...rows]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5)
    .reduce((sum, row) => sum + row.bytes, 0)

  const touched = [...archiveCandidates, ...deleteCandidates].sort(
    (a, b) => b.silence - a.silence,
  )

  const state = {
    workspace: record.id,
    settings,
    /* The schedule is the workspace's, on the artifact rule; a clone with no such
       field is still scheduling this machine alone, and the card says so. */
    sharedSchedule: Boolean(record.artifactRetention && typeof record.artifactRetention === 'object'),
    thresholds: { archiveAfterDays: arc, deleteAfterDays: del, deathDays: arc > 0 && del > 0 ? arc + del : 0 },
    meta: {
      threads: rows.length,
      active,
      archived,
      bytes: totalBytes,
      largest5Bytes: largest5,
      artifactsThreads: artifacts.threads,
      artifactsFiles: artifacts.files.size ? artifacts.total : 0,
    },
    bands,
    legend,
    forecast: {
      archive: {
        threads: archiveCandidates.length,
        bytes: archiveCandidates.reduce((sum, row) => sum + row.bytes, 0),
      },
      delete: {
        threads: deleteCandidates.length,
        bytes: deleteCandidates.reduce((sum, row) => sum + row.bytes, 0),
      },
      rail: {
        visibleBefore: active,
        visibleAfter: active - archiveCandidates.length,
        archivedBefore: archived,
        archivedAfter: archived + archiveCandidates.length - deleteCandidates.length,
      },
      held,
      list: touched.slice(0, 6).map((row) => ({
        id: row.id,
        title: row.title,
        bytes: row.bytes,
        silence: row.silence,
        outcome: row.outcome,
      })),
      total: touched.length,
    },
    schedule: {
      archive: scheduleInfo('archive', settings, now),
      delete: scheduleInfo('delete', settings, now),
    },
    last: settings.last,
  }
  /* The full candidate sets travel beside the payload, not inside it: the card
     prints six rows, the pass must not. */
  return { state, archiveRows: archiveCandidates, deleteRows: deleteCandidates }
}

function analyse(options) {
  return evaluate(options).state
}

/* ── the pass ─────────────────────────────────────────────────────── */

/**
 * Run one archive pass and one delete pass for a workspace.
 *
 * Both are threshold-driven and idempotent: `chats.archive()` keeps the date a
 * thread went in, so running twice in a minute archives nothing twice, and the
 * delete only looks at threads that were already archived before this call.
 *
 * `dryRun` computes the same list and writes nothing — used by the tests and by
 * the forecast, which is why the two can never disagree.
 */
function run({ workspace, now = new Date(), dryRun = false, kind = '' } = {}) {
  const { state, archiveRows, deleteRows } = evaluate({ workspace, now })
  const wants = (which) => !kind || kind === which
  const archived = []
  const deleted = []
  const failed = []

  for (const row of wants('archive') ? archiveRows : []) {
    if (dryRun) {
      archived.push(row.id)
      continue
    }
    try {
      chats.archive({ workspace, id: row.id, archived: true })
      archived.push(row.id)
    } catch (error) {
      failed.push(`${row.id}: ${error?.message || 'could not archive'}`)
    }
  }
  for (const row of wants('delete') ? deleteRows : []) {
    if (dryRun) {
      deleted.push(row.id)
      continue
    }
    try {
      /* Remove only what this pass' own analysis said was already archived, so a
         thread archived by hand a moment ago is not swept up by the same run. */
      chats.remove({ workspace, id: row.id })
      deleted.push(row.id)
    } catch (error) {
      failed.push(`${row.id}: ${error?.message || 'could not remove'}`)
    }
  }

  if (!dryRun) {
    const current = read({ workspace, now })
    const stamp = new Date(now).toISOString()
    writeJson(
      settingsFile(workspaces.open(workspace)),
      normalise({
        ...current,
        last: {
          ...current.last,
          at: stamp,
          ...(wants('archive') ? { archiveAt: stamp } : {}),
          ...(wants('delete') ? { deleteAt: stamp } : {}),
          archived: archived.length,
          deleted: deleted.length,
          error: failed[0] || '',
        },
      }),
    )
  }

  return {
    archived,
    deleted,
    failed,
    before: state,
    state: dryRun ? state : analyse({ workspace, now }),
  }
}

/* ── the tick ─────────────────────────────────────────────────────── */

let bootTimer = null
let timer = null
let ticking = false

/**
 * Every workspace that has a rule file, once per poll.
 *
 * Unref'd timers, like the backup scheduler: retention never keeps the app alive.
 * A workspace with no `retention.json` has not opted in, so the sweep leaves it
 * alone rather than applying defaults to a history nobody has looked at.
 */
function tick({ log = () => {}, now = new Date() } = {}) {
  if (ticking) return { skipped: true }
  ticking = true
  const done = []
  try {
    for (const item of workspaces.list()) {
      const record = workspaces.open(item.id)
      if (!fs.existsSync(settingsFile(record))) continue
      const settings = read({ workspace: item.id, now })
      const archiveDue = scheduleInfo('archive', settings, now).late
      const deleteDue = scheduleInfo('delete', settings, now).late
      if (!archiveDue && !deleteDue) continue
      const kind = archiveDue && deleteDue ? '' : archiveDue ? 'archive' : 'delete'
      const result = run({ workspace: item.id, now, kind })
      if (result.archived.length || result.deleted.length || result.failed.length) {
        log(
          `retention ${item.id}: ${result.archived.length} archived, ${result.deleted.length} removed` +
            (result.failed.length ? `, ${result.failed.length} failed` : ''),
        )
      }
      done.push({ workspace: item.id, ...result, state: undefined })
    }
  } catch (error) {
    log(`retention pass failed: ${error?.message || error}`)
  } finally {
    ticking = false
  }
  return { workspaces: done }
}

function start({ log = () => {} } = {}) {
  if (timer) return
  bootTimer = setTimeout(() => {
    tick({ log })
  }, START_DELAY_MS)
  bootTimer.unref?.()
  timer = setInterval(() => {
    tick({ log })
  }, INTERVAL_MS)
  timer.unref?.()
}

function stop() {
  if (bootTimer) clearTimeout(bootTimer)
  if (timer) clearInterval(timer)
  bootTimer = null
  timer = null
}

module.exports = {
  FILE,
  SCHEMA,
  DEFAULTS,
  EVERY_INFO,
  BANDS,
  DAY_MS,
  START_DELAY_MS,
  INTERVAL_MS,
  settingsFile,
  normalise,
  daysOf,
  read,
  save,
  scheduleInfo,
  analyse,
  run,
  tick,
  start,
  stop,
}
