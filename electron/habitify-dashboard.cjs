/**
 * The Habitify connector's Dashboard tab: the habits a day was scheduled, and the
 * week that day sits in.
 *
 * Two answers, both read-only:
 *
 *   accounts()          which Habitify accounts this machine holds, by localpart
 *   dashboard({ day })  that day's rows, the six tiles, and what could not be read
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
const habitify = require('./connectors/habitify.cjs')
const oauthAccounts = require('./oauth-accounts.cjs')

const CONNECTOR = 'habitify'
/* One visit, one read: a habit's week does not change twice in a day. */
const CACHE_MS = 24 * 60 * 60_000
/* `ENTITY_HOME` first, exactly like every other store: a test must never write the
   developer's real `~/.entity`. */
const ROOT = process.env.ENTITY_HOME
  ? path.resolve(process.env.ENTITY_HOME)
  : path.join(os.homedir(), '.entity')
const CACHE_FILE = path.join(ROOT, 'habitify-dashboard.json')
const CACHE_SCHEMA = 1
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
  return {
    id: id || `${day}:${name}`,
    name: name || 'unnamed habit',
    /* The provider's own word, narrowed by the connector's parser: `inprogress`
       means scheduled and not logged, which is `none` and not a failure. */
    status: habitify.statusOf(raw?.status),
    streak: streakOf(raw),
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
    })),
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
  const days = []
  const errors = []
  let reads = 0
  for (const date of dates) {
    try {
      const answer = await withinDeadline(habitify.read(token, date, { sessionId }))
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
        const answer = await withinDeadline(habitify.read(token, date, { sessionId }))
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
      /* A file written before `next` existed is still a valid week; the field is
         filled here so the shape a page reads never depends on the file's age. */
      return { ...hit.value, next: hit.value.next || null, cached: true, reads: 0 }
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
  const value = {
    ...base,
    readAt: new Date().toISOString(),
    rows: today?.rows || [],
    tiles: tilesOf(week1.days),
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

module.exports = { CACHE_MS, CACHE_FILE, PAGE_TIMEOUT_MS, accounts, dashboard }
