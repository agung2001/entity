/**
 * When a dashboard's pass runs.
 *
 * The same shape as `artifact-retention-store.cjs`'s tick, for the same reason: a
 * desktop is open all day and shut at night, so "daily 06:30" means "at most a day
 * behind, and not before 06:30". A boot tick catches the deadline that passed while
 * the machine was closed; an interval catches the one that passes while it is open.
 * Two unref'd timers, no scheduler library, and a pass fires **once** per due
 * cadence — `lastRun.at` is the record that makes it idempotent.
 *
 * The one thing this file does not decide: *who* runs. `dashboard-store.executorFor`
 * refuses on every machine that is not the workspace's executor, so a cloned
 * workspace has one producer and N readers, and a reader's boot tick is a cheap
 * read of a JSON field rather than a pass.
 *
 * A pass is a harness turn, and this file has no harness: `providers.run` is wired
 * in `electron/rpc.cjs` (the process that owns the runner). Without it — the shared
 * server, a test — `tick` reports the dashboards that were due and starts nothing,
 * which is what a scheduler with no engine should do.
 */
const workspaces = require('./workspace-store.cjs')
const store = require('./dashboard-store.cjs')

const START_DELAY_MS = 90_000
const INTERVAL_MS = 15 * 60_000
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/* ── the clock ─────────────────────────────────────────────────────── */

/** `'06:30'` → `{ h: 6, m: 30 }`; anything else → null. */
function clockOf(value) {
  const hit = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim())
  if (!hit) return null
  const h = Number(hit[1])
  const m = Number(hit[2])
  if (h > 23 || m > 59) return null
  return { h, m }
}

/** The most recent moment this cadence was due, at or before `now`, in ms. */
function lastDueAt(cadence, at, now = new Date()) {
  const clock = clockOf(at) || { h: 6, m: 30 }
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate(), clock.h, clock.m)
  if (cadence === 'weekly') {
    const back = (day.getDay() + 6) % 7 /* Monday is the week's first tick */
    const monday = day.getTime() - back * DAY_MS
    return monday <= now.getTime() ? monday : monday - 7 * DAY_MS
  }
  if (cadence === 'monthly') {
    const first = new Date(now.getFullYear(), now.getMonth(), 1, clock.h, clock.m).getTime()
    return first <= now.getTime() ? first : new Date(now.getFullYear(), now.getMonth() - 1, 1, clock.h, clock.m).getTime()
  }
  /* daily, and the fallback for anything a hand-edited file invented */
  return day.getTime() <= now.getTime() ? day.getTime() : day.getTime() - DAY_MS
}

/** The next moment it will be due, so the page can say "in 20 h". */
function nextDueAt(cadence, at, now = new Date()) {
  const due = lastDueAt(cadence, at, now)
  const step = cadence === 'weekly' ? 7 * DAY_MS : cadence === 'monthly' ? 0 : DAY_MS
  if (!step) {
    const base = new Date(due)
    return new Date(base.getFullYear(), base.getMonth() + 1, 1, base.getHours(), base.getMinutes()).getTime()
  }
  return due + step
}

/**
 * Is one dashboard due?
 *
 * `manual` never is — "only when I ask" is a promise the scheduler keeps by doing
 * nothing. A snapshot that has never been written is due immediately: the first
 * pass is the whole point of turning the schedule on.
 */
function due({ doc = {}, now = new Date(), toleranceMs = INTERVAL_MS } = {}) {
  const schedule = doc.schedule && typeof doc.schedule === 'object' ? doc.schedule : null
  if (!schedule || schedule.enabled === false) return { due: false, reason: 'off' }
  const cadence = String(schedule.cadence || 'daily')
  if (cadence === 'manual') return { due: false, reason: 'manual' }
  const at = lastDueAt(cadence, schedule.at, now)
  const last = Date.parse(String(doc.lastRun?.at || doc.snapshot?.at || '')) || 0
  if (!last) return { due: true, reason: 'never run', at }
  /* A pass that finished after the deadline answered it. The tolerance keeps a
     pass that ran a minute early from firing a second time at the deadline. */
  if (last >= at - toleranceMs) return { due: false, reason: 'answered', at }
  return { due: true, reason: 'past its deadline', at }
}

/* ── the tick ──────────────────────────────────────────────────────── */

const providers = { run: null, log: () => {}, now: () => new Date() }

/**
 * The one place a main process hands this scheduler its engine.
 *
 * `run({ workspace, id, doc })` returns `{ cost, durationMs }` for a finished
 * pass; anything it throws is this dashboard's failure and does not stop the
 * others. Wired in `rpc.cjs`, where the runner lives.
 */
function configure(next = {}) {
  for (const key of Object.keys(providers)) {
    if (next[key] !== undefined) providers[key] = next[key]
  }
  return providers
}

let ticking = false

/**
 * Every workspace, every dashboard, once: run the ones that are due.
 *
 * The whole loop is guarded by one module-level flag, so an interval and a boot
 * tick that overlap cannot run the same dashboard twice — the second one is
 * already a no-op by the time it starts.
 */
async function tick({ now = providers.now(), log = providers.log } = {}) {
  if (ticking) return { skipped: true, ran: [] }
  ticking = true
  const ran = []
  const dueIds = []
  try {
    for (const item of workspaces.list()) {
      let rows = []
      try {
        rows = store.list({ workspace: item.id }).items
      } catch (error) {
        log(`dashboard schedule ${item.id}: ${error?.message || error}`)
        continue
      }
      for (const row of rows) {
        if (row.scope !== 'shared') continue
        let read
        try {
          read = store.read({ workspace: item.id, id: row.id })
        } catch {
          continue
        }
        const verdict = due({ doc: read.doc, now })
        if (!verdict.due) continue
        /* The leadership rule, before anything is written or spent: a clone that
           is not the executor stands down with a sentence, not with a pass. */
        let executor
        try {
          executor = store.executorFor(item.id)
        } catch (error) {
          log(`dashboard ${item.id}/${row.id}: ${error?.message || error}`)
          continue
        }
        dueIds.push(`${item.id}/${row.id}`)
        if (typeof providers.run !== 'function') {
          log(`dashboard ${item.id}/${row.id}: due (${verdict.reason}) on ${executor.label}; no producer is wired`)
          continue
        }
        const startedAt = providers.now().getTime()
        try {
          const result = await providers.run({ workspace: item.id, id: row.id, doc: read.doc })
          store.write({
            workspace: item.id,
            id: row.id,
            doc: result?.doc || read.doc,
            run: {
              at: String(startedAt),
              durationMs: result?.durationMs ?? providers.now().getTime() - startedAt,
              cost: result?.cost,
            },
          })
          ran.push({ workspace: item.id, id: row.id, reason: verdict.reason })
          log(`dashboard ${item.id}/${row.id}: ${verdict.reason}, produced on ${executor.label}`)
        } catch (error) {
          /* A failed pass writes nothing: the previous snapshot is the last truth,
             and the page already has a state for "this source failed". */
          log(`dashboard ${item.id}/${row.id}: pass failed — ${error?.message || error}`)
        }
      }
    }
  } catch (error) {
    log(`dashboard tick failed: ${error?.message || error}`)
  } finally {
    ticking = false
  }
  return { ran, due: dueIds }
}

/* ── the timers ────────────────────────────────────────────────────── */

let bootTimer = null
let timer = null

/**
 * `start` is idempotent: the desktop calls it once at boot and the dev server on
 * every reload, and two timers firing the same pass is exactly the double write
 * the leadership rule exists to prevent. Unref'd, like every other timer here — a
 * dashboard never keeps the app alive.
 */
function start({ log = () => {}, run = null } = {}) {
  if (timer) return false
  configure({ log, run })
  bootTimer = setTimeout(() => {
    tick({ log }).catch(() => {})
  }, START_DELAY_MS)
  bootTimer.unref?.()
  timer = setInterval(() => {
    tick({ log }).catch(() => {})
  }, INTERVAL_MS)
  timer.unref?.()
  return true
}

function stop() {
  if (bootTimer) clearTimeout(bootTimer)
  if (timer) clearInterval(timer)
  bootTimer = null
  timer = null
}

module.exports = {
  START_DELAY_MS,
  INTERVAL_MS,
  clockOf,
  lastDueAt,
  nextDueAt,
  due,
  configure,
  tick,
  start,
  stop,
}
