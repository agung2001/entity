import { reactive } from 'vue'
import { call } from '@/composables/localBridge'
import { hub } from '@/stores/hub'

/**
 * The Lynk.id connector's read layer.
 *
 * Four calls, all answered by `electron/connectors/lynk/dashboard.cjs`, and one shared object
 * so the tab strip, the Overview card and the Dashboard body cannot disagree
 * about whether there is a folder to read.
 *
 * **Nothing here invents a number.** A folder that cannot be listed is an error
 * with Google's own sentence; a folder with no paid order is `readAt` set and an
 * empty `products` — two facts, two states, and the table draws the one it was
 * handed rather than six zeroes.
 *
 * The window is not a call. `30 days / 90 days / 12 months / all` re-slice what
 * the main process already sent (`months`, and the products' own totals for the
 * window that was read), so a chip costs no request — which is why the cache holds
 * rows and the read is one request per folder, not one per chip.
 *
 * `readAt` is empty until something was read. The tab keys its skeleton off that,
 * never off a spinner drawn over numbers it does not have.
 */
export const lynk = reactive({
  /* the folder list the picker draws */
  folders: [],
  nextPageToken: '',
  foldersLoading: false,
  foldersError: '',
  /* the settings the report is read with, mirrored from the connector row */
  folderId: '',
  folderName: '',
  sheetSuffix: ' - Transactions',
  currency: 'IDR',
  timezone: 'Asia/Jakarta',
  /* the answer */
  window: { days: 90, since: '', until: '' },
  readAt: '',
  /* which folder the numbers on screen came from, and which folder the last
     attempt asked for: the two are what tell "stale" apart from "not yet" */
  readFolderId: '',
  triedFolderId: '',
  cached: false,
  reads: 0,
  cacheTtlMs: 0,
  totals: { revenue: 0, orders: 0, aov: 0, paid: 0 },
  products: [],
  months: [],
  buyers: { total: 0, twice: 0, active: 0, drifting: 0, lapsed: 0 },
  repeatPct: 0,
  sheets: { total: 0, withTab: 0, empty: 0, unreadable: 0 },
  readMs: 0,
  loading: false,
  reading: false,
  loaded: false,
  error: '',
  /* a refusal is not a bug: the grant died, and the page offers Reauthorize */
  refused: false,
  /* Google counting requests is also not a bug: nothing is wrong with the grant
     or the folder, so the page offers a minute and the same read again */
  throttled: false,
  /* `Reading 34 of 70`, from the main process while the folder is being opened */
  progress: { phase: '', total: 0, read: 0 },
  /* Test folder's own strip — four numbers and a clock */
  test: null,
  testing: false,
  testError: '',
})

const FALLBACK = { days: 90, since: '', until: '' }

/** A grant that died is the one failure a person fixes with Reauthorize. */
const REFUSAL = /refused|invalid_grant|sign-in|drive\.readonly|insufficient|\b403\b/i
/** Google's own per-minute limits: the read is fine, it was too fast. */
const THROTTLE = /quota|rate limit|\b429\b|resource_exhausted|too many requests/i

/* The read is one blocking call into the main process, so "thirty of seventy" has
   to be asked for rather than pushed. One poll per second while a read is in
   flight, and none at all otherwise. */
let progressTimer = 0

function startProgress() {
  if (progressTimer) return
  progressTimer = setInterval(() => {
    call('connector.lynkProgress')
      .then((answer) => {
        lynk.progress = answer || { phase: '', total: 0, read: 0 }
      })
      .catch(() => null)
  }, 900)
}

function stopProgress() {
  if (progressTimer) clearInterval(progressTimer)
  progressTimer = 0
  lynk.progress = { phase: '', total: 0, read: 0 }
}

function adopt(answer) {
  lynk.window = answer?.window || FALLBACK
  lynk.readAt = String(answer?.readAt || '')
  lynk.cached = answer?.cached === true
  lynk.reads = Number(answer?.reads || 0)
  lynk.cacheTtlMs = Number(answer?.cacheTtlMs || 0)
  lynk.totals = answer?.totals || { revenue: 0, orders: 0, aov: 0, paid: 0 }
  lynk.products = Array.isArray(answer?.products) ? answer.products : []
  lynk.months = Array.isArray(answer?.months) ? answer.months : []
  lynk.buyers = answer?.buyers || { total: 0, twice: 0, active: 0, drifting: 0, lapsed: 0 }
  lynk.repeatPct = Number(answer?.repeatPct || 0)
  lynk.sheets = answer?.sheets || { total: 0, withTab: 0, empty: 0, unreadable: 0 }
  lynk.readMs = Number(answer?.readMs || 0)
  lynk.readFolderId = String(answer?.folderId || '')
  lynk.triedFolderId = lynk.readFolderId
  if (answer?.suffix) lynk.sheetSuffix = String(answer.suffix)
}

/** Mirror the row's settings, so the page and the read agree about the folder. */
export function adoptLynkConfig(fields) {
  lynk.folderId = String(fields?.folderId || '')
  lynk.folderName = String(fields?.folderName || '')
  lynk.sheetSuffix = String(fields?.sheetSuffix || ' - Transactions')
  lynk.currency = String(fields?.currency || 'IDR')
  lynk.timezone = String(fields?.timezone || 'Asia/Jakarta')
  return lynk
}

/** Every Drive folder this grant can see. The picker's one read. */
export async function readFolders({ query = '', pageToken = '' } = {}) {
  lynk.foldersLoading = true
  try {
    const answer = await call('connector.lynkFolders', { workspace: hub.workspace, query, pageToken })
    const files = Array.isArray(answer?.files) ? answer.files : []
    lynk.folders = pageToken ? [...lynk.folders, ...files] : files
    lynk.nextPageToken = String(answer?.nextPageToken || '')
    lynk.foldersError = ''
  } catch (problem) {
    lynk.folders = []
    lynk.nextPageToken = ''
    lynk.foldersError = String(problem?.message || problem)
    lynk.refused = REFUSAL.test(lynk.foldersError)
  } finally {
    lynk.foldersLoading = false
  }
  return lynk.folders
}

/** `70 spreadsheets · 18 with a - Transactions tab · 320 rows · read in 4.2 s`. */
export async function testFolder() {
  lynk.testing = true
  lynk.testError = ''
  startProgress()
  try {
    lynk.test = await call('connector.lynkTestFolder', { workspace: hub.workspace, id: 'lynk' })
  } catch (problem) {
    lynk.test = null
    lynk.testError = String(problem?.message || problem)
  } finally {
    lynk.testing = false
    stopProgress()
  }
  return lynk.test
}

/**
 * The numbers.
 *
 * `force` is the `Re-read now` button; without it the main process serves the
 * answer it stored on disk for six hours and says so (`cached`), so opening the tab
 * twice is one read and only a button spends requests. `days` slices that answer —
 * it is passed through only so the first read can pick a sensible window.
 */
export async function readDashboard({ days = 90, force = false } = {}) {
  if (lynk.reading) return
  lynk.reading = true
  /* The old sentence belongs to the last attempt: a retry draws the skeleton and
     the progress line, not the error it is trying to replace. Numbers already on
     screen stay until they are replaced by the answer. */
  lynk.error = ''
  lynk.refused = false
  lynk.throttled = false
  if (!lynk.readAt) lynk.loading = true
  lynk.triedFolderId = lynk.folderId
  startProgress()
  try {
    adopt(await call('connector.lynkDashboard', { workspace: hub.workspace, id: 'lynk', days, force }))
    lynk.error = ''
    lynk.refused = false
    lynk.throttled = false
  } catch (problem) {
    const said = String(problem?.message || problem)
    lynk.error = said
    /* Three failures, three sentences: a dead grant, a rate limit, and everything
       else with Google's own words on it. */
    lynk.throttled = THROTTLE.test(said)
    lynk.refused = !lynk.throttled && REFUSAL.test(said)
  } finally {
    lynk.reading = false
    lynk.loading = false
    lynk.loaded = true
    stopProgress()
  }
}

/** Point the report at a folder: the settings write, then the cache is stale. */
export async function saveFolder(folder) {
  await call('connector.setFields', {
    workspace: hub.workspace,
    id: 'lynk',
    fields: { folderId: String(folder?.id || ''), folderName: String(folder?.name || '') },
  })
  lynk.folderId = String(folder?.id || '')
  lynk.folderName = String(folder?.name || '')
  dropLynkAnswer()
  lynk.test = null
  await call('connector.lynkForget').catch(() => null)
  return lynk.folderId
}

/** Forget the folder, so the tab locks and Overview offers a picker again. */
export async function forgetFolder() {
  return saveFolder({ id: '', name: '' })
}

/** Forget what this renderer holds — a sign-in happened, so the numbers belong
    to whoever answered last. */
export function resetLynk() {
  dropLynkAnswer()
  lynk.test = null
  lynk.loaded = false
}

/**
 * The folder changed under an answer, so the answer belongs to the previous
 * folder and must not be drawn under the new folder's name. Clearing it is what
 * turns "the numbers are somebody else's" into the skeleton plus a real read.
 */
export function dropLynkAnswer() {
  lynk.window = FALLBACK
  lynk.readAt = ''
  lynk.readFolderId = ''
  lynk.cached = false
  lynk.reads = 0
  lynk.readMs = 0
  lynk.totals = { revenue: 0, orders: 0, aov: 0, paid: 0 }
  lynk.products = []
  lynk.months = []
  lynk.buyers = { total: 0, twice: 0, active: 0, drifting: 0, lapsed: 0 }
  lynk.repeatPct = 0
  lynk.sheets = { total: 0, withTab: 0, empty: 0, unreadable: 0 }
  lynk.error = ''
  lynk.refused = false
  lynk.throttled = false
}
