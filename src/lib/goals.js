/**
 * The two pieces of goal vocabulary the renderer must not retype.
 *
 * Priority is the workspace's own four words — the ones the YouTrack tab already
 * prints (`report.js:34` `WORSE`) — so a chip here and a chip there never speak
 * two dialects, and `P0`…`P3` appear nowhere (§5). A date is `12 Dec 2025`, in
 * `Intl`, because a date library for one format would be a dependency.
 */
const PRIORITY_WORDS = {
  critical: 'Critical',
  major: 'Major',
  normal: 'Normal',
  minor: 'Minor',
}

/** Unknown or missing is `Normal`: the middle word, never a silent fifth one. */
export const priorityWord = (value) => PRIORITY_WORDS[String(value)] || PRIORITY_WORDS.normal

const PRINT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

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

/** `12 Dec 2025`; an em dash when the task has no date — never an invented one. */
export function day(value) {
  const at = dayOf(value)
  return at ? PRINT.format(at) : '—'
}

/** `December 2025`, for a month heading. */
export function month(value) {
  const at = dayOf(`${String(value || '')}-01`)
  return at ? new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(at) : '—'
}
