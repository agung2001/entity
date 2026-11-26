/**
 * Every number on the YouTrack tab, derived from the two reads and nothing else.
 *
 * The main process hands back rows (`electron/connectors/youtrack/dashboard.cjs`); this module
 * turns them into the tiles, the team table, the flow and the backlog. It is pure
 * on purpose: rows and a clock in, no network, no DOM, so the arithmetic a lead is
 * going to check by hand can be checked by a test as well.
 *
 * **Two absences, two meanings.** A row set of `null` means *that read did not
 * return* — every number derived from it is `null` and prints `—`. An empty array
 * means *the tracker answered and holds nothing* — every number is a real `0`. The
 * distinction is the whole reason this file exists instead of a `reduce` inside a
 * component: collapsing the two is how a broken token becomes a confident zero.
 *
 * **Seats, not people.** An issue with two assignees is counted in both rows, so
 * the `Open` column sums past the unresolved total whenever work is shared. The
 * table's foot prints that sum next to the issue count, so nobody fails the
 * arithmetic and stops trusting the table.
 *
 * **The printed query is an equivalence, not the call that was made.** Each tile
 * carries the query whose result *equals* its number, so a figure somebody doubts
 * is one paste away from being checked even though it was computed in JavaScript.
 */
const DAY = 86_400_000
const N7 = 7 * DAY
const N30 = 30 * DAY

/* `#Unresolved` and `#Resolved` are the tracker's own switches. A priority clause
   is a comma-joined value list — spaces mean "and another word in the name", which
   is why `Priority: Major Critical` answers 1 where this answers 20 (measured on a
   real tracker: 20 of 305). */
const OPEN = '#Unresolved'
const DONE = '#Resolved'
const WORSE = 'Priority: {Major}, {Critical}, {Show-stopper}'
const WORSE_WORDS = ['major', 'critical', 'show-stopper']

const fmt = new Intl.NumberFormat('en-gb')

/* Every stamp the tracker sends is UTC, and the machine that reads it may not be:
   a formatter without `timeZone` would move a row across the chart, or a "resolved
   24 Nov" into the 23rd, for every viewer west of the tracker. */
const MONTH_SHORT = new Intl.DateTimeFormat('en-gb', { month: 'short', timeZone: 'UTC' })
const MONTH_LONG = new Intl.DateTimeFormat('en-gb', { month: 'long', timeZone: 'UTC' })
const DATE_FULL = new Intl.DateTimeFormat('en-gb', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
})
const DATE_SHORT = new Intl.DateTimeFormat('en-gb', { day: '2-digit', month: 'short', timeZone: 'UTC' })
const WEEKDAY_DAY = new Intl.DateTimeFormat('en-gb', {
  weekday: 'short',
  day: '2-digit',
  timeZone: 'UTC',
})
const STAMP_FULL = new Intl.DateTimeFormat('en-gb', {
  weekday: 'short',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
})

/** `—` is "this read did not return", never a stand-in for a zero. */
function num(value) {
  if (value === null || value === undefined) return '—'
  const n = Number(value)
  return Number.isFinite(n) ? fmt.format(n) : '—'
}

/** Floor, because a percentage that rounds up claims work nobody has done — and
 *  it is always printed beside the count it describes, never alone. */
function pct(part, whole) {
  if (part === null || part === undefined || whole === null || whole === undefined) return '—'
  const p = Number(part)
  const w = Number(whole)
  if (!Number.isFinite(p) || !Number.isFinite(w) || w <= 0) return '0%'
  return `${Math.floor((p / w) * 100)}%`
}

/** Whole days, with a comma past a thousand: `1,900 d`, not `5.2 y`. */
function days(value) {
  if (value === null || value === undefined) return '—'
  const ms = Number(value)
  if (!Number.isFinite(ms)) return '—'
  return `${fmt.format(Math.max(0, Math.floor(ms / DAY)))} d`
}

/** The tracker's spelling, lowercased: `in progress`, `to be discussed`. */
const word = (value) => String(value || '').trim().toLowerCase()

/** A tracker stamp is `2026-11-25 15:44:08` in UTC with no zone suffix. Without the
 *  `Z` every age on the page is off by the viewer's offset, and a row can slip out
 *  of the seven-day window by being read from a different time zone. */
function stamp(value) {
  if (!value) return null
  const text = String(value).trim()
  if (!text) return null
  /* An RFC 3339 stamp already carries its zone (`…T11:24:11.667Z`); appending a
     second `Z` to it would make it unparseable and silently fall back to `now`. */
  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(text)) {
    const ms = Date.parse(text)
    return Number.isFinite(ms) ? ms : null
  }
  const ms = Date.parse(`${text.replace(' ', 'T')}Z`)
  return Number.isFinite(ms) ? ms : null
}

const assigneesOf = (row) =>
  Array.isArray(row?.assignees)
    ? row.assignees.map((entry) => String(entry || '').trim()).filter(Boolean)
    : []

/** Accepts the read's `{ login, name }` or a bare login, so a caller cannot get the
 *  shape wrong and silently lose the `for: me` band. */
function meOf(me) {
  if (!me) return { login: '', name: '' }
  if (typeof me === 'string') return { login: me.trim(), name: '' }
  return { login: String(me.login || '').trim(), name: String(me.name || '').trim() }
}

/** A leading monogram. Two letters where the login has two parts, one where it does
 *  not — the cell is 26 px and a third letter would not fit, not even for the logins
 *  with three underscores. */
function monogram(login) {
  const parts = String(login || '')
    .split(/[._\-\s]+/)
    .filter(Boolean)
  if (!parts.length) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

/** The 30-day window the resolved read asked for, printed in the pane's bar. */
function windowOf(now = Date.now()) {
  const day = (ms) => new Date(ms).toISOString().slice(0, 10)
  return { days: 30, since: day(now - N30), until: day(now) }
}

/**
 * The six tiles of each band.
 *
 * `value` is a number, or `null` when the read it needs did not return. `query` is
 * the equivalence a person can paste into the tracker's search box, and it survives
 * a `null` value — the label and the query are the tile, the number is only its
 * current answer.
 */
function tiles(unresolved, resolved, me, now = Date.now()) {
  const open = Array.isArray(unresolved) ? unresolved : null
  const done = Array.isArray(resolved) ? resolved : null
  const who = meOf(me)
  const rows = open || []

  const has = (row, login) => assigneesOf(row).some((entry) => entry === login)
  const stateIs = (row, name) => word(row.state) === word(name)
  const recent = (value, window) => {
    const at = stamp(value)
    return at !== null && at >= now - window
  }

  /* A count is `null` exactly when its read is: a read that did not return cannot
     say "0", and a tile that printed one would be lying quietly. */
  const count = (fn) => (open === null ? null : rows.filter(fn).length)
  const mine = (fn) => (open === null || !who.login ? null : rows.filter((row) => has(row, who.login) && fn(row)).length)
  const mineDone = (window) =>
    done === null || !who.login
      ? null
      : done.filter((row) => has(row, who.login) && recent(row.resolvedAt, window)).length

  /* `for: me` resolves to the token's own login, so the printed query is the one a
     reader can paste; the login is a tracker identifier, never a display name. */
  const login = who.login ? `Assignee: ${who.login}` : 'for: me'

  return {
    mine: [
      {
        key: 'open',
        label: 'Open',
        value: open === null || !who.login ? null : rows.filter((row) => has(row, who.login)).length,
        query: `${OPEN} ${login}`,
      },
      {
        key: 'progress',
        label: 'In progress',
        value: mine((row) => stateIs(row, 'In Progress')),
        query: `${OPEN} State: {In Progress} ${login}`,
      },
      {
        key: 'worse',
        label: 'Major or worse',
        value: mine((row) => WORSE_WORDS.includes(word(row.priority))),
        query: `${OPEN} ${login} ${WORSE}`,
      },
      {
        key: 'done30',
        label: 'Resolved 30 d',
        value: mineDone(N30),
        query: `${DONE} ${login} resolved date: {minus 30d} .. *`,
      },
      {
        key: 'untouched',
        label: 'Untouched 7 d',
        value: mine((row) => {
          const at = stamp(row.updatedAt)
          return at !== null && at < now - N7
        }),
        query: `${OPEN} ${login} updated: * .. {minus 7d}`,
      },
      {
        key: 'done7',
        label: 'Resolved 7 d',
        value: mineDone(N7),
        query: `${DONE} ${login} resolved date: {minus 7d} .. *`,
      },
    ],
    team: [
      { key: 'open', label: 'Unresolved', value: open === null ? null : rows.length, query: OPEN },
      {
        key: 'progress',
        label: 'In progress',
        value: count((row) => stateIs(row, 'In Progress')),
        query: `${OPEN} State: {In Progress}`,
      },
      {
        key: 'discussed',
        label: 'To be discussed',
        value: count((row) => stateIs(row, 'To be discussed')),
        query: `${OPEN} State: {To be discussed}`,
      },
      {
        key: 'unassigned',
        label: 'Unassigned',
        value: count((row) => assigneesOf(row).length === 0),
        /* Not `Assignee: null` and not `{No assignee}` — both answer 0 on a real
           tracker; `has: -assignee` is the form that answers 164. */
        query: `${OPEN} has: -assignee`,
      },
      {
        key: 'untouched',
        label: 'Untouched 7 d',
        value: count((row) => {
          const at = stamp(row.updatedAt)
          return at !== null && at < now - N7
        }),
        query: `${OPEN} updated: * .. {minus 7d}`,
      },
      {
        key: 'done7',
        label: 'Resolved 7 d',
        value: done === null ? null : done.filter((row) => recent(row.resolvedAt, N7)).length,
        query: `${DONE} resolved date: {minus 7d} .. *`,
      },
    ],
  }
}

/**
 * The team table: one row per seat.
 *
 * A seat is somebody the tracker names as an assignee — on an unresolved issue (so
 * the row has work to show) or on one resolved in the last week (so the row is not
 * empty for the person who closed twelve). Rows sort by what is stuck, not
 * alphabetically: the lead's eye should land on the 96 first.
 *
 * The list of seats is the assignees actually present on the rows, not a directory
 * read: a member with nothing open and nothing closed this week has nothing to put
 * in the table, and inventing an empty row would be a second read for no number.
 */
function team(unresolved, resolved, me, now = Date.now()) {
  const open = Array.isArray(unresolved) ? unresolved : null
  const done = Array.isArray(resolved) ? resolved : null
  const who = meOf(me)
  if (open === null && done === null) {
    return { rows: [], seats: null, seatTotal: null, unassigned: null, issues: null }
  }

  const seats = new Map()
  const seat = (login) => {
    if (!seats.has(login)) {
      seats.set(login, {
        login,
        name: login === who.login ? who.name : '',
        monogram: monogram(login),
        open: 0,
        inProgress: 0,
        discussed: 0,
        stalled: 0,
        oldestMs: 0,
        done7: 0,
      })
    }
    return seats.get(login)
  }

  for (const row of open || []) {
    for (const login of assigneesOf(row)) {
      const entry = seat(login)
      entry.open += 1
      if (word(row.state) === 'in progress') entry.inProgress += 1
      if (word(row.state) === 'to be discussed') entry.discussed += 1
      const updated = stamp(row.updatedAt)
      if (updated !== null && updated < now - N7) entry.stalled += 1
      const created = stamp(row.createdAt)
      if (created !== null) entry.oldestMs = Math.max(entry.oldestMs, now - created)
    }
  }
  for (const row of done || []) {
    const at = stamp(row.resolvedAt)
    if (at === null || at < now - N7) continue
    for (const login of assigneesOf(row)) seat(login).done7 += 1
  }

  const rows = [...seats.values()]
    .filter((entry) => entry.open > 0 || entry.done7 > 0)
    .sort(
      (a, b) =>
        b.open - a.open ||
        b.stalled - a.stalled ||
        b.oldestMs - a.oldestMs ||
        a.login.localeCompare(b.login),
    )
    .map((entry) => ({
      login: entry.login,
      name: entry.name,
      monogram: entry.monogram,
      open: entry.open,
      inProgress: entry.inProgress,
      discussed: entry.discussed,
      stalled: entry.stalled,
      oldestDays: Math.floor(entry.oldestMs / DAY),
      done7: entry.done7,
    }))

  /* The share bar is the row's own signal and the number beside it is the truth, so
     a zero-open seat draws no bar rather than a minimum sliver. The scale is the
     largest row, not the seat total — a bar per total turns six rows into six
     hairlines. */
  const largest = rows.reduce((max, entry) => Math.max(max, entry.open), 0)
  for (const entry of rows) entry.share = largest ? entry.open / largest : 0

  return {
    rows,
    seats: open === null ? null : rows.length,
    seatTotal: open === null ? null : rows.reduce((sum, entry) => sum + entry.open, 0),
    unassigned: open === null ? null : open.filter((row) => assigneesOf(row).length === 0).length,
    issues: open === null ? null : open.length,
  }
}

/** Seven UTC days ending today, oldest first. UTC because every stamp the tool sends
 *  is UTC — a local-day bucket would move a row across the chart by a day for every
 *  viewer west of the tracker. */
function flowDays(now, count) {
  const out = []
  for (let back = count - 1; back >= 0; back -= 1) {
    const day = new Date(now - back * DAY).toISOString().slice(0, 10)
    out.push({
      day,
      label: day.slice(5),
      /* The same day in words, for the cadence chart One draws: `Wed 25`. */
      wd: WEEKDAY_DAY.format(new Date(`${day}T00:00:00Z`)),
      created: 0,
      resolved: 0,
    })
  }
  return out
}

/** Midnight UTC, the boundary every "last 7 days" figure is measured from. A
 *  rolling `now - 7 * DAY` would drop most of today from every window for anyone
 *  opening the page before the clock catches up with the last read. */
const startOfDay = (ms) => Math.floor(ms / DAY) * DAY

/** The first of the calendar month, in UTC — the month the KPI names. */
function startOfMonth(ms) {
  const date = new Date(ms)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10)

/** `State` is the only field that decides "open"; `#Unresolved` also carries In
 *  Progress, Review and everything else the tracker has not closed. */
const isOpenIssue = (row) => word(row.state) === 'open'

/** The resolved stamp of a row, or `null` when the row has none. */
const resolvedAt = (row) => stamp(row.resolvedAt)

/** One `CountRow`, the shape One's three breakdown cards share: a count and its
 *  share of the queue, rounded the way a reader reads it (`12%`, not `11.5%`). */
function countRows(counts, total, order = []) {
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count, pct: total ? Math.round((count / total) * 100) : 0 }))
    .sort((a, b) => {
      const ai = order.indexOf(a.label)
      const bi = order.indexOf(b.label)
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
      return b.count - a.count || a.label.localeCompare(b.label)
    })
}

/** The label a `Map` of counts is built from, with the fallback One prints so a
 *  field the tracker left empty is named rather than dropped. */
function countBy(rows, pick) {
  const counts = new Map()
  for (const row of rows) {
    const key = pick(row)
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return counts
}

/** An issue as One's two tables print it: the id, the title, the project, the date
 *  that matters for the table, and the three fields a reader scans. `date` is
 *  already formatted, because two tables formatting one stamp two ways is the bug
 *  this module exists to prevent. */
function issueOf(row, kind, base) {
  const at = kind === 'shipped' ? resolvedAt(row) : stamp(row.createdAt)
  const project = String(row.project || '').trim()
  const id = String(row.id || '')
  return {
    id,
    summary: String(row.summary || ''),
    project: project || '—',
    date: at === null ? '—' : DATE_FULL.format(new Date(at)),
    iso: at === null ? '' : isoDay(at),
    /* The row's own link when the read carried one, else built from the base: an
       issue id is the one thing on this pane that is worth a click. */
    url: String(row.url || '') || (base && id ? `${base}/issue/${encodeURIComponent(id)}` : ''),
    projectUrl: base && project ? `${base}/issues?q=${encodeURIComponent(`project: ${project}`)}` : '',
    state: String(row.state || '').trim(),
    priority: String(row.priority || '').trim(),
    type: String(row.type || '').trim(),
    kind,
  }
}

/** Every number One's page adds to Entity's, derived once and printed by the pane. */
const SPRINT_ITEM_LIMIT = 8

/**
 * The sprint card's own data, and the four ways it can have none.
 *
 * `sprint` is read by the main process (board membership, not a custom field) and
 * arrives already counted; what is derived here is the arithmetic the card prints —
 * the two percentages, the date range and the list of unfinished work — so the
 * percentage and the bar under it cannot disagree.
 */
function sprintOf(read, base) {
  const raw = read && typeof read.sprint === 'object' ? read.sprint : null
  const board = String(read?.sprintState?.board || raw?.board || '')
  const state = {
    kind: String(read?.sprintState?.kind || (raw ? 'ok' : 'unreadable')),
    board,
    detail: String(read?.sprintState?.detail || ''),
  }
  const boardUrl = base && board ? `${base}/agiles/${board}/current` : ''
  if (!raw) return { sprint: null, sprintState: { ...state, boardUrl }, boardUrl }

  const total = Number(raw.total) || 0
  const done = Number(raw.done) || 0
  const related = Number(raw.related) || 0
  const relatedDone = Number(raw.relatedDone) || 0
  const items = Array.isArray(raw.items) ? raw.items : []
  /* Only unfinished work is listed: a resolved item needs no progress bar, and the
     board is one click away for the verified ones. */
  const openItems = items.filter((item) => !item?.resolved)

  return {
    sprintState: { ...state, boardUrl },
    boardUrl,
    sprint: {
      id: String(raw.id || ''),
      name: String(raw.name || 'Current sprint'),
      start: Number(raw.start) || null,
      finish: Number(raw.finish) || null,
      total,
      done,
      inProgress: Number(raw.inProgress) || 0,
      open: Number(raw.open) || 0,
      progress: total ? Math.round((done / total) * 100) : 0,
      related,
      relatedDone,
      relatedProgress: related ? Math.round((relatedDone / related) * 100) : 0,
      /* One segment per bucket, as whole percentages, so a bar's three widths and
         the three counts beside it are one derivation. */
      segments: total
        ? [
            { key: 'done', label: 'Resolved', count: done, width: (done / total) * 100 },
            { key: 'progress', label: 'In progress', count: Number(raw.inProgress) || 0, width: ((Number(raw.inProgress) || 0) / total) * 100 },
            { key: 'open', label: 'Open', count: Number(raw.open) || 0, width: ((Number(raw.open) || 0) / total) * 100 },
          ]
        : [],
      dates: `${raw.start ? DATE_SHORT.format(new Date(Number(raw.start))) : '…'} → ${raw.finish ? DATE_SHORT.format(new Date(Number(raw.finish))) : 'open'}`,
      items,
      openItems,
      shown: openItems.slice(0, SPRINT_ITEM_LIMIT),
      hidden: Math.max(0, openItems.length - SPRINT_ITEM_LIMIT),
    },
  }
}

/**
 * Created and resolved per day, on one shared peak so the two bars in a column are
 * readable against each other and against every other column.
 *
 * Created work comes from *both* reads: an issue opened and closed inside the window
 * is only in read 2, and a chart drawn from read 1 alone would show it as never
 * opened. Resolved comes from read 2 alone, because read 1 holds only what is still
 * open.
 */
function flow(unresolved, resolved, me, now = Date.now(), count = 7) {
  const days = flowDays(now, count)
  const index = new Map(days.map((entry) => [entry.day, entry]))
  const bucket = (value) => {
    const at = stamp(value)
    return at === null ? null : index.get(new Date(at).toISOString().slice(0, 10)) || null
  }

  for (const row of Array.isArray(unresolved) ? unresolved : []) {
    const at = stamp(row.createdAt)
    if (at === null || at < now - (count - 1) * DAY) continue
    const entry = bucket(row.createdAt)
    if (entry) entry.created += 1
  }
  for (const row of Array.isArray(resolved) ? resolved : []) {
    const createdAt = stamp(row.createdAt)
    if (createdAt !== null && createdAt >= now - (count - 1) * DAY) {
      const entry = bucket(row.createdAt)
      if (entry) entry.created += 1
    }
    const resolvedAt = stamp(row.resolvedAt)
    if (resolvedAt !== null && resolvedAt >= now - (count - 1) * DAY) {
      const entry = bucket(row.resolvedAt)
      if (entry) entry.resolved += 1
    }
  }

  const peak = days.reduce((max, entry) => Math.max(max, entry.created, entry.resolved), 0)
  return days.map((entry) => ({
    ...entry,
    createdH: peak ? entry.created / peak : 0,
    resolvedH: peak ? entry.resolved / peak : 0,
  }))
}

/**
 * Top projects by unresolved count, each bar relative to the largest row so the tail
 * stays legible — a bar per total turns every project into a hairline on a tracker
 * where one project dominates.
 */
function backlog(unresolved, top = 7) {
  if (!Array.isArray(unresolved)) {
    return { rows: [], total: null, rest: null, largest: null, empty: null }
  }
  const counts = new Map()
  for (const row of unresolved) {
    const key = String(row.project || '').trim() || 'no project'
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  const all = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const largest = all.length ? all[0][1] : 0
  const rows = all.slice(0, top).map(([project, count]) => ({
    project,
    count,
    width: largest ? count / largest : 0,
  }))
  return {
    rows,
    largest,
    /* Named, not silently dropped: the foot says how many issues the top seven of
       `total` projects leave out. */
    total: all.length,
    rest: all.slice(top).reduce((sum, [, count]) => sum + count, 0),
    empty: all.length === 0 ? 0 : null,
  }
}

/**
 * The whole tab, in one call.
 *
 * `read` is a `youtrack.dashboard` reply; `now` is injectable so a test can pin the
 * clock. Nothing here throws on a missing read: `state` already says whether the tab
 * may open, and a partial read is a normal answer, not an error.
 *
 * Two clocks, two labels. `meta.month` and the `Resolved · <Mon>` KPI are the
 * calendar month; every `30 d` tile is the rolling window One calls `totals.month`.
 * They disagree on the 1st, and that is the point of naming both.
 */
function report(read = {}, now = Date.now()) {
  const unresolved = Array.isArray(read.unresolved) ? read.unresolved : null
  const resolved = Array.isArray(read.resolved) ? read.resolved : null
  /* The origin, without a trailing slash: every link on the pane is built on it. */
  const base = String(read.base || '').replace(/\/+$/, '')
  const me = meOf(read.me)
  const bands = tiles(unresolved, resolved, me, now)
  const flowRows = flow(unresolved, resolved, me, now)
  const seats = team(unresolved, resolved, me, now)
  const projects = backlog(unresolved)

  /* ── the windows, floored to a UTC midnight, then the three resolved sets ──
     One query answers all three: the resolved read already covers 30 days, which is
     the widest window on the page, so the month and the week are slices of it. */
  const weekStart = startOfDay(now - 6 * DAY)
  const monthStart = startOfMonth(now)
  const thirtyStart = startOfDay(now - 29 * DAY)
  const done = resolved || []
  const weekResolved = done.filter((row) => {
    const at = resolvedAt(row)
    return at !== null && at >= weekStart
  })
  const monthResolved = done.filter((row) => {
    const at = resolvedAt(row)
    return at !== null && at >= monthStart
  })
  const open = unresolved || []
  /* The rolling 30-day window, floored to a UTC midnight so it starts where the read
     started rather than 30 × 24 h before the moment this page was opened. */
  const done30 = resolved === null
    ? null
    : done.filter((row) => {
        const at = resolvedAt(row)
        return at !== null && at >= thirtyStart
      }).length

  /* `State: Open` only — `#Unresolved` also carries In Progress and everything else
     the tracker has not closed, which is why these two numbers differ by ~5x. */
  const openOnly = open.filter(isOpenIssue)
  const inProgress = open.filter((row) => word(row.state).includes('progress'))
  const oldestInProgress = [...inProgress].sort(
    (a, b) => (stamp(a.createdAt) || 0) - (stamp(b.createdAt) || 0),
  )[0]

  /* By project, over the calendar month — the KPI's hint and nothing else. Its own
     list, not the backlog's: what closed and what is stuck are different questions.*/
  const monthProjects = countRows(
    countBy(monthResolved, (row) => String(row.project || '').trim() || '—'),
    monthResolved.length,
  )

  /* The busiest day in the window, then the sentence that describes it. A day with
     three resolutions is a batch; a week of ones and twos is not, and saying so
     would be the sort of highlight that stops being read. */
  const byDay = new Map()
  for (const row of weekResolved) {
    const key = isoDay(resolvedAt(row))
    byDay.set(key, [...(byDay.get(key) || []), row])
  }
  const busiest = [...byDay.entries()].sort((a, b) => b[1].length - a[1].length)[0]
  const highlight = busiest && busiest[1].length >= 3
    ? {
        title: 'Largest batch',
        body: `${busiest[1].length} issues resolved on ${DATE_FULL.format(new Date(`${busiest[0]}T00:00:00Z`))}: ${busiest[1]
          .map((row) => row.id)
          .slice(0, 6)
          .join(', ')}${busiest[1].length > 6 ? ` +${busiest[1].length - 6} more` : ''}.`,
      }
    : weekResolved.length
      ? {
          title: 'Resolved this week',
          body: `${weekResolved.length} issues across ${monthProjects.length || 'several'} projects.`,
        }
      : null

  const summaryParts = resolved === null
    ? []
    : [
        `${monthResolved.length} issues resolved in ${MONTH_LONG.format(new Date(monthStart))}, ${weekResolved.length} of them in the last seven days.`,
      ]
  if (busiest && busiest[1].length > 1) {
    summaryParts.push(
      `The busiest day was ${DATE_FULL.format(new Date(`${busiest[0]}T00:00:00Z`))} with ${busiest[1].length} resolutions.`,
    )
  }

  const shipped = [...weekResolved]
    .sort((a, b) => (resolvedAt(b) || 0) - (resolvedAt(a) || 0))
    .map((row) => issueOf(row, 'shipped', base))
  const openIssues = [...open]
    .sort((a, b) => (stamp(b.createdAt) || 0) - (stamp(a.createdAt) || 0))
    .map((row) => issueOf(row, 'backlog', base))

  /* Two kinds of stuck, one list: work the tracker calls Fixed but nobody verified,
     and work nobody has touched in a quarter. Oldest first — the one that has waited
     longest is the one to look at. */
  const stale = [...open]
    .filter((row) => {
      const state = word(row.state) || 'open'
      const created = stamp(row.createdAt)
      return state === 'fixed' || (created !== null && now - created > 90 * DAY)
    })
    .sort((a, b) => (stamp(a.createdAt) || 0) - (stamp(b.createdAt) || 0))
    .map((row) => issueOf(row, 'backlog', base))

  const sprintAnswer = sprintOf(read, base)
  const board = sprintAnswer.boardUrl

  const meta = {
    period: `${DATE_SHORT.format(new Date(weekStart))} – ${DATE_FULL.format(new Date(now))}`,
    month: `${MONTH_LONG.format(new Date(monthStart))} ${new Date(monthStart).getUTCFullYear()}`,
    /* The host the rows came from, never the token: `https://host` with the scheme
       off, which is what a reader recognises and what the links below are built on. */
    source: String(read.base || read.host || 'YouTrack').replace(/^https?:\/\//, ''),
    generated: STAMP_FULL.format(new Date(stamp(read.readAt) ?? now)),
    /* The reads behind every number here are unfiltered — no `assignee:` clause —
       so the scope is the whole instance whatever band the chips are showing. */
    scope: String(read.scope || 'whole instance'),
  }

  /* A tile is a `null` when the read behind it did not answer, so the pane can print
     a dash instead of a confident zero — the same rule as every other number here. */
  const kpis = [
    {
      label: 'Resolved · last 7d',
      value: resolved === null ? null : weekResolved.length,
      hint: resolved === null ? 'no read' : `${(weekResolved.length / 7).toFixed(1)} issues / day`,
    },
    {
      label: 'Backlog',
      value: unresolved === null ? null : open.length,
      hint:
        unresolved === null
          ? 'no read'
          : `${inProgress.length} in progress · ${openOnly.length} open`,
    },
    {
      label: 'In progress',
      value: unresolved === null ? null : inProgress.length,
      hint:
        unresolved === null
          ? 'no read'
          : oldestInProgress && stamp(oldestInProgress.createdAt) !== null
            ? `oldest: ${oldestInProgress.id}, since ${DATE_FULL.format(new Date(stamp(oldestInProgress.createdAt)))}`
            : oldestInProgress
              ? `oldest: ${oldestInProgress.id}`
              : 'none',
    },
    {
      label: `Resolved · ${MONTH_SHORT.format(new Date(monthStart))} ${new Date(now).getUTCFullYear()}`,
      value: resolved === null ? null : monthResolved.length,
      hint:
        resolved === null
          ? 'no read'
          : monthProjects.slice(0, 3).map((row) => `${row.label} ${row.count}`).join(' · ') ||
            'No resolutions yet',
    },
  ]

  const cadence = flowRows.map((entry) => ({ label: entry.wd, value: entry.resolved, day: entry.day }))
  /* The tallest bar, so seven counts share one scale. Derived here because a chart
     that scales itself in a template is a chart that can scale a week two ways. */
  const cadencePeak = cadence.reduce((max, bar) => Math.max(max, bar.value), 0)

  return {
    state: String(read.state || 'ok'),
    readAt: read.readAt || '',
    cached: Boolean(read.cached),
    cacheTtlMs: Number(read.cacheTtlMs) || 0,
    calls: Number(read.calls) || 0,
    window: read.window?.since ? read.window : windowOf(now),
    me,
    errors: Array.isArray(read.errors) ? read.errors : [],
    truncated: {
      unresolved: Boolean(read.truncated?.unresolved),
      resolved: Boolean(read.truncated?.resolved),
    },
    /* The one flag the pane needs to choose between "0 issues" and "no answer", and
       the one that turns "created 7 d" into a number that is merely low. */
    partial: unresolved === null || resolved === null,
    tiles: bands,
    team: seats,
    flow: {
      days: flowRows,
      peak: flowRows.reduce((max, entry) => Math.max(max, entry.created, entry.resolved), 0),
      created: flowRows.reduce((sum, entry) => sum + entry.created, 0),
      resolved: flowRows.reduce((sum, entry) => sum + entry.resolved, 0),
      empty: flowRows.every((entry) => entry.created === 0 && entry.resolved === 0),
    },
    backlog: projects,
    /* ── what One's page adds, derived here so the pane prints instead of computing ── */
    meta,
    /* The origin the rows came from, so a row can link back to the issue it names. */
    base,
    kpis,
    cadence,
    cadencePeak,
    sprint: sprintAnswer.sprint,
    sprintState: sprintAnswer.sprintState,
    queue: countRows(
      countBy(open, (row) => String(row.state || '').trim() || 'Open'),
      open.length,
      ['Open', 'In Progress', 'Fixed'],
    ),
    queueTypes: countRows(
      countBy(open, (row) => String(row.type || '').trim() || 'Other'),
      open.length,
    ),
    queuePriorities: countRows(
      countBy(open, (row) => String(row.priority || '').trim() || 'Other'),
      open.length,
    ),
    projects: monthProjects,
    board,
    shipped,
    open: openIssues,
    stale,
    highlight,
    summary: summaryParts.join(' ') || 'The resolved read did not answer, so there is no cadence to describe.',
    totals: {
      unresolved: unresolved === null ? null : unresolved.length,
      /* One calls the rolling 30-day count `month`; Entity's own tiles call it `30 d`.
         One derivation, two names, so neither reader has to re-add a window. */
      resolved30: done30,
      month: done30,
      resolved7: resolved === null ? null : weekResolved.length,
      week: resolved === null ? null : weekResolved.length,
      open: unresolved === null ? null : openOnly.length,
      backlog: unresolved === null ? null : open.length,
      inProgress: unresolved === null ? null : inProgress.length,
      seats: seats.seats,
      seatTotal: seats.seatTotal,
      unassigned: seats.unassigned,
      projects: projects.total,
      created7: flowRows.reduce((sum, entry) => sum + entry.created, 0),
    },
  }
}

export {
  DAY,
  N7,
  N30,
  num,
  pct,
  days,
  word,
  stamp,
  monogram,
  meOf,
  windowOf,
  tiles,
  team,
  flow,
  backlog,
  flowDays,
  isOpenIssue,
  SPRINT_ITEM_LIMIT,
}
export default report
