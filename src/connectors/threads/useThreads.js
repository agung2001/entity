import { reactive } from 'vue'
import { call } from '@/composables/localBridge'

/**
 * The Threads connector's own state, in the renderer.
 *
 * Two reads and nothing else: `connector.token.status` answers the gate (is a token
 * on this machine, and its last four characters), and `threads.dashboard` answers the
 * numbers. Both are main-process reads — **the token never reaches this file**, which
 * is why a page that is screenshotted or opened from disk cannot leak one.
 *
 * **Nothing here invents a number.** A missing token, a refused read and a window
 * with no posts all leave the figures as they were and set `problem`; the tab prints
 * that sentence instead of a row of zeroes, because `0 views` is a claim about a month
 * and "nothing was read" is not one.
 *
 * The window and `readAt` come back on the payload for the same reason the day does on
 * Fitbit's: "which 30 days" is arithmetic, and a second copy of it here would disagree
 * with the first.
 */
export const threads = reactive({
  /* the gate */
  configured: false,
  hint: '',
  loaded: false,
  /* the report */
  totals: { posts: 0, views: 0, likes: 0, replies: 0, reposts: 0 },
  rates: { likeRate: 0, replyRate: 0, repostRate: 0 },
  posts: [],
  window: { since: '', until: '' },
  readAt: '',
  reading: false,
  /* the sentence to print instead of numbers, or '' */
  problem: '',
})

/** The key half of the gate: whether a token is stored on this machine. */
export async function readState() {
  try {
    const answer = await call('connector.token.status', { connector: 'threads' })
    threads.configured = Boolean(answer?.configured)
    threads.hint = String(answer?.hint || '')
  } catch {
    threads.configured = false
    threads.hint = ''
  } finally {
    threads.loaded = true
  }
}

/**
 * One 30-day read for the tab.
 *
 * `force` is the Refresh button and the only thing that skips the main process's
 * ten-minute cache. A refusal arrives as an `Error` whose `message` is the sentence
 * the tab prints — the code behind it is `threads-no-token` or `threads-upstream`, and
 * the copy is the same either way, so it is kept as text rather than re-worded here.
 */
export async function readReport({ days = 30, force = false } = {}) {
  if (threads.reading) return
  threads.reading = true
  try {
    const answer = await call('threads.dashboard', { days, force })
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
    threads.window = {
      since: String(answer?.window?.since || ''),
      until: String(answer?.window?.until || ''),
    }
    threads.readAt = String(answer?.readAt || '')
    threads.problem = ''
  } catch (problem) {
    threads.readAt = ''
    threads.posts = []
    threads.problem = String(problem?.message || problem)
  } finally {
    threads.reading = false
  }
}
