import { reactive } from 'vue'
import { call } from '@/composables/localBridge'
import { loadAccounts } from '@/stores/connectors'

/**
 * The Threads connector's own state, in the renderer.
 *
 * Two reads and nothing else: the account rows this machine holds (the same store
 * every account-bearing connector uses — `connector.accounts`), and one account's
 * 30-day report from `threads.dashboard`. **No token reaches this file**: the main
 * process mints one per read out of `oauth-secrets.cjs`, so a page that is
 * screenshotted or opened from disk cannot leak one.
 *
 * **Nothing here invents a number.** No account, a refused token and a window with no
 * posts each leave the figures as they were and set `problem`; the tab prints that
 * sentence instead of a row of zeroes, because `0 views` is a claim about a month and
 * "nothing was read" is not one.
 *
 * The window and `readAt` come back on the payload for the same reason the day does on
 * Fitbit's: "which 30 days" is arithmetic, and a second copy of it here would disagree
 * with the first.
 */
export const threads = reactive({
  /* the gate: one row per account, from the account store */
  accounts: [],
  loaded: false,
  /* the account on screen, by localpart — the mention's own word for it */
  account: '',
  /* the report */
  totals: { posts: 0, views: 0, likes: 0, replies: 0, reposts: 0 },
  rates: { likeRate: 0, replyRate: 0, repostRate: 0 },
  posts: [],
  /* one bucket per day in the window, zero-filled, from the main process */
  daily: [],
  window: { since: '', until: '' },
  readAt: '',
  reading: false,
  /* the sentence to print instead of numbers, or '' */
  problem: '',
})

/** The accounts a read may use: the connected ones, in the store's order. */
export function usableAccounts() {
  return (Array.isArray(threads.accounts) ? threads.accounts : []).filter(
    (entry) => entry.status === 'connected',
  )
}

/**
 * The account rows, and the one on screen.
 *
 * The selection is sticky until its row disappears: re-reading the state after a
 * remove must not leave the tab pointed at an account that is no longer here.
 */
export async function readState() {
  try {
    const rows = await loadAccounts('threads')
    threads.accounts = Array.isArray(rows) ? rows : []
  } catch {
    threads.accounts = []
  } finally {
    threads.loaded = true
    const usable = usableAccounts()
    if (!usable.some((entry) => entry.localpart === threads.account)) {
      threads.account = usable[0]?.localpart || ''
    }
  }
}

/**
 * One account's 30-day read.
 *
 * `force` is the Refresh button and the only thing that skips the main process's
 * ten-minute cache. A refusal arrives as an `Error` whose `message` is the sentence
 * the tab prints — the code behind it is `threads-upstream` — so it is kept as text
 * rather than re-worded here.
 */
export async function readReport({ account = threads.account, days = 30, force = false } = {}) {
  if (threads.reading) return
  if (!account) {
    threads.problem = 'No Threads account on this machine yet — add one on the connector page.'
    return
  }
  threads.reading = true
  try {
    const answer = await call('threads.dashboard', { account, days, force })
    threads.account = String(answer?.account || account)
    threads.totals = {
      posts: Number(answer?.totals?.posts) || 0,
      views: Number(answer?.totals?.views) || 0,
      likes: Number(answer?.totals?.likes) || 0,
      replies: Number(answer?.totals?.replies) || 0,
      reposts: Number(answer?.totals?.reposts) || 0,
    }
    threads.rates = {
      likeRate: Number(answer?.rates?.likeRate) || 0,
      replyRate: Number(answer?.rates?.replyRate) || 0,
      repostRate: Number(answer?.rates?.repostRate) || 0,
    }
    threads.posts = Array.isArray(answer?.posts) ? answer.posts : []
    threads.daily = Array.isArray(answer?.daily) ? answer.daily : []
    threads.window = {
      since: String(answer?.window?.since || ''),
      until: String(answer?.window?.until || ''),
    }
    threads.readAt = String(answer?.readAt || '')
    threads.problem = ''
  } catch (problem) {
    threads.readAt = ''
    threads.posts = []
    threads.daily = []
    threads.problem = String(problem?.message || problem)
  } finally {
    threads.reading = false
  }
}
