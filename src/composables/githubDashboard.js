import { reactive } from 'vue'
import { call } from '@/composables/localBridge'

/**
 * The GitHub connector's read layer, in the renderer.
 *
 * Three calls, all answered by `electron/github-dashboard.cjs`, and one shared
 * object so the tab strip and the tab body cannot disagree: the strip needs to
 * know whether `gh` has a login before it can offer the Dashboard, and the body
 * needs the numbers that login produces.
 *
 * **Nothing here invents an account.** A missing binary is `binary.found: false`,
 * a missing login is an empty list, and a refused token is a row with the CLI's
 * own sentence on it — three facts, three states, and the page draws the one it
 * was handed rather than a zero.
 *
 * `call()` already unwraps the `{ ok, data }` envelope and throws on `{ ok:false }`,
 * so a failure arrives as an `Error` and lands in `state.error` verbatim.
 *
 * A read is served from the main process's day-long file cache unless `force` is
 * set, so opening the tab twice is one read, and only Refresh spends requests.
 */
export const github = reactive({
  binary: { found: false, path: '' },
  host: 'github.com',
  logins: [],
  problem: '',
  checkedAt: '',
  /* The dashboard's own answer. `readAt` is empty until something was read, which
     is what the tab keys its skeleton off — never a spinner over numbers it does
     not have. */
  window: { days: 90, since: '', until: '' },
  readAt: '',
  accounts: {},
  errors: [],
  budget: null,
  limited: null,
  reads: 0,
  cached: false,
  /* How long a stored answer stays good, as the main process reports it. The page
     prints this instead of hardcoding "15 minutes" — a copy that drifted from the
     constant was the bug that made the cache look shorter than it is. */
  cacheTtlMs: 0,
  loading: false,
  reading: false,
  loaded: false,
  error: '',
})

function adopt(answer) {
  github.binary = answer?.binary || { found: false, path: '' }
  github.host = answer?.host || 'github.com'
  github.logins = Array.isArray(answer?.logins) ? answer.logins : []
  github.problem = String(answer?.problem || '')
  github.checkedAt = String(answer?.checkedAt || '')
}

/** Who `gh` holds. Cheap — one `auth status` — and the only answer the tab strip
    needs, so it runs on the page whether or not the Dashboard is open. */
export async function readLogins() {
  try {
    adopt(await call('github.logins'))
    github.error = ''
  } catch (problem) {
    github.logins = []
    github.error = String(problem?.message || problem)
  }
  github.loaded = true
  return github.logins
}

/**
 * The numbers.
 *
 * `force` is the Refresh button; without it the main process serves the answer it
 * stored on disk within the last day and says so (`cached`), so opening the tab
 * and pressing Refresh are the only two ways this ever reaches GitHub.
 */
export async function readDashboard({ force = false } = {}) {
  if (github.reading) return
  github.reading = true
  if (!github.readAt) github.loading = true
  try {
    const answer = await call('github.dashboard', { force })
    adopt(answer)
    github.window = answer?.window || github.window
    github.readAt = String(answer?.readAt || '')
    github.accounts = answer?.accounts || {}
    github.errors = Array.isArray(answer?.errors) ? answer.errors : []
    github.budget = answer?.budget || null
    github.limited = answer?.limited || null
    github.reads = Number(answer?.reads || 0)
    github.cached = answer?.cached === true
    github.cacheTtlMs = Number(answer?.cacheTtlMs || 0)
    github.error = ''
  } catch (problem) {
    github.error = String(problem?.message || problem)
  } finally {
    github.reading = false
    github.loading = false
  }
}

/** The one write: make another login the active one, so the reads that follow use
    its token. The token itself is never touched. */
export async function makeActive(login) {
  const answer = await call('github.useActive', { login })
  if (Array.isArray(answer?.logins)) github.logins = answer.logins
  await readDashboard({ force: true })
  return answer
}

/** Forget what is cached in this renderer — a sign-in or a switch happened
    elsewhere and the numbers belong to whoever answered last. */
export function resetGithub() {
  github.readAt = ''
  github.accounts = {}
  github.errors = []
  github.budget = null
  github.limited = null
  github.loaded = false
}
