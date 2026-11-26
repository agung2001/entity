/**
 * `@gcal:<account|all>:<query>` — events in the calendars a person already ticks.
 *
 * Two reads per account and no more: the calendar list decides *where* to look,
 * and one `events.list` per selected calendar answers with titles. `q=` is the
 * one search Google offers on events, so plain words go into it verbatim — an
 * event has a summary and a location and nothing else worth parsing, which is
 * the whole reason this file is shorter than `gmail.cjs`.
 *
 * **Read-only, by shape.** There is no `POST`, `PATCH` or `DELETE` in this file
 * and no scope below that would allow one; a mention that found an event and then
 * moved it would be a different feature with a confirm dialog, which is why the
 * catalog entry says so in its own words.
 */

const { accountScope, accessToken, connectorOfKind, get, quotaFor } = require('../_shared.cjs')

const MAX_PER_SOURCE = 3
const CONNECTOR = connectorOfKind('calendar')
/* The window a mention reads: a week forward from now. A mention asked "when is
   the planning" is not asking about March, and a wider window is more pages for
   an answer that would then be longer than a turn can use. */
const WINDOW_DAYS = 7
/* Enough events to fill the limit several times over after the per-calendar merge;
   Google's own default is 250 and one page is one request. */
const PAGE_SIZE = 50
const SCOPE = 'calendar.readonly'

const calendarListUrl = () =>
  'https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader'

/** One calendar's events, matching the query, in the next seven days. */
function eventsUrl(calendarId, query, since, until) {
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
  )
  url.searchParams.set('timeMin', since)
  url.searchParams.set('timeMax', until)
  /* Without this a weekly standup is one row and an expanding one is nine: the
     read wants occurrences, which is what the dashboard counts too. */
  url.searchParams.set('singleEvents', 'true')
  url.searchParams.set('orderBy', 'startTime')
  url.searchParams.set('maxResults', String(PAGE_SIZE))
  if (query) url.searchParams.set('q', query)
  return url
}

/** The moment an event starts — all-day events carry `date`, timed ones `dateTime`. */
function startOf(event) {
  const raw = event?.start?.dateTime || event?.start?.date || ''
  const at = new Date(raw)
  return Number.isFinite(at.getTime()) ? at : null
}

function whenOf(event) {
  const start = startOf(event)
  if (!start) return ''
  const allDay = Boolean(event?.start?.date) && !event?.start?.dateTime
  /* An all-day event in a local-time column would read `01:00–01:00` in most
     zones; the day is the honest answer, so it says so. */
  if (allDay) return start.toLocaleDateString('en-gb', { weekday: 'short', day: 'numeric', month: 'short' })
  const end = new Date(event?.end?.dateTime || event?.end?.date || '')
  const clock = (date) =>
    date.toLocaleTimeString('en-gb', { hour: '2-digit', minute: '2-digit' })
  return Number.isFinite(end.getTime()) ? `${clock(start)}–${clock(end)}` : clock(start)
}

/**
 * A row. `label` is the event's own summary because that is what a person scanned
 * for; `detail` carries the three things that decide whether it is the one they
 * meant — when, which calendar, and where.
 */
function rowOf(event, account, calendarName) {
  const summary = String(event?.summary || '(no title)')
  return {
    id: String(event?.id || ''),
    account: account.email,
    label: summary,
    detail: [whenOf(event), calendarName, String(event?.location || '').trim()]
      .filter(Boolean)
      .join(' · '),
    url: String(event?.htmlLink || ''),
  }
}

/** Calendar and its events. A calendar that answers 403 is one skipped calendar,
 *  never a failed mention: the rest of the week is still a true answer. */
async function readCalendar(token, entry, query, since, until) {
  const body = await get(eventsUrl(entry.id, query, since, until), token, CONNECTOR).catch(() => null)
  if (!body) return { name: String(entry.summary || entry.id), events: [] }
  return {
    name: String(entry.summary || entry.id),
    events: Array.isArray(body.items) ? body.items : [],
  }
}

/** One account's share of the rows. */
async function readAccount(account, query, limit, since, until, skipped) {
  let token
  try {
    token = await accessToken(CONNECTOR, account.localpart)
  } catch {
    skipped.push(account.localpart)
    return []
  }
  /* The grant, checked before the call rather than after the 403: a person who
     consented to `calendar.events` alone reads busy blocks, not events, and the
     sentence that says so is more use than Google's error code. */
  const scopes = Array.isArray(account.scopes) ? account.scopes.map(String) : []
  const display = scopes.some((scope) => scope === SCOPE || scope.endsWith(`/${SCOPE}`))
  if (!display) {
    throw new Error(
      `@gcal:${account.localpart}: this account's grant does not include ${SCOPE}, so there are no events to read. Sign in again on the Google Calendar page and ask for Read your calendars.`,
    )
  }
  const list = await get(calendarListUrl(), token, CONNECTOR)
  const calendars = (Array.isArray(list.items) ? list.items : []).filter(
    (entry) => entry && entry.selected === true && entry.id,
  )
  const answers = await Promise.all(
    calendars.map((entry) => readCalendar(token, entry, query, since, until)),
  )
  const rows = []
  for (const answer of answers) {
    for (const event of answer.events) {
      if (event?.status === 'cancelled') continue
      rows.push(rowOf(event, account, answer.name))
      if (rows.length >= limit) return rows
    }
  }
  return rows
}

/** Calendar: `@gcal:<account|all>:<query>` — the events in a week's calendars. */
async function resolveCalendar(ctx, segment, { limit = MAX_PER_SOURCE } = {}) {
  const query = String(segment.query || '').trim()
  if (!query) throw new Error('@gcal:all: needs a search, e.g. @gcal:all:planning')
  const accounts = accountScope(CONNECTOR, segment.account, 'gcal')
  const quota = quotaFor(accounts, limit)
  const now = new Date()
  const since = now.toISOString()
  const until = new Date(now.getTime() + WINDOW_DAYS * 86_400_000).toISOString()
  const rows = []
  const skipped = []
  for (const [index, account] of accounts.entries()) {
    rows.push(...(await readAccount(account, query, quota[index], since, until, skipped)))
    if (rows.length >= limit) break
  }
  segment.skipped = skipped
  return rows.slice(0, limit)
}

module.exports = { resolveCalendar }
