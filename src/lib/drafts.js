/**
 * Unsent text belongs to the thread it was typed in.
 *
 * The composer is one box for every conversation, so a draft lived exactly as
 * long as that conversation stayed open: switching away dropped it, and a long
 * prompt written at 2am died on a reload. A draft is per-thread state.
 *
 * Two rules shape the storage:
 *
 *   - it is **app state, not workspace content**. The renderer only writes files
 *     through the call table, so a draft never lands in the workspace, the
 *     transcript or the harness — it is this window's unsent text;
 *   - it must survive a reload but never cost a keystroke. Writes are debounced
 *     and the map is pruned, so a hundred abandoned drafts cannot turn into a
 *     write per keypress.
 *
 * Everything here is pure: a storage object goes in, a value comes out. That is
 * what makes the pruning and the debounce testable without a browser.
 */
export const KEY = 'entity.drafts'
/* A draft map that never shrinks is a slow leak; keep the most recent threads. */
export const MAX_DRAFTS = 60
/* Longer than any prompt worth keeping, small enough to stay clear of a quota. */
export const MAX_LENGTH = 20_000

/** Coerce to a string and cap it: a paste is not a reason to lose the draft. */
export function normaliseDraft(value) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text.length > MAX_LENGTH ? text.slice(0, MAX_LENGTH) : text
}

/** What is stored, defensively: a corrupt or foreign value is simply no drafts. */
export function readDrafts(storage) {
  const out = {}
  if (!storage) return out
  let raw = null
  try {
    raw = storage.getItem(KEY)
  } catch {
    return out
  }
  if (!raw) return out
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    return out
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out
  for (const [id, text] of Object.entries(parsed)) {
    const key = String(id || '').trim()
    if (!key) continue
    const value = normaliseDraft(text)
    /* whitespace-only is not a draft: it would show as an empty box anyway */
    if (value.trim()) out[key] = value
  }
  return out
}

/**
 * Keep the last `max` non-empty drafts. Insertion order is the only ordering a
 * JSON object has, and the book below re-inserts on every edit, so the last
 * keys are the most recently typed in.
 */
export function pruneDrafts(map, max = MAX_DRAFTS) {
  const entries = Object.entries(map || {}).filter(([, text]) => String(text || '').trim())
  return Object.fromEntries(entries.slice(-Math.max(1, max)))
}

export function saveDrafts(storage, map) {
  if (!storage) return
  const pruned = pruneDrafts(map)
  try {
    if (!Object.keys(pruned).length) storage.removeItem(KEY)
    else storage.setItem(KEY, JSON.stringify(pruned))
  } catch {
    /* a full or disabled storage costs a reload, never the app */
  }
}

/**
 * The persisted side of the drafts, with the write debounced.
 *
 * `schedule`/`cancel` are injected so a test can prove that ten keystrokes are
 * one write, which is the whole point of the class.
 */
export function createDraftBook({
  storage = null,
  delay = 400,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  let map = readDrafts(storage)
  let timer = null

  const flush = () => {
    if (timer !== null) {
      cancel(timer)
      timer = null
    }
    saveDrafts(storage, map)
  }

  const later = () => {
    if (timer !== null) return
    timer = schedule(() => {
      timer = null
      saveDrafts(storage, map)
    }, delay)
  }

  return {
    /** A copy: the reactive hub keeps its own, and comparison must be by value. */
    all: () => ({ ...map }),

    get(id) {
      const key = String(id || '')
      return key ? map[key] || '' : ''
    },

    /** Store one thread's draft; empty text forgets it (an empty box is not a draft). */
    set(id, text) {
      const key = String(id || '').trim()
      if (!key) return ''
      const value = normaliseDraft(text)
      /* delete first: re-inserting moves the key to the end, so pruning drops
         the thread nobody has touched, not the one being edited */
      delete map[key]
      if (value.trim()) map[key] = value
      later()
      return value
    },

    drop(id) {
      delete map[String(id || '').trim()]
      later()
    },

    flush,
  }
}
