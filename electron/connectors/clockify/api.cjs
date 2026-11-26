/**
 * The Clockify connector's shared half: the week arithmetic, the two upstream reads
 * and the workspace state they run on.
 *
 * Four files in this folder, because a connector has four jobs and mixing them is
 * how one of them gets a rule the others do not follow:
 *
 *   connector.cjs   the descriptor — what this connector is, and `verify()`
 *   mention.cjs     `@clockify:<project|login>:<monday>`
 *   dashboard.cjs   one week for the tab, and the workspace list
 *   api.cjs         this file: the clock, the report calls and the row helpers
 *
 * The week math is the part that looks right and is off by an hour. `weekBounds()`
 * is 167 or 169 hours when the week crosses a DST change, because both ends are
 * local midnights read with the offset **at that instant**, not `start + 7 days`.
 *
 * The mention and the tab read the same `week()`, so their totals cannot disagree.
 */
const MAX_PER_SOURCE = 3

/* The reports API, not `api.clockify.me`: the summary report is the only call that
   answers "hours per project and per person for this week" in one request. */
const REPORTS_API = 'https://reports.api.clockify.me/v1'
/* The other API host: `/v1/workspaces` is not a report, so it is not on the
   reports host. It exists here for one reason — the Overview selector needs the
   ids and names a person can pick from, and nothing else in this file fetches a
   list. */
const WORKSPACES_API = 'https://api.clockify.me/api/v1'
const TIMEOUT_MS = 20_000
/* The first week a Clockify summary is worth offering, and the floor a week key
   has to clear — the same one One's plugin uses, so the two agree. */
const MIN_WEEK = '2020-01-06'
/* Client rows are a breakdown, not a ledger: a workspace with ninety clients is a
   list nobody scrolls, and One caps the same shape at the same number. */
const CLIENT_CEILING = 12
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
/* A report is more than three rows: a project, its members, the week total and a
   day-by-day series. The mention block keeps its own cap; this is the resolver's. */
const ROW_CEILING = 14

const WEEK = /^\d{4}-\d{2}-\d{2}$/
const USER_ID = /^[a-f0-9]{24}$/

const text = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

/* ── week math ────────────────────────────────────────────────────────────
   ponytail: the wall-clock offset is derived with `toLocaleString`, the same
   trick as One's Clockify plugin — no timezone dependency, no new package.
   Upgrade: `Temporal` once it is in the runtime. */

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

function addDays(key, days) {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

/** This week's Monday, read in the workspace's zone rather than the machine's. */
function currentMonday(timeZone, now = Date.now()) {
  const day = zonedDay(now, timeZone)
  return addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7))
}

/**
 * The UTC instant of a local midnight.
 *
 * Two passes, and the second one is not optional: the offset at UTC midnight can
 * belong to the *other* side of a DST change, so it is re-read at the instant the
 * first pass landed on. That is what makes a week that crosses a change the right
 * length — a single pass is an hour out on the week the clocks move.
 */
function localMidnight(key, timeZone) {
  const guess = Date.parse(`${key}T00:00:00Z`)
  return guess - zonedOffset(guess - zonedOffset(guess, timeZone), timeZone)
}

/** One week's UTC bounds. Never `start + 7 days`: that is the off-by-an-hour bug. */
function weekBounds(mondayKey, timeZone) {
  return {
    startUtc: new Date(localMidnight(mondayKey, timeZone)).toISOString(),
    endUtc: new Date(localMidnight(addDays(mondayKey, 7), timeZone)).toISOString(),
  }
}

/**
 * A week key this resolver will accept, or a refusal that names the rule.
 *
 * `''` and `this week` mean this week; anything else must be a real Monday, not in
 * the future and not before `MIN_WEEK`. A silently corrected week would answer
 * about a week nobody asked for, which is worse than an error.
 */
function validWeek(key, timeZone) {
  const raw = text(key, 40)
  const monday = currentMonday(timeZone)
  const week = !raw || /^this week$/i.test(raw) ? monday : raw
  const ok =
    WEEK.test(week) &&
    new Date(`${week}T00:00:00Z`).getUTCDay() === 1 &&
    week >= MIN_WEEK &&
    week <= monday
  if (!ok) {
    throw new Error(
      `A Clockify week must be a real Monday between ${MIN_WEEK} and this week (${monday}), written YYYY-MM-DD or "this week" — “${week}” is not one.`,
    )
  }
  return week
}

function weekLabel(mondayKey) {
  const start = Date.parse(`${mondayKey}T00:00:00Z`)
  const end = Date.parse(`${addDays(mondayKey, 6)}T00:00:00Z`)
  const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', timeZone: 'UTC' })
  const tail = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
  return `${day.format(start)} – ${tail.format(end)}`
}

const duration = (seconds) => {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const hours = Math.floor(total / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  if (hours) return `${hours}h ${minutes}m`
  if (minutes) return `${minutes}m`
  return total ? `${total}s` : '0m'
}

/* ── the workspace's own Clockify state ─────────────────────────────────── */

/**
 * `{ workspaceId, timezone, members }` from the connector's index row.
 *
 * Required at call time: `connector-store` loads this file through the registry,
 * and a top-level require here would close that cycle.
 */
function fieldsOf(record) {
  try {
    const index = require('../../connector-store.cjs').readIndex(record)
    const fields = index.rows?.clockify?.fields || {}
    return {
      workspaceId: text(fields.workspaceId, 60),
      timezone: text(fields.timezone, 60),
      members: fields.members && typeof fields.members === 'object' ? fields.members : {},
    }
  } catch {
    return { workspaceId: '', timezone: '', members: {} }
  }
}

function settingsFor(record) {
  const fields = fieldsOf(record)
  if (!fields.workspaceId) {
    throw coded(
      'clockify-no-workspace',
      'Clockify has no workspace id in this workspace yet. Add it on the connector’s page, then paste the API key.',
    )
  }
  /* An unusable zone would make every week key wrong, so it is refused rather than
     replaced with UTC. */
  let timezone = 'UTC'
  if (fields.timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: fields.timezone })
      timezone = fields.timezone
    } catch {
      throw new Error(`Clockify's timezone “${fields.timezone}” is not an IANA timezone. Fix it on the connector's page.`)
    }
  }
  return { ...fields, timezone }
}

/* ── the two upstream reads ─────────────────────────────────────────────── */

/* A failure the renderer has to *draw*, not just print: the tab picks its copy and
   its one control from the `code`, and a page matching on English would break the
   first time a sentence was reworded. */
function coded(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function upstreamError(status, said) {
  if (status === 401) {
    /* Clockify answers the same 401 for both, and telling them apart is the whole
       difference between "rotate the key" and "fix the workspace id". */
    return coded(
      'clockify-401',
      'Clockify answered 401. That means either the API key is wrong or expired, or the workspace id does not exist — Clockify uses one status for both, so check the workspace id on the connector’s page and the key itself.',
    )
  }
  if (status === 403) {
    return coded(
      'clockify-403',
      'This Clockify key cannot read the workspace report. Its owner needs report access in that workspace.',
    )
  }
  if (status === 429) return coded('clockify-429', 'Clockify rate-limited the report. Try again in a minute.')
  return new Error(`Clockify answered ${status}${said ? `: ${said}` : ''}.`)
}

async function summary(token, workspaceId, body) {
  const url = `${REPORTS_API}/workspaces/${encodeURIComponent(workspaceId)}/reports/summary`
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'X-Api-Key': token, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw coded('clockify-timeout', 'Clockify did not answer within 20 seconds.')
  }
  const raw = await response.text().catch(() => '')
  if (!response.ok) throw upstreamError(response.status, text(raw, 200))
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    throw new Error('Clockify returned an unreadable summary payload.')
  }
}

const groupsOf = (value) =>
  (Array.isArray(value) ? value : []).filter((entry) => entry && typeof entry === 'object')

const numberOf = (value) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0
}

/* A printed share, rounded once: One prints `duration · 48%` beside every row and
   `share()` in the tab is a bar width with a floor, so the two are not the same
   number and neither can stand in for the other. */
const pct = (part, total) => (total > 0 ? Math.round((part / total) * 100) : 0)


/**
 * One week of the workspace, in the two calls the issue allows: projects × members
 * (which also carries `clientName`) and days.
 */
async function week(token, settings, weekKey) {
  /* `weekBounds()` names its ends for this file, not for Clockify: the Reports API
     rejects a body without `dateRangeStart`/`dateRangeEnd` (400, both named), so the
     two names are mapped here rather than renamed there — those names are what the
     DST arithmetic is tested through. */
  const { startUtc, endUtc } = weekBounds(weekKey, settings.timezone)
  const base = {
    dateRangeStart: startUtc,
    dateRangeEnd: endUtc,
    users: {
      /* The member map is the workspace's, so only people it names are read — and
         when it is empty, "everyone in this workspace" is the honest ask. */
      ids: Object.values(settings.members).filter((id) => USER_ID.test(String(id))),
      containsTags: false,
      status: 'ALL',
    },
    pageSize: 200,
  }
  if (!base.users.ids.length) delete base.users.ids
  const [byProject, byDay] = await Promise.all([
    summary(token, settings.workspaceId, { ...base, summaryFilter: { groups: ['PROJECT', 'USER'] } }),
    summary(token, settings.workspaceId, { ...base, summaryFilter: { groups: ['DATE'] } }),
  ])

  const loginOf = (userId) =>
    Object.entries(settings.members).find(([, id]) => String(id) === userId)?.[0] || ''
  const projects = groupsOf(byProject.groupOne).map((group) => ({
    label: text(group.name, 160) || 'No project',
    seconds: numberOf(group.duration),
    client: text(group.clientName, 120),
    members: groupsOf(group.children)
      .flatMap((child) => {
        const userId = String(child._id ?? '')
        const seconds = numberOf(child.duration)
        if (!USER_ID.test(userId) || !seconds) return []
        const login = loginOf(userId)
        return [{ login: login || userId, name: text(child.name, 120) || login, seconds }]
      })
      .sort((a, b) => b.seconds - a.seconds),
  }))

  const totals = groupsOf(byProject.totals)[0] || {}
  const seconds = numberOf(totals.totalTime)
  /* Clients are summed from the project rows, never fetched: `/reports/summary`
     has no CLIENT grouping, and a third call would be a second answer to a
     question this payload already answers. A project with no client still names
     one — “No client” — rather than disappearing from the split. */
  const clients = [
    ...projects.reduce((map, project) => {
      const label = project.client || 'No client'
      return map.set(label, (map.get(label) ?? 0) + project.seconds)
    }, new Map()),
  ]
    .map(([label, clientSeconds]) => ({ label, seconds: clientSeconds, pct: pct(clientSeconds, seconds) }))
    .filter((row) => row.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, CLIENT_CEILING)

  const days = new Map()
  for (const group of groupsOf(byDay.groupOne)) {
    const day = String(group._id ?? '')
    if (WEEK.test(day)) days.set(day, numberOf(group.duration))
  }
  /* Clockify's day groups are sparse — a day nobody tracked is absent, not zero.
     The week is always seven days, so it is zero-filled before anything reads it. */
  const daily = DAY_NAMES.map((label, index) => {
    const day = addDays(weekKey, index)
    return { id: day, label, detail: duration(days.get(day) ?? 0), seconds: days.get(day) ?? 0 }
  })

  return {
    projects,
    clients,
    daily,
    seconds,
    entries: numberOf(totals.entriesCount),
    logins: Object.keys(settings.members),
    weekKey,
    label: weekLabel(weekKey),
  }
}


/**
 * `GET /v1/workspaces` in full: the raw list, `[{ id, name }]`, in Clockify's order.
 *
 * Shared by `workspaces()` and the no-workspace-id branch of `verify()`, because a
 * key is only ever proven by a call, and this is the one call a key with no
 * workspace chosen can honestly make.
 */
async function workspaceList(token) {
  let response
  try {
    response = await fetch(`${WORKSPACES_API}/workspaces`, {
      headers: { 'X-Api-Key': token, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw coded('clockify-timeout', 'Clockify did not answer within 20 seconds.')
  }
  const raw = await response.text().catch(() => '')
  if (!response.ok) {
    /* This call names no workspace, so the shared 401 sentence — which offers a
       wrong workspace id as a cause — would point at a field that was not sent. */
    if (response.status === 401) {
      throw coded(
        'clockify-401',
        'Clockify refused this key. It was replaced or revoked, or it cannot read any workspace.',
      )
    }
    throw upstreamError(response.status, text(raw, 200))
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Clockify returned an unreadable workspace list.')
  }
  return (Array.isArray(parsed) ? parsed : [])
    .map((entry) => ({ id: text(entry?.id, 60), name: text(entry?.name, 120) }))
    .filter((entry) => entry.id)
}


module.exports = {
  MAX_PER_SOURCE,
  CLIENT_CEILING,
  MIN_WEEK,
  ROW_CEILING,
  DAY_NAMES,
  USER_ID,
  WORKSPACES_API,
  TIMEOUT_MS,
  REPORTS_API,
  WEEK,
  text,
  zonedDay,
  zonedOffset,
  addDays,
  currentMonday,
  localMidnight,
  weekBounds,
  validWeek,
  weekLabel,
  duration,
  fieldsOf,
  settingsFor,
  coded,
  upstreamError,
  summary,
  groupsOf,
  numberOf,
  pct,
  week,
  workspaceList,
}
