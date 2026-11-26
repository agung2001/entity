import { reactive } from 'vue'
import { call } from '@/composables/localBridge'

/**
 * The Fitbit connector's read layer, in the renderer.
 *
 * One call — `fitbit.dashboard` — answered by `electron/connectors/fitbit/dashboard.cjs`,
 * and one shared object so the tab strip and the tab body cannot disagree about
 * which day is on screen or how much of the hour's budget is left.
 *
 * **This file never sees a token**, and it never decides which day "today" is. The
 * account's timezone lives on the main process, next to the calls that read it, so
 * the day is resolved there and comes back on the payload (`date`, `day.timezone`).
 * A renderer that computed its own date would be wrong for every person whose
 * machine is not in their Fitbit account's zone — which is most people who travel.
 *
 * The read is **read-only**: there is no function here that logs activity, food,
 * water or sleep, and no control is drawn for one. `force` is the only argument,
 * because a re-read is the only verb.
 *
 * A refused or limited read arrives as a plain answer (`ok: false` with
 * `limited`) or as an `Error` from `call()`; both are kept, because "the hour is
 * spent" and "the token is refused" need different words on screen.
 */
export const fitbit = reactive({
  /* The account's own day, as the main process resolved it. */
  date: '',
  /* The day the numbers on screen were *asked* for. A remount compares the address
     against this, so opening a different day's link cannot show the previous day's
     numbers under the new date.

     It starts **empty**, not `'today'`: the first mount asks for today, and a value
     no request can equal is the only thing that makes that first ask happen. Seeded
     with `'today'`, `ensureDay('')` compares like with like and the pane paints
     dashes for ever. */
  askedDay: '',
  day: { start: '', end: '', timezone: '', hoursLeft: 0 },
  counts: {
    steps: null,
    distanceKm: null,
    activeMinutes: null,
    sleep: { minutes: null, score: null },
    restingHr: null,
    devices: { count: 0, name: '', syncedAt: '' },
  },
  goals: { steps: null, distanceKm: null, activeMinutes: null },
  hrRange: null,
  bands: [],
  week: [],
  /* The device list behind the count, so the rail can name what synced. Named
     apart from `counts.devices`, which is the one-line summary of the same read. */
  deviceList: [],
  /* What the read cost and when it happened. `stale` means the numbers came from
     the main process's file rather than from Fitbit just now, and the page says
     so; `cacheTtlMs` is the rule itself, so the copy cannot drift from it. */
  stale: false,
  calls: 0,
  readAt: '',
  cacheTtlMs: 0,
  budget: null,
  limited: null,
  /* Two flags that change the words rather than the numbers: a grant without the
     heart-rate scope reads nulls, and a profile without a timezone means the day
     boundary is UTC. Neither is a zero and neither is a guess. */
  noHeartrate: false,
  noTimezone: false,
  reading: false,
  error: '',
})

/** `''` and `today` are one word on the wire: both mean the account's current day,
    and the main process is the only thing that can say which date that is. This is
    the *request's* spelling — the comparison below is against `askedDay`, which only
    ever holds a value this function returned. */
function dayKey(day) {
  const value = String(day || '').toLowerCase()
  return value === '' || value === 'today' ? 'today' : value
}

/* The request a read-in-flight displaced, run once that read has landed. */
let waiting = null

/* The two shapes a payload may leave out entirely; every other field is either
   optional or has a `null` that means the same thing as absence. */
const EMPTY = {
  counts: {
    steps: null,
    distanceKm: null,
    activeMinutes: null,
    sleep: { minutes: null, score: null },
    restingHr: null,
    devices: { count: 0, name: '', syncedAt: '' },
  },
  goals: { steps: null, distanceKm: null, activeMinutes: null },
}

/** Take one answer into the shared object. Every field has a shape, so a payload
    missing one leaves the previous value rather than `undefined` on screen. */
function adopt(answer) {
  const value = answer || {}
  fitbit.date = String(value.date || '')
  fitbit.day = value.day || { start: '', end: '', timezone: '', hoursLeft: 0 }
  fitbit.counts = value.counts || EMPTY.counts
  fitbit.goals = value.goals || EMPTY.goals
  fitbit.hrRange = value.hrRange || null
  fitbit.bands = Array.isArray(value.bands) ? value.bands : []
  fitbit.week = Array.isArray(value.week) ? value.week : []
  fitbit.deviceList = Array.isArray(value.devices) ? value.devices : []
  fitbit.stale = value.stale === true
  fitbit.calls = Number(value.calls || 0)
  fitbit.readAt = String(value.readAt || '')
  fitbit.cacheTtlMs = Number(value.cacheTtlMs || 0)
  fitbit.budget = value.budget || null
  fitbit.noHeartrate = value.noHeartrate === true
  fitbit.noTimezone = value.noTimezone === true
}

/** Read the day the address names, unless it is the day already on screen. A
    remount after a tab switch is the case this exists for: the numbers are still in
    memory, and a link to another day must not be answered with them. */
export function ensureDay(day) {
  if (fitbit.askedDay !== dayKey(day)) readDashboard({ day })
}

/**
 * One day.
 *
 * `day` is what the address says — `''` (today), `yesterday`, or `YYYY-MM-DD` —
 * and is passed straight through, because the main process owns both the
 * validation and the timezone. `force` is the Re-read button: without it a day
 * already read is served from the file and says so (`stale`).
 */
export async function readDashboard({ day = '', force = false } = {}) {
  /* One read at a time, because two answers on screen at once is how a day's
     numbers end up under the wrong date. The newest request is kept, not the
     oldest: a person who pressed twice wants the second day. */
  if (fitbit.reading) {
    waiting = { day, force }
    return
  }
  fitbit.reading = true
  /* The day is marked as asked for **as the read starts**, not when it lands: a
     second `ensureDay` during the flight must not queue the same day behind
     itself, and a read that fails still answered *which day was wanted*. */
  fitbit.askedDay = dayKey(day)
  try {
    const answer = await call('fitbit.dashboard', { day, force })
    /* A spent hour is an answer, not a failure: the numbers already on screen are
       still real, and the reset time is the only thing to act on. */
    if (answer?.ok === false) {
      fitbit.limited = answer.limited || null
      /* The refusal carries the hour's count, so the banner can name it even
         though nothing was re-read. */
      if (answer.budget) fitbit.budget = answer.budget
    } else {
      adopt(answer)
      fitbit.limited = null
    }
    fitbit.error = ''
  } catch (problem) {
    fitbit.error = String(problem?.message || problem)
    fitbit.limited = null
  } finally {
    fitbit.reading = false
    if (waiting) {
      const next = waiting
      waiting = null
      readDashboard(next)
    }
  }
}
