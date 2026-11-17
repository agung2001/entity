/**
 * Artifact retention — when a file on the shelf archives itself, and when it is
 * gone.
 *
 * This is ENTITY-20's chat rule (`electron/retention-store.cjs`) applied to a
 * different population: keep the shape, change only the words that must differ.
 * Two thresholds drawn on one histogram, a cadence plus a deadline per pass, a
 * list of protections, and a forecast of what the next pass actually costs.
 *
 * Three rules are load-bearing, and they are the chat store's three:
 *
 *   1. **The two thresholds are different clocks.** ① counts days since a file
 *      was last opened. ② counts days *in the archive* — so a file archived at
 *      30 days dies at `archiveAfter + deleteAfter` days of age, and moving ①
 *      moves both lines. Copy that says "delete after 90 days" while the line
 *      sits at 120 is the most likely bug in this feature.
 *   2. **The schedule is a cadence and a deadline, not an hour.** The app is
 *      open all day and shut at night, so `every day by 03:00` means "at most a
 *      day behind, and not before 03:00"; the boot tick catches a deadline that
 *      passed while the machine was closed.
 *   3. **Nothing irreversible happens without a threshold in front of it.** The
 *      archive is a move into `artifacts/.archive/`, which is reversible with a
 *      file manager; the delete goes through the OS Trash when this build has
 *      one, and only ever touches files that are already archived.
 *
 * The settings live in the workspace (`<ws>/artifact-retention.json`), not in a
 * machine preference: a shelf is workspace data, and a workspace opened on
 * another machine should not inherit this one's idea of when its files end.
 */
const fs = require('node:fs')
const path = require('node:path')
const workspaces = require('./workspace-store.cjs')
const artifacts = require('./artifact-store.cjs')

const FILE = 'artifact-retention.json'
const SCHEMA = 1
const DAY_MS = 24 * 60 * 60 * 1000
const START_DELAY_MS = 60_000
const INTERVAL_MS = 30 * 60_000
const MAX_DAYS = 3650

/* Dot folders under `artifacts/`. The shelf walk skips dot entries, so a file
   moved into one of these leaves the shelf without leaving the workspace. */
const ARCHIVE = '.archive'
const TRASH = '.trash'
const STAMPS = '.stamps.json'

/** `manual` is the store's own word for "only when I ask" (backup-store MODES). */
const EVERY = ['day', 'week', 'month', 'manual']
const EVERY_INFO = [
  { id: 'day', label: 'every day', days: 1 },
  { id: 'week', label: 'every week', days: 7 },
  { id: 'month', label: 'every month', days: 30 },
  { id: 'manual', label: 'only when I ask', days: 0 },
]
const EVERY_DAYS = { day: 1, week: 7, month: 30 }
const UNIT_DAYS = { days: 1, weeks: 7, months: 30 }
const UNITS = ['days', 'weeks', 'months', 'never']

/* The chart's 14 bands, oldest last. A band is cut on its lower edge, so a file
   belongs to exactly one column; the last band is open-ended on purpose, so a
   file older than the axis is counted instead of dropped. */
const BANDS = [
  [0, 7],
  [7, 14],
  [14, 30],
  [30, 60],
  [60, 90],
  [90, 120],
  [120, 180],
  [180, 240],
  [240, 300],
  [300, 360],
  [360, 420],
  [420, 480],
  [480, 540],
  [540, Infinity],
]

const DEFAULTS = {
  schema: SCHEMA,
  archiveAfter: { n: 30, unit: 'days' },
  deleteAfter: { n: 90, unit: 'days' },
  archiveEvery: 'day',
  archiveBy: '03:00',
  deleteEvery: 'week',
  deleteBy: '03:00',
  whenIdle: true,
  protectReferenced: true,
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

/** Whole days since `thenMs`, floored, never negative. `0` for a file with no clock. */
const daysBetween = (thenMs, nowMs) => {
  if (!thenMs) return 0
  return Math.max(0, Math.floor((nowMs - thenMs) / DAY_MS))
}

const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] || 0), 0)

function settingsFile(record) {
  return path.join(record.path, FILE)
}

function archiveDir(record) {
  return path.join(artifacts.artifactsDir(record), ARCHIVE)
}

/** Where a file's archive date is kept: one map beside the archived files. */
function stampsFile(record) {
  return path.join(archiveDir(record), STAMPS)
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

function readStamps(record) {
  const raw = readJson(stampsFile(record), {})
  return raw && typeof raw === 'object' ? raw : {}
}

/* ── what this store cannot know by itself ────────────────────────── */

/**
 * Two things are wired by the call table, not imported here: `referenced` reads
 * the live transcripts (the chat store's data — this store must not depend on
 * it) and `trash` is the OS Trash (Electron only). `busy` is the quiet signal a
 * desktop can actually see. `analyse()` reports which ones are present, so the
 * card can say what is in force instead of promising a protection it lacks.
 */
const providers = { referenced: null, trash: null, busy: null }

function configure(next = {}) {
  for (const key of Object.keys(providers)) {
    if (next[key] !== undefined) providers[key] = next[key]
  }
  return providers
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
    whenIdle: raw.whenIdle === undefined ? true : Boolean(raw.whenIdle),
    protectReferenced: raw.protectReferenced === undefined ? true : Boolean(raw.protectReferenced),
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
 * the first pass on a fresh install would archive every old file at once. Until a
 * member visits the tab, the sweep leaves the workspace alone.
 */
function read({ workspace, now = new Date() } = {}) {
  const record = workspaces.open(workspace)
  const file = settingsFile(record)
  const raw = readJson(file)
  if (raw && typeof raw === 'object') return normalise(raw)
  const seeded = normalise({
    ...DEFAULTS,
    last: { createdAt: new Date(now).toISOString(), archived: 0, deleted: 0 },
  })
  writeJson(file, seeded)
  return seeded
}

/** Patch one workspace's rule. Values are validated here, not in the view. */
function save({ workspace, patch = {}, now = new Date() } = {}) {
  const record = workspaces.open(workspace)
  const current = read({ workspace, now })
  const next = normalise({ ...current, ...patch, last: current.last })
  if (patch.archiveAfter) next.archiveAfter = pairOf(patch.archiveAfter, current.archiveAfter)
  if (patch.deleteAfter) next.deleteAfter = pairOf(patch.deleteAfter, current.deleteAfter)
  writeJson(settingsFile(record), next)
  return next
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
 * the next pass waits for, which is what the card prints as "by 03:00, or at the
 * next launch".
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
  const earliest = new Date(base + span * DAY_MS)
  const dueAt = atClock(earliest, by)
  return {
    every,
    by,
    automatic: true,
    late: now.getTime() >= dueAt.getTime(),
    dueAt: dueAt.toISOString(),
  }
}

/* ── the shelf, as the rule sees it ───────────────────────────────── */

/** Files that already left the shelf, walked out of the archive folder. */
function archivedFiles(record) {
  const root = archiveDir(record)
  const out = []
  const walk = (rel) => {
    let entries = []
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(child)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const stat = fs.statSync(path.join(root, child))
        out.push({ id: child, bytes: stat.size, modifiedAt: stat.mtime.toISOString() })
      } catch {
        /* a file that vanished mid-walk is not a row */
      }
    }
  }
  walk('')
  return out
}

/**
 * One file, as the rule sees it.
 *
 * `region` is where it sits relative to the two lines — what the legend, the bars
 * and the two rule effects show. `outcome` applies the protections — what the
 * next pass will actually do. A protection downgrades `arch`/`del` to "leave it
 * where it is", and the two answers come from this one object, so they cannot
 * disagree.
 */
function rowFor(file, { arc, del, protect, referenced, now }) {
  const openedMs = timeOf(file.openedAt) || timeOf(file.modifiedAt)
  const age = daysBetween(openedMs, now)
  const archived = Boolean(file.archivedAt)
  const inArchive = archived ? daysBetween(timeOf(file.archivedAt), now) : 0
  const row = {
    id: file.id,
    name: file.name,
    bytes: file.bytes || 0,
    age,
    inArchive,
    archived,
    /* Where it stays if nothing happens to it. */
    outcome: archived ? 'arch' : 'keep',
    /* The rule's own verdict, ignoring the protections. */
    region: archived ? 'arch' : 'keep',
    held: '',
    reason: '',
  }

  if (archived) {
    if (del <= 0) {
      row.reason = 'the archive is never emptied'
      return row
    }
    if (inArchive < del) {
      row.reason = `${inArchive} of ${del} days in the archive`
      return row
    }
    row.region = 'del'
    if (protect && referenced.has(row.id)) {
      row.held = 'referenced'
      row.reason = 'a live chat still names this file'
      return row
    }
    row.outcome = 'del'
    row.reason = `${inArchive} days in the archive`
    return row
  }

  if (arc <= 0) {
    row.reason = 'nothing is archived on its own'
    return row
  }
  if (age < arc) {
    row.reason = `${age} of ${arc} days since it was last opened`
    return row
  }
  row.region = 'arch'
  if (protect && referenced.has(row.id)) {
    row.held = 'referenced'
    row.reason = 'a live chat still names this file'
    return row
  }
  row.outcome = 'arch'
  row.reason = `${age} days since it was last opened`
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
  const del = daysOf(settings.deleteAfter, 90)
  const nowMs = new Date(now).getTime()
  const opened = artifacts.openedMap({ workspace })
  const stamps = readStamps(record)
  const protect = settings.protectReferenced
  const wired = typeof providers.referenced === 'function'

  let referenced = new Set()
  if (protect && wired) {
    try {
      referenced = new Set(Array.from(providers.referenced({ workspace }) || []))
    } catch {
      /* an unreadable transcript protects nothing, and the card says so */
      referenced = new Set()
    }
  }

  const rows = []
  let shelf = []
  try {
    shelf = artifacts.list({ workspace }).items
  } catch {
    shelf = []
  }
  for (const item of shelf) {
    rows.push(
      rowFor(
        {
          id: item.id,
          name: item.name,
          bytes: item.size,
          modifiedAt: item.modifiedAt,
          openedAt: opened[item.id],
        },
        { arc, del, protect, referenced, now: nowMs },
      ),
    )
  }
  for (const item of archivedFiles(record)) {
    rows.push(
      rowFor(
        {
          id: item.id,
          name: path.basename(item.id),
          bytes: item.bytes,
          modifiedAt: item.modifiedAt,
          openedAt: opened[item.id],
          /* The date the file entered the archive, stamped once on the way in.
             A file moved by hand (or before the stamp existed) counts from its
             own mtime instead of pretending it was archived today. */
          archivedAt: stamps[item.id] || item.modifiedAt,
        },
        { arc, del, protect, referenced, now: nowMs },
      ),
    )
  }

  const legend = {
    keep: { files: 0, bytes: 0 },
    arch: { files: 0, bytes: 0 },
    del: { files: 0, bytes: 0 },
  }
  /* The legend describes the chart — which side of the two lines a file is on —
     so it ignores the protections: a held file is still past the line. The
     forecast is the one that says what the pass will actually do. */
  for (const row of rows) {
    const bucket = legend[row.region]
    bucket.files += 1
    bucket.bytes += row.bytes
  }

  const bands = BANDS.map(([from, to]) => {
    const inBand = rows.filter((row) => row.age >= from && row.age < to)
    const keep = inBand.filter((row) => row.region === 'keep').length
    const arch = inBand.filter((row) => row.region === 'arch').length
    const del = inBand.filter((row) => row.region === 'del').length
    /* One column per band, one colour: a band whose files do not all share an
       outcome takes the colour of the majority (ties go to the more severe one,
       so a doomed file is never hidden). */
    const region = del && del >= arch && del >= keep ? 'del' : arch && arch >= keep ? 'arch' : 'keep'
    return {
      from,
      to: Number.isFinite(to) ? to : null,
      files: inBand.length,
      bytes: sum(inBand, 'bytes'),
      keep,
      arch,
      del,
      region,
    }
  })

  const active = rows.filter((row) => !row.archived)
  const archivedRows = rows.filter((row) => row.archived)
  const archiveCandidates = active.filter((row) => row.outcome === 'arch')
  const deleteCandidates = archivedRows.filter((row) => row.outcome === 'del')
  const heldRows = rows.filter((row) => row.held)
  const settled = rows.filter((row) => row.region === 'keep')

  const touched = [...archiveCandidates, ...deleteCandidates].sort((a, b) => b.age - a.age)

  const state = {
    workspace: record.id,
    settings,
    thresholds: {
      archiveAfterDays: arc,
      deleteAfterDays: del,
      deathDays: arc > 0 && del > 0 ? arc + del : 0,
    },
    meta: {
      files: active.length,
      bytes: sum(active, 'bytes'),
      archived: archivedRows.length,
      archivedBytes: sum(archivedRows, 'bytes'),
      opened: rows.filter((row) => opened[row.id]).length,
    },
    bands,
    legend,
    forecast: {
      archive: { files: archiveCandidates.length, bytes: sum(archiveCandidates, 'bytes') },
      delete: { files: deleteCandidates.length, bytes: sum(deleteCandidates, 'bytes') },
      shelf: {
        filesBefore: active.length,
        bytesBefore: sum(active, 'bytes'),
        filesAfter: active.length - archiveCandidates.length,
        bytesAfter: sum(active, 'bytes') - sum(archiveCandidates, 'bytes'),
        filesSettled: settled.length,
        bytesSettled: sum(settled, 'bytes'),
      },
      held: { referenced: heldRows.length, bytes: sum(heldRows, 'bytes') },
      list: touched.slice(0, 6).map((row) => ({
        id: row.id,
        name: row.name,
        bytes: row.bytes,
        age: row.age,
        outcome: row.outcome,
      })),
      total: touched.length,
    },
    schedule: {
      archive: scheduleInfo('archive', settings, now),
      delete: scheduleInfo('delete', settings, now),
      whenIdle: settings.whenIdle,
    },
    /* What the card may promise about the two things this store does not own. */
    trash: typeof providers.trash === 'function' ? 'system' : 'folder',
    references: wired,
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

function sourceOf(record, id) {
  const parts = String(id || '').split('/')
  if (!parts.length || parts.some((part) => !part || part === '..' || part === '.')) {
    throw new Error(`Not an artifact id: ${id}`)
  }
  return parts
}

function moveInto(record, id) {
  const parts = sourceOf(record, id)
  const source = path.join(artifacts.artifactsDir(record), ...parts)
  const target = path.join(archiveDir(record), ...parts)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.renameSync(source, target)
}

/** The OS Trash when this build has one; a workspace folder it can never lose. */
async function removeFile(record, id) {
  const parts = sourceOf(record, id)
  const source = path.join(archiveDir(record), ...parts)
  if (typeof providers.trash === 'function') {
    await providers.trash(source)
    return
  }
  const target = path.join(artifacts.artifactsDir(record), TRASH, ...parts)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
  fs.rmSync(source, { force: true })
}

/**
 * Run one archive pass and one delete pass for a workspace.
 *
 * Both are threshold-driven and idempotent: a file that is already in the
 * archive is not archived again, its archive date is written once on the way in,
 * and the delete only looks at files that were already archived before this
 * call. `dryRun` computes the same list and writes nothing.
 */
async function run({ workspace, now = new Date(), dryRun = false, kind = '' } = {}) {
  const record = workspaces.open(workspace)
  const { state, archiveRows, deleteRows } = evaluate({ workspace, now })
  const wants = (which) => !kind || kind === which
  const archived = []
  const deleted = []
  const failed = []
  const stamps = readStamps(record)
  const stamp = new Date(now).toISOString()

  for (const row of wants('archive') ? archiveRows : []) {
    if (dryRun) {
      archived.push(row.id)
      continue
    }
    try {
      moveInto(record, row.id)
      /* The date a file entered the archive is what ② counts, so it is stamped
         on the way in and written before the next file moves: a pass that runs
         every thirty minutes must never reset that clock. */
      if (!stamps[row.id]) {
        stamps[row.id] = stamp
        writeJson(stampsFile(record), stamps)
      }
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
      await removeFile(record, row.id)
      if (stamps[row.id]) {
        delete stamps[row.id]
        writeJson(stampsFile(record), stamps)
      }
      deleted.push(row.id)
    } catch (error) {
      failed.push(`${row.id}: ${error?.message || 'could not remove'}`)
    }
  }

  if (!dryRun) {
    const current = read({ workspace, now })
    writeJson(
      settingsFile(record),
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
 * Unref'd timers, like the backup scheduler: retention never keeps the app
 * alive. A workspace with no `artifact-retention.json` has not opted in, so the
 * sweep leaves it alone rather than applying defaults to a shelf nobody has
 * looked at. The idle switch keeps its word where this process can see it — a
 * pass waits while a run or a chat turn is answering.
 */
async function tick({ log = () => {}, now = new Date() } = {}) {
  if (ticking) return { skipped: true }
  ticking = true
  const done = []
  try {
    let busy = false
    try {
      busy = typeof providers.busy === 'function' ? Boolean(providers.busy()) : false
    } catch {
      busy = false
    }
    for (const item of workspaces.list()) {
      const record = workspaces.open(item.id)
      if (!fs.existsSync(settingsFile(record))) continue
      const settings = read({ workspace: item.id, now })
      const archiveDue = scheduleInfo('archive', settings, now).late
      const deleteDue = scheduleInfo('delete', settings, now).late
      if (!archiveDue && !deleteDue) continue
      if (settings.whenIdle && busy) {
        log(`artifact retention ${item.id}: waiting for a quiet machine`)
        continue
      }
      const kind = archiveDue && deleteDue ? '' : archiveDue ? 'archive' : 'delete'
      const result = await run({ workspace: item.id, now, kind })
      if (result.archived.length || result.deleted.length || result.failed.length) {
        log(
          `artifact retention ${item.id}: ${result.archived.length} archived, ${result.deleted.length} removed` +
            (result.failed.length ? `, ${result.failed.length} failed` : ''),
        )
      }
      done.push({ workspace: item.id, archived: result.archived, deleted: result.deleted })
    }
  } catch (error) {
    log(`artifact retention pass failed: ${error?.message || error}`)
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
  stampsFile,
  normalise,
  daysOf,
  read,
  save,
  scheduleInfo,
  analyse,
  run,
  tick,
  configure,
  start,
  stop,
}
