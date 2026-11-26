/**
 * One day of Fitbit, read through the Web API — **read-only, and expensive enough
 * to count.**
 *
 * Five requests per day, in this order:
 *
 *   /1/user/-/activities/date/<date>.json          steps, distance, active minutes, goals
 *   /1.2/user/-/sleep/date/<date>.json             last night, and its score
 *   /1/user/-/activities/heart/date/<date>/1d.json resting heart rate, and the zone edges
 *   /1/user/-/activities/heart/date/<date>/1d/1min.json  the minute trace the bands are cut from
 *   /1/user/-/devices.json                         what synced, and when
 *
 * A sixth read is not part of the day: `/1/user/-/profile.json` supplies the
 * account's timezone, and it is cached for an hour **in the same block as the
 * device list** — so a new day costs five calls, not six, and a page that moves
 * between days spends nothing on either. Both halves of that block are re-read at
 * most once an hour, and neither is re-spent because the day changed.
 *
 * **Nothing here writes to Fitbit.** Every call is a GET; logging activity, food,
 * water or sleep is not wired, and no caller of this module can ask for it. The
 * token is refreshed on this machine through the shared path and never leaves it:
 * no token, no secret and no address is printed, returned or logged here.
 *
 * **Fitbit allows 150 calls an hour per account.** This module keeps its own
 * counter beside the cache and refuses a read *before* it spends one, so a page
 * that is opened thirty times in an hour says "the hour resets at 14:20" instead
 * of collecting 429s. A 429 that still arrives carries Fitbit's own
 * `fitbit-rate-limit-reset`, which is reported and never guessed.
 *
 * **A number that is unknown is null, never zero.** A missing heart-rate scope, a
 * night with no sleep logged, an hour the device was not worn: each of those is
 * `null` and the page prints `—`. A zero would be a claim that a person did
 * nothing, and this file has no way to know that.
 *
 * Cache: `<ENTITY_HOME>/fitbit-dashboard.json`, one entry per day plus the hourly
 * block and the call counter. A day already read is served from the file; `force`
 * is the only thing that bypasses it, and it is the "Re-read" button, not an
 * hourly refresh nobody asked for.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const oauthAccounts = require('./oauth-accounts.cjs')
const { accessToken } = require('./connectors/_shared.cjs')

const API = 'https://api.fitbit.com'
/* What one day of the page costs, and what Fitbit lets one account spend in an
   hour. Both are facts about the API, not settings. */
const DAY_CALLS = 5
const HOURLY_CALLS = 150
const RATE_WINDOW_MS = 60 * 60_000
/* The device list and the account's timezone share this block: neither changes
   within an hour, and a day change must not re-spend either. */
const HOURLY_TTL_MS = 60 * 60_000
/* A finished day is a fact; today is a number still moving. Served from the file
   for a day and for ten minutes respectively — `force` bypasses both. */
const TTL_PAST_MS = 24 * 60 * 60_000
const TTL_TODAY_MS = 10 * 60_000
/* Enough to draw a week's rail from days already read, and small enough that the
   file stays a file. */
const KEEP_DAYS = 31
const TIMEOUT_MS = 20_000
const CACHE_SCHEMA = 1
const DAY = /^\d{4}-\d{2}-\d{2}$/
const ROOT = process.env.ENTITY_HOME
  ? path.resolve(process.env.ENTITY_HOME)
  : path.join(os.homedir(), '.entity')
const CACHE_FILE = path.join(ROOT, 'fitbit-dashboard.json')

const text = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const num = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value))

/* ── the zone, and the day it makes ───────────────────────────────────────
   Every date in this file is a **wall clock** in the account's own zone, never a
   UTC day: at 06:00 in Jakarta, `toISOString().slice(0, 10)` still says yesterday
   and the page would show the wrong day for seven hours of every day. */

/** The zone's offset from UTC at one instant, in milliseconds. */
function zonedOffset(ms, timeZone) {
  return Date.parse(`${new Date(ms).toLocaleString('en-US', { timeZone })} UTC`) - ms
}

/** The wall-clock date in the zone, `YYYY-MM-DD`. */
function zonedDay(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(ms)
  const part = (type) => parts.find((entry) => entry.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

const addDays = (key, days) =>
  new Date(Date.parse(`${key}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

/**
 * The UTC instant of a local midnight — two passes, because the offset at UTC
 * midnight can belong to the other side of a DST change. One pass is an hour out
 * on the two days a year the clocks move, which is exactly when a day boundary
 * matters.
 */
function localMidnight(key, timeZone) {
  const guess = Date.parse(`${key}T00:00:00Z`)
  return guess - zonedOffset(guess - zonedOffset(guess, timeZone), timeZone)
}

const realDate = (key) => {
  const at = Date.parse(`${key}T00:00:00Z`)
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === key
}

/**
 * `today`, `yesterday`, or a literal `YYYY-MM-DD` — nothing else, no silent guess.
 *
 * A malformed date, an impossible one (`2026-02-31`) and one that has not
 * happened yet are each an error that says which rule it broke. The date reaches
 * a URL, so it is checked before it is interpolated, not after.
 */
function dayOf(raw, timeZone, now = Date.now()) {
  const said = text(raw, 20).toLowerCase()
  const today = zonedDay(now, timeZone)
  if (!said || said === 'today') return today
  /* minus a day, not minus 24 hours at a fixed wall clock: the worst a ±1 hour
     shift can do is move 00:10 to 23:10 of the previous day, which is still
     yesterday. */
  if (said === 'yesterday') return zonedDay(now - 86_400_000, timeZone)
  if (!DAY.test(said) || !realDate(said)) {
    throw new Error(
      `@fitbit: a date is \`today\`, \`yesterday\` or YYYY-MM-DD — “${text(raw, 20)}” is none of those.`,
    )
  }
  if (said > today) {
    throw new Error(`@fitbit: ${said} has not happened yet — the last day this account has is ${today}.`)
  }
  return said
}

/* ── the account ──────────────────────────────────────────────────────────
   One account per install, like Habitify: the connector id is both the account
   store's key and the token's, so a mention has no account segment to name. */

/** The localpart to read from the one connected account. */
function accountOf() {
  const accounts = oauthAccounts.connectedAccounts('fitbit')
  const usable = accounts.filter((entry) => entry.status === 'connected' && entry.hasToken)
  if (!usable.length) {
    throw new Error(
      accounts.length
        ? 'The Fitbit account on this machine needs a sign-in — its grant was refused. Sign in on the connector’s page.'
        : 'No Fitbit account is signed in on this machine yet. Connect one on the connector’s page.',
    )
  }
  return usable[0].localpart
}

/* ── the file ─────────────────────────────────────────────────────────────
   One JSON file holds three things that belong together: the days already read
   (so the week rail needs no sixth call), the hourly block, and the call counter.
   Every failure here is a miss, never a read that fails. */

const emptyStore = () => ({ schema: CACHE_SCHEMA, days: {}, hourly: null, rate: null })

function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    if (raw?.schema !== CACHE_SCHEMA) return emptyStore()
    return {
      schema: CACHE_SCHEMA,
      days: raw?.days && typeof raw.days === 'object' ? raw.days : {},
      hourly: raw?.hourly && typeof raw.hourly === 'object' ? raw.hourly : null,
      rate: raw?.rate && typeof raw.rate === 'object' ? raw.rate : null,
    }
  } catch {
    return emptyStore()
  }
}

function writeStore(store) {
  /* Newest first, and only what fits: a year of days would make the rail's own
     question ("this week") slower to answer than the five calls it saves. */
  const kept = Object.entries(store.days || {})
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .slice(0, KEEP_DAYS)
  const body = `${JSON.stringify(
    { schema: CACHE_SCHEMA, days: Object.fromEntries(kept), hourly: store.hourly, rate: store.rate },
    null,
    2,
  )}\n`
  try {
    fs.mkdirSync(ROOT, { recursive: true })
    const staged = `${CACHE_FILE}.${process.pid}.tmp`
    fs.writeFileSync(staged, body, 'utf8')
    fs.renameSync(staged, CACHE_FILE)
  } catch {
    /* a read-only home or a full disk: the next visit reads Fitbit again */
  }
}

/** Signing out changes whose token answers, so the stored days belong to nobody. */
function forgetCache() {
  try {
    fs.rmSync(CACHE_FILE, { force: true })
  } catch {
    /* already gone */
  }
}

/* ── the call counter ─────────────────────────────────────────────────────
   Fitbit's own budget, counted here so a limit is a sentence and not a 429. The
   window is an hour from the first call, which is the shape Fitbit documents. */

function budgetOf(store) {
  const at = Number(store?.rate?.at) || 0
  const fresh = at > 0 && Date.now() - at < RATE_WINDOW_MS
  return {
    used: fresh ? Number(store.rate.calls) || 0 : 0,
    limit: HOURLY_CALLS,
    resetAt: new Date((fresh ? at : Date.now()) + RATE_WINDOW_MS).toISOString(),
  }
}

function charge(store, calls = 1) {
  const at = Number(store.rate?.at) || 0
  if (!(at > 0 && Date.now() - at < RATE_WINDOW_MS)) store.rate = { at: Date.now(), calls: 0 }
  store.rate.calls = (Number(store.rate.calls) || 0) + calls
  const budget = budgetOf(store)
  budget.used = store.rate.calls
  return budget
}

/** A refusal that the caller turns into `{ ok: false, limited }` — the shape the
 *  page prints with the hour it resets, and the one a 429 also produces. */
const limitedError = (resetAt, calls) =>
  Object.assign(new Error('Fitbit’s call limit for this hour is spent.'), {
    limited: { resetAt: String(resetAt || ''), calls: Number(calls) || 0 },
  })

/* ── HTTP ─────────────────────────────────────────────────────────────────
   One GET, and the four answers worth telling apart: a body, a spent budget, a
   dead token, and a scope this grant never asked for.
   Every attempt is charged before it is judged: a call that answers 429 or 500
   was still a call, and a counter that only counts successes under-reports the
   one number this file uses to avoid a 429. */

async function callJson(pathname, token, store) {
  const answer = await getJson(pathname, token)
  charge(store)
  return answer
}

async function getJson(pathname, token) {
  let response
  try {
    response = await fetch(`${API}${pathname}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new Error('Fitbit did not answer within 20 seconds.')
  }
  const body = await response.json().catch(() => null)
  /* Fitbit's own reset, in seconds. Absent means unknown and stays empty: a
     guessed hour would be a sentence about time this module cannot see. */
  const reset = response.headers.get('fitbit-rate-limit-reset')
  const errorType = text(body?.errors?.[0]?.errorType, 80)
  const message = text(body?.errors?.[0]?.message, 200)
  return {
    ok: response.ok,
    status: response.status,
    body,
    errorType,
    scopeDenied: response.status === 401 || response.status === 403 || /insufficient_scope|permission/i.test(`${errorType} ${message}`),
    said: message || errorType || `HTTP ${response.status}`,
    resetAt:
      reset && Number.isFinite(Number(reset))
        ? new Date(Date.now() + Number(reset) * 1000).toISOString()
        : '',
  }
}

/** The two failures a read cannot continue through. A 403 is the caller's call:
 *  for the heart trace it means a scope was not granted, which is a null, not a
 *  refusal. */
function guard(answer, store) {
  if (answer.status === 429) throw limitedError(answer.resetAt, store?.rate?.calls || 0)
  if (answer.status === 401) {
    throw new Error(
      '@fitbit: needs a sign-in — Fitbit rejected the token. Sign in on the connector’s page.',
    )
  }
  if (!answer.ok && answer.status !== 403) {
    throw new Error(`@fitbit: Fitbit answered ${answer.said}.`)
  }
}

/* ── the hourly block: the account's zone and the devices ─────────────────
   Both are read at most once an hour and are cached together, because both answer
   questions that do not change within an hour. A new day re-uses them.
   A profile with no timezone is not guessed at: the read falls back to UTC and
   says so (`noTimezone`), which the page can print as the reason a day boundary
   looks odd. */

async function hourlyBlock(store, token) {
  const at = Number(store.hourly?.at) || 0
  if (at > 0 && Date.now() - at < HOURLY_TTL_MS) return store.hourly

  const profileAnswer = await callJson('/1/user/-/profile.json', token, store)
  guard(profileAnswer, store)
  const user = profileAnswer.body?.user || {}
  const zone = text(user.timezone, 64)

  const devicesAnswer = await callJson('/1/user/-/devices.json', token, store)
  guard(devicesAnswer, store)
  const devices = Array.isArray(devicesAnswer.body) ? devicesAnswer.body : []

  const block = {
    at: Date.now(),
    timezone: zone && zone !== 'UTC' ? zone : zone || 'UTC',
    /* Fitbit always sends a zone. An empty one means the answer was thinner than
       the contract, and UTC is the fallback the page is told about. */
    noTimezone: !zone,
    encodedId: text(user.encodedId, 40),
    name: text(user.fullName || user.displayName, 80),
    devices: devices
      .map((device) => ({
        name: text(device?.deviceVersion || device?.type, 60),
        type: text(device?.type, 40),
        lastSyncTime: text(device?.lastSyncTime, 40),
        battery: text(device?.battery, 20),
      }))
      .filter((device) => device.name),
  }
  store.hourly = block
  return block
}

/* ── shaping ────────────────────────────────────────────────────────────── */

/** The day's zone edges: start, end, and how much of it is left. */
function dayOfPayload(date, timezone, now) {
  const start = localMidnight(date, timezone)
  const end = localMidnight(addDays(date, 1), timezone)
  const left = (end - now) / 3_600_000
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    timezone,
    /* 0 for a day that is over, 24 for one that has not begun (which this module
       refuses anyway), and a fraction for today. */
    hoursLeft: Math.max(0, Math.min(24, Math.round(left * 100) / 100)),
  }
}

/** The day's counts, from the three answers that carry them. */
function countsOf(activity, sleepBody, heartBody, block) {
  const summary = activity?.summary || {}
  const distances = Array.isArray(summary.distances) ? summary.distances : []
  const total = distances.find((entry) => String(entry?.activity || '').toLowerCase() === 'total')
  const distanceM = total ? num(total.distance) : null

  const nights = Array.isArray(sleepBody?.sleep) ? sleepBody.sleep.filter(Boolean) : []
  const main = nights.find((night) => night?.isMainSleep === true) || nights[0] || null
  /* `minutesAsleep` is the number a person means by "slept"; the score is in the
     log for some accounts and absent for others, which is a null and not a zero. */
  const sleepMinutes = main ? num(main.minutesAsleep) : null
  const sleepScore = main ? num(main.score ?? main.efficiency) : null

  const heart = (Array.isArray(heartBody?.['activities-heart']) ? heartBody['activities-heart'][0] : null)?.value || null
  const fairly = num(summary.fairlyActiveMinutes)
  const very = num(summary.veryActiveMinutes)

  return {
    steps: num(summary.steps),
    distanceKm: distanceM === null ? null : Math.round((distanceM / 1000) * 100) / 100,
    activeMinutes: fairly === null && very === null ? null : (fairly || 0) + (very || 0),
    sleep: { minutes: sleepMinutes, score: sleepScore },
    restingHr: heart ? num(heart.restingHeartRate) : null,
    /* A count plus the device that stands behind it: "Charge 6 · synced 12 min
       ago" is what makes the number believable, and it is the only place a device
       name appears. */
    devices: {
      count: block.devices.length,
      name: block.devices[0]?.name || '',
      syncedAt: block.devices[0]?.lastSyncTime || '',
    },
  }
}

/** The day's goals, in the same units as the counts. */
function goalsOf(activity) {
  const goals = activity?.goals || {}
  const distance = num(goals.distance)
  return {
    steps: num(goals.steps),
    distanceKm: distance === null ? null : Math.round(distance * 100) / 100,
    activeMinutes: num(goals.activeMinutes),
  }
}

/** The lower edge of "active" from the day's own zone table, or null when the
    grant never asked for heart rate — a threshold nobody sent cannot be invented. */
function activeFloor(heartBody) {
  const value = (Array.isArray(heartBody?.['activities-heart']) ? heartBody['activities-heart'][0] : null)?.value
  const zones = Array.isArray(value?.heartRateZones) ? value.heartRateZones : []
  const named = zones.find((zone) => /fat burn|cardio|peak/i.test(String(zone?.name || '')))
  const floor = num(named?.min)
  return floor === null ? null : floor
}

/**
 * Twenty-four hour slots, cut from the minute trace.
 *
 * `activeMinutes` here is **derived**: a sample at or above the day's own active
 * zone floor counts as one active minute. The KPI above is Fitbit's own count, so
 * the two can differ by a minute at an edge — the table says where the minutes
 * were, the KPI says what Fitbit logged.
 *
 * `steps` is `null` in every band on purpose: the day endpoint aggregates steps,
 * and a per-hour split would be a sixth request this read does not spend. The
 * page prints `—` there rather than inventing a distribution.
 *
 * `status` carries the fact a glance needs:
 *   `not yet`      the hour has not begun
 *   `in progress`  the hour we are in, and only for today
 *   `rest`         the device was not on a wrist for any of it
 *   `on track`     the hour logged at least one active minute
 *   `behind`       a finished hour with heart data and no active minute
 */
function bandsOf(dataset, floor, { today, nowHour, done }) {
  const byHour = new Map()
  for (const sample of Array.isArray(dataset) ? dataset : []) {
    const time = text(sample?.time, 8)
    const hour = Number(time.slice(0, 2))
    const value = num(sample?.value)
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || value === null) continue
    if (!byHour.has(hour)) byHour.set(hour, [])
    byHour.get(hour).push(value)
  }

  const bands = []
  for (let hour = 0; hour < 24; hour += 1) {
    const from = `${String(hour).padStart(2, '0')}:00`
    const samples = byHour.get(hour) || []
    const avgHr = samples.length
      ? Math.round(samples.reduce((total, value) => total + value, 0) / samples.length)
      : null
    const activeMinutes =
      floor === null || !samples.length
        ? null
        : samples.filter((value) => value >= floor).length

    let status
    if (!done && hour > nowHour) status = 'not yet'
    else if (today && hour === nowHour) status = 'in progress'
    else if (!samples.length) status = 'rest'
    else if ((activeMinutes || 0) > 0) status = 'on track'
    else status = 'behind'

    bands.push({
      from,
      to: `${String(hour).padStart(2, '0')}:59`,
      label: from,
      activeMinutes,
      avgHr,
      status,
    })
  }
  return bands
}

/**
 * Seven days ending at `date`, from the days this file has already read.
 *
 * There is no sixth call here: the week rail is a memory of days the page has
 * visited, and a day nobody has opened is `null`, not a zero. That is a smaller
 * answer than a week endpoint would give, and it is the honest one for a read
 * that costs five calls. The day being read is passed in, because it is not in
 * the file until after this runs.
 */
function weekOf(store, date, fresh) {
  const week = []
  for (let back = 6; back >= 0; back -= 1) {
    const key = addDays(date, -back)
    const value = key === date ? fresh : store.days?.[key]?.value
    const steps = num(value?.counts?.steps)
    const goal = num(value?.goals?.steps)
    week.push({ date: key, steps, goalMet: steps !== null && goal !== null ? steps >= goal : false })
  }
  return week
}

/**
 * The range resting heart rate moved through on the days this file holds.
 *
 * A range of one number is not a range, so a week with a single reading has none
 * and the page prints the reading alone. Same rule as everywhere else here: unknown
 * is `null`, never a number that looks measured.
 */
function restingRange(store, date, fresh) {
  const values = []
  for (let back = 6; back >= 0; back -= 1) {
    const key = addDays(date, -back)
    const counts = key === date ? fresh : store.days?.[key]?.value?.counts
    const hr = num(counts?.restingHr)
    if (hr !== null) values.push(hr)
  }
  if (values.length < 2) return null
  return { low: Math.min(...values), high: Math.max(...values), days: values.length }
}

/* ── the read ──────────────────────────────────────────────────────────── */

/**
 * One day, shaped for the page.
 *
 * Answers the payload (with `ok: true`), or `{ ok: false, limited: { resetAt,
 * calls } }` when this account's hour is spent or Fitbit said 429. Everything
 * else — a dead token, a malformed date, a day that has not happened — throws,
 * with a sentence the card can print as-is.
 */
async function readDay({ day = '', force = false } = {}) {
  const localpart = accountOf()
  const token = await accessToken('fitbit', localpart)
  const store = readStore()
  const said = text(day, 20).toLowerCase()

  const served = (date) => {
    const hit = store.days?.[date]
    if (!hit || !hit.value) return null
    const today = zonedDay(Date.now(), store.hourly?.timezone || 'UTC')
    const ttl = date === today ? TTL_TODAY_MS : TTL_PAST_MS
    if (Date.now() - (Number(hit.at) || 0) >= ttl) return null
    /* A stored day costs nothing now: `calls: 0` is what the receipt prints, and
       `stale` is what makes the page say the numbers are from the file. */
    return { ...hit.value, ok: true, stale: true, calls: 0, cacheTtlMs: ttl, budget: budgetOf(store) }
  }

  try {
    /* A literal day can be answered from the file without asking Fitbit for the
       zone: the stored payload already carries the one it was read in. This is
       what makes moving between two finished days free. */
    if (!force && DAY.test(said)) {
      const hit = served(said)
      if (hit) return hit
    }

    const hourly = await hourlyBlock(store, token)
    const date = dayOf(said, hourly.timezone)
    if (!force) {
      const hit = served(date)
      if (hit) return hit
    }

    /* Refused before it is spent: five calls are what this read costs, and an
       hour with four left is an hour that cannot answer. */
    const before = budgetOf(store)
    if (before.used + DAY_CALLS > HOURLY_CALLS) throw limitedError(before.resetAt, before.used)

    const activity = await callJson(`/1/user/-/activities/date/${date}.json`, token, store)
    guard(activity, store)

    const sleep = await callJson(`/1.2/user/-/sleep/date/${date}.json`, token, store)
    guard(sleep, store)

    const heart = await callJson(`/1/user/-/activities/heart/date/${date}/1d.json`, token, store)
    guard(heart, store)

    const trace = await callJson(`/1/user/-/activities/heart/date/${date}/1d/1min.json`, token, store)
    guard(trace, store)

    /* The receipt is five calls: the four above plus the device list, which the
       hourly block has already spent at most once this hour. A same-hour second
       day therefore costs four calls and reports five — the receipt counts what
       one day of the page is priced at, and the hourly block is priced
       separately. */
    const now = Date.now()
    const today = zonedDay(now, hourly.timezone)
    const done = date !== today
    const noHeartrate = heart.status === 403 || trace.status === 403

    const counts = noHeartrate
      ? { ...countsOf(activity.body, sleep.body, null, hourly), restingHr: null }
      : countsOf(activity.body, sleep.body, heart.body, hourly)
    const dataset = noHeartrate ? [] : trace.body?.['activities-heart-intraday']?.dataset
    const nowHour = Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: hourly.timezone, hour: '2-digit', hourCycle: 'h23' }).format(now),
    )

    const result = {
      ok: true,
      date,
      day: dayOfPayload(date, hourly.timezone, now),
      counts,
      goals: goalsOf(activity.body),
      bands: bandsOf(dataset, noHeartrate ? null : activeFloor(heart.body), {
        today: !done,
        nowHour: Number.isInteger(nowHour) ? nowHour : 0,
        done,
      }),
      /* A week read from the days already in the file, never a sixth call. */
      week: weekOf(store, date, { counts, goals: goalsOf(activity.body) }),
      /* The list behind `counts.devices.count`: an account can have an old
         tracker and a new one, and only the rail has room to say which. */
      devices: hourly.devices,
      hrRange: restingRange(store, date, counts),
      stale: false,
      calls: DAY_CALLS,
      readAt: new Date(now).toISOString(),
      cacheTtlMs: done ? TTL_PAST_MS : TTL_TODAY_MS,
      noHeartrate,
      ...(hourly.noTimezone ? { noTimezone: true } : {}),
      budget: budgetOf(store),
    }
    store.days[date] = { at: now, value: result }
    writeStore(store)
    return result
  } catch (error) {
    /* The counter is worth keeping even when the read failed: the calls were
       spent whether or not the page got a number out of them. */
    writeStore(store)
    /* The refusal carries the hour's arithmetic with it, so the page can say how
       many of the calls were spent without waiting for a read that would succeed. */
    if (error?.limited) return { ok: false, limited: error.limited, budget: budgetOf(store) }
    throw error
  }
}

module.exports = {
  CACHE_FILE,
  DAY_CALLS,
  HOURLY_CALLS,
  TTL_PAST_MS,
  TTL_TODAY_MS,
  readDay,
  dayOf,
  budgetOf,
  forgetCache,
  zonedDay,
}
