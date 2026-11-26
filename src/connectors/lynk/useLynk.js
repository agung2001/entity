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
 * **The window is not a call.** The chips re-slice what the main process already
 * sent — `days` (the whole folder's history, ascending), `months`, and each
 * product's own `series` — so a chip costs no request, which is why the cache
 * holds rows and the read is one request per folder, not one per chip.
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
  /* The marketplace document this workspace configured, mirrored from the row so
     `safeUrl()` can trust its host — and empty when there is none, which is why no
     domain is a constant in this file. */
  marketplaceUrl: '',
  currency: 'IDR',
  timezone: 'Asia/Jakarta',
  /* ── the answer ────────────────────────────────────────────────────────
     Every field below is the object `aggregate()` returns, field for field, so a
     component reads one shape and the store never renames a number. An empty
     default is `null`/`[]`, never a plausible zero: `revenue: 0` before a read
     would be a claim, and these are `—` until there is an answer. */
  window: { days: 0, since: '', until: '', firstDay: '', lastDay: '' },
  readAt: '',
  /* which folder the numbers on screen came from, and which folder the last
     attempt asked for: the two are what tell "stale" apart from "not yet" */
  readFolderId: '',
  triedFolderId: '',
  cached: false,
  reads: 0,
  cacheTtlMs: 0,
  readMs: 0,
  suffix: '',
  /* `{ pulled, reused }` from the read: how many workbooks came down this time and how
     many were already on this machine. `null` until something was read. */
  downloads: null,
  /* the whole folder, added up */
  totals: {
    revenue: 0,
    orders: 0,
    units: 0,
    aov: 0,
    fees: { affiliate: 0, notif: 0, convenience: 0 },
    vouchers: 0,
    sheets: 0,
    sheetsWithData: 0,
    paid: 0,
  },
  /* the same folder, paying buyers only: the denominator an AOV deserves */
  paid: {
    orders: 0,
    revenue: 0,
    aov: 0,
    buyers: 0,
    repeat: 0,
    repeatRate: 0,
    freeOrders: 0,
    voucheredOrders: 0,
    listMissing: 0,
  },
  /* `[{ day, revenue, orders }]`, ascending, the whole history — the chips cut it */
  days: [],
  months: [],
  /* the twelve months ending on the folder's own last sale, oldest first */
  seriesMonths: [],
  /* `[{ key, name, revenue, orders, units, aov, share, cumulativeShare, pareto,
        firstSale, lastSale, freeOrders, paidOrders, paidRevenue, free, mixed,
        series[], sheetUrl, landingUrl }]` */
  products: [],
  buyers: {
    total: 0,
    repeat: 0,
    repeatRate: 0,
    churn: { low: 0, medium: 0, high: 0 },
    thisMonthNew: 0,
    thisMonthReturning: 0,
    twice: 0,
    active: 0,
    drifting: 0,
    lapsed: 0,
  },
  /* the Customers tab: cohorts, frequency, recency, value, breadth, leaderboard */
  customers: {
    orders: { one: 0, two: 0, threeToFive: 0, sixPlus: 0 },
    months: [],
    recency: {
      active: { buyers: 0, orders: 0, revenue: 0 },
      drifting: { buyers: 0, orders: 0, revenue: 0 },
      lapsed: { buyers: 0, orders: 0, revenue: 0 },
    },
    breadth: { multiProduct: 0, of: 0 },
    value: { payingBuyers: 0, perBuyer: 0, top10: 0, top25: 0, gapDays: null },
    leaderboard: [],
  },
  statuses: [],
  repeatPct: 0,
  /* `failed` is a copy that could not be downloaded — a different fact from a tab
     with no readable header, and the page says which one happened. */
  sheets: { total: 0, withTab: 0, empty: 0, unreadable: 0, failed: 0 },
  /* a spreadsheet with a header and no rows: a product, not a zero */
  emptyProducts: [],
  /* `{ checked, sheets: [{ key, sheet, title, titles, rows, sheetUrl }] }` */
  names: { checked: 0, sheets: [] },
  /* `{ url, at, resolved }` — the Drive folder and whether its landing links landed */
  links: { url: null, at: '', resolved: false },
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

const FALLBACK = { days: 0, since: '', until: '', firstDay: '', lastDay: '' }
const NO_TOTALS = {
  revenue: 0,
  orders: 0,
  units: 0,
  aov: 0,
  fees: { affiliate: 0, notif: 0, convenience: 0 },
  vouchers: 0,
  sheets: 0,
  sheetsWithData: 0,
  paid: 0,
}
const NO_PAID = {
  orders: 0,
  revenue: 0,
  aov: 0,
  buyers: 0,
  repeat: 0,
  repeatRate: 0,
  freeOrders: 0,
  voucheredOrders: 0,
  listMissing: 0,
}
const NO_BUYERS = {
  total: 0,
  repeat: 0,
  repeatRate: 0,
  churn: { low: 0, medium: 0, high: 0 },
  thisMonthNew: 0,
  thisMonthReturning: 0,
  twice: 0,
  active: 0,
  drifting: 0,
  lapsed: 0,
}
const NO_SEGMENT = { buyers: 0, orders: 0, revenue: 0 }
const NO_CUSTOMERS = {
  orders: { one: 0, two: 0, threeToFive: 0, sixPlus: 0 },
  months: [],
  recency: { active: { ...NO_SEGMENT }, drifting: { ...NO_SEGMENT }, lapsed: { ...NO_SEGMENT } },
  breadth: { multiProduct: 0, of: 0 },
  value: { payingBuyers: 0, perBuyer: 0, top10: 0, top25: 0, gapDays: null },
  leaderboard: [],
}
const NO_SHEETS = { total: 0, withTab: 0, empty: 0, unreadable: 0, failed: 0 }

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

/**
 * Take the answer, field for field.
 *
 * `answer.readAt` is when the *rows* were read; a cached answer carries the time it
 * was stored, so the page's age sentence and the footnote agree about one clock.
 * Every nested object defaults to its empty shape rather than to `undefined`, so a
 * component can read `lynk.customers.value.top10` before the first read without a
 * guard on each field.
 */
function adopt(answer) {
  lynk.window = answer?.window || FALLBACK
  lynk.readAt = String(answer?.readAt || '')
  lynk.cached = answer?.cached === true
  lynk.reads = Number(answer?.reads || 0)
  lynk.cacheTtlMs = Number(answer?.cacheTtlMs || 0)
  lynk.readMs = Number(answer?.readMs || 0)
  lynk.suffix = String(answer?.suffix || lynk.sheetSuffix || '')
  lynk.downloads = answer?.downloads || null
  lynk.totals = answer?.totals ? { ...NO_TOTALS, ...answer.totals } : NO_TOTALS
  lynk.paid = answer?.paid ? { ...NO_PAID, ...answer.paid } : NO_PAID
  lynk.days = Array.isArray(answer?.days) ? answer.days : []
  lynk.months = Array.isArray(answer?.months) ? answer.months : []
  lynk.seriesMonths = Array.isArray(answer?.seriesMonths) ? answer.seriesMonths : []
  lynk.products = Array.isArray(answer?.products) ? answer.products : []
  lynk.buyers = answer?.buyers ? { ...NO_BUYERS, ...answer.buyers } : NO_BUYERS
  lynk.customers = answer?.customers
    ? {
        ...NO_CUSTOMERS,
        ...answer.customers,
        recency: { ...NO_CUSTOMERS.recency, ...(answer.customers.recency || {}) },
        value: { ...NO_CUSTOMERS.value, ...(answer.customers.value || {}) },
        breadth: { ...NO_CUSTOMERS.breadth, ...(answer.customers.breadth || {}) },
      }
    : NO_CUSTOMERS
  lynk.statuses = Array.isArray(answer?.statuses) ? answer.statuses : []
  lynk.sheets = answer?.sheets ? { ...NO_SHEETS, ...answer.sheets } : NO_SHEETS
  lynk.emptyProducts = Array.isArray(answer?.emptyProducts) ? answer.emptyProducts : []
  lynk.names = answer?.names
    ? { checked: Number(answer.names.checked || 0), sheets: answer.names.sheets || [] }
    : { checked: 0, sheets: [] }
  lynk.links = answer?.links
    ? { url: answer.links.url || null, at: String(answer.links.at || ''), resolved: answer.links.resolved === true }
    : { url: null, at: '', resolved: false }
  lynk.repeatPct = Number(answer?.repeatPct || 0)
  lynk.readFolderId = String(answer?.folderId || '')
  lynk.triedFolderId = lynk.readFolderId
  if (answer?.suffix) lynk.sheetSuffix = String(answer.suffix)
}

/** Mirror the row's settings, so the page and the read agree about the folder. */
export function adoptLynkConfig(fields) {
  lynk.folderId = String(fields?.folderId || '')
  lynk.folderName = String(fields?.folderName || '')
  lynk.sheetSuffix = String(fields?.sheetSuffix || ' - Transactions')
  lynk.marketplaceUrl = String(fields?.marketplaceUrl || '')
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
 * twice is one read and only a button spends requests. `days` is kept on the signature
 * for the callers that still pass it and is deliberately **not** forwarded to the
 * window: the answer is the whole folder, and a chip slices it in the renderer.
 */
export async function readDashboard({ days = 0, force = false } = {}) {
  if (lynk.reading) return
  void days
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
    adopt(await call('connector.lynkDashboard', { workspace: hub.workspace, id: 'lynk', force }))
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
  lynk.suffix = ''
  lynk.downloads = null
  lynk.totals = NO_TOTALS
  lynk.paid = NO_PAID
  lynk.days = []
  lynk.months = []
  lynk.seriesMonths = []
  lynk.products = []
  lynk.buyers = NO_BUYERS
  lynk.customers = NO_CUSTOMERS
  lynk.statuses = []
  lynk.repeatPct = 0
  lynk.sheets = NO_SHEETS
  lynk.emptyProducts = []
  lynk.names = { checked: 0, sheets: [] }
  lynk.links = { url: null, at: '', resolved: false }
  lynk.error = ''
  lynk.refused = false
  lynk.throttled = false
}

/* ── formatting, and the one link guard ───────────────────────────────────
   These live beside the store rather than in each component because the same
   figure is printed on both tabs — an AOV on Overview and a per-buyer spend on
   Customers — and two copies of `id-ID` money drift the first time one of them is
   edited. Nothing below reads the answer: each function takes a number or a date
   string and returns text. */

const nFmt = new Intl.NumberFormat('en-gb')

/** A count. `—` for a value that is not a number at all, which is not zero. */
export function num(value) {
  if (value === null || value === undefined || value === '') return '—'
  const amount = Number(value)
  return Number.isFinite(amount) ? nFmt.format(amount) : '—'
}

/* `Rp 9.351.900` — id-ID, a space after the prefix, and `Rp 0` rather than an em
   dash when nothing was sold: zero is a fact, missing is `—`. */
const moneyFmt = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 })
export function money(value) {
  if (value === null || value === undefined || value === '') return '—'
  const amount = Number(value)
  if (!Number.isFinite(amount)) return '—'
  return amount < 0 ? `−Rp ${moneyFmt.format(Math.abs(amount))}` : `Rp ${moneyFmt.format(amount)}`
}

/**
 * A percentage that the answer already states as a percentage (`share: 42.3`).
 *
 * The answer carries two kinds and they must not be confused: `share`,
 * `cumulativeShare`, `top10`, `top25` and `newShare` are 0–100, while `repeatPct`
 * is a fraction. `frac()` is the other one, named so a reader cannot pick wrong.
 */
export function pct(value) {
  if (value === null || value === undefined || value === '') return '—'
  const amount = Number(value)
  if (!Number.isFinite(amount)) return '—'
  const shown = Number(amount.toFixed(1))
  return `${Number.isInteger(shown) ? shown : shown.toFixed(1)} %`
}

/** A fraction (0–1) as a percentage: `repeatPct`, and nothing else. */
export function frac(value) {
  if (value === null || value === undefined || value === '') return '—'
  const amount = Number(value)
  if (!Number.isFinite(amount)) return '—'
  return pct(amount * 100)
}

/** `4 Mar 2026`. A day with no answer is `—`, never today. */
export function dayText(iso, year = true) {
  if (!iso) return '—'
  const date = new Date(`${String(iso).slice(0, 10)}T12:00:00`)
  if (!Number.isFinite(date.getTime())) return '—'
  return date.toLocaleDateString('en-gb', {
    day: 'numeric',
    month: 'short',
    ...(year ? { year: 'numeric' } : {}),
  })
}

/** `2026-03` or `2026-03-04` → `Mar 26` / `Mar 2026`. */
export function monthText(key, long = false) {
  const date = new Date(`${String(key).slice(0, 7)}-01T12:00:00`)
  if (!Number.isFinite(date.getTime())) return '—'
  return date.toLocaleDateString('en-gb', { month: long ? 'long' : 'short', year: long ? 'numeric' : '2-digit' })
}

/** `4 Mar 2026, 14:20` — the read's own clock, in this machine's zone. */
export function clock(iso) {
  if (!iso) return '—'
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return '—'
  return `${date.toLocaleDateString('en-gb', { day: 'numeric', month: 'short', year: 'numeric' })}, ${date.toLocaleTimeString('en-gb', { hour: '2-digit', minute: '2-digit' })}`
}

/* ── days ──────────────────────────────────────────────────────────────────
   Every window is a pair of civil days compared as strings: `YYYY-MM-DD` sorts
   and compares correctly, so no window arithmetic depends on this machine's
   clock or zone. */
const DAY_MS = 86_400_000

export function shiftDay(day, delta) {
  const at = Date.parse(`${String(day).slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(at)) return ''
  return new Date(at + delta * DAY_MS).toISOString().slice(0, 10)
}

/** Inclusive: `2026-03-01 → 2026-03-01` is one day. */
export function spanDays(since, until) {
  if (!since || !until) return 0
  const from = Date.parse(`${since}T00:00:00Z`)
  const to = Date.parse(`${until}T00:00:00Z`)
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return 0
  return Math.round((to - from) / DAY_MS) + 1
}

/** The first day of the month `delta` months away from `day`. */
export function shiftMonth(day, delta) {
  const at = Date.parse(`${String(day).slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(at)) return ''
  const date = new Date(at)
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + delta, 1)).toISOString().slice(0, 10)
}

/** `2026-03-04` → `2026-03`. */
export const monthKey = (day) => String(day || '').slice(0, 7)

/**
 * The hosts a spreadsheet row may link to, and nothing else.
 *
 * The answer carries three kinds of URL — a Sheet, a landing page and the Drive
 * folder — and all of them are built by the main process from ids. This is the
 * second check, in the renderer, so a value that reached the answer from somewhere
 * else (a cached file, a renamed row) is drawn as text rather than becoming a link
 * with someone else's host on it.
 *
 * The landing page's host is **this workspace's own**, parsed out of the marketplace
 * URL it configured — never a constant here. A domain in this file would publish one
 * store's site to everyone who clones the app, and would refuse a second store's
 * links; with no marketplace configured there is no such host, and a landing URL
 * falls back to plain text.
 */
export const SAFE_HOSTS = new Set(['lynk.id', 'www.lynk.id', 'docs.google.com', 'drive.google.com'])

/** The host the configured marketplace document names, or `''`. */
export function marketplaceHost(value) {
  if (!value) return ''
  try {
    const url = new URL(String(value).trim())
    return url.protocol === 'https:' ? url.hostname.toLowerCase() : ''
  } catch {
    return ''
  }
}

/** The allowlist for the current configuration: the constants, plus that host. */
const hostsNow = () => {
  const host = marketplaceHost(lynk.marketplaceUrl)
  if (!host || SAFE_HOSTS.has(host)) return SAFE_HOSTS
  return new Set([...SAFE_HOSTS, host])
}

export function safeUrl(value) {
  if (!value) return null
  let url
  try {
    url = new URL(String(value))
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (!hostsNow().has(url.hostname.toLowerCase())) return null
  return url.toString()
}
