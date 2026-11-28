/**
 * Goal vocabulary, the four date rules, and the two derivations every page needs.
 *
 * This module is the renderer's only arithmetic over a goal: counts, the bar's
 * state, and the deterministic draft. Priority is the workspace's own four words
 * — the ones the YouTrack tab already prints (`report.js:34`) — so no `P0`…`P3`
 * dialect can appear, and a date is `12 Dec 2025` in `Intl` (a date library for
 * one format would be a dependency for nothing).
 */
const PRIORITY_WORDS = { critical: 'Critical', major: 'Major', normal: 'Normal', minor: 'Minor' }

/** How big a job is, in the same three steps everywhere (the chats' S/M/L). */
export const EFFORT_WORDS = { small: 'Small', medium: 'Medium', large: 'Large' }
export const EFFORT_WEIGHT = { small: 1, medium: 2, large: 3 }
export const effortWord = (value) => EFFORT_WORDS[String(value)] || ''
export const effortWeight = (value) => EFFORT_WEIGHT[String(value)] || 0

/** Worst first: the order a group is drawn in, and the tie-break in "next". */
export const PRIORITY_ORDER = ['critical', 'major', 'normal', 'minor']

/** Unknown or missing is `Normal`: the middle word, never a silent fifth one. */
export const priorityWord = (value) => PRIORITY_WORDS[String(value)] || PRIORITY_WORDS.normal

const PRINT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
const SHORT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })

/**
 * A stored day (`YYYY-MM-DD`) as local midnight. Parsed field by field, not with
 * `Date.parse`: that reads a bare date as UTC and prints the day before on every
 * machine west of Greenwich.
 */
function dayOf(value) {
  const text = String(value || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null
  const [year, month, date] = text.split('-').map(Number)
  const at = new Date(year, month - 1, date)
  if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== date) return null
  return at
}

/** `12 Dec 2025`; an em dash when there is no date — never an invented one. */
export function day(value) {
  const at = dayOf(value)
  return at ? PRINT.format(at) : '—'
}

/** `12 Dec`, for a row that already sits under its month. */
export function shortDay(value) {
  const at = dayOf(value)
  return at ? SHORT.format(at) : '—'
}

/** `December 2025`, for a month heading. */
export function month(value) {
  const at = dayOf(`${String(value || '')}-01`)
  return at ? new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(at) : '—'
}

const pad = (value) => String(value).padStart(2, '0')
const iso = (at) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`

/** The machine's own day, `YYYY-MM-DD`. */
export const today = () => iso(new Date())

/** Whole days from `from` to `to`; both are calendar days, so no DST drift. */
export function daysBetween(from, to) {
  const a = dayOf(from)
  const b = dayOf(to)
  if (!a || !b) return null
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}

/** Days from today until a stored day; negative once it has passed. */
export const daysTo = (value) => daysBetween(today(), value)

/** `3 days late` / `1 day late`, for a task or a goal. */
export function lateBy(value) {
  const left = daysTo(value)
  if (left === null || left >= 0) return ''
  const days = Math.abs(left)
  return `${days} ${days === 1 ? 'day' : 'days'} late`
}

/**
 * What a row counts: `done` of the **dated** tasks — the pair the bar prints — and
 * the three numbers the page states in words. An undated task cannot be ahead or
 * behind, so it is not in the fraction; `open` and `late` are about work, not dates.
 */
export function countsOf(goal) {
  const tasks = Array.isArray(goal?.tasks) ? goal.tasks : []
  const dated = tasks.filter((task) => task.date)
  return {
    done: dated.filter((task) => task.done).length,
    total: dated.length,
    open: tasks.filter((task) => !task.done).length,
    late: tasks.filter((task) => !task.done && task.date && daysTo(task.date) < 0).length,
    undated: tasks.filter((task) => !task.date).length,
    all: tasks.length,
  }
}

/** `done` · `overdue` · `soon` · `none` — the row's own state (§4.1). */
export function taskState(task) {
  if (task?.done) return 'done'
  if (!task?.date) return 'none'
  const left = daysTo(task.date)
  if (left < 0) return 'overdue'
  if (left <= 2) return 'soon'
  return ''
}

const STALE_MS = 24 * 60 * 60 * 1000

/**
 * The bar, derived from the **last read** and the deadline — never from today's
 * tick count.
 *
 * `percent` is `null` whenever the read is: that is the em dash, and it is the
 * only value an unread goal may print. A `missed` goal keeps `missed by N days`
 * even with no read, because the deadline is a date fact and not a figure (§8
 * rule 4). `state` and `pace` are the words §4.2 fixes.
 */
export function barOf(goal) {
  const counts = countsOf(goal)
  const read = goal?.read && typeof goal.read === 'object' ? goal.read : null
  const left = daysTo(goal?.deadline)
  const met = counts.total > 0 && counts.done >= counts.total
  const missed = left !== null && left < 0 && !met
  const stale =
    Boolean(goal?.readAt) && Date.now() - Date.parse(goal.readAt || '') > STALE_MS

  let state = 'unread'
  if (missed) state = 'missed'
  else if (read && read.total !== null) {
    if (met) state = 'met'
    else if (stale) state = 'stale'
    else if ((read.slip ?? 0) < 0) state = 'behind'
    else state = 'ahead'
  }

  const percent =
    read && read.total !== null ? Math.round((read.done / (read.total || 1)) * 100) : null

  let pace = 'not read yet · Refresh'
  if (state === 'missed') pace = `missed by ${Math.abs(left)} ${Math.abs(left) === 1 ? 'day' : 'days'}`
  else if (state === 'met') pace = 'met'
  else if (state === 'stale') pace = 'read a while ago · Refresh'
  else if (state === 'ahead') {
    const slip = read?.slip ?? 0
    pace = slip > 0 ? `${slip} ${slip === 1 ? 'day' : 'days'} ahead` : 'on pace'
  } else if (state === 'behind') {
    const slip = Math.abs(read?.slip ?? 0)
    pace = `${slip} ${slip === 1 ? 'day' : 'days'} behind`
  }

  return { counts, read, state, percent, pace, missed, met, left }
}

/** Where today sits between the goal's creation and its deadline, 0…100. */
export function paceOf(goal) {
  const start = String(goal?.createdAt || '').slice(0, 10) || today()
  const span = daysBetween(start, goal?.deadline)
  if (span === null || span <= 0) return 100
  const elapsed = daysBetween(start, today()) ?? 0
  return Math.min(100, Math.max(0, Math.round((elapsed / span) * 100)))
}

/** The index order: late first, then nearest deadline, and a met goal sinks. */
export function indexOrder(goals) {
  const weight = (goal) => {
    const bar = barOf(goal)
    if (bar.state === 'missed') return 0
    if (bar.met) return 2
    return 1
  }
  return [...goals].sort(
    (a, b) =>
      weight(a) - weight(b) ||
      String(a.deadline).localeCompare(String(b.deadline)) ||
      String(a.title).localeCompare(String(b.title)),
  )
}

/* ── the deterministic draft (§1 F3/F4) ─────────────────────────────────────
   ponytail: this is a local draft — one task per clause, no agent round-trip. The
   ceiling is reasoning: it cannot merge two clauses that describe one job, and its
   dates are an even spread instead of read from a tracker. The upgrade path is the
   harness call the mockup's `.skel` state is drawn for; the task objects and the
   merge rule below are already the shape that answer has to arrive in. */

/** How urgent a clause sounds, in the workspace's own words. */
function priorityOf(text) {
  if (/\bcritical\b|\bblocker\b|\bp0\b/i.test(text)) return 'critical'
  if (/\bmajor\b/i.test(text)) return 'major'
  if (/\bminor\b|\bnice to have\b/i.test(text)) return 'minor'
  return 'normal'
}

const clauseTitle = (clause) =>
  clause
    .replace(/^(and|then|also)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
    .replace(/^[a-z]/, (letter) => letter.toUpperCase())

const mergeKey = (title) => String(title || '').trim().toLowerCase()

/** A row id. `randomUUID` is the browser's; the fallback keeps a task usable on a
    page served from an origin Chromium does not treat as secure. */
const newId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

/**
 * Merge proposed tasks into the accepted list by title: the earlier date wins and
 * the accepted row keeps its id, so a retry — an agent's second answer or a local
 * re-draft — can never merge twice. Returns what merged so the banner can say so.
 */
export function mergeTasks(accepted, proposed) {
  const byTitle = new Map((accepted || []).map((task) => [mergeKey(task.title), task]))
  const merged = []
  const tasks = [...(accepted || [])]
  for (const task of proposed || []) {
    const existing = byTitle.get(mergeKey(task.title))
    if (!existing) {
      tasks.push(task)
      byTitle.set(mergeKey(task.title), task)
      continue
    }
    merged.push(existing.title)
    if (task.date && (!existing.date || task.date < existing.date)) existing.date = task.date
  }
  return { tasks, merged }
}

/**
 * The harness-free draft: one task per clause of the sentence, dated evenly
 * between today and the deadline. It is the "Write the tasks myself" exit, not
 * the plan — the planning step is `goals.draft`.
 */
export function draftFrom(sentence, deadline, accepted = []) {
  const clauses = String(sentence || '')
    .split(/[.;\n]+|,\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length > 2)
    .slice(0, 12)

  const span = Math.max(0, daysBetween(today(), deadline) ?? 0)
  const start = dayOf(today())
  const dateAt = (index) => {
    if (span <= 0) return deadline || ''
    const offset = Math.round(((index + 1) * span) / (clauses.length + 1))
    const at = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset)
    return iso(at)
  }

  const proposed = clauses.map((clause, index) => ({
    id: newId(),
    priority: priorityOf(clause),
    title: clauseTitle(clause),
    token: { kind: 'draft', label: 'from the sentence' },
    date: dateAt(index),
    done: false,
  }))

  return mergeTasks(accepted, proposed)
}

/** A new empty row in a group. The store refuses an empty title on save. */
export const blankTask = (priority) => ({
  id: newId(),
  priority,
  title: '',
  token: { kind: 'draft', label: '' },
  date: '',
  done: false,
  entity: '',
  effort: '',
})
