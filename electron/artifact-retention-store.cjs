/**
 * Artifact retention — when a file on the shelf archives itself, and when it is
 * gone.
 *
 * This is ENTITY-20's chat rule (`electron/retention-store.cjs`) applied to a
 * different population: keep the shape, change only the words that must differ.
 * Two thresholds on one histogram, a cadence plus a deadline per pass, a list of
 * protections, and a forecast of what the next pass actually costs.
 *
 * The one thing that is not the chat rule: **a shelf can be shared.** A file is
 * a workspace artifact, and a shared workspace exists on a sync host and on every
 * teammate's clone, so the rule has to say *which machine sweeps* or N machines
 * would delete the same file from each other's shelf.
 *
 *   - **The rule is workspace configuration.** Thresholds, cadences, the idle
 *     switch and the executor live in `workspace.json` beside the label and the
 *     roster, so an owner or admin sets it once (`applyMeta` on the server is the
 *     gate) and every clone reads the same numbers.
 *   - **The facts are this machine's.** Which files are in *this* archive, the
 *     date each of them went in, when this machine last opened a file, and the
 *     moment it took the sweep over are all local. A clone never inherits
 *     another machine's `.archive/`.
 *   - **Exactly one machine executes.** `executor.kind` is `owner` (the first
 *     owner-signed-in machine claims it), `machine` (the machine that was picked)
 *     or `host` (the sync host, which is always on). Every other clone shows the
 *     rule and stands down: its tick, and its "Archive due now", refuse.
 *
 * Three rules remain load-bearing, exactly as in the chat store:
 *
 *   1. **The two thresholds are different clocks.** ① counts days since a file
 *      was last opened. ② counts days *in the archive* — so the delete line sits
 *      at `archiveAfter + deleteAfter` days of age, and moving ① moves both lines.
 *   2. **The schedule is a cadence and a deadline, not an hour.** The desktop is
 *      open all day and shut at night, so `every day by 03:00` means "at most a
 *      day behind, and not before 03:00"; the boot tick catches a deadline that
 *      passed while the machine was closed. On the sync host the idle switch has
 *      nothing to wait for, so it does not apply.
 *   3. **Nothing irreversible happens without a threshold in front of it** — and
 *      a machine that has only just been given the sweep does not inherit the
 *      shelf's age either. A file nobody has opened counts from the later of its
 *      modification time and the moment this machine took over, so a takeover can
 *      never archive a shelf that was healthy elsewhere.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const workspaces = require('./workspace-store.cjs')
const artifacts = require('./artifact-store.cjs')

/* The rule is in `workspace.json`; this file is only what cannot travel: the
   moment this machine took the sweep over. */
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
const KINDS = ['owner', 'machine', 'host']

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
  executor: { kind: 'owner', member: '', hostname: '', claimedAt: '' },
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

const text = (value, max = 120) => String(value || '').slice(0, max)

/** Whole days since `thenMs`, floored, never negative. `0` for a file with no clock. */
const daysBetween = (thenMs, nowMs) => {
  if (!thenMs) return 0
  return Math.max(0, Math.floor((nowMs - thenMs) / DAY_MS))
}

const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] || 0), 0)

function localHost() {
  return String(os.hostname() || 'local').replace(/\.local$/i, '')
}

function runtimeFile(record) {
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

/** An untouched workspace writes nothing until it is read or swept. */
function readRuntime(record) {
  const raw = readJson(runtimeFile(record), {})
  return {
    executorSince: timeOf(raw?.executorSince) ? String(raw.executorSince) : '',
  }
}

function writeRuntime(record, runtime) {
  return writeJson(runtimeFile(record), { schema: SCHEMA, ...runtime })
}

/* ── what this store cannot know by itself ────────────────────────── */

/**
 * Defaults wired by the call table, not imported here, because each one is
 * somebody else's data: `referenced` reads the live transcripts, `trash` is the
 * OS Trash (Electron only), `busy` is the quiet signal a desktop can see, and
 * `identity` is the signed-in account the owner claim is matched against.
 * `host` says this process *is* the sync host, which is the only executor that
 * never waits for a person.
 */
const providers = {
  referenced: null,
  trash: null,
  busy: null,
  identity: null,
  host: false,
}

function configure(next = {}) {
  for (const key of Object.keys(providers)) {
    if (next[key] !== undefined) providers[key] = next[key]
  }
  return providers
}

function identityOf() {
  try {
    return typeof providers.identity === 'function' ? providers.identity() : null
  } catch {
    return null
  }
}

/** The signed-in account is the workspace's owner (by email, then by username). */
function isWorkspaceOwner(record) {
  const owner = record.owner
  if (!owner || (!owner.email && !owner.name)) return true
  const me = identityOf()
  if (!me) return false
  const mail = String(me.email || '').toLowerCase()
  const name = String(me.username || me.name || '').toLowerCase()
  if (owner.email && mail) return String(owner.email).toLowerCase() === mail
  if (owner.name && name) return String(owner.name).toLowerCase() === name || String(owner.name).toLowerCase() === mail
  return false
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

function executorOf(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  return {
    kind: KINDS.includes(source.kind) ? source.kind : DEFAULTS.executor.kind,
    member: text(source.member),
    hostname: text(source.hostname),
    claimedAt: text(source.claimedAt, 40),
  }
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
    executor: executorOf(raw.executor),
    last: {
      /* `at` is a pass that happened. `createdAt` is when the rule started, which
         is the clock the first deadline is measured from — a card that says "last
         pass just now" before any pass has run is the lie this field prevents. */
      at: text(raw.last?.at, 40),
      createdAt: text(raw.last?.createdAt, 40),
      archiveAt: text(raw.last?.archiveAt, 40),
      deleteAt: text(raw.last?.deleteAt, 40),
      archived: Math.max(0, Number(raw.last?.archived) || 0),
      deleted: Math.max(0, Number(raw.last?.deleted) || 0),
      error: text(raw.last?.error, 400),
    },
  }
}

/* ── the shared rule, and this machine's part in it ───────────────── */

/** The part that belongs in `workspace.json`: everything but this machine's view. */
function shareOf(settings) {
  const { configured, resolved, executorSince, ...shared } = settings
  return shared
}

/**
 * Read one workspace's rule.
 *
 * The rule is created by the first read *of a local workspace* — a local
 * workspace is opted in by opening its tab, and the clock starts there. A clone
 * of a shared workspace does not invent one: an owner or admin configures it
 * once, and until then `configured` is false and nothing is swept.
 */
function read({ workspace, now = new Date(), seed = false } = {}) {
  const record = workspaces.open(workspace)
  const shared = record.artifactRetention && typeof record.artifactRetention === 'object'
    ? record.artifactRetention
    : null
  let settings = normalise(shared || {})
  let configured = Boolean(shared)

  /* `seed` is the tab's own read: it is what opts a local workspace in. The tick
     reads without seeding, so a workspace nobody has looked at stays untouched. */
  if (seed && !configured && record.kind !== 'remote') {
    settings = normalise({
      ...DEFAULTS,
      last: { createdAt: new Date(now).toISOString(), archived: 0, deleted: 0 },
    })
    workspaces.setArtifactRetention({ id: record.id, artifactRetention: shareOf({ ...settings, configured: true }) })
    configured = true
  }

  const resolved = resolveExecutor(record, settings, { now, configured })
  const runtime = readRuntime(record)
  const armed = resolved.isThis
  /* A machine that takes the sweep over starts its own clock: nothing that was
     already old on another machine is old *here* until the threshold has passed
     on this machine too. */
  let executorSince = runtime.executorSince
  if (armed && !executorSince) {
    executorSince = new Date(now).toISOString()
    writeRuntime(record, { executorSince })
  } else if (!armed && executorSince) {
    executorSince = ''
    writeRuntime(record, { executorSince: '' })
  }

  return { ...settings, configured, resolved, executorSince }
}

/**
 * Who sweeps this workspace.
 *
 * A local workspace has exactly one machine, so the answer is free. A clone of a
 * shared one reads the shared choice: `host` is the sync host, `machine` is the
 * machine that was picked, and `owner` is claimed by the first machine whose
 * signed-in account is the workspace's owner.
 */
function resolveExecutor(record, settings, { now, configured }) {
  const here = localHost()
  const host = providers.host === true

  /* A local workspace on a desktop has exactly one machine, so the answer is
     free. The sync host is an exception: its copy is the shared one even though
     it was created there, so it honours the field like every other clone. */
  if (record.kind !== 'remote' && !host) {
    return {
      kind: 'local',
      label: 'this machine',
      where: here,
      isThis: true,
      alwaysOn: false,
      claimed: true,
    }
  }

  const claim = settings.executor
  if (claim.kind === 'host') {
    return { kind: 'host', label: 'the sync host', where: '', isThis: host, alwaysOn: true, claimed: true }
  }
  if (claim.kind === 'machine' && claim.hostname) {
    return {
      kind: 'machine',
      label: claim.hostname,
      where: claim.hostname,
      isThis: claim.hostname === here,
      alwaysOn: false,
      claimed: true,
    }
  }
  if (claim.kind === 'owner' && claim.hostname) {
    /* The claim names a machine *and* the account that may use it: a second
       signed-in account on the same laptop is not the owner. */
    return {
      kind: 'owner',
      label: claim.hostname,
      where: claim.hostname,
      isThis: claim.hostname === here && isWorkspaceOwner(record),
      alwaysOn: false,
      claimed: true,
    }
  }

  /* `owner` with no claim: the first owner-signed-in machine takes it. The sync
     host has no person to ask, so it never claims this one. */
  if (claim.kind === 'owner' && !host && configured && isWorkspaceOwner(record)) {
    const me = identityOf() || {}
    const claimed = {
      ...settings,
      executor: {
        kind: 'owner',
        member: text(me.email || me.username || ''),
        hostname: here,
        claimedAt: new Date(now).toISOString(),
      },
    }
    workspaces.setArtifactRetention({ id: record.id, artifactRetention: shareOf({ ...claimed, configured }) })
    return { kind: 'owner', label: here, where: here, isThis: true, alwaysOn: false, claimed: true }
  }

  return {
    kind: claim.kind,
    label: claim.kind === 'machine' ? 'a machine nobody has picked yet' : "the owner's machine",
    where: '',
    isThis: false,
    alwaysOn: false,
    claimed: false,
  }
}

/** Patch one workspace's rule. Values are validated here, not in the view. */
function save({ workspace, patch = {}, now = new Date() } = {}) {
  const record = workspaces.open(workspace)
  const current = read({ workspace, now })
  const next = normalise({ ...current, ...patch, last: current.last })

  if (patch.archiveAfter) next.archiveAfter = pairOf(patch.archiveAfter, current.archiveAfter)
  if (patch.deleteAfter) next.deleteAfter = pairOf(patch.deleteAfter, current.deleteAfter)

  if (patch.executor) {
    const wanted = KINDS.includes(patch.executor.kind) ? patch.executor.kind : next.executor.kind
    const me = identityOf() || {}
    /* `machine` pins the machine that asked; `owner` and `host` clear the claim,
       so the owner's machine (or the sync host) takes it on its next read. */
    next.executor =
      wanted === 'machine'
        ? {
            kind: 'machine',
            member: text(me.email || me.username || ''),
            hostname: localHost(),
            claimedAt: new Date(now).toISOString(),
          }
        : { kind: wanted, member: '', hostname: '', claimedAt: '' }
  }

  /* Saving is what starts the clock for a clone that had no rule yet. */
  next.last = {
    ...current.last,
    createdAt: current.last.createdAt || new Date(now).toISOString(),
  }

  workspaces.setArtifactRetention({ id: record.id, artifactRetention: shareOf({ ...next, configured: true }) })
  return analyse({ workspace, now })
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
function rowFor(file, { arc, del, protect, referenced, now, watchingSince }) {
  const openedMs = timeOf(file.openedAt)
  /* Never opened here: it is as old as the later of its modification time and
     the moment this machine took the sweep over. A takeover therefore inherits
     no age — the clock starts when the machine starts watching. */
  const baseMs = openedMs || Math.max(timeOf(file.modifiedAt), watchingSince || 0)
  const age = daysBetween(baseMs, now)
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
  const settings = read({ workspace, now, seed: true })
  const configured = settings.configured
  const arc = daysOf(settings.archiveAfter, 30)
  const del = daysOf(settings.deleteAfter, 90)
  const nowMs = new Date(now).getTime()
  /* A machine that took an existing sweep over from another one inherits no age.
     A workspace that is adopting the rule itself keeps its honest mtime ages —
     the chart and the forecast are the warning there, and they are on screen
     before the first pass runs. */
  const since = timeOf(settings.executorSince)
  const createdAt = timeOf(settings.last.createdAt)
  const watchingSince = since && createdAt && since - createdAt > DAY_MS ? since : 0
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
        { arc, del, protect, referenced, now: nowMs, watchingSince },
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
        { arc, del, protect, referenced, now: nowMs, watchingSince },
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
    /* A clone with no shared rule has nothing to apply: the card shows the
       defaults to preview, never as a live promise. */
    configured,
    executor: settings.resolved,
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
    schedule:
      configured
        ? {
            archive: scheduleInfo('archive', settings, now),
            delete: scheduleInfo('delete', settings, now),
            whenIdle: settings.whenIdle && !settings.resolved.alwaysOn,
          }
        : {
            archive: { every: settings.archiveEvery, by: settings.archiveBy, automatic: false, late: false, dueAt: '' },
            delete: { every: settings.deleteEvery, by: settings.deleteBy, automatic: false, late: false, dueAt: '' },
            whenIdle: false,
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

/** The shared `last` block: one report, written by the machine that swept. */
function stampLast(record, current, stamp, archived, deleted, failed, wants) {
  const next = normalise({
    ...(record.artifactRetention || current),
    last: {
      ...current.last,
      at: stamp,
      ...(wants('archive') ? { archiveAt: stamp } : {}),
      ...(wants('delete') ? { deleteAt: stamp } : {}),
      archived,
      deleted,
      error: failed[0] || '',
    },
  })
  workspaces.setArtifactRetention({ id: record.id, artifactRetention: shareOf({ ...next, configured: true }) })
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
  /* One machine sweeps. Every other clone refuses, because its archive would
     read as a deletion of the shared shelf on the next sync. */
  if (!state.configured) throw new Error('The artifact sweep is not configured for this workspace yet.')
  if (!state.executor.isThis) {
    throw new Error(`The artifact sweep runs on ${state.executor.label}; this machine does not sweep it.`)
  }
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

  if (!dryRun) stampLast(record, state.settings, stamp, archived.length, deleted.length, failed, wants)

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
 * Every workspace that has a rule, once per poll.
 *
 * Unref'd timers, like the backup scheduler: retention never keeps the app
 * alive. A workspace with no shared rule has not opted in, and a clone whose
 * executor is another machine stands down — this is the whole reason the rule
 * names an executor.
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
      const settings = read({ workspace: item.id, now })
      if (!settings.configured) continue
      if (!settings.resolved.isThis) continue
      const due = scheduleInfo('archive', settings, now).late
      const deleteDue = scheduleInfo('delete', settings, now).late
      if (!due && !deleteDue) continue
      /* A desktop waits for a quiet machine; the sync host has no desktop to
         wait for, so the switch does not apply there. */
      if (settings.whenIdle && !settings.resolved.alwaysOn && busy) {
        log(`artifact retention ${item.id}: waiting for a quiet machine`)
        continue
      }
      const kind = due && deleteDue ? '' : due ? 'archive' : 'delete'
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
  runtimeFile,
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
