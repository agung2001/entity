import { reactive } from 'vue'
import { call } from '@/composables/localBridge'

/**
 * The YouTube Studio dashboard's read layer, in the renderer.
 *
 * Two calls, both answered by `electron/connectors/youtube-studio/dashboard.cjs`, and one
 * shared object because the tab strip and the tab body ask different halves of
 * the same question: the strip needs to know whether any account answers before
 * it can offer the Dashboard at all, and the body needs the numbers that account
 * produces. Two objects would let the strip say "locked" while the body was
 * reading — the bug `githubDashboard.js` already paid for.
 *
 * **Nothing here invents an account or a number.** No account is an empty roster,
 * a grant with no analytics scope is a `null` field (never a `0`), and a refused
 * token is a row carrying Google's own sentence. The page draws the state it was
 * handed.
 *
 * `call()` already unwraps the `{ ok, data }` envelope and throws on `{ ok:false }`,
 * so a failure arrives as an `Error` and lands in `state.error` verbatim.
 *
 * A read is served from the main process's day-long file cache unless `force` is
 * set, so opening the tab twice is one read and only Refresh reaches Google.
 */
export const studio = reactive({
  /* Who is signed in, and which channels each one owns. The strip reads only this
     much, so it is cheap enough to run on every visit. */
  rosterReadAt: '',
  accounts: [],
  /* What is being asked for. `days` is one of the three chips; `account` and
     `channel` are ids, empty meaning "the first one that answers". */
  picked: { account: '', channel: '', days: 28 },
  /* The dashboard's own answer. Everything below `readAt` is empty until
     something was read, which is what the body keys its skeleton off — never a
     spinner over numbers it does not have. */
  payload: null,
  readAt: '',
  cached: false,
  /* The main process's own TTL. The page prints this instead of hardcoding "24
     hours": a copy that drifted from the constant is a bug this repository has
     already paid for once. */
  cacheTtlMs: 0,
  loading: false,
  reading: false,
  loaded: false,
  error: '',
})

/** The channel rows, flattened, for a page that only wants to name them. */
export function studioChannels() {
  return studio.accounts.flatMap((account) =>
    (account.channels || []).map((channel) => ({
      ...channel,
      account: account.localpart,
      email: account.email,
    })),
  )
}

/** Whether any account on this machine can answer at all — the tab's gate. */
export function studioUsable() {
  return studio.accounts.some((account) => (account.channels || []).length > 0)
}

function adoptRoster(answer) {
  studio.accounts = Array.isArray(answer?.accounts) ? answer.accounts : []
  studio.rosterReadAt = String(answer?.readAt || '')
  /* A pick that no longer exists (signed out, a channel moved to another login)
     must not pin the page to a dead id: fall back to whatever answers first. */
  const channels = studioChannels()
  if (!channels.some((channel) => channel.id === studio.picked.channel)) {
    studio.picked.channel = channels[0]?.id || ''
    studio.picked.account = channels[0]?.account || ''
  }
}

/**
 * Who is signed in.
 *
 * Runs on the page whether or not the Dashboard is open, because the tab strip
 * needs the answer to decide whether it may offer the tab. Never throws: a broken
 * store is an empty roster and an error string, which is a locked tab and a
 * sentence, not a blank page.
 */
export async function readRoster() {
  try {
    adoptRoster(await call('youtube.roster'))
    studio.error = ''
  } catch (problem) {
    studio.accounts = []
    studio.error = String(problem?.message || problem)
  }
  studio.loaded = true
  return studio.accounts
}

/**
 * The numbers.
 *
 * `force` is the Refresh button; without it the main process serves the answer it
 * stored within the last day and says so (`cached`). A read in flight is not
 * restarted — pressing Refresh twice must not double the spend.
 */
export async function readDashboard({ force = false } = {}) {
  if (studio.reading) return
  studio.reading = true
  if (!studio.readAt) studio.loading = true
  try {
    const answer = await call('youtube.dashboard', {
      account: studio.picked.account,
      channel: studio.picked.channel,
      days: studio.picked.days,
      force,
    })
    studio.payload = answer || null
    studio.readAt = String(answer?.readAt || '')
    studio.cached = answer?.cached === true
    studio.cacheTtlMs = Number(answer?.cacheTtlMs || 0)
    /* The main process resolved the channel this account leads with; adopting it
       keeps the chip row honest about which one the numbers came from. */
    if (answer?.channel?.id) studio.picked.channel = String(answer.channel.id)
    studio.error = ''
  } catch (problem) {
    studio.error = String(problem?.message || problem)
  } finally {
    studio.reading = false
    studio.loading = false
  }
}

/** One chip: another account, another channel, another window. The next read
    picks the change up; nothing is fetched here, so a chip is never a request. */
export function pick({ account, channel, days } = {}) {
  if (account !== undefined) studio.picked.account = String(account || '')
  if (channel !== undefined) studio.picked.channel = String(channel || '')
  if (days !== undefined) {
    const span = Math.round(Number(days))
    if (Number.isFinite(span) && span > 0) studio.picked.days = span
  }
}

/** Forget what this renderer knows — a sign-in happened elsewhere, so the numbers
    belong to whoever answers next. */
export function resetStudio() {
  studio.payload = null
  studio.readAt = ''
  studio.cached = false
  studio.loaded = false
  studio.reading = false
  studio.loading = false
}
