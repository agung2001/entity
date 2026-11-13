/**
 * Markdown rendering without paying for the parser up front.
 *
 * `proseReady` flips once the engine chunk has arrived. `renderProse` is safe to
 * call before that: it returns escaped plain text and starts the fetch. Anything
 * rendering it in a computed or the template picks up the ready flag (it is read
 * inside the function), so the real HTML replaces the plain text as soon as the
 * chunk lands — no explicit re-render plumbing.
 */
import { ref } from 'vue'

export const proseReady = ref(false)

let engine = null
let pending = null

/** Fetch the parser chunk. Call it when a view that will need it mounts. */
export function loadProse() {
  if (engine) return Promise.resolve(engine)
  if (!pending) {
    pending = import('./prose-engine.js')
      .then((mod) => {
        engine = mod
        proseReady.value = true
        return mod
      })
      .catch((error) => {
        pending = null
        throw error
      })
  }
  return pending
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
const MAX_CACHED = 600
const cache = new Map()

/** The same contract as `prose-engine.render`, with a text-only stand-in until
    the chunk is here. A failed fetch leaves readable text rather than nothing. */
export function renderProse(text) {
  if (!engine) {
    loadProse().catch(() => {})
    return String(text || '')
      .replace(/[&<>]/g, (ch) => ESCAPES[ch])
      .replace(/\n/g, '<br>')
  }
  const key = String(text || '')
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const html = engine.render(key)
  /* One entry per distinct reply, shared by every message component: opening
     a thread a second time parses nothing. */
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value)
  cache.set(key, html)
  return html
}
