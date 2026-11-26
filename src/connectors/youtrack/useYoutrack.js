import { reactive } from 'vue'
import { call } from '@/composables/localBridge'
import { hub } from '@/stores/hub'

/**
 * The YouTrack connector's read layer, in the renderer.
 *
 * Two calls, both answered by `electron/connectors/youtrack/dashboard.cjs`, and one shared
 * object so the tab strip and the tab body cannot disagree: the strip needs to know
 * whether this workspace has a `youtrack` entry at all before it can offer the
 * Dashboard, and the body needs the rows that entry produces.
 *
 * **Nothing here invents a number.** A workspace with no entry is `missing`, a dead
 * token is `refused` with its code, a dropped connection is `offline` — three
 * facts, three states, and the pane draws the one it was handed rather than a zero.
 * The Authorization value never leaves the main process, so there is nothing here
 * that could print it.
 *
 * `call()` already unwraps the `{ ok, data }` envelope and throws on `{ ok:false }`,
 * so a failure arrives as an `Error` and lands in `state.error` verbatim.
 *
 * A read is served from the main process's five-minute memory cache unless `force`
 * is set, so opening the tab twice is one read, and only Refresh reaches the
 * tracker sooner.
 */
export const youtrack = reactive({
  /* Two states, because one field was answering two questions.

     `probeState` is what the *probe* answered: is there a server here, and does it
     accept this token. It is the only thing the tab strip locks on — the strip's
     question is "can this tab be opened at all", and a probe that said `ok` did
     open it.

     `state` is the sharper answer a *read* may hand back, `refused` on a token that
     died between the probe and the first page. That is the pane's fact to draw — a
     red panel over the numbers — and not a reason to hide a tab the person already
     chose. Locking on `state` bounced them to Overview and the panel never rendered.

     Empty until the probe lands — never `missing`, which is a real answer about a
     file nobody has read yet. */
  probeState: '',
  state: '',
  probed: false,
  host: '',
  file: '',
  headerPath: 'servers.youtrack.headers.Authorization',
  /* `status` is what the probe's own HTTP exchange answered; `readStatus` is the
     code the last read was refused with, and only that one belongs next to a
     refused panel. */
  status: 0,
  readStatus: 0,
  message: '',
  login: '',
  name: '',
  tools: 0,
  checkedAt: '',
  /* The dashboard's own answer. `readAt` is empty until something was read, which
     is what the tab keys its skeleton off — never a spinner over numbers it does
     not have. */
  window: { days: 30, since: '', until: '' },
  readAt: '',
  /* `null`, not `[]`, until a read answers: an empty array is the tracker saying
     "nothing", and a pane that printed a zero before the first read would be the
     confident zero this tab exists to avoid. */
  unresolved: null,
  resolved: null,
  errors: [],
  truncated: { unresolved: false, resolved: false },
  queries: { unresolved: '', resolved: '' },
  calls: 0,
  cached: false,
  cacheTtlMs: 0,
  loading: false,
  reading: false,
  loaded: false,
  error: '',
})

function adoptProbe(answer) {
  const state = String(answer?.state || 'offline')
  youtrack.probeState = state
  youtrack.state = state
  youtrack.host = String(answer?.host || '')
  youtrack.file = String(answer?.file || '')
  youtrack.headerPath = String(answer?.headerPath || 'servers.youtrack.headers.Authorization')
  youtrack.status = Number(answer?.status) || 0
  youtrack.message = String(answer?.message || '')
  youtrack.login = String(answer?.login || '')
  youtrack.name = String(answer?.name || '')
  youtrack.tools = Number(answer?.tools) || 0
  youtrack.checkedAt = String(answer?.checkedAt || '')
}

/**
 * Who the token belongs to, and whether there is a server to ask.
 *
 * One initialize plus one `tools/list`, and the only answer the tab strip needs, so
 * it runs on the page whether or not the Dashboard is open. `ok` here is what
 * unlocks the tab; it is not a promise that the reads below will succeed, which is
 * why the pane keeps a refused/offline panel of its own.
 */
export async function probe() {
  try {
    adoptProbe(await call('youtrack.probe', { workspace: hub.workspace }))
    youtrack.error = ''
  } catch (problem) {
    /* A thrown probe is a broken call table, not a tracker state. It still has to
       leave the strip locked rather than offer a tab nobody can fill. */
    youtrack.state = 'offline'
    youtrack.probeState = 'offline'
    youtrack.message = String(problem?.message || problem)
    youtrack.error = youtrack.message
  }
  youtrack.probed = true
  youtrack.loaded = true
  return youtrack.state
}

/**
 * The numbers.
 *
 * `force` is the Refresh button; without it the main process serves the answer it
 * read in the last five minutes and says so (`cached`), so opening the tab and
 * pressing Refresh are the only two ways this reaches the tracker.
 *
 * The reply is kept as the rows it came with, not as a summary: the shapes the page
 * prints are derived in `src/connectors/youtrack/report.js`, so every number on screen comes
 * from one place and a tile cannot disagree with the table under it.
 */
export async function readDashboard({ force = false } = {}) {
  if (youtrack.reading) return
  youtrack.reading = true
  if (!youtrack.readAt) youtrack.loading = true
  try {
    const answer = await call('youtrack.dashboard', { workspace: hub.workspace, force })
    /* A read can carry a state of its own (`refused` on a token that died between
       the probe and the first page), so the strip follows the sharper answer. */
    if (answer?.state && answer.state !== 'ok') youtrack.state = String(answer.state)
    else if (answer?.state === 'ok') youtrack.state = 'ok'
    youtrack.readStatus = Number(answer?.status) || 0
    youtrack.window = answer?.window || youtrack.window
    /* `readAt` is when rows were read, not when the call was made: a refused read
       stamps nothing, so the pane can still tell "no numbers yet" from "numbers from
       09:58". */
    if (answer?.state === 'ok') youtrack.readAt = String(answer?.readAt || '')
    if (answer?.file) youtrack.file = String(answer.file)
    if (answer?.headerPath) youtrack.headerPath = String(answer.headerPath)
    youtrack.unresolved = Array.isArray(answer?.unresolved) ? answer.unresolved : null
    youtrack.resolved = Array.isArray(answer?.resolved) ? answer.resolved : null
    youtrack.errors = Array.isArray(answer?.errors) ? answer.errors : []
    youtrack.truncated = {
      unresolved: answer?.truncated?.unresolved === true,
      resolved: answer?.truncated?.resolved === true,
    }
    youtrack.queries = answer?.queries || youtrack.queries
    youtrack.calls = Number(answer?.calls) || 0
    youtrack.cached = answer?.cached === true
    youtrack.cacheTtlMs = Number(answer?.cacheTtlMs) || 0
    if (answer?.me) {
      youtrack.login = String(answer.me.login || youtrack.login)
      youtrack.name = String(answer.me.name || youtrack.name)
    }
    if (answer?.message) youtrack.message = String(answer.message)
    youtrack.error = ''
  } catch (problem) {
    youtrack.error = String(problem?.message || problem)
  } finally {
    youtrack.reading = false
    youtrack.loading = false
  }
}
