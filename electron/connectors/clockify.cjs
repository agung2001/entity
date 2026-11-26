/**
 * `@clockify:<project|login>:<monday|this week>` — tracked hours, per project and
 * per person, for one week.
 *
 * Three things are unusual here, and each one is the reason a line of this file
 * exists:
 *
 *   1. **The credential is one pasted key**, not an account. It lives in
 *      `connector-tokens.cjs` (`0600`), and `verify()` is what a save calls before
 *      writing, so a key that cannot read this workspace never reaches the file.
 *   2. **The workspace id, the IANA timezone and the member map are workspace
 *      state**, stored on the connector's index row under `fields` — they are not
 *      a secret and they travel with the workspace. Nothing here invents one.
 *   3. **No email ever leaves.** A Clockify workspace user list would carry one,
 *      and this file does not call it: the rows hold a user id, a display name, a
 *      login a person chose locally, and hours.
 *
 * The week math is the part that looks right and is off by an hour. `weekBounds()`
 * is 167 or 169 hours when the week crosses a DST change, because both ends are
 * local midnights read with the offset **at that instant**, not `start + 7 days`.
 *
 * Two more verbs serve the connector's Dashboard tab rather than a mention:
 * `workspaces()` lists what the key can read (the Overview selector), and
 * `dashboard()` reads one week plus its predecessor. Both are read-only and both
 * keep the key on this side of the bridge — neither call takes or returns one.
 * The tab and the mention read the same `week()`, so their totals cannot disagree.
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
    const index = require('../connector-store.cjs').readIndex(record)
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

/**
 * The save-time check: one real one-day summary for today.
 *
 * `POST /reports/summary` and not `/user`, because `/user` ignores the workspace id
 * and would pass for a key pointed at the wrong workspace — the exact mistake this
 * check exists to catch.
 */
async function verify({ token, workspaceId } = {}) {
  const key = text(token, 400)
  const workspace = text(workspaceId, 60)
  if (!key) throw new Error('Paste a Clockify API key first.')
  if (!workspace) {
    /* An empty id is the state a fresh install is in, and it is the state the
       Overview selector exists to leave — so it is checked against the list that
       selector reads, not refused: a refusal here would need the list to prove the
       key, and the list to have a key. */
    await workspaceList(key)
    return { ok: true }
  }
  const day = new Date().toISOString().slice(0, 10)
  await summary(key, workspace, {
    dateRangeStart: `${day}T00:00:00.000Z`,
    dateRangeEnd: `${addDays(day, 1)}T00:00:00.000Z`,
    summaryFilter: { groups: ['PROJECT'] },
    pageSize: 1,
  })
  return { ok: true }
}

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
    daily,
    seconds: numberOf(totals.totalTime),
    entries: numberOf(totals.entriesCount),
    logins: Object.keys(settings.members),
    weekKey,
    label: weekLabel(weekKey),
  }
}

/* ── the mention ────────────────────────────────────────────────────────── */

/**
 * `@clockify:<project|login>:<week>`.
 *
 * The target is required: `@clockify:` with no project would silently answer about
 * everybody, and a report about the wrong scope is worse than an error.
 */
async function resolve(ctx, segment, { limit = ROW_CEILING } = {}) {
  /* Validation first, credentials second: a malformed week must be refused for
     being malformed on a machine that has no key yet, not excused by one. */
  const settings = settingsFor(ctx?.record)
  const wanted = text(segment?.target, 120)
  if (!wanted) {
    throw new Error(
      'Clockify needs a project name or a member login, e.g. @clockify:design-system:this week',
    )
  }
  const weekKey = validWeek(segment?.week, settings.timezone)
  const token = require('../connector-tokens.cjs').tokenFor('clockify')
  if (!token) {
    throw new Error('Clockify has no API key on this machine yet. Paste one on the connector’s page.')
  }
  const report = await week(token, settings, weekKey)

  const rows = []
  const project = report.projects.find((entry) => entry.label.toLowerCase() === wanted.toLowerCase())
  const login = report.logins.find((entry) => entry.toLowerCase() === wanted.toLowerCase())

  if (project) {
    rows.push({
      id: project.label,
      label: project.label,
      detail: [duration(project.seconds), project.client || 'no client', report.label].join(' · '),
    })
    for (const member of project.members) {
      rows.push({
        id: member.login,
        label: `${member.name} · ${project.label}`,
        detail: `${duration(member.seconds)} · ${member.login}`,
      })
    }
  } else if (login) {
    for (const entry of report.projects) {
      const member = entry.members.find((child) => child.login === login)
      if (!member) continue
      rows.push({
        id: entry.label,
        label: entry.label,
        detail: `${duration(member.seconds)} · ${login}`,
      })
    }
  } else {
    const known = [
      ...report.projects.map((entry) => entry.label),
      ...report.logins,
    ].filter(Boolean)
    throw new Error(
      known.length
        ? `@clockify:${wanted}: is not a project or a member here. This workspace has: ${known.join(', ')}.`
        : `@clockify:${wanted}: matched no project or member in this week.`,
    )
  }

  const totalRow = {
    id: '',
    label: `${login ? login : project.label} · ${report.label}`,
    detail: `${duration(report.seconds)} across ${report.projects.length} projects`,
  }
  if (rows.length) rows.push(totalRow)
  for (const day of report.daily) {
    rows.push({ id: day.id, label: day.label, detail: `${day.detail}` })
  }
  return rows.slice(0, limit)
}

/**
 * The composer's suggestions: the projects and member logins this week can see,
 * filtered by what has been typed. Never throws and answers `[]` on any failure —
 * a menu must not go blank under the cursor because a key expired.
 */
async function preview(fields = [], { record, limit = 8 } = {}) {
  try {
    const needle = String(fields?.[0] || '').trim().toLowerCase()
    const settings = settingsFor(record)
    const token = require('../connector-tokens.cjs').tokenFor('clockify')
    if (!token) return []
    const report = await week(token, settings, currentMonday(settings.timezone))
    const targets = [
      ...report.projects.map((entry) => ({ name: entry.label, what: 'project' })),
      ...report.logins.map((login) => ({ name: login, what: 'member' })),
    ]
    return targets
      .filter((entry) => !needle || entry.name.toLowerCase().includes(needle))
      .slice(0, limit)
      .map((entry) => ({
        id: entry.name,
        label: entry.name,
        detail: entry.what,
        mention: `@clockify:${entry.name}:`,
      }))
  } catch {
    return []
  }
}

/* ── the dashboard's two reads ────────────────────────────────────────────
   Read-only, main-process only, and no token crosses either verb: the key is
   read here and the renderer gets rows. A dashboard is a slow-moving number, so
   an answer is held for ten minutes in this process — stepping a week back and
   forward again should not spend eight calls — and `force` is the Refresh button
   and the only thing that skips it. */
const CACHE_MS = 10 * 60_000
const cache = new Map()
/* A week plus its predecessor is the only shape either read produces, so a tiny
   ceiling is enough; it exists so a long session cannot grow the map forever. */
const CACHE_KEYS = 8

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

/**
 * The workspaces this key can read: `[{ id, name, members }]`.
 *
 * `members` is not from Clockify — the endpoint returns no count. It is the size
 * of the stored member map, and only for the workspace that map belongs to; every
 * other row says `0` so nothing here prints a number it did not read.
 */
async function workspaces(record) {
  const fields = fieldsOf(record)
  const token = require('../connector-tokens.cjs').tokenFor('clockify')
  if (!token) {
    throw coded(
      'clockify-no-key',
      'Clockify has no API key on this machine yet. Paste one on the connector’s page.',
    )
  }
  return (await workspaceList(token)).map((entry) => ({
    ...entry,
    name: entry.name || entry.id,
    members: entry.id === fields.workspaceId ? Object.keys(fields.members).length : 0,
  }))
}

/**
 * Everyone this week can see, as one row each, so a member with no entries is a
 * row and not an absence.
 *
 * The member map is the roster nobody has to fetch: its keys are the logins, and
 * a login with no minutes is exactly the person the lead is looking for. Names
 * come from the report (the summary is the only call that carries one) and fall
 * back to the login, because inventing one from a map that stores only ids would
 * be a lie in the one column read first.
 */
function peopleOf(report, previous, members) {
  const rows = new Map()
  const ensure = (login) => {
    if (!rows.has(login)) {
      rows.set(login, {
        userId: members[login] || (USER_ID.test(login) ? login : ''),
        login,
        name: login,
        seconds: 0,
        previousSeconds: 0,
      })
    }
    return rows.get(login)
  }
  for (const login of Object.keys(members)) ensure(login)
  for (const project of report.projects) {
    for (const member of project.members) {
      const row = ensure(member.login)
      if (member.name) row.name = member.name
      row.seconds += member.seconds
    }
  }
  /* The previous week only decorates rows this week already has: a login that
     disappeared from the map is not resurrected by an old hour. */
  for (const project of previous?.projects || []) {
    for (const member of project.members) {
      const row = rows.get(member.login)
      if (row) row.previousSeconds += member.seconds
    }
  }
  return [...rows.values()].sort((a, b) => b.seconds - a.seconds || a.login.localeCompare(b.login))
}

/**
 * One week of this workspace, for the tab: the team, the projects, the day series
 * and the individual card, all from four `reports/summary` calls.
 *
 * Two calls per week, because each one answers a different question from the same
 * payload — projects × members, then days — and the previous week repeats both
 * for the `vs previous` column. That pair fails on its own: a week that reads is
 * still a week when its predecessor does not, so `delta: false` drops the column
 * and never the numbers.
 */
async function dashboard(record, { week: wanted, force = false } = {}) {
  /* Both prerequisites are named before either call: `settingsFor` throws for a
     missing workspace, and the key is checked for a missing token. A read that
     cannot happen should say which half is missing. */
  const settings = settingsFor(record)
  const token = require('../connector-tokens.cjs').tokenFor('clockify')
  if (!token) {
    throw coded(
      'clockify-no-key',
      'Clockify has no API key on this machine yet. Paste one on the connector’s page.',
    )
  }
  const weekKey = validWeek(wanted, settings.timezone)
  const previousKey = addDays(weekKey, -7)
  /* The member map is part of the key: adding a login changes the roster, and a
     cached week that predates it would show one fewer row than the map has. */
  const cacheKey = [settings.workspaceId, weekKey, settings.timezone, Object.keys(settings.members).sort().join(',')].join('|')
  const hit = cache.get(cacheKey)
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return { ...hit.value, cached: true }

  const [now, before] = await Promise.all([
    week(token, settings, weekKey),
    week(token, settings, previousKey).catch(() => null),
  ])
  const calls = [
    { n: 1, endpoint: 'reports/summary', groups: 'PROJECT, USER', week: 'this week' },
    { n: 2, endpoint: 'reports/summary', groups: 'DATE', week: 'this week' },
  ]
  if (before) {
    calls.push(
      { n: 3, endpoint: 'reports/summary', groups: 'PROJECT, USER', week: 'previous week' },
      { n: 4, endpoint: 'reports/summary', groups: 'DATE', week: 'previous week' },
    )
  }
  const value = {
    weekKey,
    label: now.label,
    /* The stepper's destinations, computed from the same arithmetic that read this
       week: a second implementation in the renderer would be a second answer to
       "which Monday", and the two would disagree across a DST change. */
    previousKey,
    previousLabel: weekLabel(previousKey),
    nextKey: addDays(weekKey, 7),
    nextLabel: weekLabel(addDays(weekKey, 7)),
    thisWeek: currentMonday(settings.timezone),
    isCurrent: weekKey === currentMonday(settings.timezone),
    minWeek: MIN_WEEK,
    workspaceId: settings.workspaceId,
    timezone: settings.timezone,
    seconds: now.seconds,
    entries: now.entries,
    /* Only the projects with hours: `/reports/summary` returns nothing else, and
       a zero row would print a project the read did not actually report on. */
    projects: now.projects.filter((entry) => entry.seconds > 0),
    people: peopleOf(now, before, settings.members),
    daily: now.daily.map((day) => ({ id: day.id, label: day.label, seconds: day.seconds })),
    logins: now.logins,
    members: settings.members,
    previous: before ? { seconds: before.seconds, projects: before.projects.filter((entry) => entry.seconds > 0).length } : null,
    delta: Boolean(before),
    readAt: new Date().toISOString(),
    cached: false,
    /* How long an answer stays good, so the page prints this rule instead of a
       number that drifts from the constant. */
    cacheTtlMs: CACHE_MS,
    calls,
  }
  if (cache.size >= CACHE_KEYS) cache.clear()
  cache.set(cacheKey, { at: Date.now(), value })
  return value
}

module.exports = {
  ROW_CEILING,
  MIN_WEEK,
  MAX_PER_SOURCE,
  currentMonday,
  weekBounds,
  zonedDay,
  addDays,
  validWeek,
  verify,
  resolve,
  preview,
  workspaces,
  dashboard,
}
