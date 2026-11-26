import { reactive } from 'vue'
import { call } from '@/composables/localBridge'

/**
 * Google Calendar's read layer, in the renderer.
 *
 * Two calls, answered by `electron/connectors/google-calendar/dashboard.cjs`, and one shared object so
 * the tab strip and the tab body cannot disagree: the strip needs to know whether a
 * connected account can read events before it can offer the Dashboard, and the body
 * needs the week that grant produces.
 *
 * **Nothing here invents an account.** No account is an empty list, a refused grant
 * is a row with the reason on it, and a scope that cannot read events is `scopes`
 * without `calendar.readonly` — three facts, three states, and the page draws the
 * one it was handed rather than a zero. `0` means a read succeeded.
 *
 * `call()` already unwraps the `{ ok, data }` envelope and throws on `{ ok:false }`,
 * so a failure arrives as an `Error` and lands in `state.error` verbatim.
 *
 * A read is served from the main process's ten-minute file cache unless `force` is
 * set, so opening the tab twice is one read, and only Refresh spends requests.
 */
export const SCOPE = 'calendar.readonly'

export const googleCalendar = reactive({
  /* The gate. `accounts` is the connector's own roster plus how many calendars each
     one answered on the last read — `null` for "nothing read yet", never `0`. */
  accounts: [],
  gateAt: '',
  apiOff: false,
  /* The dashboard's own answer. `readAt` is empty until something was read, which
     is what the tab keys its skeleton off — never a spinner over numbers it does
     not have. */
  window: { days: 7, since: '', until: '' },
  readAt: '',
  lanes: {},
  events: [],
  tiles: { today: null, week: null, hours: null, nextIn: null, needsReply: null, overlaps: null },
  gaps: [],
  /* The week's shape: one column per day of the window, the four figures One prints,
     the kind budget and the deterministic readings. `totals` is `null` until a read
     answered, and `days` is empty then too — never a week of zeroes. */
  days: [],
  totals: null,
  kinds: [],
  readings: [],
  wait: null,
  errors: [],
  limited: null,
  quota: null,
  refused: [],
  reads: 0,
  scopeMissing: false,
  cached: false,
  /* How long a stored answer stays good, as the main process reports it. The page
     prints this instead of hardcoding "10 minutes" — a copy that drifted from the
     constant was how the GitHub tab came to lie about its own cache. */
  cacheTtlMs: 0,
  loading: false,
  reading: false,
  loaded: false,
  error: '',
})

/** An account that can actually answer the tab: connected, with a token, and with
    the scope that reads events rather than only busy blocks. */
export const canRead = (entry) =>
  entry?.status === 'connected' &&
  entry?.hasToken === true &&
  (Array.isArray(entry?.scopes) ? entry.scopes : []).some(
    (scope) => scope === SCOPE || String(scope).endsWith(`/${SCOPE}`),
  )

function adoptGate(answer) {
  googleCalendar.accounts = Array.isArray(answer?.accounts) ? answer.accounts : []
  googleCalendar.gateAt = String(answer?.readAt || '')
  googleCalendar.apiOff = answer?.apiOff === true
}

/** Who is signed in, and which of them can read a week. Cheap — it answers from the
    account store and the last cache — and the only thing the tab strip needs. */
export async function readAccounts() {
  try {
    adoptGate(await call('calendar.accounts'))
    googleCalendar.error = ''
  } catch (problem) {
    googleCalendar.accounts = []
    googleCalendar.error = String(problem?.message || problem)
  }
  googleCalendar.loaded = true
  return googleCalendar.accounts
}

/**
 * The numbers.
 *
 * `force` is the Refresh button; without it the main process serves the answer it
 * stored within the last ten minutes and says so (`cached`), so opening the tab and
 * pressing Refresh are the only two ways this ever reaches Google.
 */
export async function readDashboard({ force = false } = {}) {
  if (googleCalendar.reading) return
  googleCalendar.reading = true
  if (!googleCalendar.readAt) googleCalendar.loading = true
  try {
    const answer = await call('calendar.dashboard', { force })
    googleCalendar.window = answer?.window || googleCalendar.window
    googleCalendar.readAt = String(answer?.readAt || '')
    googleCalendar.lanes = answer?.accounts || {}
    googleCalendar.events = Array.isArray(answer?.events) ? answer.events : []
    googleCalendar.tiles = answer?.tiles || googleCalendar.tiles
    googleCalendar.gaps = Array.isArray(answer?.gaps) ? answer.gaps : []
    googleCalendar.days = Array.isArray(answer?.days) ? answer.days : []
    googleCalendar.totals = answer?.totals || null
    googleCalendar.kinds = Array.isArray(answer?.kinds) ? answer.kinds : []
    googleCalendar.readings = Array.isArray(answer?.readings) ? answer.readings : []
    googleCalendar.wait = answer?.wait || null
    googleCalendar.errors = Array.isArray(answer?.errors) ? answer.errors : []
    googleCalendar.limited = answer?.limited || null
    googleCalendar.quota = answer?.quota || null
    googleCalendar.refused = Array.isArray(answer?.refused) ? answer.refused : []
    googleCalendar.reads = Number(answer?.reads || 0)
    googleCalendar.scopeMissing = answer?.scopeMissing === true
    googleCalendar.cached = answer?.cached === true
    googleCalendar.cacheTtlMs = Number(answer?.cacheTtlMs || 0)
    googleCalendar.error = ''
    /* The gate is answered again from the same read: the number of calendars per
       account only exists once something was read. */
    readAccounts().catch(() => {})
  } catch (problem) {
    googleCalendar.error = String(problem?.message || problem)
  } finally {
    googleCalendar.reading = false
    googleCalendar.loading = false
  }
}

/** Forget what is cached in this renderer — a sign-in happened elsewhere and the
    week belongs to whoever answered last. */
export function resetCalendar() {
  googleCalendar.readAt = ''
  googleCalendar.lanes = {}
  googleCalendar.events = []
  googleCalendar.gaps = []
  googleCalendar.days = []
  googleCalendar.totals = null
  googleCalendar.kinds = []
  googleCalendar.readings = []
  googleCalendar.wait = null
  googleCalendar.errors = []
  googleCalendar.limited = null
  googleCalendar.refused = []
  googleCalendar.loaded = false
}
