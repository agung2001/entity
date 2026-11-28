/**
 * A page's half-written work, per browser tab, with an expiry.
 *
 * `sessionStorage`, not `localStorage`: a draft belongs to the tab you are
 * working in, and a second window should not inherit a form somebody abandoned
 * there. It survives a reload and an in-app navigation — the point — and is gone
 * when the tab closes.
 *
 * Every entry carries its own `expiresAt`; a read past it removes the entry, and
 * `sweepDrafts()` drops the abandoned ones on mount so a long session cannot
 * accumulate them. The TTL is a day: long enough for "I went to look at
 * something", short enough that yesterday's half-form is not today's surprise.
 */
const PREFIX = 'entity.draft:'

export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000

function storage() {
  try {
    return window.sessionStorage
  } catch {
    /* a tab with storage denied still works, it just forgets */
    return null
  }
}

const at = (key) => `${PREFIX}${key}`

/** Write one draft. Returns false when the tab refuses (private mode, quota). */
export function saveDraft(key, value, ttl = DRAFT_TTL_MS) {
  const store = storage()
  if (!store) return false
  try {
    store.setItem(at(key), JSON.stringify({ savedAt: Date.now(), expiresAt: Date.now() + ttl, value }))
    return true
  } catch {
    /* attachment data can exceed the quota; the draft is best-effort by design */
    return false
  }
}

/** The draft and when it was saved, or null — an expired entry is removed. */
export function readDraft(key) {
  const store = storage()
  if (!store) return null
  try {
    const raw = store.getItem(at(key))
    if (!raw) return null
    const entry = JSON.parse(raw)
    if (!entry || typeof entry !== 'object' || !Number.isFinite(entry.savedAt)) return null
    if (!(Number(entry.expiresAt) > Date.now())) {
      store.removeItem(at(key))
      return null
    }
    return { value: entry.value, savedAt: entry.savedAt }
  } catch {
    return null
  }
}

export function clearDraft(key) {
  try {
    storage()?.removeItem(at(key))
  } catch {
    /* nothing was stored */
  }
}

/** Drop every expired draft this tab holds; call once when a draftable page opens. */
export function sweepDrafts() {
  const store = storage()
  if (!store) return
  for (let index = store.length - 1; index >= 0; index -= 1) {
    const key = store.key(index)
    if (key && key.startsWith(PREFIX)) readDraft(key.slice(PREFIX.length))
  }
}
