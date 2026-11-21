/**
 * Dashboards on disk.
 *
 * A dashboard is one inert file: `<ws>/artifacts/<slug>.dashboard`, JSON, no HTML
 * and no JavaScript (`docs/artifacts.md` — the preview strips scripts, and a
 * snapshot people read is not a program). This module owns the file's four
 * verbs — locate, read, write, list — on top of the artifact store's own path
 * helpers, so there is exactly one resolver for "where does an artifact live".
 *
 * Two rules come from the retention store, unchanged, because they are about a
 * *shared* file rather than about this file:
 *
 *   1. **Exactly one machine executes.** A workspace is cloned; two daily passes
 *      write the same file seconds apart and the sync has no rows to merge, so
 *      `artifacts/conflicts/` fills with `pulse (conflict …).dashboard` every
 *      day. `executorOf` and `isThis` are the retention store's own rule, copied
 *      here: whoever sweeps the shelf produces the dashboard. A non-executor
 *      refuses with a sentence and writes nothing at all.
 *   2. **A write is atomic and stamped.** A pass that dies mid-write must leave
 *      the previous snapshot intact, so every write stages beside the file and
 *      renames into place; the `lastRun` record (`at`, `durationMs`, `cost`,
 *      `machine`) travels with the file so the badge can say who produced it.
 */
const fs = require('node:fs')
const path = require('node:path')
const workspaces = require('./workspace-store.cjs')
const artifacts = require('./artifact-store.cjs')
const retention = require('./artifact-retention-store.cjs')
const auth = require('./auth-store.cjs')
const { MACHINE_NAME } = require('./frontmatter.cjs')

const SUFFIX = '.dashboard'
const KIND = 'entity.dashboard'
const SCHEMA = 2
const MAX_HISTORY = 90
const MAX_BYTES = 4 * 1024 * 1024

/* ── small helpers ─────────────────────────────────────────────────── */

const text = (value, max = 400) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const num = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
const arr = (value) => (Array.isArray(value) ? value : [])

/** A file name a person can read and a shell can hold: no spaces, no slashes. */
function slugOf(value, fallback = 'dashboard') {
  const base = text(value, 80)
    .replace(/\.dashboard$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return base || fallback
}

/** The id this module writes: one slug, resolved against the roots below. */
function idOf(value) {
  const raw = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '')
  const parts = raw.split('/').filter(Boolean)
  /* A producer writes one file and a reader reads wherever it is; only the last
     segment is the name, so an id that arrives with a root attached still
     resolves. */
  if (!parts.length) throw new Error('A dashboard needs an id.')
  const last = slugOf(parts[parts.length - 1])
  return `${last}${SUFFIX}`
}

/* ── where a dashboard lives ────────────────────────────────────────────

   `artifact-store` is the only thing that decides which root an artifact is in,
   and it decides by *location*: `locateFile` (personal first, then shared) reads,
   `adoptUnclaimed` moves anything in the shared tree that the scope index does not
   claim into the personal root. A dashboard is written by a producer entity rather
   than shared by a person, so it never gets a claim — which means `artifacts/` is
   not where it stays: the next shelf read adopts it.

   So this module resolves the same way the store does instead of assuming a root.
   Write to wherever the file already is (a snapshot keeps its identity across a
   move), and a brand-new dashboard defaults to the personal root — the root the
   reader prefers and the root adoption would move it to anyway. One id, one
   path, one scope, whichever surface asks. */

const rootsOf = (record) => [
  { dir: artifacts.personalDir(record), scope: 'personal' },
  { dir: artifacts.artifactsDir(record), scope: 'shared' },
]

/** `{ rel, file, scope }` for the first root that has this id, or null. */
function locateFile(record, id) {
  const rel = idOf(id)
  for (const root of rootsOf(record)) {
    const file = path.resolve(root.dir, rel)
    if (fs.existsSync(file)) return { rel, file, scope: root.scope }
  }
  return null
}

/** Where a write lands: the file's own root if it exists, else the read-preferred one. */
function targetFile(record, id) {
  const hit = locateFile(record, id)
  if (hit) return hit
  const rel = idOf(id)
  return { rel, file: path.resolve(artifacts.personalDir(record), rel), scope: 'personal' }
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtime.toISOString()
  } catch {
    return ''
  }
}

/* ── the leadership rule, copied from `artifact-retention-store.cjs` ── */

/**
 * Who runs the pass for this workspace.
 *
 * `localHost` and the three claim kinds are the retention store's: a local
 * workspace has exactly one machine so the answer is free; a clone reads the
 * shared choice (`owner` = the first owner-signed-in machine, guarded by hostname
 * *and* account; `machine` = the pinned hostname; `host` = the always-on sync
 * host). The one thing this module adds is its own vocabulary — `executor` — so a
 * page can say *who produces the file* without knowing about sweeping.
 */
function localHost() {
  return MACHINE_NAME || require('node:os').hostname()
}

function identityOf() {
  try {
    return auth.get() || null
  } catch {
    return null
  }
}

function isWorkspaceOwner(record) {
  const owner = record?.owner || {}
  const me = identityOf() || {}
  const name = String(me.username || me.user || '').toLowerCase()
  const mail = String(me.email || '').toLowerCase()
  if (owner.email && mail) return String(owner.email).toLowerCase() === mail
  if (owner.name && name) {
    return String(owner.name).toLowerCase() === name || String(owner.name).toLowerCase() === mail
  }
  return false
}

/** The part that lives in `workspace.json`: the choice, never this machine's view. */
function executorOf(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  return retention.executorOf(source)
}

/**
 * `{ kind, label, where, isThis, alwaysOn, claimed }` — the retention store's
 * resolution, without its side effects: this answer is read on every tick and
 * every refresh, and a read may not write a claim.
 */
function resolveExecutor(record) {
  const here = localHost()
  const claim = executorOf(record?.artifactRetention?.executor)
  if (record?.kind !== 'remote') {
    return { kind: 'local', label: 'this machine', where: here, isThis: true, alwaysOn: false, claimed: true }
  }
  if (claim.kind === 'host') {
    return { kind: 'host', label: 'the sync host', where: '', isThis: false, alwaysOn: true, claimed: true }
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
    return {
      kind: 'owner',
      label: claim.hostname,
      where: claim.hostname,
      isThis: claim.hostname === here && isWorkspaceOwner(record),
      alwaysOn: false,
      claimed: true,
    }
  }
  return {
    kind: claim.kind,
    label: claim.kind === 'machine' ? 'a machine nobody has picked yet' : "the owner's machine",
    where: '',
    isThis: false,
    alwaysOn: false,
    claimed: Boolean(claim.kind === 'owner' && isWorkspaceOwner(record)),
  }
}

/**
 * Refuse on a machine that does not produce this workspace.
 *
 * The failure this prevents is expensive and silent: two executors write the same
 * shared file, the `sha256` sync finds no rows to merge, and the shelf fills with
 * conflicts nobody opened. So the refusal is a sentence naming the machine that
 * *does* run it, not a silent no-op or a half-written file.
 */
function executorFor(workspace) {
  const record = workspaces.open(workspace)
  const resolved = resolveExecutor(record)
  if (!resolved.isThis) {
    throw new Error(
      `The pass runs on ${resolved.label}; this machine only reads the dashboard. ${localHost()} does not produce it.`,
    )
  }
  return resolved
}

/* ── reading ───────────────────────────────────────────────────────── */

function readJson(file) {
  const stat = fs.statSync(file)
  if (stat.size > MAX_BYTES) throw new Error('That dashboard is too large to read here.')
  const raw = fs.readFileSync(file, 'utf8')
  const doc = JSON.parse(raw)
  if (!doc || typeof doc !== 'object') throw new Error('That file is not a dashboard.')
  return doc
}

function locate(record, id) {
  /* The same personal-then-shared search `artifact-store.locateFile` does, so a
     dashboard that adoption moved is still found by its id. */
  const hit = locateFile(record, id)
  return hit ? hit.file : null
}

/**
 * One dashboard, as stored. The `v`/`kind` check is a *read* rule, not a write
 * rule: a file from a newer build is handed back with its problem stated, so the
 * page can say "this needs a newer Entity" instead of failing to open at all.
 */
function read({ workspace, id } = {}) {
  const record = workspaces.open(workspace)
  const rel = idOf(id)
  const file = locate(record, rel)
  if (!file) throw new Error('That dashboard no longer exists.')
  let doc
  try {
    doc = readJson(file)
  } catch (error) {
    throw new Error(`That dashboard could not be read — ${error?.message || error}`)
  }
  return {
    id: rel,
    path: file,
    modifiedAt: mtimeOf(file),
    kind: text(doc.kind, 60),
    v: num(doc.v),
    doc,
  }
}

/** Every dashboard on this workspace's shelf, newest first. One directory walk. */
function list({ workspace } = {}) {
  const record = workspaces.open(workspace)
  let items = []
  try {
    items = artifacts.list({ workspace }).items
  } catch {
    items = []
  }
  const rows = items
    .filter((item) => item.kind === 'dashboard')
    .map((item) => {
      let doc = null
      try {
        /* Resolved by id, not rebuilt from one root: the row knows which root its
           file is in, and after an adoption the personal one is the answer. */
        const hit = locateFile(record, item.id)
        doc = hit ? readJson(hit.file) : null
      } catch {
        doc = null
      }
      const snapshot = doc?.snapshot && typeof doc.snapshot === 'object' ? doc.snapshot : null
      return {
        id: item.id,
        name: item.name,
        scope: item.scope,
        modifiedAt: item.modifiedAt,
        size: item.size,
        title: text(doc?.title, 120) || item.name.replace(/\.dashboard$/i, ''),
        producer: text(doc?.producer?.entity || doc?.producer, 80),
        state: doc ? '' : 'unsupported',
        hasSnapshot: Boolean(snapshot?.at),
        snapshotAt: text(snapshot?.at, 40),
        /* who produced it, so the band can say "produced on …" without a second
           read of the file it just parsed */
        machine: text(snapshot?.machine || doc?.lastRun?.machine, 80),
        schedule: doc?.schedule && typeof doc.schedule === 'object' ? text(doc.schedule.cadence, 20) : '',
        workspace: record.id,
      }
    })
  return { items: rows, count: rows.length }
}

/* ── writing ───────────────────────────────────────────────────────── */

/**
 * One pass's result, onto the file.
 *
 * The ring is appended here (never by the producer), because "the last 90 passes"
 * is a property of the container: a producer that forgets to trim would grow the
 * file forever, and a producer that rewrites the ring would lose history on a
 * retry. `lastRun` is stamped with this machine, so a badge can name the executor
 * without inferring it from a hostname in a path.
 */
function withRun(doc, { at, durationMs, cost, machine } = {}) {
  const next = { ...doc }
  next.kind = KIND
  next.v = Number(next.v) || SCHEMA
  const entry = {
    at: text(at, 40) || new Date().toISOString(),
    values: {},
    durationMs: num(durationMs),
    cost: num(cost),
    machine: text(machine, 80) || localHost(),
  }
  const ring = arr(doc.history).slice(-(MAX_HISTORY - 1))
  next.history = [...ring, entry]
  next.lastRun = { ...entry }
  return next
}

function write({ workspace, id, doc, run = null } = {}) {
  const record = workspaces.open(workspace)
  const target = targetFile(record, id)
  const rel = target.rel
  const file = target.file
  const source = doc && typeof doc === 'object' ? doc : {}
  const next = run ? withRun(source, run) : source
  /* Every write states its own kind and schema: a hand-edited file must not be
     able to pretend it is a v1 that this build will read differently. */
  next.kind = next.kind || KIND
  next.v = Number(next.v) || SCHEMA
  const body = `${JSON.stringify(next, null, 2)}\n`
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error('That dashboard is too large to write here.')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  /* Staged beside the target and renamed in: a pass that dies mid-write leaves
     the previous snapshot intact, which is the whole point of a cache file. */
  const staged = `${file}.${process.pid}.tmp`
  fs.writeFileSync(staged, body, 'utf8')
  fs.renameSync(staged, file)
  return { id: rel, path: file, modifiedAt: mtimeOf(file), doc: next }
}

/** One line of the ring, appended by a caller that already has a whole snapshot. */
function recordRun({ workspace, id, at, durationMs, cost } = {}) {
  const record = workspaces.open(workspace)
  const rel = idOf(id)
  const file = locate(record, rel)
  if (!file) throw new Error('That dashboard no longer exists.')
  const doc = readJson(file)
  return write({
    workspace,
    id: rel,
    doc,
    run: { at, durationMs, cost, machine: localHost() },
  })
}

/** Patch the schedule only; the ring and the snapshot are untouched. */
function setSchedule({ workspace, id, schedule = {} } = {}) {
  const record = workspaces.open(workspace)
  const rel = idOf(id)
  const file = locate(record, rel)
  if (!file) throw new Error('That dashboard no longer exists.')
  const doc = readJson(file)
  const cadence = ['daily', 'weekly', 'monthly', 'manual'].includes(schedule.cadence) ? schedule.cadence : 'daily'
  const next = {
    ...doc,
    schedule: {
      ...(doc.schedule || {}),
      cadence,
      at: text(schedule.at, 10) || text(doc.schedule?.at, 10) || '06:30',
      grace: text(schedule.grace, 10) || text(doc.schedule?.grace, 10) || '2h',
      enabled: schedule.enabled === undefined ? (doc.schedule?.enabled !== false) : Boolean(schedule.enabled),
    },
  }
  return write({ workspace, id: rel, doc: next })
}

/**
 * Remove the `.dashboard` files from a retention candidate list.
 *
 * A dashboard is a *cache*, not a document someone finished with: the next pass
 * writes it again, and a sweep that archived one would make the page say "no
 * dashboard" while the producer was still running. The exemption lives here so
 * the sweep has one function to call and one comment to read.
 */
function retainable(id) {
  return !String(id || '').toLowerCase().endsWith(SUFFIX)
}

module.exports = {
  SUFFIX,
  KIND,
  SCHEMA,
  MAX_HISTORY,
  slugOf,
  idOf,
  executorOf,
  resolveExecutor,
  executorFor,
  localHost,
  list,
  read,
  write,
  recordRun,
  setSchedule,
  retainable,
  mtimeOf,
}
