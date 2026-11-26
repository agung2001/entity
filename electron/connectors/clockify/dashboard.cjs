/**
 * The Clockify dashboard's two reads: the workspaces a key can see, and one week for
 * the tab.
 *
 * `workspaces()` answers the Overview selector; `dashboard()` reads one week plus its
 * predecessor. Both are read-only and both keep the key on this side of the bridge —
 * neither call takes or returns one. The tab and the mention read the same `week()`
 * (from `api.cjs`), so their totals cannot disagree.
 */
const {
  MIN_WEEK,
  USER_ID,
  WORKSPACES_API,
  TIMEOUT_MS,
  text,
  addDays,
  currentMonday,
  validWeek,
  weekLabel,
  fieldsOf,
  settingsFor,
  coded,
  upstreamError,
  summary,
  pct,
  week,
  workspaceList,
} = require('./api.cjs')

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
 * The workspaces this key can read: `[{ id, name, members }]`.
 *
 * `members` is not from Clockify — the endpoint returns no count. It is the size
 * of the stored member map, and only for the workspace that map belongs to; every
 * other row says `0` so nothing here prints a number it did not read.
 */
async function workspaces(record) {
  const fields = fieldsOf(record)
  const token = require('../../connector-tokens.cjs').tokenFor('clockify')
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
        pct: 0,
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
  /* Each person's share of the week, rounded here: the tab prints it beside the
     hours and draws a bar from the same figure, so a second rounding there would
     let the number and the bar disagree by a point. */
  for (const row of rows.values()) row.pct = pct(row.seconds, report.seconds)
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
  const token = require('../../connector-tokens.cjs').tokenFor('clockify')
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
    projects: now.projects
      .filter((entry) => entry.seconds > 0)
      .sort((a, b) => b.seconds - a.seconds)
      .map((entry) => ({ ...entry, pct: pct(entry.seconds, now.seconds) })),
    clients: now.clients,
    /* One's “Daily average” is the week divided by the days that had time, not by
       seven, and an average over zero days is a dash rather than a zero. */
    activeDays: now.daily.filter((day) => day.seconds > 0).length,
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


module.exports = { workspaces, dashboard }
