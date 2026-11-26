import { reactive } from 'vue'
import { call } from '@/composables/localBridge'

/**
 * The Habitify connector's read layer, in the renderer.
 *
 * Two calls, both answered by `electron/habitify-dashboard.cjs`, and one shared
 * object so the tab strip and the tab body cannot disagree: the strip needs to know
 * whether an account is signed in before it can offer the Dashboard, and the body
 * needs the day that account's grant can read.
 *
 * **Nothing here invents a number.** No account is an empty list with a `problem`
 * sentence, a grant missing a scope is `tiles: null` and one `errors` row, and a day
 * that answered with nothing scheduled is `rows: []` with no error at all. Three
 * facts, three states, and the page draws the one it was handed rather than a zero.
 *
 * `call()` already unwraps the `{ ok, data }` envelope and throws on `{ ok:false }`,
 * so a failure arrives as an `Error` and lands in `state.error` verbatim.
 *
 * A read is served from the main process's day-long file cache unless `force` is
 * set, so opening the tab twice is one read, and only Refresh spends a request.
 */
export const habitify = reactive({
  connector: 'habitify',
  accounts: [],
  /* The day on screen, and the week it sits in. `readAt` is empty until something
     was read, which is what the tab keys its skeleton off — never a spinner over
     numbers it does not have. */
  day: '',
  week: { start: '', end: '' },
  timezone: '',
  rows: [],
  tiles: null,
  /* `{ day, scheduled }` when the asked day was empty and the schedule resumes
     within the three days the main process probes; `null` when it does not, or when
     the probe could not answer. */
  next: null,
  readAt: '',
  /* `budget` and `limited` are answered `null` by the main process: Habitify's MCP
     server publishes no spending meter and throttles nothing this app can see, so
     the two strips it would fill stay quiet instead of being invented here. */
  budget: null,
  limited: null,
  reads: 0,
  cached: false,
  /* How long a stored answer stays good, as the main process reports it. The page
     prints this instead of hardcoding "a day" — a copy that drifted from the
     constant was the bug that made the GitHub cache look shorter than it is. */
  cacheTtlMs: 0,
  errors: [],
  problem: '',
  loading: false,
  reading: false,
  loaded: false,
  error: '',
})

/** The account the tab reads: the first one whose grant holds a token. */
export const account = () => habitify.accounts.find((entry) => entry.hasToken) || habitify.accounts[0] || null

/** Whether the strip may offer the Dashboard at all. */
export const connected = () => habitify.accounts.some((entry) => entry.hasToken)

function adopt(answer) {
  habitify.connector = String(answer?.connector || 'habitify')
  habitify.accounts = Array.isArray(answer?.accounts) ? answer.accounts : []
  habitify.problem = String(answer?.problem || '')
}

/** Which Habitify accounts this machine holds. Cheap — a file read — and the only
    answer the tab strip needs, so it runs on the page whether or not the tab is
    open. */
export async function readAccounts() {
  try {
    adopt(await call('habitify.accounts'))
    habitify.error = ''
  } catch (problem) {
    habitify.accounts = []
    habitify.error = String(problem?.message || problem)
  }
  habitify.loaded = true
  return habitify.accounts
}

/**
 * One day's habits, its week's tiles and whatever could not be read.
 *
 * `day` is a civil `YYYY-MM-DD`, and it is part of the request rather than something
 * the main process remembers: the address carries the day, so a reload, a bookmark
 * and the day-picker all ask for the same thing. `force` is the Refresh button;
 * without it the main process serves the answer it stored on disk for the last day
 * and says so (`cached`).
 */
export async function readDashboard({ day = '', force = false } = {}) {
  if (habitify.reading) return
  habitify.reading = true
  if (!habitify.readAt) habitify.loading = true
  try {
    const answer = await call('habitify.dashboard', { day, force })
    adopt(answer)
    habitify.day = String(answer?.day || '')
    habitify.week = answer?.week || habitify.week
    habitify.timezone = String(answer?.timezone || '')
    habitify.rows = Array.isArray(answer?.rows) ? answer.rows : []
    habitify.tiles = answer?.tiles || null
    habitify.next = answer?.next?.day ? answer.next : null
    habitify.readAt = String(answer?.readAt || '')
    habitify.budget = answer?.budget || null
    habitify.limited = answer?.limited || null
    habitify.reads = Number(answer?.reads || 0)
    habitify.cached = answer?.cached === true
    habitify.cacheTtlMs = Number(answer?.cacheTtlMs || 0)
    habitify.errors = Array.isArray(answer?.errors) ? answer.errors : []
    habitify.error = ''
  } catch (problem) {
    habitify.error = String(problem?.message || problem)
  } finally {
    habitify.reading = false
    habitify.loading = false
  }
}

/** Forget what is cached in this renderer — a sign-in happened elsewhere and the
    day belongs to whoever answered last. */
export function resetHabitify() {
  habitify.day = ''
  habitify.rows = []
  habitify.tiles = null
  habitify.next = null
  habitify.readAt = ''
  habitify.errors = []
  habitify.loaded = false
}
