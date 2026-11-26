/**
 * `@fitbit:[steps|sleep|heart|devices:]<date|today|yesterday>` — one day of a
 * Fitbit account, read through the same module the connector page's dashboard
 * reads.
 *
 * **Read-only, by design.** Fitbit's Web API also accepts `POST` for logging
 * activity, food, water, weight and sleep. This file calls `readDay` and nothing
 * else, and `readDay` only ever issues a GET. An agent that can log food is an
 * agent that can make a week's calories say something nobody ate — the same stance
 * `@habitify:` takes with ticking a habit off. Adding a write here is a decision to
 * reverse, not a gap to fill.
 *
 * The reader word in front of the date is a **filter, not a second reader**: one
 * fetch of the day already answers all six counts, so `@fitbit:sleep:yesterday`
 * costs the same five calls as `@fitbit:yesterday` and simply returns one line of
 * it. That is why the word is refused when it is not one of the four names — a
 * typo would otherwise return the whole day and look like it worked.
 *
 * The numbers come from `electron/connectors/fitbit/dashboard.cjs`, which owns the day
 * arithmetic, the call counter and the cache. Nothing here re-derives a day: two
 * implementations of "which day is it" is how the WIB off-by-a-day bug happens
 * twice.
 *
 * No token, no secret and no address appears in a row, a note, an error or a log
 * line: the account is named by the encoded id Fitbit itself uses.
 */
const dashboard = require('./dashboard.cjs')

const ROW_CEILING = 12
const READERS = new Set(['steps', 'sleep', 'heart', 'devices'])

const text = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

/* ── formatting ───────────────────────────────────────────────────────────
   The same shapes the connector page prints, so a turn and the tab cannot
   disagree about a number. `—` is the answer for an unknown value: a zero would
   claim a person did nothing, and an unknown heart rate is not a heart rate of
   zero. */

const count = new Intl.NumberFormat('en-gb')

const stepsLine = (day) => {
  const steps = day.counts?.steps ?? null
  const goal = day.goals?.steps ?? null
  if (steps === null) return '—'
  if (!goal) return count.format(steps)
  const share = Math.round((steps / goal) * 100)
  return `${count.format(steps)} of ${count.format(goal)} (${share}%)`
}

const distanceLine = (day) => {
  const km = day.counts?.distanceKm ?? null
  const goal = day.goals?.distanceKm ?? null
  if (km === null) return '—'
  return goal ? `${km.toFixed(1)} km of ${goal.toFixed(1)} km` : `${km.toFixed(1)} km`
}

const activeLine = (day) => {
  const minutes = day.counts?.activeMinutes ?? null
  const goal = day.goals?.activeMinutes ?? null
  if (minutes === null) return '—'
  if (!goal) return `${minutes} min`
  return `${minutes} min of ${goal} (${minutes >= goal ? 'goal met' : 'short of the goal'})`
}

const sleepLine = (day) => {
  const minutes = day.counts?.sleep?.minutes ?? null
  if (minutes === null) return 'no sleep logged'
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const score = day.counts?.sleep?.score
  return `${hours}h ${String(rest).padStart(2, '0')}m${score ? ` · score ${score}` : ''}`
}

const heartLine = (day) => {
  const bpm = day.counts?.restingHr ?? null
  if (bpm === null) {
    return day.noHeartrate ? 'not granted — the heart-rate scope was not asked for' : '—'
  }
  const range = day.hrRange
  return range ? `${bpm} bpm · ${range.low}–${range.high} this week` : `${bpm} bpm`
}

const devicesLine = (day) => {
  const devices = day.counts?.devices || null
  if (!devices?.count) return 'no device has synced'
  const name = devices.name || `${devices.count} device${devices.count === 1 ? '' : 's'}`
  return devices.syncedAt ? `${name} · last synced ${devices.syncedAt}` : name
}

/** The one line a reader word asks for. */
function lineFor(word, day) {
  if (word === 'steps') return [`Steps`, stepsLine(day)]
  if (word === 'sleep') return [`Sleep`, sleepLine(day)]
  if (word === 'heart') return [`Resting heart rate`, heartLine(day)]
  return [`Devices`, devicesLine(day)]
}

/* ── the resolver ──────────────────────────────────────────────────────── */

/**
 * One day, or one count of it.
 *
 * Throws on its own failures (a date that is not a day, an account that needs a
 * sign-in, a spent hour) and answers `[]` for a day this read could not reach —
 * an empty answer here would read as "nothing happened that day", so only a real
 * empty day is allowed to be empty, and none of them are: a Fitbit day always has
 * sleep or steps or both.
 */
async function resolve(ctx, segment, { limit = ROW_CEILING } = {}) {
  const wanted = text(segment?.target, 20).toLowerCase()
  if (wanted && !READERS.has(wanted)) {
    throw new Error(
      `@fitbit: “${wanted}” is not one of the readers — use steps, sleep, heart or devices, or leave the word out for the whole day.`,
    )
  }
  const answer = await dashboard.readDay({ day: text(segment?.query, 20), force: false })
  if (answer?.ok === false) {
    /* The hour is spent: this is a fact about Fitbit's budget, not a failure of the
       day, and the reset is the only thing worth saying. */
    throw new Error(
      `@fitbit: Fitbit’s 150 calls for this hour are spent, so nothing was read. The hour resets at ${answer.limited?.resetAt || 'a time Fitbit did not say'}.`,
    )
  }

  const date = answer.date
  const rows = []
  if (wanted) {
    const [label, detail] = lineFor(wanted, answer)
    rows.push({ id: `${wanted}:${date}`, label, detail })
  } else {
    rows.push({ id: `steps:${date}`, label: 'Steps', detail: stepsLine(answer) })
    rows.push({ id: `distance:${date}`, label: 'Distance', detail: distanceLine(answer) })
    rows.push({ id: `active:${date}`, label: 'Active minutes', detail: activeLine(answer) })
    rows.push({ id: `sleep:${date}`, label: 'Sleep', detail: sleepLine(answer) })
    rows.push({ id: `heart:${date}`, label: 'Resting heart rate', detail: heartLine(answer) })
    rows.push({ id: `devices:${date}`, label: 'Devices', detail: devicesLine(answer) })
  }

  /* The hours are the one part of a day a count cannot carry: "when was it" is a
     question the table answers and the six numbers do not. Only the active bands
     are listed — twenty-four rows of "rest" is a table nobody reads. */
  const active = (answer.bands || [])
    .filter((band) => band.status === 'on track' || band.status === 'in progress' || band.status === 'behind')
    .filter((band) => band.activeMinutes !== null || band.avgHr !== null)

  for (const band of active.slice(0, Math.max(0, limit - rows.length))) {
    const parts = []
    if (band.activeMinutes !== null) parts.push(`${band.activeMinutes} active min`)
    if (band.avgHr !== null) parts.push(`${band.avgHr} bpm avg`)
    parts.push(band.status)
    rows.push({ id: `band:${date}:${band.from}`, label: `${band.from}–${band.to}`, detail: parts.join(' · ') })
  }

  /* Where the numbers came from, on the last row: a cached day is a day read
     earlier, and saying so is cheaper than being asked why it is not moving. */
  const when = answer.stale ? `read earlier, ${answer.readAt.replace('T', ' ').slice(0, 16)}` : 'read now'
  rows.push({
    id: `summary:${date}`,
    label: date,
    detail: `${answer.day?.timezone || 'UTC'} · ${when} · ${answer.calls} calls`,
  })
  return rows.slice(0, limit)
}

/**
 * The composer's suggestions: the four reader words and the two date words, plus
 * the shape of each. Never throws and answers `[]` on any failure — a menu must not
 * go blank because a token expired, and the menu must not spend five API calls to
 * fill itself.
 */
async function preview(fields = [], { limit = 8 } = {}) {
  try {
    const said = String(fields?.[0] || '').trim().toLowerCase()
    /* Two segments: the reader, then the date. The typed text may be either. */
    const rows = []
    const readers = [
      { word: 'steps', detail: 'count and goal' },
      { word: 'sleep', detail: 'last night and the score' },
      { word: 'heart', detail: 'resting rate, and the week around it' },
      { word: 'devices', detail: 'what synced, and when' },
    ]
    for (const reader of readers) {
      if (said && !reader.word.startsWith(said) && !said.startsWith(reader.word)) continue
      rows.push({
        id: reader.word,
        label: reader.word,
        detail: reader.detail,
        mention: `@fitbit:${reader.word}:today`,
      })
    }
    for (const day of ['today', 'yesterday']) {
      if (said && !day.startsWith(said)) continue
      rows.push({
        id: day,
        label: day,
        detail: said ? 'date' : 'whole day, every count',
        mention: said && READERS.has(said) ? `@fitbit:${said}:${day}` : `@fitbit:${day}`,
      })
    }
    return rows.slice(0, limit)
  } catch {
    return []
  }
}

module.exports = { ROW_CEILING, READERS, resolve, preview }
