/**
 * The three skills.sh boards, read once and kept.
 *
 * skills.sh is a Next.js app with no JSON API for its boards: the rows arrive as
 * a streamed `__next_f` payload split across many `<script>` tags, so a regex for
 * `"installs"` over the raw HTML finds nothing — the JSON is escaped inside a JS
 * string literal. Two parses, in this order, and both are cheap:
 *
 *   1. each `self.__next_f.push([1,"…"])` literal is decoded as a JSON string;
 *   2. the concatenation carries `"initialSkills":[ … ]`, which is plain JSON.
 *
 * The fetch itself is `skills.board` in the call table (`electron/rpc.cjs`),
 * because the site sends no CORS headers and a renderer cannot read it. The
 * allowlist, the timeout and the URL live there; only the parsing lives here.
 *
 * Four rules this module exists to enforce:
 *
 * - **One board per open.** All time carries lifetime installs, so it is the one
 *   read the tab needs; Trending and Hot are read only when that sub-tab is
 *   opened, and Hot is read once (it moves by single installs and is not worth a
 *   refresh). Three pages on first open was the cost the three tabs exist to
 *   avoid.
 * - **The last good read survives a cold start.** Every board is cached in
 *   `localStorage` with the moment it was read, so an offline window still has
 *   rows and their date — never an empty page.
 * - **A failure is a stamp, not a blank.** `error` carries the sentence, the
 *   cached rows stay on screen, and `retryAt` is the moment a retry is allowed.
 * - **Eight fields, all of them.** `installs`, `weeklyInstalls`, `isOfficial`,
 *   `installsYesterday` and `change` each answer a column or a badge; a reader
 *   that drops four of them (as the Rust struct does) cannot draw the boards.
 */
import { reactive } from 'vue'
import { call } from '@/composables/localBridge'

/** The three boards skills.sh publishes. Never a fourth invented name. */
export const BOARDS = [
  { id: 'all', label: 'All time' },
  { id: 'trending', label: 'Trending' },
  { id: 'hot', label: 'Hot' },
]

export const boardLabel = (id) => BOARDS.find((board) => board.id === id)?.label || id

/** Five minutes between a failed read and the next attempt, as the spec draws it. */
export const RETRY_MS = 5 * 60_000
const CACHE_KEY = 'entity.skillsh.v1'

export const boards = reactive({
  /** board id → rows, the last good read of that board */
  rows: {},
  /** board id → ISO moment that read arrived */
  readAt: {},
  /** skill name (lower case) → lifetime installs, from the All time board */
  lifetime: {},
  /** the moment the cache on disk was written */
  savedAt: '',
  /** the board whose fetch is in flight, if any */
  loading: '',
  /** the last failure, as a sentence a person can read */
  error: '',
  /** no fetch before this moment */
  retryAt: 0,
  /** true once the cache has been consulted, so "never read" is not "empty" */
  restored: false,
})

/* ── the cache ─────────────────────────────────────────────────────────────
   `localStorage` is the only place the renderer may persist without the call
   table, and this is a cache: losing it costs one read, so a failure to write is
   silent. */
function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function writeCache() {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        savedAt: boards.savedAt,
        rows: boards.rows,
        readAt: boards.readAt,
        lifetime: boards.lifetime,
      }),
    )
  } catch {
    /* a full or unavailable store costs a re-read, not the page */
  }
}

/** Consult the cache once, at import: a cold start shows rows without a fetch. */
function restore() {
  const cached = readCache()
  if (cached) {
    if (cached.savedAt) boards.savedAt = String(cached.savedAt)
    if (cached.rows && typeof cached.rows === 'object') boards.rows = cached.rows
    if (cached.readAt && typeof cached.readAt === 'object') boards.readAt = cached.readAt
    if (cached.lifetime && typeof cached.lifetime === 'object') boards.lifetime = cached.lifetime
  }
  boards.restored = true
}

restore()

/* ── the parse ───────────────────────────────────────────────────────────── */

/** The JSON string literal starting at `at`, escapes intact, or ''. */
function stringLiteralAt(text, at) {
  if (text[at] !== '"') return ''
  for (let i = at + 1; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1
      continue
    }
    if (text[i] === '"') return text.slice(at, i + 1)
  }
  return ''
}

/** Every streamed chunk, decoded and concatenated in document order. */
function decodeStream(html) {
  let out = ''
  for (const hit of html.matchAll(/self\.__next_f\.push\(\[1,/g)) {
    const literal = stringLiteralAt(html, hit.index + hit[0].length)
    if (!literal) continue
    try {
      out += JSON.parse(literal)
    } catch {
      /* a chunk this build does not understand is skipped, not fatal */
    }
  }
  return out
}

/** The index just past the bracket that closes the one at `start`. */
function matchBracket(text, start) {
  const open = text[start]
  const close = open === '[' ? ']' : '}'
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (char === '\\') i += 1
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/** One row with all eight fields, whether or not the board carries them. */
function normalize(row) {
  return {
    name: String(row?.name || row?.skillId || ''),
    source: String(row?.source || ''),
    skillId: String(row?.skillId || ''),
    installs: Number(row?.installs) || 0,
    weeklyInstalls: Array.isArray(row?.weeklyInstalls)
      ? row.weeklyInstalls.map((value) => Number(value) || 0)
      : [],
    isOfficial: row?.isOfficial === true,
    installsYesterday: Number(row?.installsYesterday) || 0,
    change: Number(row?.change) || 0,
  }
}

/**
 * The rows out of one board's HTML, or `null` when the payload is not there.
 *
 * `null` is the honest answer for markup that moved: the caller keeps its cache
 * and says the read failed, instead of painting an empty board that looks like a
 * site with no skills.
 */
export function parseBoard(html) {
  const text = decodeStream(String(html || ''))
  if (!text) return null
  const key = text.lastIndexOf('"initialSkills":')
  if (key < 0) return null
  const start = key + '"initialSkills":'.length
  const end = matchBracket(text, start)
  if (end < 0) return null
  let parsed
  try {
    parsed = JSON.parse(text.slice(start, end))
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || !parsed.length) return null
  return parsed.map(normalize).filter((row) => row.name)
}

/* ── the reads ───────────────────────────────────────────────────────────── */

/** The lifetime installs one board carries, by name. Only All time has them. */
function applyLifetime(rows) {
  const map = { ...boards.lifetime }
  for (const row of rows) map[row.name.toLowerCase()] = row.installs
  boards.lifetime = map
}

/**
 * Read one board, unless it is already here and fresh enough.
 *
 * Resolves to the board's rows (possibly the cached ones). It never throws: the
 * page draws `boards.error` next to the rows it still has.
 */
export async function loadBoard(id = 'all', { force = false } = {}) {
  const board = BOARDS.some((entry) => entry.id === id) ? id : 'all'
  const cached = boards.rows[board]
  if (!force) {
    if (cached?.length) return cached
    if (boards.loading) return boards.rows[board] || []
    if (boards.retryAt && Date.now() < boards.retryAt) return boards.rows[board] || []
  }

  boards.loading = board
  boards.error = ''
  try {
    const answer = await call('skills.board', { board })
    const rows = parseBoard(answer?.html)
    if (!rows) {
      throw new Error('skills.sh answered, but its rows were not in the page this build can read.')
    }
    boards.rows = { ...boards.rows, [board]: rows }
    boards.readAt = { ...boards.readAt, [board]: new Date().toISOString() }
    boards.savedAt = new Date().toISOString()
    boards.retryAt = 0
    if (board === 'all') applyLifetime(rows)
    writeCache()
    return rows
  } catch (problem) {
    boards.error = problem?.message || 'skills.sh could not be read.'
    boards.retryAt = Date.now() + RETRY_MS
    return boards.rows[board] || []
  } finally {
    boards.loading = ''
  }
}

/** `Nov 21, 14:52` — the same shape the app prints elsewhere, with the clock. */
export function readStamp(iso) {
  const when = new Date(String(iso || ''))
  if (!Number.isFinite(when.getTime())) return ''
  return when.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Whole minutes until a retry is allowed; 0 when one is allowed now. */
export function retryInMinutes() {
  if (!boards.retryAt) return 0
  const left = boards.retryAt - Date.now()
  return left > 0 ? Math.ceil(left / 60_000) : 0
}
