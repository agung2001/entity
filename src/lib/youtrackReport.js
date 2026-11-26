/**
 * Every number on the YouTrack tab, derived from the two reads and nothing else.
 *
 * The main process hands back rows (`electron/youtrack-dashboard.cjs`); this module
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
    out.push({ day, label: day.slice(5), created: 0, resolved: 0 })
  }
  return out
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
 */
function report(read = {}, now = Date.now()) {
  const unresolved = Array.isArray(read.unresolved) ? read.unresolved : null
  const resolved = Array.isArray(read.resolved) ? read.resolved : null
  const me = meOf(read.me)
  const bands = tiles(unresolved, resolved, me, now)
  const flowRows = flow(unresolved, resolved, me, now)
  const seats = team(unresolved, resolved, me, now)
  const projects = backlog(unresolved)

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
    totals: {
      unresolved: unresolved === null ? null : unresolved.length,
      resolved30: resolved === null ? null : resolved.filter((row) => {
        const at = stamp(row.resolvedAt)
        return at !== null && at >= now - N30
      }).length,
      resolved7: resolved === null ? null : resolved.filter((row) => {
        const at = stamp(row.resolvedAt)
        return at !== null && at >= now - N7
      }).length,
      seats: seats.seats,
      seatTotal: seats.seatTotal,
      unassigned: seats.unassigned,
      projects: projects.total,
      created7: flowRows.reduce((sum, entry) => sum + entry.created, 0),
    },
  }
}

export { DAY, N7, N30, num, pct, days, word, stamp, monogram, meOf, windowOf, tiles, team, flow, backlog, flowDays }
export default report
