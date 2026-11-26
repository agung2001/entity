/**
 * The Habitify connector's Dashboard tab: the habits a day was scheduled, and the
 * week that day sits in.
 *
 * Two answers, both read-only:
 *
 *   accounts()          which Habitify accounts this machine holds, by localpart
 *   dashboard({ day })  that day's rows, the six tiles, the week's habits and totals,
 *                       and what could not be read
 *
 * **A week, not just a day.** The grid is one row per habit seen in the days that were
 * read, with a cell for each of the seven civil dates Monday..Sunday: `read` says
 * whether anybody looked, `scheduled` whether the habit was on that day, and `status`
 * one of the provider's four words. A cell nobody read and a cell where nothing was
 * due are both dashes on the page — never a miss.
 *
 * **Nothing here writes to Habitify.** The only tool called is
 * `list-habits-by-date`, through `connectors/habitify.cjs`; `complete`, `skip`,
 * `fail` and `log` are not reachable from this module at all, and the grant this
 * reads carries no write scope to reach them with (`oauth-scopes.cjs`).
 *
 * **No address appears in an answer.** The account store holds an email and this
 * file never copies it: the account is named by its localpart, which is the same
 * thing the connector card prints. `accounts()` builds each row field by field for
 * exactly that reason — a spread would carry the address through.
 *
 * **One read a day, per day.** The answer is written to
 * `<~/.entity>/habitify-dashboard.json`, keyed on the day and the localpart it was
 * read for, and served from there for a day: opening the tab twice is one read, and
 * Refresh is the only thing that asks Habitify sooner. The file is read on each
 * call, so nothing is held in this process's memory between visits.
 *
 * **A day that could not be read is a day, not a dashboard.** The week's tiles count
 * only the days that answered, a failed day says so on its own row, and a refused
 * account is one `errors` row while everything else still prints. A tile whose
 * number is unknown is `null`, never `0` — the page prints `—` for it.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const habitify = require('./mention.cjs')
const oauthAccounts = require('../../oauth-accounts.cjs')

const CONNECTOR = 'habitify'
/* One visit, one read: a habit's week does not change twice in a day. */
const CACHE_MS = 24 * 60 * 60_000
/* `ENTITY_HOME` first, exactly like every other store: a test must never write the
   developer's real `~/.entity`. */
const ROOT = process.env.ENTITY_HOME
  ? path.resolve(process.env.ENTITY_HOME)
  : path.join(os.homedir(), '.entity')
const CACHE_FILE = path.join(ROOT, 'habitify-dashboard.json')
const CACHE_SCHEMA = 2
const DAY = /^\d{4}-\d{2}-\d{2}$/
/* The page stops waiting before the client does. `rpc` gives up at 20 s and says so;
   a tab that has been spinning for ten is already the complaint, so the read is cut
   here first and the reason names both clocks. */
const PAGE_TIMEOUT_MS = 10_000
/* The table is one day's schedule and the tiles are one week's; a habit list longer
   than this is a provider answering about something other than a day. */
const ROW_CEILING = 60
/* How far past an empty day the schedule is looked for. A week is the horizon a
   person can act on; three days is enough to answer "when does this start again"
   without turning one tab visit into a fortnight of MCP calls. */
const NEXT_DAYS = 3

const text = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

/* ── civil dates ─────────────────────────────────────────────────────────
   Noon UTC as the anchor, never midnight: a `T00:00:00Z` instant lands on the
   previous date for every zone east of Greenwich, which is the bug `civilDay()`
   exists to avoid. `habitify.civilDay` is the machine's own day for "today". */
const noon = (day) => Date.parse(`${day}T12:00:00Z`)
const shift = (day, delta) => new Date(noon(day) + delta * 86_400_000).toISOString().slice(0, 10)

/** Monday to Sunday for the week a day sits in — the week the tiles count. */
function weekOf(day) {
  const weekday = new Date(noon(day)).getUTCDay()
  const start = shift(day, -((weekday + 6) % 7))
  return { start, end: shift(start, 6) }
}

function zone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
  } catch {
    return 'local'
  }
}

/* ── the day-long cache, on disk ─────────────────────────────────────────
   The last answer lives in one JSON file rather than in this process: a restart
   should not spend seven MCP reads to rediscover a week it already printed. `key`
   is the day and the localpart the answer was read for, so signing in as somebody
   else or turning to another day is a miss without anyone remembering to clear it.

   A cache nobody can write is a cache that misses: every failure here is a miss,
   never a read that fails. */
function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    if (raw?.schema !== CACHE_SCHEMA || !Number.isFinite(raw?.at) || !raw?.value) return null
    return raw
  } catch {
    return null
  }
}

function writeCache(key, value) {
  const body = `${JSON.stringify({ schema: CACHE_SCHEMA, key, at: Date.now(), value }, null, 2)}\n`
  try {
    fs.mkdirSync(ROOT, { recursive: true })
    const staged = `${CACHE_FILE}.${process.pid}.tmp`
    fs.writeFileSync(staged, body, 'utf8')
    fs.renameSync(staged, CACHE_FILE)
  } catch {
    /* read-only home, a full disk: the next visit reads Habitify again. */
  }
}

/* ── who is signed in ────────────────────────────────────────────────── */

/**
 * Every Habitify account this machine holds, named by localpart.
 *
 * Field by field, never a spread: the store row carries an `email`, and the one
 * rule this file shares with `connectors/habitify.cjs` is that no address reaches a
 * page. `hasToken` is the fact the gate needs — an account whose grant has no
 * refresh token cannot be read at all.
 */
async function accounts() {
  const rows = oauthAccounts.connectedAccounts(CONNECTOR)
  return {
    connector: CONNECTOR,
    accounts: rows
      .map((row) => ({
        localpart: text(row?.localpart, 64),
        status: text(row?.status, 40),
        scopes: Array.isArray(row?.scopes) ? row.scopes.map((scope) => text(scope, 80)).filter(Boolean) : [],
        missing: Array.isArray(row?.missing) ? row.missing.map((scope) => text(scope, 80)).filter(Boolean) : [],
        hasToken: row?.hasToken === true,
        addedAt: text(row?.addedAt, 40),
        refreshedAt: text(row?.refreshedAt, 40),
      }))
      .filter((row) => row.localpart),
    readAt: new Date().toISOString(),
  }
}

/* ── one day's rows ────────────────────────────────────────────────────── */

/**
 * The streak a row carries, or `null`.
 *
 * ponytail: `connectors/habitify.cjs` reads only a name and a status — a mention
 * needs nothing else — and the live server could not be asked for a sample while
 * this was written, so the field name is read tolerantly rather than assumed. Four
 * spellings cover what Habitify's journal and One's verified client have used.
 * Anything else is unknown, and unknown prints `—`: a streak of zero is a claim
 * about a habit nobody has started, which is a different fact.
 */
function streakOf(row) {
  const nested = row?.currentStreak && typeof row.currentStreak === 'object' ? row.currentStreak : null
  const raw = nested?.length ?? nested?.days ?? row?.streak ?? row?.currentStreakLength
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

/** One row of the table, or `null` when the provider sent nothing nameable. */
function rowOf(raw, day) {
  const name = text(raw?.name ?? raw?.habitName, 120)
  const id = text(raw?.id ?? raw?.habitId, 64)
  if (!name && !id) return null
  const progress = raw?.progress && typeof raw.progress === 'object' ? raw.progress : null
  return {
    id: id || `${day}:${name}`,
    name: name || 'unnamed habit',
    /* The provider's own word, narrowed by the connector's parser: `inprogress`
       means scheduled and not logged, which is `none` and not a failure. */
    status: habitify.statusOf(raw?.status),
    streak: streakOf(raw),
    /* Which parts of the day the habit belongs to, as ids. Empty means "any time",
       which is not "unset" — the provider says so with the empty array. */
    timeOfDayIds: Array.isArray(raw?.timeOfDayIds)
      ? raw.timeOfDayIds.map((id) => text(id, 40)).filter(Boolean).slice(0, 8)
      : [],
    /* `{ value, target, unit }` when the provider carried a progress block, else
       `null`. Never zeroed: a habit with no measurement is not a habit at 0 of 0. */
    progress:
      progress || Number.isFinite(Number(raw?.target))
        ? {
            value: Number.isFinite(Number(progress?.current ?? raw?.current)) ? Number(progress?.current ?? raw?.current) : null,
            target: Number.isFinite(Number(progress?.target ?? raw?.target)) ? Number(progress?.target ?? raw?.target) : null,
            unit: text(progress?.unit ?? raw?.unit, 40),
          }
        : null,
    day,
  }
}

/* ── the six tiles ─────────────────────────────────────────────────────── */

/**
 * The numbers, over the days that answered.
 *
 * `null` is an answer: a streak nobody reported is not a streak of zero, and a week
 * with no scheduled habit has no rate. Each tile carries its own denominator so the
 * page never has to invent one.
 */
function tilesOf(days) {
  const today = days[days.length - 1] || { rows: [] }
  const rows = today.rows || []
  const completed = rows.filter((row) => row.status === 'completed').length
  const open = rows.filter((row) => row.status === 'none').length
  /* A habit that was done today is not at risk whatever its streak says. A row whose
     streak the provider did not report cannot be shown to be at risk, so it is not
     counted — the tile prints how many are still open, so the omission is visible
     rather than silent. */
  const unfinished = rows.filter((row) => row.status !== 'completed')
  const atRisk = unfinished.filter((row) => Number(row.streak) > 0)
  const streaks = rows.map((row) => row.streak).filter((value) => value !== null)
  const best = streaks.length ? Math.max(...streaks) : null
  const bestRow = best === null ? null : rows.find((row) => row.streak === best) || null

  const read = days.filter((day) => day.state === 'ok')
  const weekCompleted = read.reduce(
    (sum, day) => sum + day.rows.filter((row) => row.status === 'completed').length,
    0,
  )
  const weekScheduled = read.reduce((sum, day) => sum + day.rows.length, 0)
  /* A check-in is a day whose every scheduled habit was completed. A day with
     nothing scheduled is not one: nothing was checked in. */
  const checkins = read.filter(
    (day) => day.rows.length > 0 && day.rows.every((row) => row.status === 'completed'),
  ).length

  return {
    done: completed,
    scheduled: rows.length,
    open,
    risk: atRisk.length,
    best,
    bestHabit: bestRow?.name || '',
    week: weekCompleted,
    weekScheduled,
    checkins,
    daysRead: read.length,
    days: days.map((day) => ({
      day: day.day,
      state: day.state,
      scheduled: day.rows.length,
      completed: day.rows.filter((row) => row.status === 'completed').length,
      /* Whether this is the civil day it is today, so the strip can mark it instead
         of every caller re-deriving a week and a clock. */
      open: day.day === habitify.civilDay(),
    })),
  }
}

/* ── the week, as rows ────────────────────────────────────────────────── */

/**
 * One row per habit seen anywhere in the days that were read, with a cell for each of
 * the week's seven civil dates Monday..Sunday.
 *
 * A date outside the read is `read: false` — a dash, not a miss. `days` says which day
 * was read at all, so a cell cannot imply somebody looked when nobody did.
 */
function habitsOf(days, week) {
  const read = new Set(days.filter((day) => day.state === 'ok').map((day) => day.day))
  const habits = new Map()
  for (const day of days) {
    if (day.state !== 'ok') continue
    for (const row of day.rows) {
      const key = row.id
      const habit = habits.get(key) || {
        id: row.id,
        name: row.name,
        streak: row.streak,
        timeOfDayIds: row.timeOfDayIds,
        cells: [],
        scheduledDays: 0,
        completedDays: 0,
        skippedDays: 0,
        failedDays: 0,
        bestDay: null,
      }
      habit.name = row.name || habit.name
      if (row.streak !== null) habit.streak = row.streak
      if (row.timeOfDayIds.length) habit.timeOfDayIds = row.timeOfDayIds
      habits.set(key, habit)
    }
  }

  for (const habit of habits.values()) {
    for (let index = 0; index < 7; index += 1) {
      const date = shift(week.start, index)
      const day = days.find((entry) => entry.day === date) || null
      const row = day?.rows.find((entry) => entry.id === habit.id) || null
      habit.cells.push({
        date,
        read: read.has(date),
        scheduled: Boolean(row),
        status: row?.status || null,
        progress: row?.progress || null,
      })
      if (!row) continue
      habit.scheduledDays += 1
      if (row.status === 'completed') {
        habit.completedDays += 1
        habit.bestDay = date
      }
      if (row.status === 'skipped') habit.skippedDays += 1
      if (row.status === 'failed') habit.failedDays += 1
    }
    habit.rate = habit.scheduledDays ? habit.completedDays / habit.scheduledDays : null
  }
  return [...habits.values()]
}

/**
 * The week's own numbers, over the days that answered.
 *
 * `rate` is `null` when nothing was scheduled — there is no rate to report, and `0`
 * would be a claim about a week nobody had anything due in.
 */
function totalsOf(days, habits) {
  const read = days.filter((day) => day.state === 'ok')
  const scheduledSlots = habits.reduce((sum, habit) => sum + habit.scheduledDays, 0)
  const completed = habits.reduce((sum, habit) => sum + habit.completedDays, 0)
  const longest = habits.reduce((best, habit) => ((habit.streak ?? -1) > (best?.streak ?? -1) ? habit : best), null)
  const done = habits.filter((habit) => habit.bestDay).sort((left, right) => (left.bestDay < right.bestDay ? 1 : -1))
  /* A perfect day is one where every scheduled habit was completed. A day with nothing
     scheduled is not one: nothing was checked in. */
  const perfectDays = read.filter(
    (day) => day.rows.length > 0 && day.rows.every((row) => row.status === 'completed'),
  ).length
  /* The habit that needs the look: the lowest rate that missed two or more days. Ties
     go to the habit that missed more, then to the one with more scheduled. */
  const slipping = habits
    .filter((habit) => habit.scheduledDays - habit.completedDays >= 2 && habit.rate !== null)
    .sort(
      (left, right) =>
        left.rate - right.rate ||
        right.scheduledDays - right.completedDays - (left.scheduledDays - left.completedDays) ||
        right.scheduledDays - left.scheduledDays,
    )[0] || null
  return {
    habits: habits.length,
    scheduledSlots,
    completed,
    rate: scheduledSlots ? completed / scheduledSlots : null,
    longestStreak: longest && longest.streak !== null ? { habit: longest.name, days: longest.streak } : null,
    bestDay: done[0]?.bestDay || null,
    perfectDays,
    slipping: slipping ? { id: slipping.id, name: slipping.name, rate: slipping.rate } : null,
  }
}

/* ── the read, with a clock the page can live with ───────────────────── */

function withinDeadline(work) {
  let timer = null
  const limit = new Promise((resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            'Habitify’s MCP server (mcp.habitify.me) did not answer within 10 seconds — the page stops waiting at 10, the client at 20 — so this day is unread rather than guessed.',
          ),
        ),
      PAGE_TIMEOUT_MS,
    )
  })
  return Promise.race([work, limit]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * Every day of the week up to the one asked about, read through **one** MCP session.
 *
 * A session costs two round trips before the first tool call, so the week is walked
 * inside the one `initialize` the connector already knows how to open. Days after
 * the one asked about are skipped: they have not been scheduled into existence, and
 * a week of zeroes for them would be a claim rather than a reading.
 *
 * `next` answers the one question an empty day raises — where the schedule resumes.
 * It is only probed when the asked day came back empty, it walks forward three days
 * at most inside the session that is already open, and a probe that fails is not the
 * tab's problem: it leaves `next` null and the page says nothing rather than sending
 * somebody to a day it could not check.
 */
async function readWeek(token, day, week) {
  const dates = []
  for (let index = 0; index < 7; index += 1) {
    const date = shift(week.start, index)
    if (date > day) break
    dates.push(date)
  }
  if (!dates.includes(day)) dates.push(day)

  const sessionId = await habitify.openSession(token)
  /* Healed, not merely opened: Habitify ends a session and then answers 404, and a
     week walked inside one session would otherwise lose every day after the expiry.
     The retry hands back the session it ended on, so the rest of the week keeps it. */
  let session = sessionId
  const days = []
  const errors = []
  let reads = 0
  for (const date of dates) {
    try {
      const answer = await withinDeadline(habitify.readHealing(token, date, { sessionId: session }))
      if (answer.sessionId) session = answer.sessionId
      reads += 1
      days.push({
        day: date,
        state: 'ok',
        said: text(answer.said, 200),
        rows: (Array.isArray(answer.rows) ? answer.rows : [])
          .map((row) => rowOf(row, date))
          .filter(Boolean)
          .slice(0, ROW_CEILING),
      })
    } catch (problem) {
      /* One day's failure is that day's: the rest of the week still counts. */
      errors.push({ localpart: '', day: date, message: text(problem?.message || problem, 300) })
      days.push({ day: date, state: 'error', said: '', reason: text(problem?.message || problem, 200), rows: [] })
    }
  }

  const asked = days.find((entry) => entry.day === day) || null
  let next = null
  if (asked && asked.state === 'ok' && !asked.rows.length) {
    for (let ahead = 1; ahead <= NEXT_DAYS && !next; ahead += 1) {
      const date = shift(day, ahead)
      try {
        const answer = await withinDeadline(habitify.readHealing(token, date, { sessionId: session }))
        if (answer.sessionId) session = answer.sessionId
        reads += 1
        const rows = (Array.isArray(answer.rows) ? answer.rows : [])
          .map((row) => rowOf(row, date))
          .filter(Boolean)
          .slice(0, ROW_CEILING)
        if (rows.length) next = { day: date, scheduled: rows.length }
      } catch {
        /* The probe is a courtesy, not a read: an unanswered day ahead leaves the
           answer without a `next` rather than turning the tab into an error. */
      }
    }
  }
  return { days, errors, reads, next }
}

/* ── the dashboard ───────────────────────────────────────────────────── */

/**
 * Six tiles, the day's rows and what failed, for the one account this machine holds.
 *
 * Cached for a day in `habitify-dashboard.json`, keyed on the day and the
 * localpart, so `force` — the Refresh button — is the only thing that reaches
 * Habitify again before the expiry.
 */
async function dashboard({ day = '', force = false } = {}) {
  const roster = await accounts()
  const wanted = DAY.test(String(day)) ? String(day) : habitify.civilDay()
  const week = weekOf(wanted)
  const base = {
    connector: CONNECTOR,
    accounts: roster.accounts,
    day: wanted,
    timezone: zone(),
    week,
    rows: [],
    tiles: null,
    /* One row per habit seen in the week, and the week's own numbers. Empty and
       `null`-roed before a read: a page must not print last week's habits under
       this week's heading. */
    habits: [],
    totals: null,
    /* Where the schedule resumes after an empty day, `{ day, scheduled }` or null.
       Never absent: a page that has to tell "no next day" from "not answered yet"
       would print a spinner for the second. */
    next: null,
    readAt: '',
    cached: false,
    /* How long a stored answer stays good, so the page prints the rule instead of
       hardcoding a number that drifts from this constant. */
    cacheTtlMs: CACHE_MS,
    reads: 0,
    errors: [],
    /* Neither is a Habitify idea — the account store throttles nothing and the MCP
       server publishes no budget — but the page's two strips are about them, so
       they are answered rather than left for a component to guess at. */
    budget: null,
    limited: null,
    problem: '',
  }

  const account = roster.accounts.find((entry) => entry.hasToken) || roster.accounts[0] || null
  if (!account) {
    base.problem = 'No Habitify account is signed in on this machine yet.'
    return base
  }

  /* A day is read with an access token and kept readable by a refresh token, so that
     is the one fact the gate turns on. The `offline_access` scope is a means to that
     end, not the end itself — and a server may honour it without echoing the scope id
     back (Habitify does), so the scope list alone is not evidence either way. Testing
     `hasToken` reads the grant's actual power and spares a person a re-consent for
     access they already hold. */
  if (!account.hasToken) {
    /* Exactly one row for one account that cannot be read, and the tiles stay
       `null`: no refresh token makes every count unknown, not zero, and `—` is the
       only honest thing to print. */
    base.errors = [
      {
        localpart: account.localpart,
        day: wanted,
        message: `@${CONNECTOR}:${account.localpart} has no refresh token on this machine, so the access token cannot be renewed. Sign in again on the connector’s page.`,
      },
    ]
    base.problem = 'The grant holds no refresh token.'
    return base
  }

  const key = `${account.localpart}|${wanted}`
  if (!force) {
    const hit = readCache()
    if (hit && hit.key === key && Date.now() - hit.at < CACHE_MS) {
      /* A file written before `next` and the week grid existed is still a valid week.
         The habits are the one answer that cannot be filled in from it — recomputing
         them here would print a week of `read: false` cells for habits the file never
         named — so a pre-grid file is a miss and is read again. */
      if (hit.value.totals) {
        return { ...hit.value, next: hit.value.next || null, cached: true, reads: 0 }
      }
    }
  }

  let token = ''
  try {
    token = await habitify.accessTokenFor(account.localpart)
  } catch (problem) {
    base.errors = [{ localpart: account.localpart, day: wanted, message: text(problem?.message || problem, 300) }]
    base.problem = 'The account’s access token could not be renewed.'
    return base
  }

  let week1
  try {
    week1 = await readWeek(token, wanted, week)
  } catch (problem) {
    /* The handshake itself failed: one row, no days, tiles unknown. */
    base.errors = [{ localpart: account.localpart, day: wanted, message: text(problem?.message || problem, 300) }]
    base.problem = 'Habitify’s MCP server could not be reached.'
    return base
  }

  const today = week1.days.find((entry) => entry.day === wanted) || null
  const habits = habitsOf(week1.days, week)
  const value = {
    ...base,
    readAt: new Date().toISOString(),
    rows: today?.rows || [],
    tiles: tilesOf(week1.days),
    habits,
    totals: totalsOf(week1.days, habits),
    next: week1.next,
    reads: week1.reads,
    errors: week1.errors.filter((entry) => entry.message).map((entry) => ({ ...entry, localpart: account.localpart })),
    problem: week1.days.some((entry) => entry.state === 'error')
      ? `${week1.days.filter((entry) => entry.state === 'error').length} of ${week1.days.length} days in this week could not be read.`
      : '',
  }
  /* A partially-read week is still worth storing: the days that answered are real,
     and the page says which ones did not. A read with nothing in it is not stored —
     it would only serve the same failure for a day. */
  if (week1.days.some((entry) => entry.state === 'ok')) writeCache(key, value)
  return value
}

module.exports = { CACHE_MS, CACHE_FILE, PAGE_TIMEOUT_MS, accounts, dashboard, habitsOf, totalsOf }
