/**
 * The Lynk.id dashboard: one Drive folder of spreadsheets, read into one table.
 *
 * Lynk.id writes a spreadsheet per product and one ` - Transactions` tab in each.
 * There is no API to ask for "what did the store sell": the answer only exists in
 * that folder, so this module lists it, opens every spreadsheet, reads the one tab
 * whose name ends with the workspace's suffix, and adds the rows up.
 *
 * Four rules, each of which was a way to print a wrong number:
 *
 *   1. **A spreadsheet with no such tab is counted and not read.** A product that
 *      never sold is a fact, not a zero, so it appears in `sheets.empty` and never
 *      as a row of noughts in the table.
 *   2. **Columns are found by their header, not their position.** A Lynk export
 *      that grows a column must not silently shift revenue into a phone number.
 *      A column that cannot be found makes that sheet unreadable — `—`, not `0`.
 *   3. **Nothing is converted.** The amount column is already rupiah; `currency` is
 *      printed, never applied.
 *   4. **The folder is the cache key.** Two workspaces pointing at two folders must
 *      never be served each other's numbers, so `folderId` is in the key, the
 *      file's own record and the hit test.
 *   5. **The reads are paced, and a refusal stays a sentence.** Google counts
 *      Sheets reads per minute *per user*, and one spreadsheet costs two of them.
 *      Seventy spreadsheets opened as fast as sockets allow is how a first visit
 *      used to end in `Quota exceeded … Read requests per minute per user` with
 *      nothing on screen — so the burst is paced, a 429 is retried once, and a
 *      read that still fails is reported with Google's own words and no number at
 *      all. A throttled folder is never drawn as a folder of zeroes.
 *
 * The window is not a parameter of the read. Every row is kept with its date and
 * the renderer slices `30 days / 90 days / 12 months / all` out of what is already
 * in memory — a chip must cost no request, which is why the cache holds rows and
 * not a window's totals.
 *
 * ponytail: the sheet grammar is not vendored anywhere in this repo, so the header
 * words below are the ones Lynk.id's own export uses. They are matched loosely on
 * purpose; the honest failure is an unreadable sheet, never a guessed column.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const oauthAccounts = require('../../oauth-accounts.cjs')
const { accessToken, get } = require('../_shared.cjs')

const CONNECTOR = 'lynk'
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet'
const DRIVE = 'https://www.googleapis.com/drive/v3/files'
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets'

/* Six hours: a day's sales do not move fast enough to justify re-reading seventy
   spreadsheets on every visit, and `Re-read now` is one button away. */
const CACHE_MS = 6 * 60 * 60_000
const CACHE_SCHEMA = 1
const ROOT = process.env.ENTITY_HOME
  ? path.resolve(process.env.ENTITY_HOME)
  : path.join(os.homedir(), '.entity')
const CACHE_FILE = path.join(ROOT, 'lynk-dashboard.json')

/* How many spreadsheets are opened at once, and how fast new requests may start.
   The ceiling is Google's own: a Sheets read quota of 300 a minute per user means
   five a second, and one spreadsheet is a metadata read plus a values read. A
   small folder is read instantly — the first `PACE_BURST` requests are unpaced —
   and a large one settles at ~4 a second, which is under the limit with room for
   the person's other tabs. Slow and complete beats fast and refused. */
const CONCURRENCY = 4
const PACE_BURST = 24
const PACE_MS = 240
const QUOTA_RETRY_MS = 5_000
/* `Quota exceeded for quota metric 'Read requests'`, `429`, `RESOURCE_EXHAUSTED`:
   all the same answer — wait, do not reauthorize, and do not print a zero. */
const QUOTA = /quota|rate limit|429|resource_exhausted|too many requests/i

let pacedStarts = 0
let nextStartAt = 0

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Hold the next request until the pace allows it. */
async function pace() {
  pacedStarts += 1
  if (pacedStarts <= PACE_BURST) return
  const now = Date.now()
  const at = Math.max(now, nextStartAt)
  nextStartAt = at + PACE_MS
  if (at > now) await wait(at - now)
}

/** One paced GET. A quota answer is waited out once, then reported. */
async function read(url, token) {
  for (let attempt = 0; ; attempt += 1) {
    await pace()
    try {
      return await get(url, token, CONNECTOR)
    } catch (error) {
      if (attempt >= 1 || !QUOTA.test(String(error?.message || ''))) throw error
      await wait(QUOTA_RETRY_MS)
    }
  }
}

/* What the tab prints while a read is in flight — `Reading 34 of 70`.
   A folder this size takes a minute on purpose, and a minute of no visible work
   reads as a hung page, so the count is exposed rather than guessed at. */
const progress = { phase: '', total: 0, read: 0 }

function beginProgress() {
  progress.phase = 'listing'
  progress.total = 0
  progress.read = 0
  pacedStarts = 0
  nextStartAt = 0
}

function progressOf() {
  return { phase: progress.phase, total: progress.total, read: progress.read }
}
/* One transaction row set is small, but a busy year is not. Beyond this the sheet
   is reported unreadable rather than truncated into a smaller revenue. */
const MAX_ROWS = 20_000
const DEFAULT_DAYS = 90
const MONTHS = 12

/* ── reading a folder ─────────────────────────────────────────────────── */

/** The first signed-in Lynk.id account on this machine, or why there is none. */
function accountOf() {
  const rows = oauthAccounts.connectedAccounts(CONNECTOR)
  const usable = rows.filter((row) => row.status === 'connected' && row.hasToken)
  if (!usable.length) {
    const error = new Error(
      'Dashboard needs a Google account — drive.readonly. Connect one on Overview.',
    )
    error.refused = true
    error.locked = 'account'
    throw error
  }
  return usable[0]
}

/** A failure a person can act on: a refused grant, not a bug. */
function refusal(error) {
  const said = String(error?.message || error || '')
  /* A rate limit is neither a refusal nor a bug: nothing about the grant or the
     folder is wrong, so it is marked as its own kind and drawn as its own sentence. */
  if (QUOTA.test(said)) {
    const wrapped = new Error(said)
    wrapped.throttled = true
    return wrapped
  }
  if (/needs a sign-in|invalid_grant|401|PERMISSION_DENIED|403|insufficient|not been used/i.test(said)) {
    const wrapped = new Error(said)
    wrapped.refused = /sign-in|invalid_grant|401|insufficient/i.test(said)
    return wrapped
  }
  return error
}

async function tokenFor() {
  const account = accountOf()
  try {
    return { account, token: await accessToken(CONNECTOR, account.localpart) }
  } catch (error) {
    throw refusal(error)
  }
}

/**
 * The folder a pasted value names, if it names one.
 *
 * `Search folders…` used to be a name search and nothing else, so the one value a
 * person actually has — the id out of a Drive URL — found nothing. A Drive folder
 * id is a single url-safe token, and a pasted link carries it after `/folders/`.
 * Twenty characters is the floor for a bare token: shorter than that is a folder
 * *name* with hyphens (`digital-lab`), which belongs to the search, not here.
 */
function pastedId(value) {
  const said = String(value || '').trim()
  const link = said.match(/\/folders\/([A-Za-z0-9_-]{10,})/) || said.match(/[?&]id=([A-Za-z0-9_-]{10,})/)
  if (link) return link[1]
  return /^[A-Za-z0-9_-]{20,}$/.test(said) ? said : ''
}

/** One folder by id, or `[]` — a wrong id is an answer, not a failed grant. */
async function folderById(id, token) {
  const url = new URL(`${DRIVE}/${encodeURIComponent(id)}`)
  url.searchParams.set('fields', 'id,name,mimeType,trashed,modifiedTime')
  try {
    const body = await read(url, token)
    if (body?.mimeType !== FOLDER_MIME || body?.trashed) return []
    return [
      {
        id: String(body.id || id),
        name: String(body.name || body.id || id),
        modifiedTime: String(body.modifiedTime || ''),
      },
    ]
  } catch (error) {
    /* `File not found` is what a wrong id, or a folder this grant cannot see,
       answers. It is an empty list, never a refusal — the query was the mistake. */
    if (/404|not found|notFound/i.test(String(error?.message || ''))) return []
    throw refusal(error)
  }
}

/** Every folder in the Drive this grant can see, newest first. */
async function folders({ query = '', pageToken = '' } = {}) {
  const { token } = await tokenFor()
  /* A pasted id or link is not a search: it names exactly one folder, so it is
     fetched by id and the name search is skipped entirely. */
  const pasted = pageToken ? '' : pastedId(query)
  if (pasted) return { files: await folderById(pasted, token), nextPageToken: '' }
  const url = new URL(DRIVE)
  const clauses = [`mimeType='${FOLDER_MIME}'`, 'trashed=false']
  const name = String(query || '').replace(/['\\]/g, ' ').trim()
  if (name) clauses.push(`name contains '${name}'`)
  url.searchParams.set('q', clauses.join(' and '))
  url.searchParams.set('pageSize', '25')
  url.searchParams.set('orderBy', 'recency')
  url.searchParams.set('fields', 'nextPageToken,files(id,name,modifiedTime)')
  if (pageToken) url.searchParams.set('pageToken', String(pageToken))
  const body = await read(url, token).catch((error) => {
    throw refusal(error)
  })
  return {
    files: (body.files || []).map((file) => ({
      id: String(file.id || ''),
      name: String(file.name || file.id || ''),
      modifiedTime: String(file.modifiedTime || ''),
    })),
    nextPageToken: String(body.nextPageToken || ''),
  }
}

/** Every spreadsheet directly inside one folder, in Drive's own order. */
async function sheetsIn(folderId, token) {
  const files = []
  let pageToken = ''
  do {
    const url = new URL(DRIVE)
    url.searchParams.set(
      'q',
      `'${String(folderId).replace(/'/g, "\\'")}' in parents and mimeType='${SHEET_MIME}' and trashed=false`,
    )
    url.searchParams.set('pageSize', '100')
    url.searchParams.set('orderBy', 'name')
    url.searchParams.set('fields', 'nextPageToken,files(id,name,modifiedTime)')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const body = await read(url, token)
    for (const file of body.files || []) {
      files.push({
        id: String(file.id || ''),
        name: String(file.name || file.id || ''),
        modifiedTime: String(file.modifiedTime || ''),
      })
    }
    pageToken = String(body.nextPageToken || '')
  } while (pageToken && files.length < 500)
  return files
}

/* ── reading one spreadsheet ──────────────────────────────────────────── */

/** The tab whose name ends with the workspace's suffix, or none. */
function tabOf(sheet, suffix) {
  const titles = (sheet.sheets || []).map((entry) => String(entry?.properties?.title || ''))
  const ending = String(suffix || '')
  const hit = titles.find((title) => ending && title.endsWith(ending))
  return hit || ''
}

const quoted = (title) => `'${String(title).replace(/'/g, "''")}'`

/** A header cell holding a date. */
const isDateHead = (head) => /tanggal|date|waktu|time|created|dibuat/i.test(head)
/** A header cell holding the money a person paid. */
const isMoneyHead = (head) => /^total|grand|amount|jumlah|harga|price|nominal|revenue|gross|dibayar/i.test(head)
/** A header cell holding who bought it. */
const isBuyerHead = (head) => /email|buyer|pembeli|customer|pemesan|nama/i.test(head)
/** A header cell holding the state of the order. */
const isStateHead = (head) => /status|state|pembayaran|payment/i.test(head)
const PAID_WORDS = /paid|sukses|success|settle|complete|lunas|berhasil|selesai|done/i
const DEAD_WORDS = /cancel|batal|expire|kadaluarsa|refund|gagal|fail|pending|unpaid|menunggu/i

/**
 * `12/11/2026`, `2026-11-12`, `12 Nov 2026`, `Nov 12, 2026` → `2026-11-12`.
 *
 * Sheets already serialises a date cell to a locale string, so all four shapes
 * arrive from the same tab depending on how the person typed it.
 */
function dayOf(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(text)
  if (dmy) {
    const [, d, m, y] = dmy
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  const named = /^(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{4})/.exec(text)
  if (named) {
    const month = monthOf(named[2])
    if (month) return `${named[3]}-${month}-${named[1].padStart(2, '0')}`
  }
  const mdn = /^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(text)
  if (mdn) {
    const month = monthOf(mdn[1])
    if (month) return `${mdn[3]}-${month}-${mdn[2].padStart(2, '0')}`
  }
  const parsed = new Date(text)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : ''
}

/* Both spellings, because the tab may be written by an Indonesian export (`Agu`,
   `Okt`, `Des`) or an English one (`Aug`, `Oct`, `Dec`). */
const MONTH_WORDS = [
  ['jan', 'jan'], ['feb', 'feb'], ['mar', 'mar'], ['apr', 'apr'], ['may', 'mei'],
  ['jun', 'jun'], ['jul', 'jul'], ['aug', 'agu'], ['sep', 'sep'], ['oct', 'okt'],
  ['nov', 'nov'], ['dec', 'des'],
]
function monthOf(word) {
  const key = String(word || '').slice(0, 3).toLowerCase()
  const index = MONTH_WORDS.findIndex((pair) => pair.includes(key))
  return index >= 0 ? String(index + 1).padStart(2, '0') : ''
}

/** `Rp 1.234.567`, `1234567`, `1,234,567.00`, `(500)` → 1234567 / -500 / null. */
function moneyOf(value) {
  const text = String(value ?? '').replace(/[^\d,.\-()]/g, '')
  if (!text) return null
  const negative = /^\(.*\)$/.test(text)
  const digits = text.replace(/[()]/g, '')
  /* Indonesian grouping is `.` for thousands and `,` for decimals. A trailing
     `,00` is the only decimal an export writes, so it is dropped, not converted. */
  const clean = digits.replace(/,\d{0,2}$/, '').replace(/[.,]/g, '')
  const number = Number(clean)
  if (!Number.isFinite(number)) return null
  return negative ? -number : number
}

/**
 * One ` - Transactions` tab, normalised to transaction rows.
 *
 * Returns `null` when a column the totals depend on cannot be found: a sheet with
 * no price column is not a sheet that sold nothing.
 */
function rowsOf(values, product) {
  if (!Array.isArray(values) || !values.length) return { rows: [], reason: 'header and no rows' }
  const header = (values[0] || []).map((cell) => String(cell ?? '').trim())
  const at = {
    date: header.findIndex(isDateHead),
    money: header.findIndex(isMoneyHead),
    buyer: header.findIndex(isBuyerHead),
    state: header.findIndex(isStateHead),
  }
  if (at.date < 0 || at.money < 0) return null
  const rows = []
  for (let index = 1; index < values.length; index += 1) {
    const cells = values[index] || []
    const day = dayOf(cells[at.date])
    const amount = moneyOf(cells[at.money])
    if (!day || amount === null) continue
    const state = at.state >= 0 ? String(cells[at.state] ?? '') : ''
    if (state && DEAD_WORDS.test(state) && !PAID_WORDS.test(state)) continue
    const buyer = at.buyer >= 0 ? String(cells[at.buyer] ?? '').trim().toLowerCase() : ''
    rows.push({ p: product, d: day, a: amount, b: buyer || `${product}#${index}` })
    if (rows.length > MAX_ROWS) return null
  }
  return { rows, reason: '' }
}

async function readSheet(file, suffix, token) {
  const meta = await read(
    `${SHEETS}/${encodeURIComponent(file.id)}?fields=properties.title,sheets.properties.title`,
    token,
  )
  const tab = tabOf(meta, suffix)
  if (!tab) {
    progress.read += 1
    return { file, tab: '', rows: [], reason: 'no tab' }
  }
  const range = `${quoted(tab)}!A1:Z${MAX_ROWS + 1}`
  const body = await read(
    `${SHEETS}/${encodeURIComponent(file.id)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`,
    token,
  )
  progress.read += 1
  const parsed = rowsOf(body.values || [], String(meta?.properties?.title || file.name))
  if (!parsed) return { file, tab, rows: [], reason: 'unreadable' }
  return { file, tab, rows: parsed.rows, reason: parsed.rows.length ? '' : parsed.reason }
}

/** Open `items` with at most CONCURRENCY in flight, preserving order. */
async function pool(items, worker) {
  const out = new Array(items.length)
  let next = 0
  const run = async () => {
    while (next < items.length) {
      const index = next
      next += 1
      try {
        out[index] = await worker(items[index], index)
      } catch (error) {
        out[index] = { error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, run))
  return out
}

/* ── the cache ────────────────────────────────────────────────────────── */

function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    if (raw?.schema !== CACHE_SCHEMA || !Number.isFinite(raw?.at) || !raw?.value) return null
    return raw
  } catch {
    return null
  }
}

function writeCache(key, value) {
  const body = `${JSON.stringify({ schema: CACHE_SCHEMA, key, at: Date.now(), value }, null, 2)}\n`
  try {
    fs.mkdirSync(ROOT, { recursive: true })
    const staged = `${CACHE_FILE}.${process.pid}.tmp`
    fs.writeFileSync(staged, body, 'utf8')
    fs.renameSync(staged, CACHE_FILE)
  } catch {
    /* read-only home: the next visit reads the folder again. */
  }
}

/** The folder (or the suffix) changed, so the stored answer belongs to nobody. */
function forgetCache() {
  try {
    fs.rmSync(CACHE_FILE, { force: true })
  } catch {
    /* already gone */
  }
}

/** What a cached answer is worth, in the words the Report card prints. */
const cacheTtlMs = CACHE_MS

/* ── the read ─────────────────────────────────────────────────────────── */

/**
 * `Test folder` — what is actually in `config.folderId`.
 *
 * Three counts and one clock, because the number a person needs before trusting
 * the tab is "how many of these did you manage to read": `70 spreadsheets · 18
 * with a - Transactions tab · 320 rows · read in 4.2 s`.
 */
async function testFolder({ folderId, suffix } = {}) {
  if (!folderId) {
    const error = new Error('Dashboard needs a Drive folder — pick one on Overview.')
    error.locked = 'folder'
    throw error
  }
  const started = Date.now()
  beginProgress()
  const { token } = await tokenFor()
  let files
  try {
    files = await sheetsIn(folderId, token)
  } catch (error) {
    progress.phase = ''
    throw refusal(error)
  }
  progress.phase = 'reading'
  progress.total = files.length
  const opened = await pool(files, (file) => readSheet(file, suffix, token))
  progress.phase = ''
  let withTab = 0
  let rows = 0
  for (const entry of opened) {
    if (!entry || entry.error) continue
    if (entry.tab) withTab += 1
    rows += entry.rows.length
  }
  return {
    sheets: files.length,
    withTab,
    rows,
    empty: Math.max(0, files.length - withTab),
    ms: Date.now() - started,
    folderId,
  }
}

/** `30 Nov 2025 – 29 Nov 2026`, the window the KPI tiles are measured over. */
function windowOf(days, rows) {
  const dates = rows.map((row) => row.d).sort()
  const until = dates.length ? dates[dates.length - 1] : new Date().toISOString().slice(0, 10)
  const wanted = Number(days)
  if (!Number.isFinite(wanted) || wanted <= 0) {
    return { days: 0, since: dates[0] || until, until }
  }
  const end = new Date(`${until}T00:00:00Z`).getTime()
  const since = new Date(end - (wanted - 1) * 86_400_000).toISOString().slice(0, 10)
  return { days: wanted, since, until }
}

const monthKey = (day) => String(day).slice(0, 7)

/**
 * The dashboard: every ` - Transactions` tab in the folder, added up.
 *
 * `days` slices what was read; it does not change what is read. `force` skips the
 * cache, which is the `Re-read now` button and nothing else.
 */
async function dashboard({ workspace = '', id = 'lynk', folderId = '', suffix = '', days = DEFAULT_DAYS, force = false } = {}) {
  if (!folderId) {
    const error = new Error('Dashboard needs a Drive folder — pick one on Overview.')
    error.locked = 'folder'
    throw error
  }
  const key = `${workspace}|${id}|${folderId}|${suffix}`
  if (!force) {
    const hit = readCache()
    if (hit && hit.key === key && Date.now() - hit.at < CACHE_MS) {
      return { ...shapeOf(hit.value, days), cached: true, reads: 0, readAt: new Date(hit.at).toISOString() }
    }
  }

  const started = Date.now()
  beginProgress()
  const { token } = await tokenFor()
  let files
  try {
    files = await sheetsIn(folderId, token)
  } catch (error) {
    progress.phase = ''
    throw refusal(error)
  }
  progress.phase = 'reading'
  progress.total = files.length
  const opened = await pool(files, (file) => readSheet(file, suffix, token))
  progress.phase = ''

  const rows = []
  const sheets = { total: files.length, withTab: 0, empty: 0, unreadable: 0 }
  const products = []
  for (const entry of opened) {
    if (!entry || entry.error) {
      if (entry?.error) throw refusal(entry.error)
      continue
    }
    if (!entry.tab) {
      sheets.empty += 1
      continue
    }
    sheets.withTab += 1
    if (!entry.rows.length && entry.reason === 'unreadable') sheets.unreadable += 1
    for (const row of entry.rows) rows.push(row)
    products.push({ name: entry.file.name, id: entry.file.id })
  }

  const value = { sheets, rows, products, ms: Date.now() - started, folderId, suffix }
  writeCache(key, value)
  return { ...shapeOf(value, days), cached: false, reads: files.length, readAt: new Date().toISOString() }
}

/**
 * Cached rows → the numbers on the screen, for one window.
 *
 * Kept separate from the read so a chip is arithmetic on rows already in memory:
 * `30 days` after `12 months` costs no request.
 */
function shapeOf(value, days) {
  const rows = Array.isArray(value.rows) ? value.rows : []
  const window = windowOf(days, rows)
  const inWindow = window.days
    ? rows.filter((row) => row.d >= window.since && row.d <= window.until)
    : rows

  let money = 0
  let paid = 0
  const byProduct = new Map()
  const byBuyer = new Map()
  const byMonth = new Map()

  for (const row of inWindow) {
    const amount = Number(row.a) || 0
    money += amount
    if (amount > 0) paid += 1
    const product = byProduct.get(row.p) || { name: row.p, revenue: 0, orders: 0, freeOrders: 0, lastOrder: '' }
    product.revenue += amount
    product.orders += 1
    if (amount <= 0) product.freeOrders += 1
    if (row.d > product.lastOrder) product.lastOrder = row.d
    byProduct.set(row.p, product)

    const buyer = byBuyer.get(row.b) || { orders: 0, last: '', money: 0 }
    buyer.orders += 1
    buyer.money += amount
    if (row.d > buyer.last) buyer.last = row.d
    byBuyer.set(row.b, buyer)

    const month = monthKey(row.d)
    const bucket = byMonth.get(month) || { month, revenue: 0, orders: 0 }
    bucket.revenue += amount
    bucket.orders += 1
    byMonth.set(month, bucket)
  }

  const totals = { revenue: money, orders: inWindow.length, paid, aov: paid ? Math.round(money / paid) : 0 }
  const list = [...byProduct.values()].sort((a, b) => b.revenue - a.revenue || b.orders - a.orders)
  for (const product of list) {
    product.share = money > 0 ? product.revenue / money : 0
    product.slug = String(product.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
  }

  /* Twelve months ending on the window's own last day, so the series and the table
     cover the same period even when the store was quiet last week. */
  const months = []
  const until = new Date(`${window.until}T00:00:00Z`)
  for (let back = MONTHS - 1; back >= 0; back -= 1) {
    const cursor = new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth() - back, 1))
    const month = cursor.toISOString().slice(0, 7)
    months.push(byMonth.get(month) || { month, revenue: 0, orders: 0 })
  }

  /* Watched against the window's own end, not the clock: a cached answer read
     three hours ago must not age its buyers by three hours twice. */
  const edge = new Date(`${window.until}T00:00:00Z`).getTime()
  const daysSince = (day) => Math.round((edge - new Date(`${day}T00:00:00Z`).getTime()) / 86_400_000)
  const buyers = { total: byBuyer.size, twice: 0, active: 0, drifting: 0, lapsed: 0 }
  for (const buyer of byBuyer.values()) {
    if (buyer.orders >= 2) buyers.twice += 1
    const age = daysSince(buyer.last)
    if (age <= 30) buyers.active += 1
    else if (age <= 90) buyers.drifting += 1
    else buyers.lapsed += 1
  }

  return {
    window,
    totals,
    products: list,
    months,
    buyers,
    sheets: {
      total: value.sheets?.total || 0,
      withTab: value.sheets?.withTab || 0,
      empty: value.sheets?.empty || 0,
      unreadable: value.sheets?.unreadable || 0,
    },
    repeatPct: buyers.total ? buyers.twice / buyers.total : 0,
    readMs: value.ms || 0,
    cacheTtlMs: CACHE_MS,
    folderId: value.folderId || '',
    suffix: value.suffix || '',
  }
}

module.exports = { folders, testFolder, dashboard, forgetCache, progressOf, cacheTtlMs, CACHE_MS }
