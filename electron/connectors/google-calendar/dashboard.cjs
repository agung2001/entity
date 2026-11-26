/**
 * Google Calendar's Dashboard tab: six counts, the next seven days, and the gaps
 * between them.
 *
 * Four reads per account, and never a fifth for a number already in hand:
 *
 *   calendarList.list    which calendars are ticked (the same set the app shows)
 *   freeBusy.query       the busy blocks, including on calendars whose events this
 *                        grant cannot read — which is what makes the gaps honest
 *   events.list          per calendar, one page each, `singleEvents` so a weekly
 *                        standup is one row per week and not one row forever
 *
 * **Nothing here invents a zero.** A grant without `calendar.readonly` reads busy
 * blocks and prints `—` where an event would be; a refused token is a row with
 * Google's own sentence on it; a rate limit keeps the numbers that were last true
 * and ages the stamp. `0` means a read succeeded and found nothing, which is a
 * different fact from all three.
 *
 * **No token is read, printed or stored here.** Tokens come from
 * `oauth-accounts.cjs` one account at a time and go straight into a header.
 *
 * **One read per ten minutes.** The answer is written to
 * `<~/.entity>/calendar-dashboard.json` and served from there until it expires, so
 * switching tabs is free and only Refresh spends requests. The file is re-read on
 * each call — nothing is held in this process's memory between visits.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const oauthAccounts = require('../../oauth-accounts.cjs')

const WINDOW_DAYS = 7
/* A dashboard is a slow-moving number: ten minutes is short enough that "read 3
   min ago" is true and long enough that flipping tabs costs nothing. */
const CACHE_MS = 10 * 60_000
/* `ENTITY_HOME` first, exactly like every other store: a test must never write the
   developer's real `~/.entity`. */
const ROOT = process.env.ENTITY_HOME
  ? path.resolve(process.env.ENTITY_HOME)
  : path.join(os.homedir(), '.entity')
const CACHE_FILE = path.join(ROOT, 'calendar-dashboard.json')
/* 4: 3 was written before the week grid learned that a seven-day window lands on
   eight calendar days and can end mid-day, so its `days` has no `partial` and one
   day short. Refused rather than reused, exactly like 1 and 2 were. */
const CACHE_SCHEMA = 4
const CONNECTOR = 'google-calendar'
const SCOPE = 'calendar.readonly'
/* What one page read may cost an account: the calendar list, the free/busy pass,
   and a page per calendar up to the cap. Past this the table is already longer
   than a week a person can act on. */
const MAX_READS = 6
const PAGE = 'https://www.googleapis.com/calendar/v3'
const READ_TIMEOUT_MS = 20_000
/* The work window the gaps and the out-of-hours count share. One place, so a gap
   cannot start at 09:00 while the week shape calls 08:30 out of hours. */
const WORK_START = 8
const WORK_END = 19
/* Back-to-back: One's five-minute rule. Two events with up to five minutes between
   them leave no time to write a note, so they are one chain and not two.
   ponytail: the gap is a constant, not a preference — a setting is the upgrade if
   somebody wants their own walk time. */
const BACK_TO_BACK_GAP = 5
/* An event title is attacker-controlled (anyone can invite the person) and these
   kinds feed a coloured cell, so the match stays on the title and never on HTML. */
const PERSONAL_TITLE =
  /\b(lunch|breakfast|dinner|break|gym|workout|run|walk|private|personal|family|doctor|dentist|school|pickup|holiday|vacation|nap|rest)\b/i

/* ── the cache, on disk ────────────────────────────────────────────
   `at` is when the read finished, `key` is the accounts and the window it was read
   for, and `value` is the payload verbatim — `readAt` inside it is what the page
   stamps. Every failure here is a miss, never a read that fails. */
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
    /* read-only home, a full disk: the next visit reads Google again. */
  }
}

/* ── talking to Google ───────────────────────────────────────────── */

/** One request, with the body and the failure kept apart so a caller can quote
    Google's own JSON rather than a sentence this file made up. */
async function send(url, token, { method = 'GET', body } = {}) {
  const options = {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout?.(READ_TIMEOUT_MS) || undefined,
  }
  try {
    const response = await fetch(url, options)
    const payload = await response.json().catch(() => ({}))
    return { ok: response.ok, status: response.status, body: payload }
  } catch (problem) {
    return { ok: false, status: 0, body: {}, transport: String(problem?.message || problem) }
  }
}

/** Which of the three failures this is. They look alike and are not: a disabled
    API is a project problem, a rate limit is a clock problem, and a rejected token
    is a consent problem the accounts card already knows how to fix. */
function classify(answer) {
  const reason = String(answer?.body?.error?.errors?.[0]?.reason || answer?.body?.error?.status || '')
  const said = String(answer?.body?.error?.message || answer?.transport || `HTTP ${answer?.status || 0}`)
  if (/userRateLimitExceeded|rateLimitExceeded|quotaExceeded/i.test(reason) || answer?.status === 429) {
    return { kind: 'limited', message: said }
  }
  if (/accessNotConfigured|SERVICE_DISABLED/i.test(reason) || /has not been used in project|is disabled/i.test(said)) {
    return { kind: 'apiOff', message: said }
  }
  if (answer?.status === 401 || /invalid_grant|Invalid Credentials|insufficientPermissions/i.test(reason)) {
    return { kind: 'refused', message: said }
  }
  if (/insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(reason) || answer?.status === 403) {
    return { kind: 'scope', message: said }
  }
  return { kind: 'error', message: said }
}

/* ── times ───────────────────────────────────────────────────────── */

const dayKey = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

/** An event's start and end as real instants: a timed event carries `dateTime`, an
    all-day one carries `date` and means the whole local day. */
function spanOf(event) {
  const startRaw = event?.start?.dateTime || event?.start?.date
  const endRaw = event?.end?.dateTime || event?.end?.date
  const start = startRaw ? new Date(startRaw) : null
  const end = endRaw ? new Date(endRaw) : null
  if (!start || !Number.isFinite(start.getTime())) return null
  const allDay = !event?.start?.dateTime
  return {
    start,
    end: end && Number.isFinite(end.getTime()) ? end : new Date(start.getTime() + 30 * 60_000),
    allDay,
  }
}

/** The pill's word, and only the tone it needs. `needs reply` is the answer a
    person acts on, so it is a word and not a colour. */
function responseOf(event) {
  const status = String(event?.attendees?.find?.((who) => who?.self)?.responseStatus || '')
  if (status === 'needsAction') return { word: 'needs reply', tone: 'warn' }
  if (status === 'accepted') return { word: 'accepted', tone: 'ok' }
  if (status === 'tentative') return { word: 'tentative', tone: '' }
  if (status === 'declined') return { word: 'declined', tone: 'bad' }
  return { word: 'no reply asked', tone: '' }
}

function whereOf(event) {
  const place = String(event?.location || '').trim()
  /* `hangoutLink` is checked before the empty-location return: a Meet event usually
     has no `location` string at all, so bailing on it first would print `—` for a
     meeting whose link is right there. */
  const meet = String(event?.hangoutLink || '')
  if (meet) return { text: 'Google Meet', url: meet }
  if (!place) return { text: '', url: '' }
  const link = /^https?:\/\//i.test(place) ? place : (event?.description || '').match(/https?:\/\/\S+/)?.[0] || ''
  return { text: place, url: link }
}

/** Minutes, as the table's thin `em` wants them: `1 h 30`, `45 min`, `2 h`. */
function lengthOf(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return ''
  const hours = Math.floor(minutes / 60)
  const rest = Math.round(minutes % 60)
  if (!hours) return `${rest} min`
  return rest ? `${hours} h ${rest}` : `${hours} h`
}

/* ── one account ─────────────────────────────────────────────────── */

/**
 * Everything one account answers: its calendars, their events, its busy blocks and
 * whatever went wrong. A failure is a field on the lane, never a thrown error — one
 * revoked token must not cost the other account its numbers.
 */
async function readLane(account, win, counter) {
  const lane = {
    email: String(account.email || ''),
    localpart: String(account.localpart || ''),
    calendars: [],
    errors: [],
    refused: null,
    scopes: Array.isArray(account.scopes) ? account.scopes.map(String) : [],
    events: [],
    busy: [],
  }
  const scopes = lane.scopes
  const canReadEvents = scopes.includes(SCOPE) || scopes.some((scope) => scope.endsWith(`/${SCOPE}`))
  if (!canReadEvents) {
    lane.errors.push(`This grant does not include ${SCOPE}, so only busy blocks can be read.`)
    return lane
  }
  if (!account.hasToken) {
    lane.refused = { message: 'No token is stored for this account on this machine. Sign in again to read it.' }
    return lane
  }
  let token = ''
  try {
    const answer = await oauthAccounts.accessTokenFor(CONNECTOR, lane.localpart)
    token = String(answer?.accessToken || '')
    if (Array.isArray(answer?.scopes) && answer.scopes.length) lane.scopes = answer.scopes.map(String)
  } catch (problem) {
    /* The refresh layer speaks in the card's own words ("needs a sign-in"), which is
       the sentence the tab can act on; Google's raw `invalid_grant` body never
       reaches here because the refresh already consumed it. */
    lane.refused = { message: String(problem?.message || problem) }
    return lane
  }
  if (!token) {
    lane.refused = { message: 'Google answered no access token for this account.' }
    return lane
  }

  counter.n += 1
  const list = await send(
    `${PAGE}/users/me/calendarList?minAccessRole=freeBusyReader&fields=items(id,summary,accessRole,selected,backgroundColor)`,
    token,
  )
  if (!list.ok) {
    const failure = classify(list)
    if (failure.kind === 'apiOff') lane.errors.push(failure.message)
    else if (failure.kind === 'refused') lane.refused = { message: failure.message }
    else lane.errors.push(failure.message)
    lane.limited = failure.kind === 'limited' ? failure : null
    lane.apiOff = failure.kind === 'apiOff'
    return lane
  }
  const calendars = (Array.isArray(list.body?.items) ? list.body.items : [])
    .filter((entry) => entry && entry.id && entry.selected === true)
    /* One page read is one request per calendar, and the calendar list and the busy
       pass are two more: at four calendars that is the six the foot prints. A
       fifth calendar would cost a seventh request for a week nobody scrolls to the
       end of.

       ponytail: the cap is on calendars read, not on events — a person who ticks
       twelve calendars sees the first four. Paginating the list, or reading
       calendars lazily as the table scrolls, is the upgrade if that is ever the
       wrong four. */
    .slice(0, MAX_READS - 2)
    .map((entry) => ({
      id: String(entry.id),
      name: String(entry.summary || entry.id),
      participant: lane.localpart,
      readOnly: /Reader$/.test(String(entry.accessRole || '')),
      events: [],
    }))
  lane.calendars = calendars
  if (!calendars.length) {
    lane.errors.push('No calendar is ticked in Google Calendar, so there is nothing to read.')
    return lane
  }

  /* The busy pass covers every ticked calendar at once, including ones whose events
     this grant cannot read. It is the only reason the gaps are true when a
     calendar is shared with the person and not owned by them. */
  counter.n += 1
  const free = await send(`${PAGE}/freeBusy`, token, {
    method: 'POST',
    body: { timeMin: win.since, timeMax: win.until, items: calendars.map((entry) => ({ id: entry.id })) },
  })
  if (free.ok) {
    for (const [id, answer] of Object.entries(free.body?.calendars || {})) {
      const target = calendars.find((entry) => entry.id === id)
      for (const block of Array.isArray(answer?.busy) ? answer.busy : []) {
        lane.busy.push({ start: String(block.start || ''), end: String(block.end || ''), calendar: target?.name || '' })
      }
    }
  }

  for (const calendar of calendars) {
    counter.n += 1
    const url = new URL(`${PAGE}/calendars/${encodeURIComponent(calendar.id)}/events`)
    url.searchParams.set('timeMin', win.since)
    url.searchParams.set('timeMax', win.until)
    /* Without this a weekly standup is one row and an expanded one is nine: the
       dashboard counts occurrences, which is what a week means. */
    url.searchParams.set('singleEvents', 'true')
    url.searchParams.set('orderBy', 'startTime')
    url.searchParams.set('maxResults', '250')
    const page = await send(url.toString(), token)
    if (!page.ok) {
      const failure = classify(page)
      lane.errors.push(`${calendar.name}: ${failure.message}`)
      if (failure.kind === 'limited') lane.limited = failure
      if (failure.kind === 'apiOff') lane.apiOff = true
      if (failure.kind === 'refused') lane.refused = { message: failure.message }
      continue
    }
    const items = Array.isArray(page.body?.items) ? page.body.items : []
    calendar.events = items
      .filter((event) => event && event.status !== 'cancelled')
      .map((event) => {
        const span = spanOf(event)
        if (!span) return null
        const response = responseOf(event)
        const where = whereOf(event)
        const minutes = Math.round((span.end.getTime() - span.start.getTime()) / 60_000)
        const title = String(event.summary || '(no title)')
        /* One's own shape: the organiser is who called the meeting, the attendees
           are who answered it, and the count is what a day column can hold. */
        const organiser = event.organizer || {}
        const attendees = whoOf(event)
        return {
          id: String(event.id || ''),
          title,
          url: String(event.htmlLink || ''),
          calendar: calendar.name,
          participant: lane.localpart,
          account: lane.email,
          start: span.start.toISOString(),
          end: span.end.toISOString(),
          allDay: span.allDay,
          minutes,
          length: lengthOf(minutes),
          day: dayKey(span.start),
          where: where.text,
          whereUrl: where.url,
          response: response.word,
          tone: response.tone,
          people: attendees.length,
          attendees,
          organiser: String(organiser.displayName || organiser.email || ''),
          organiserEmail: String(organiser.email || ''),
          kind: kindOf(span, title, attendees.length),
          outOfHours: outOfHoursOf(span),
        }
      })
      .filter(Boolean)
    /* The lane is what the tab counts, and the calendar's own list is what its chip
       counts: both, because `All calendars` and one calendar's chip are two
       different questions. */
    lane.events.push(...calendar.events)
  }
  return lane
}

/* ── the numbers ─────────────────────────────────────────────────── */

/** Two events share an hour: the marker is a word on the row, and this is what
    decides which rows wear it. Compared as intervals on the real clock, so an
    all-day event does not collide with everything in its day. */
function markOverlaps(events) {
  const timed = events.filter((event) => !event.allDay)
  const overlapped = new Set()
  for (let i = 0; i < timed.length; i += 1) {
    for (let j = i + 1; j < timed.length; j += 1) {
      const a = timed[i]
      const b = timed[j]
      const aStart = new Date(a.start).getTime()
      const aEnd = new Date(a.end).getTime()
      const bStart = new Date(b.start).getTime()
      const bEnd = new Date(b.end).getTime()
      /* The hour, not the minute: two back-to-back meetings at 11:00 and 11:30 are
         an overlap in the sense a person means — they cannot both be attended. */
      if (aStart < bEnd && bStart < aEnd) {
        overlapped.add(a.id)
        overlapped.add(b.id)
      }
    }
  }
  return overlapped
}

/** Free slots of 30 minutes or more inside the work window, over the union of every
    busy block — so a calendar shared with the person still fills the day. */
function gapsOf(busy, win) {
  const MIN_GAP = 30 * 60_000
  const perDay = new Map()
  for (const block of busy) {
    const start = new Date(block.start)
    const end = new Date(block.end)
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) continue
    const key = dayKey(start)
    if (!perDay.has(key)) perDay.set(key, [])
    perDay.get(key).push({ start: start.getTime(), end: end.getTime() })
  }
  const gaps = []
  const cursor = new Date(new Date(win.since).setHours(0, 0, 0, 0))
  const last = new Date(win.until)
  while (cursor <= last && gaps.length < 40) {
    const key = dayKey(cursor)
    const dayStart = new Date(cursor).setHours(WORK_START, 0, 0, 0)
    const dayEnd = new Date(cursor).setHours(WORK_END, 0, 0, 0)
    const blocks = (perDay.get(key) || []).sort((a, b) => a.start - b.start)
    let at = dayStart
    for (const block of blocks) {
      if (block.end <= at) continue
      if (block.start - at >= MIN_GAP) gaps.push({ day: key, from: at, to: Math.min(block.start, dayEnd) })
      at = Math.max(at, block.end)
      if (at >= dayEnd) break
    }
    if (dayEnd - at >= MIN_GAP) gaps.push({ day: key, from: at, to: dayEnd })
    cursor.setDate(cursor.getDate() + 1)
  }
  return gaps
    .filter((gap) => gap.to > gap.from)
    .map((gap) => ({ day: gap.day, from: new Date(gap.from).toISOString(), to: new Date(gap.to).toISOString() }))
}

/** Outside the work window: before it opens, after it closes, or past midnight —
    a window that wraps is out of hours whatever the clock says. */
function outOfHoursOf(span) {
  if (span.allDay) return false
  const from = span.start.getHours() * 60 + span.start.getMinutes()
  const to = span.end.getHours() * 60 + span.end.getMinutes()
  return from < WORK_START * 60 || from >= WORK_END * 60 || to > WORK_END * 60 || to <= from
}

/** One's four kinds, decided once so a cell, a legend and a tile cannot disagree.
    An all-day event is dated rather than timed, so it can never be focus minutes. */
function kindOf(span, title, people) {
  if (span.allDay) return 'other'
  if (people > 0) return 'meeting'
  if (PERSONAL_TITLE.test(title) || outOfHoursOf(span)) return 'personal'
  return 'focus'
}

/** Who answered the invite, in the order a person reads it: the organiser is the one
    who called it, and the rest are clipped so one 80-person invite cannot push the
    attendees nobody needs past the fold. A row keeps the names, not just a count, so
    hover is not the only way to find out who is in the room. */
function whoOf(event) {
  const rows = Array.isArray(event?.attendees) ? event.attendees : []
  return rows
    .filter((who) => who && (who.email || who.displayName))
    .slice(0, 12)
    .map((who) => ({
      name: String(who.displayName || who.email || ''),
      email: String(who.email || ''),
      status: String(who.responseStatus || ''),
      self: who.self === true,
      organiser: who.organizer === true,
    }))
}

function windowOf() {
  const since = new Date()
  const until = new Date(since.getTime() + WINDOW_DAYS * 86_400_000)
  return { days: WINDOW_DAYS, since: since.toISOString(), until: until.toISOString() }
}

/** The union of intervals, in minutes: two meetings that overlap are one hour of the
    person's day, not two. Everything the week shape counts starts here, so `busy` and
    `focus` cannot be summed two ways. */
function unionMinutes(spans) {
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  let total = 0
  let from = 0
  let to = 0
  let open = false
  for (const span of sorted) {
    if (!open) {
      from = span.start
      to = span.end
      open = true
    } else if (span.start <= to) {
      to = Math.max(to, span.end)
    } else {
      total += to - from
      from = span.start
      to = span.end
    }
  }
  if (open) total += to - from
  return Math.round(total / 60_000)
}

const spanOfEvent = (event) => ({ start: new Date(event.start).getTime(), end: new Date(event.end).getTime() })

/** One column per local day the window touches — the same local day keys the rows
    carry, because a UTC day would be wrong for seven hours of every WIB day. A seven
    day window is not always seven columns: it starts at the current minute, so it
    lands on eight calendar days, and a grid that stopped at seven would drop the last
    day's events while the totals still counted them. `open` is the day holding now:
    its minutes are still filling, so the grid says so rather than looking short. */
function daysOf(events, win) {
  const today = dayKey(new Date())
  const cursor = new Date(new Date(win.since).setHours(12, 0, 0, 0))
  const last = dayKey(new Date(win.until))
  const ends = new Date(win.until)
  /* The window stops at the current minute a week out, so its last day is a partial
     one. It is marked rather than silently shorter than the rest. */
  const cuts = ends.getHours() * 60 + ends.getMinutes() > 0
  const days = []
  for (let index = 0; index < 31; index += 1) {
    const date = dayKey(cursor)
    const mine = events.filter((event) => event.day === date)
    const timed = mine.filter((event) => !event.allDay)
    days.push({
      date,
      open: date === today,
      partial: cuts && date === last,
      events: mine.length,
      busyMinutes: unionMinutes(timed.map(spanOfEvent)),
      meetingMinutes: unionMinutes(timed.filter((event) => event.kind === 'meeting').map(spanOfEvent)),
      focusMinutes: unionMinutes(timed.filter((event) => event.kind === 'focus').map(spanOfEvent)),
      outOfHours: mine.filter((event) => event.outOfHours).length,
    })
    if (date >= last) break
    cursor.setDate(cursor.getDate() + 1)
  }
  return days
}

/** A focus block only counts as unbroken while the next solo event starts inside the
    same five-minute gap `backToBack` uses, so a 50 + 50 pair is one 100-minute block. */
function longestFocus(events) {
  const focus = events
    .filter((event) => event.kind === 'focus' && !event.allDay)
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
  let best = { minutes: 0, at: null }
  let from = 0
  let to = 0
  let started = null
  for (const event of focus) {
    const begin = new Date(event.start).getTime()
    const end = new Date(event.end).getTime()
    if (to && begin - to <= BACK_TO_BACK_GAP * 60_000) {
      to = Math.max(to, end)
    } else {
      from = begin
      to = end
      started = event
    }
    const minutes = Math.round((to - from) / 60_000)
    if (minutes > best.minutes) best = { minutes, at: started }
  }
  return { minutes: best.minutes, at: best.at ? best.at.start : null, title: best.at ? best.at.title : '' }
}

const KIND_LABELS = { meeting: 'Meetings', focus: 'Focus', personal: 'Personal', other: 'Other' }

/** The week's shape, from the one event list the table also draws — so a reading can
    never disagree with the rows above it. */
function shapeOf(events, days) {
  const timed = events.filter((event) => !event.allDay)
  const busyMinutes = days.reduce((sum, day) => sum + day.busyMinutes, 0)
  const meetingMinutes = days.reduce((sum, day) => sum + day.meetingMinutes, 0)
  const byStart = [...timed].sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
  let backToBack = 0
  for (let index = 1; index < byStart.length; index += 1) {
    const gap = (new Date(byStart[index].start).getTime() - new Date(byStart[index - 1].end).getTime()) / 60_000
    if (gap >= 0 && gap <= BACK_TO_BACK_GAP) backToBack += 1
  }
  let overlapPairs = 0
  for (let first = 0; first < timed.length; first += 1) {
    for (let second = first + 1; second < timed.length; second += 1) {
      const a = spanOfEvent(timed[first])
      const b = spanOfEvent(timed[second])
      if (a.start < b.end && b.start < a.end) overlapPairs += 1
    }
  }
  const focus = longestFocus(events)
  const weekendMinutes = days
    .filter((day) => [0, 6].includes(new Date(`${day.date}T12:00:00`).getDay()))
    .reduce((sum, day) => sum + day.busyMinutes, 0)
  const busiest = [...days].sort((a, b) => b.busyMinutes - a.busyMinutes)[0]
  const kinds = ['meeting', 'focus', 'personal', 'other'].map((id) => {
    /* Per kind, the union: the legend's minutes must not be able to outrun the
       per-day columns above it, and a doubled invite is one hour there too. */
    const minutes = unionMinutes(timed.filter((event) => event.kind === id).map(spanOfEvent))
    return { id, label: KIND_LABELS[id], minutes, share: 0 }
  })
  /* A budget, so the chips add up: the denominator is the minutes they name, not the
     busy union — a focus block booked over a meeting is in both, and a row of chips
     that sums to 111% reads as a bug even when the arithmetic is right. */
  const budgeted = kinds.reduce((sum, kind) => sum + kind.minutes, 0)
  for (const kind of kinds) {
    kind.share = budgeted > 0 ? Math.round((kind.minutes / budgeted) * 1000) / 1000 : 0
  }
  return {
    days,
    totals: {
      events: events.length,
      busyMinutes,
      meetingMinutes,
      /* 0 rather than NaN on an empty week: the page prints a percentage, and a
         percentage of nothing is a sentence nobody can act on. */
      meetingShare: busyMinutes > 0 ? Math.round((meetingMinutes / busyMinutes) * 1000) / 1000 : 0,
      longestFocusMinutes: focus.minutes,
      longestFocusAt: focus.at,
      longestFocusTitle: focus.title,
      backToBack,
      overlapPairs,
      outOfHoursEvents: events.filter((event) => event.outOfHours).length,
      weekendMinutes,
      busiestDay: busiest && busiest.busyMinutes > 0 ? busiest.date : null,
      emptyDays: days.filter((day) => day.events === 0).length,
    },
    kinds,
  }
}

const lengthMinutes = (minutes) =>
  minutes >= 60
    ? `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60}` : ''}`
    : `${minutes} min`

/** The deterministic findings, written here rather than in the template: the card, the
    numbers under it and any sentence that quotes them read from this one list. `null`
    totals (a grant that could not answer) produce no readings — never a reading about
    zeroes nobody read. */
function readingsOf(totals) {
  if (!totals) return []
  if (totals.events === 0) {
    return [
      {
        id: 'empty',
        label: 'Nothing scheduled',
        value: '0 events',
        tone: 'good',
        hint: 'No events were in this window, so there is no focus or meeting figure to report.',
      },
    ]
  }
  const readings = [
    {
      id: 'focus',
      label: 'Longest focus block',
      value: totals.longestFocusMinutes
        ? `${lengthMinutes(totals.longestFocusMinutes)}${totals.longestFocusTitle ? `, ${totals.longestFocusTitle}` : ''}`
        : 'no solo block',
      tone:
        totals.longestFocusMinutes >= 90 ? 'good' : totals.longestFocusMinutes >= 45 ? 'watch' : 'risk',
      hint:
        totals.longestFocusMinutes >= 90
          ? 'An unbroken block that long is where a hard task actually gets done; protect the same slot next week.'
          : 'Blocks this short rarely cover a hard task — one 90-minute block would change the week more than anything else here.',
    },
    {
      id: 'meetings',
      label: 'Meeting share',
      value: `${Math.round(totals.meetingShare * 100)}% of busy time`,
      tone: totals.meetingShare <= 0.4 ? 'good' : totals.meetingShare <= 0.65 ? 'watch' : 'risk',
      hint: `${totals.meetingMinutes} meeting minutes inside ${totals.busyMinutes} busy minutes, counted as a union so two overlapping invites count once.`,
    },
    {
      id: 'fragmentation',
      label: 'Back-to-back chains',
      value: `${totals.backToBack} ${totals.backToBack === 1 ? 'pair' : 'pairs'} · ${totals.overlapPairs} ${totals.overlapPairs === 1 ? 'overlap' : 'overlaps'}`,
      tone: totals.backToBack >= 12 || totals.overlapPairs > 0 ? 'risk' : totals.backToBack >= 6 ? 'watch' : 'good',
      hint:
        totals.overlapPairs > 0
          ? 'An overlap means two events claim the same minutes — one of them was not really attended.'
          : 'Back-to-back pairs leave no minute to write a note or walk to the next thing.',
    },
    {
      id: 'boundary',
      label: 'Outside the work window',
      value: `${totals.outOfHoursEvents} ${totals.outOfHoursEvents === 1 ? 'event' : 'events'} · ${totals.weekendMinutes} weekend min`,
      tone:
        totals.outOfHoursEvents === 0 && totals.weekendMinutes === 0
          ? 'good'
          : totals.outOfHoursEvents <= 2
            ? 'watch'
            : 'risk',
      hint: `The window is ${WORK_START}:00–${WORK_END}:00 local. Everything outside it is time the week did not cost on paper.`,
    },
  ]
  /* ponytail: no `Against last week` reading. This window rolls forward from now
     rather than being a calendar week, and the previous seven days are not in hand —
     one is a real extra Google read (four more requests per visit) and the one the
     page has instead is the trend this window itself shows. Upgrade: keep the last
     window's totals beside the cache and compare when the stored window is a full
     week behind. */
  return readings.slice(0, 6)
}

/**
 * The whole tab, in one answer.
 *
 * `force` is the Refresh button. The cache key is the readable accounts plus the
 * window's start day, so signing in or out — or the day rolling over — invalidates
 * it without anyone remembering to.
 */
async function dashboard({ force = false } = {}) {
  const win = windowOf()
  const accounts = oauthAccounts.connectedAccounts(CONNECTOR)
  const base = {
    window: win,
    readAt: '',
    cached: false,
    /* How long a stored answer stays good, so the page can print the rule instead
       of hardcoding a number that drifts from this constant. */
    cacheTtlMs: CACHE_MS,
    accounts: {},
    events: [],
    tiles: emptyTiles(),
    gaps: [],
    days: [],
    totals: null,
    kinds: [],
    readings: [],
    wait: null,
    errors: [],
    limited: null,
    quota: null,
    reads: 0,
    scopeMissing: false,
    apiOff: false,
  }
  if (!accounts.length) return base

  const key = `${accounts.map((entry) => entry.localpart).join(',')}|${dayKey(new Date(win.since))}`
  const stored = readCache()
  if (!force && stored && stored.key === key && Date.now() - stored.at < CACHE_MS) {
    return { ...stored.value, cached: true, reads: 0 }
  }

  const counter = { n: 0 }
  const lanes = []
  for (const account of accounts) lanes.push(await readLane(account, win, counter))

  const now = Date.now()
  const tomorrow = new Date()
  tomorrow.setHours(0, 0, 0, 0)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const events = []
  /* The same meeting sits on every calendar that was invited to it, and Google
     repeats its id on each. One row per event id: counting the copies would double
     `This week` and `Meeting hours`, and — worse — mark the two copies as overlapping
     each other. The row keeps every calendar it appeared on, so a chip still finds
     it. The first calendar to answer keeps the name on the row. */
  const byId = new Map()
  const errors = []
  const refused = []
  let limited = null
  let apiOff = false
  let scopeMissing = false
  const byAccount = {}
  for (const lane of lanes) {
    byAccount[lane.localpart] = {
      email: lane.email,
      calendars: lane.calendars,
      errors: lane.errors,
      refused: lane.refused,
    }
    for (const event of lane.events) {
      const kept = byId.get(event.id)
      if (kept) {
        /* The same meeting, on a second calendar: it is one row in the table, but
           it must still answer to *both* calendars' chips — otherwise a chip that
           says `1` filters the table down to nothing. */
        if (!kept.calendars.includes(event.calendar)) kept.calendars.push(event.calendar)
        continue
      }
      event.calendars = [event.calendar]
      byId.set(event.id, event)
      events.push(event)
    }
    errors.push(...lane.errors.map((message) => ({ account: lane.localpart, message })))
    if (lane.refused) {
      refused.push(lane.localpart)
      errors.push({ account: lane.localpart, message: lane.refused.message })
    }
    if (lane.apiOff) apiOff = true
    if (lane.limited) limited = { account: lane.localpart, message: lane.limited.message, resetAt: '' }
    if (!(lane.scopes.includes(SCOPE) || lane.scopes.some((scope) => scope.endsWith(`/${SCOPE}`)))) {
      scopeMissing = true
    }
  }

  /* One list, sorted by start, then the markers and the numbers read off it. The
     table, the tiles and the rail all come from here, so they cannot disagree. */
  events.sort((a, b) => String(a.start).localeCompare(String(b.start)))
  const overlaps = markOverlaps(events)
  for (const event of events) event.overlap = overlaps.has(event.id)

  const accepted = events.filter((event) => event.response === 'accepted' && !event.allDay)
  const minutes = accepted.reduce((sum, event) => sum + event.minutes, 0)
  const upcoming = events.find((event) => new Date(event.start).getTime() >= now && !event.allDay)
  const today = events.filter(
    (event) => new Date(event.end).getTime() > now && new Date(event.start) < tomorrow,
  )
  const busy = lanes.flatMap((lane) => lane.busy)
  const gaps = gapsOf(busy, win)

  const tiles = {
    today: today.length,
    week: events.length,
    /* A decimal, because 11 h 20 rounds to something a person would not recognise
       as their own week. */
    hours: Math.round((minutes / 60) * 10) / 10,
    nextIn: upcoming
      ? {
          minutes: Math.max(0, Math.round((new Date(upcoming.start).getTime() - now) / 60_000)),
          title: upcoming.title,
          start: upcoming.start,
        }
      : null,
    needsReply: events.filter((event) => event.response === 'needs reply').length,
    overlaps: events.filter((event) => event.overlap).length,
  }
  /* When no lane could read events at all, every tile is unknown rather than zero:
     a grant that reads busy blocks answered nothing about how many events there
     are. */
  if (!events.length && (scopeMissing || apiOff)) {
    for (const name of ['today', 'week', 'hours', 'needsReply', 'overlaps']) tiles[name] = null
    tiles.nextIn = null
  }

  const firstOverlap = events.find((event) => event.overlap)
  /* The week's shape is read off the same list the table draws, and it is `null` — not
     a week of zeroes — when no lane could read events at all: a grant that returns
     busy blocks answered nothing about meetings, so it has no meeting share. */
  const blind = !events.length && (scopeMissing || apiOff)
  const shape = blind ? { days: [], totals: null, kinds: [] } : shapeOf(events, daysOf(events, win))
  const value = {
    ...base,
    readAt: new Date().toISOString(),
    accounts: byAccount,
    events,
    tiles,
    gaps,
    /* The grid, the four figures and the readings: one derivation, three places that
       print it, so the column totals and `This week` cannot drift apart. */
    days: shape.days,
    totals: shape.totals,
    kinds: shape.kinds,
    readings: readingsOf(shape.totals),
    /* The strip's own copy of the three things that need the person, so the numbers
       above it and the sentence under it are the same numbers. */
    wait:
      tiles.needsReply || tiles.overlaps
        ? {
            needsReply: tiles.needsReply,
            overlaps: tiles.overlaps,
            overlapDay: firstOverlap ? firstOverlap.day : '',
            nextMinutes: tiles.nextIn?.minutes ?? null,
          }
        : null,
    errors,
    limited,
    /* Google's Calendar API has no quota endpoint, so nothing is claimed about it:
       the rail prints `—` until a 403 says the budget is spent, which is the one
       moment the number is knowable. */
    quota: limited ? { state: 'limited', resetAt: '', limit: null, used: null } : { state: 'unknown' },
    reads: counter.n,
    scopeMissing,
    apiOff,
    refused,
  }
  /* Stale numbers are better than none, and they are what a rate-limited tab shows
     — but they are never presented as fresh, and a rate-limited read is not worth
     storing: it would only re-serve the same refusal for ten minutes. */
  if (!limited) writeCache(key, value)
  return value
}

function emptyTiles() {
  return { today: null, week: null, hours: null, nextIn: null, needsReply: null, overlaps: null }
}

/**
 * The accounts card's own read: who is signed in, and how many calendars each one
 * answered on the last dashboard read. `calendars` is `null` when nothing has been
 * read yet — not `0`, which would claim a read that never happened.
 */
function accounts() {
  const rows = oauthAccounts.connectedAccounts(CONNECTOR)
  const stored = readCache()
  const known = stored?.value?.accounts || null
  return {
    /* The gate's third sentence: an API that is off is a different lock from an
       account that is missing, and the page has to be able to tell them apart
       before it presses anything. */
    apiOff: stored?.value?.apiOff === true,
    readAt: String(stored?.value?.readAt || ''),
    accounts: rows.map((row) => {
      const lane = known?.[row.localpart]
      return {
        localpart: row.localpart,
        email: row.email,
        status: row.status,
        scopes: row.scopes,
        missing: row.missing,
        hasToken: row.hasToken,
        calendars: Array.isArray(lane?.calendars) ? lane.calendars.length : null,
      }
    }),
  }
}

module.exports = { CACHE_MS, CACHE_FILE, WINDOW_DAYS, accounts, dashboard }
