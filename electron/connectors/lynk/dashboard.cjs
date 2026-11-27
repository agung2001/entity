/**
 * The Lynk.id dashboard: one Drive folder of spreadsheets, read into one report.
 *
 * Lynk.id writes a spreadsheet per product and one ` - Transactions` tab in each.
 * There is no API to ask for "what did the store sell": the answer only exists in
 * that folder, so this module lists it, opens every spreadsheet, reads the one tab
 * whose name ends with the workspace's suffix, and adds the rows up.
 *
 * Seven rules, each of which was a way to print a wrong number:
 *
 *   1. **A spreadsheet with no such tab is counted and not read.** A product that
 *      never sold is a fact, not a zero, so it appears in `sheets.empty` and in
 *      `emptyProducts` — never as a row of noughts in the table.
 *   2. **Columns are found by their header, exact name first.** A Lynk export that
 *      grows a column must not silently shift revenue into a phone number, and a
 *      `Total Addon` column must never be mistaken for `Total`. Exact header names
 *      are tried before any loose pattern, and a column that cannot be found makes
 *      that sheet unreadable — `—`, not `0`.
 *   3. **Nothing is converted.** The amount column is already rupiah; `currency` is
 *      printed, never applied.
 *   4. **The folder is the cache key.** Two workspaces pointing at two folders must
 *      never be served each other's numbers, so `folderId` is in the key, the
 *      file's own record and the hit test.
 *   5. **The reads are paced, and a refusal stays a sentence.** Google counts
 *      Sheets reads per minute *per user*, and one spreadsheet costs two of them.
 *      Seventy spreadsheets opened as fast as sockets allow is how a first visit
 *      used to end in `Quota exceeded … Read requests per minute per user` with
 *      nothing on screen — so a burst is paced, a 429 is retried once, and a read
 *      that still fails is reported with Google's own words and no number at all. A
 *      throttled folder is never drawn as a folder of zeroes.
 *   6. **Revenue is the SUCCESS rule, and only that.** A row is counted in money,
 *      orders and units when its own `Status` cell says `SUCCESS`; every other row
 *      still lands in `statuses` so a folder of cancelled orders explains itself
 *      instead of reading as an empty store.
 *   7. **The answer is the whole folder.** The window is not a parameter of the
 *      read: every row is kept and the renderer slices
 *      `30 days / 90 days / 12 months / all` out of `days[]` and each product's own
 *      `series` — a chip must cost no request, which is why the cache holds rows and
 *      not a window's totals.
 *
 * `shapeOf()` is pure: the cache holds rows, and every answer — including the ones a
 * chip produces — is derived from them, so a stored answer can never disagree with
 * the table it was built for.
 *
 * ponytail: the sheet grammar is not vendored anywhere in this repo, so the header
 * words below are the ones Lynk.id's own export uses. They are matched loosely on
 * purpose *after* the exact pass; the honest failure is an unreadable sheet, never a
 * guessed column.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const oauthAccounts = require('../../oauth-accounts.cjs')
const { accessToken, get } = require('../_shared.cjs')
const landing = require('./landing.cjs')
const local = require('./local.cjs')
const xlsx = require('./xlsx.cjs')

const CONNECTOR = 'lynk'
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet'
const DRIVE = 'https://www.googleapis.com/drive/v3/files'

/* Six hours: a day's sales do not move fast enough to justify re-reading seventy
   spreadsheets on every visit, and `Re-read now` is one button away. */
const CACHE_MS = 6 * 60 * 60_000
/* 3: a stored answer is now a set of *readings* — one per spreadsheet, with the long
   row shape (`day`, `total`, `status`, …) — and the report is derived from them. An
   answer written by schema 2 carries short `{p,d,a,b}` rows and no reading list, so
   it is re-read rather than served as a report with no customers block. */
const CACHE_SCHEMA = 3
const ROOT = process.env.ENTITY_HOME
  ? path.resolve(process.env.ENTITY_HOME)
  : path.join(os.homedir(), '.entity')
const CACHE_FILE = path.join(ROOT, 'lynk-dashboard.json')

/* **One request per spreadsheet, not two, and no pace to protect.** The Sheets API
   answers 60 reads a minute for one person, and a folder of seventy products is 140
   reads — the limit this tab kept hitting. The workbook now comes down through Drive's
   export endpoint (one request, a quota a hundred times larger) and is parsed here, so
   the pacing that used to keep the Sheets quota breathing is gone with it. */
const QUOTA_RETRY_MS = 5_000
/* `Quota exceeded for quota metric 'Read requests'`, `429`, `RESOURCE_EXHAUSTED`:
   all the same answer — wait, do not reauthorize, and do not print a zero. */
const QUOTA = /quota|rate limit|429|resource_exhausted|too many requests/i

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** One GET, with the folder listing's quota — the only Sheets-era request left. */
async function read(url, token) {
  for (let attempt = 0; ; attempt += 1) {
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
}

function progressOf() {
  return { phase: progress.phase, total: progress.total, read: progress.read }
}
/* One transaction row set is small, but a busy year is not. Beyond this the sheet
   is reported unreadable rather than truncated into a smaller revenue. */
const MAX_ROWS = 20_000
const MONTHS = 12
/* How many products a leaderboard row carries: a click opens with no request, and a
   buyer with sixty products does not carry sixty rows into a snapshot. */
const MAX_LISTED_PRODUCTS = 5
/* Twelve recency bands are the point of the Customers tab, not the growth of this
   file: an order count above this is bucketed as `sixPlus`. */

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

/* ── columns, by name ─────────────────────────────────────────────────── */

/**
 * A header cell, normalised for comparison: lower case, one space between words,
 * no accents. `Buyer Name (Opsional)` → `buyer name (opsional)`.
 */
const headKey = (cell) =>
  String(cell ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

/**
 * The columns this reader needs or wants, each with the exact header names that
 * mean it and a loose test that only runs when no exact name is present.
 *
 * **Exact first is not a style choice.** Lynk's export writes both `Total` and
 * `Total Addon`, both `Buyer Email` and `Affiliator email`, and both `sub total` and
 * `Total`. A loose `/^total/` finds `Total Addon` (index 7) before `Total` (index
 * 13) and a loose `/email/` finds the affiliate's address before the buyer's — two
 * wrong numbers that look entirely plausible.
 */
const COLUMNS = {
  day: {
    exact: ['tanggal', 'date', 'waktu', 'time', 'created', 'dibuat', 'tanggal transaksi'],
    loose: /tanggal|date|waktu|time|created|dibuat/i,
  },
  /* The money a person actually paid. `harga` is a unit price and `sub total` is a
     list price, so neither may stand in for it unless nothing else is named. */
  total: {
    exact: ['total', 'grand total', 'amount', 'jumlah', 'nominal', 'dibayar', 'revenue', 'gross'],
    loose: /total|amount|jumlah|nominal|dibayar|revenue|gross/i,
  },
  qty: { exact: ['qty', 'quantity', 'kuantitas', 'jumlah item'], loose: /^(qty|quantity|kuantitas)$/i },
  title: {
    exact: ['judul barang', 'judul', 'produk', 'product', 'item', 'nama produk', 'product name'],
    loose: /judul|product|produk|item/i,
  },
  variant: { exact: ['varian', 'variant', 'variasi'], loose: /varian|variant|variasi/i },
  status: { exact: ['status', 'state', 'status pembayaran', 'payment status'], loose: /status|state|pembayaran|payment/i },
  /* `Buyer Email` exactly; `Affiliator email` is somebody else's column. */
  buyer: {
    exact: ['buyer email', 'email buyer', 'email pembeli', 'pembeli email', 'customer email', 'buyer', 'pembeli', 'customer', 'pemesan'],
    loose: /email|buyer|pembeli|customer|pemesan/i,
  },
  name: {
    exact: ['buyer name (opsional)', 'buyer name', 'nama buyer', 'nama pembeli', 'name'],
    loose: /name|nama/i,
  },
  /* The list price the sheet recorded, before voucher and addon. */
  list: { exact: ['sub total', 'subtotal', 'list price', 'harga asli', 'harga normal'], loose: /sub ?total|list price/i },
  unit: { exact: ['harga', 'harga satuan', 'unit price', 'price'], loose: /^harga$|unit price|^price$/i },
  voucher: { exact: ['voucher', 'diskon', 'discount', 'potongan'], loose: /voucher|diskon|discount|potongan/i },
  affiliateFee: { exact: ['affiliate fee', 'biaya affiliate', 'affiliate'], loose: /affiliate/i },
  notifFee: { exact: ['notif fee', 'notification fee', 'biaya notif'], loose: /notif/i },
  convenienceFee: { exact: ['convenience fee', 'biaya kenyamanan'], loose: /convenience/i },
  ref: { exact: ['ref', 'reference', 'referensi', 'order id', 'id pesanan'], loose: /^ref$|reference|referensi|order id/i },
}

/** The index of a column, exact header name first, then the loose test. */
function columnAt(header, spec) {
  for (const name of spec.exact) {
    const at = header.indexOf(name)
    if (at >= 0) return at
  }
  return header.findIndex((cell) => cell && spec.loose.test(cell))
}

/** Every column this reader knows, resolved once per tab. */
function columnsOf(values) {
  const header = (values?.[0] || []).map(headKey)
  const at = {}
  for (const [key, spec] of Object.entries(COLUMNS)) at[key] = columnAt(header, spec)
  return { header, at }
}

/** Whether a first row names both a date and a price: the shape this reader needs,
    and what decides which tab in a workbook is the transactions one. */
const readableHeader = (values) => {
  const { at } = columnsOf(values)
  return at.day >= 0 && at.total >= 0
}

const SUCCESS = 'SUCCESS'

/**
 * `12/11/2026`, `2026-11-12`, `12 Nov 2026`, `Nov 12, 2026` → `2026-11-12`.
 *
 * Sheets already serialises a date cell to a locale string, so all four shapes
 * arrive from the same tab depending on how the person typed it.
 */
function dayOf(value, date1904 = false) {
  /* A downloaded workbook stores a date as a serial, not as the string Sheets renders.
     The serial is turned into a civil day here, so one column reads the same whether
     it arrived through the API or through the copy on disk. */
  if (typeof value === 'number') return xlsx.serialDay(value, date1904)
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

/** A whole number from a cell that may carry grouping: `2`, `2 pcs`, `1.0` → 2 / 2 / 1. */
function intOf(value, fallback) {
  const digits = String(value ?? '').replace(/[^\d]/g, '')
  if (!digits) return fallback
  const number = Number(digits)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

const NAME_MAX = 60
/* Dropped, not clipped: at this length the free-text field held a pasted address far
   more often than a name. */
const ADDRESS_MAX = 120
/* Shapes only: a matched value is rejected here so the PII guard can stay absolute. */
const PHONE_SHAPE = /(^|[^0-9])(?:\+?62|0)8[0-9]{7,12}([^0-9]|$)/

/**
 * The optional `Buyer Name (Opsional)` cell.
 *
 * Rejected when it is really an address, a phone number, or a pasted shipping
 * address — those three are the columns that exist beside it, and a copy-paste
 * mistake is common enough that printing it would be printing a stranger's address.
 */
function buyerNameOf(value) {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ')
  if (!text) return ''
  if (text.includes('@')) return ''
  if (PHONE_SHAPE.test(text)) return ''
  if (text.length > ADDRESS_MAX) return ''
  return text.slice(0, NAME_MAX)
}

/**
 * One ` - Transactions` tab, normalised to transaction rows.
 *
 * Returns `null` when a column the totals depend on cannot be found: a sheet with
 * no price column is not a sheet that sold nothing. A row without a date, without a
 * price or without a status is skipped rather than guessed at.
 */
function rowsOf(values, product, date1904 = false) {
  if (!Array.isArray(values) || !values.length) return { rows: [], reason: 'header and no rows' }
  const { at } = columnsOf(values)
  if (at.day < 0 || at.total < 0 || at.status < 0) return null
  const rows = []
  for (let index = 1; index < values.length; index += 1) {
    const cells = values[index] || []
    const day = dayOf(cells[at.day], date1904)
    const total = moneyOf(cells[at.total])
    const status = String(cells[at.status] ?? '').trim().toUpperCase()
    /* No day, no price, no status: a blank line or a footer, not an order. */
    if (!day || total === null || !status) continue
    const qty = at.qty >= 0 ? intOf(cells[at.qty], 1) : 1
    /* `sub total` is the list price the sheet recorded; `harga` × qty is the
       fallback, because a row written before the column existed still has a price. */
    const listFromColumn = at.list >= 0 ? moneyOf(cells[at.list]) : null
    const unit = at.unit >= 0 ? moneyOf(cells[at.unit]) : null
    const list = listFromColumn === null ? (unit === null ? null : unit * qty) : listFromColumn
    const email = at.buyer >= 0 ? String(cells[at.buyer] ?? '').trim().toLowerCase() : ''
    rows.push({
      day,
      total,
      qty,
      title: String(cells[at.title] ?? '').trim().slice(0, 160) || product,
      variant: at.variant >= 0 ? String(cells[at.variant] ?? '').trim().slice(0, 80) : '',
      status,
      /* One buyer is one address. A row with no address is its own buyer: guessing
         an identity would merge two strangers into one repeat customer. */
      buyer: email || `${product}#${index}`,
      name: at.name >= 0 ? buyerNameOf(cells[at.name]) : '',
      list,
      voucher: (at.voucher >= 0 ? moneyOf(cells[at.voucher]) : null) ?? 0,
      fees: {
        affiliate: (at.affiliateFee >= 0 ? moneyOf(cells[at.affiliateFee]) : null) ?? 0,
        notif: (at.notifFee >= 0 ? moneyOf(cells[at.notifFee]) : null) ?? 0,
        convenience: (at.convenienceFee >= 0 ? moneyOf(cells[at.convenienceFee]) : null) ?? 0,
      },
      ref: at.ref >= 0 ? String(cells[at.ref] ?? '').trim().slice(0, 80) || null : null,
    })
    if (rows.length > MAX_ROWS) return null
  }
  return { rows, reason: '' }
}

/**
 * `&amp;` → `&`.
 *
 * Drive hands a file name back with its XML entities intact, so eleven of this
 * folder's products arrive as `Template Siap Pakai: …, &amp; …`. The pockets of
 * `&amp;` in a table are not the product's name.
 */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }
const decodeEntities = (value) =>
  String(value ?? '').replace(/&(amp|lt|gt|quot|#39);/g, (whole, name) => ENTITIES[name] ?? whole)

/** The product's label: its file name with this workspace's tab suffix stripped. */
function labelOf(file, suffix) {
  const raw = decodeEntities(file.name || file.id || '')
  const ending = String(suffix || '')
  return (ending && raw.endsWith(ending) ? raw.slice(0, -ending.length) : raw).trim() || raw
}

/**
 * One spreadsheet, read from the copy on this machine.
 *
 * `local.read` answers the tab and its raw cells (with the workbook's own date
 * system); the column semantics stay here, where the header names are. A workbook
 * with no ` - Transactions` tab is `no tab`; one whose header lost its date, price
 * or status column is `unreadable` — the same two answers the API path gave.
 */
function readSheet(file, suffix, folderId) {
  progress.read += 1
  const answer = local.read(file, { folderId, suffix, usable: readableHeader })
  const name = labelOf(file, suffix)
  if (!answer.tab) return { id: file.id, name, tab: '', rows: [], reason: answer.reason || 'no tab' }
  const parsed = rowsOf(answer.rows || [], name, answer.date1904)
  if (!parsed) return { id: file.id, name, tab: answer.tab, rows: [], reason: 'unreadable' }
  return {
    id: file.id,
    name,
    tab: answer.tab,
    rows: parsed.rows,
    reason: parsed.rows.length ? '' : parsed.reason,
  }
}

/* ── the cache ────────────────────────────────────────────────────────── */

function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    if (raw?.schema !== CACHE_SCHEMA || !Number.isFinite(raw?.at) || !raw?.value) return null
    if (!Array.isArray(raw.value.readings)) return null
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

/**
 * Forget the stored answer **and the copied workbooks**.
 *
 * This is the verb behind `Forget folder` and behind switching folders: the copies are
 * keyed by folder id, so leaving them behind would spend disk on a folder nothing
 * reads. `Refresh` does not come through here — it keeps the folder and asks for its
 * bytes again (`local.ensure({ force: true })`).
 */
function forgetCache() {
  try {
    fs.rmSync(CACHE_FILE, { force: true })
  } catch {
    /* already gone */
  }
  local.forget()
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
  progress.phase = 'downloading'
  progress.total = files.length
  const copied = await local.ensure(files, {
    folderId,
    token,
    onEach: (done) => {
      progress.read = done
    },
  })
  progress.phase = 'reading'
  progress.read = 0
  const opened = files.map((file) => readSheet(file, suffix, folderId))
  progress.phase = ''
  let withTab = 0
  let rows = 0
  for (const entry of opened) {
    if (entry.tab) withTab += 1
    rows += entry.rows.length
  }
  return {
    sheets: files.length,
    withTab,
    rows,
    empty: Math.max(0, files.length - withTab),
    downloaded: copied.downloaded,
    reused: copied.reused,
    failed: copied.failed.length,
    ms: Date.now() - started,
    folderId,
  }
}

/* ── aggregation ──────────────────────────────────────────────────────── */

const round1 = (value) => Math.round(value * 10) / 10
const shareOf = (part, total) => (total > 0 ? round1((part / total) * 100) : 0)
/** `2026-11` → `Nov 2026`, the label every month column prints. */
const monthLabel = (key) => {
  const at = Date.parse(`${key}-01T00:00:00Z`)
  if (Number.isNaN(at)) return String(key)
  return new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(at)
}
const monthKey = (day) => String(day).slice(0, 7)
const daySpan = (first, last) =>
  first && last ? Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000) + 1 : 0

/**
 * One row's own bucket, on that row's own prices.
 *
 * A paid row took money; a vouchered row had a list price and paid nothing; a free
 * row had neither. Per row and never per product, because a product that switches
 * price mid-window keeps its legacy rows in their own bucket.
 */
function orderBucket(row) {
  if (row.total > 0) return 'paid'
  if (row.list !== null && row.list > 0) return 'vouchered'
  return 'free'
}

/**
 * Readings → the report. Pure, and the only place the numbers are decided.
 *
 * Every index is built in one pass: per product, per product-per-day (the leader
 * rows' series), per month, per day, per buyer, per status. Nothing here reads the
 * network, so a stored answer and a fresh one are the same arithmetic.
 */
function aggregate(value) {
  const readings = Array.isArray(value?.readings) ? value.readings : []
  const links = value?.links?.urls || {}
  const landingOf = (id) => landing.landingUrl(links[String(id)]) || null

  const products = new Map()
  const months = new Map()
  const days = new Map()
  /** Per product, then per day: the same rows, one more index — no second pass. */
  const productDays = new Map()
  const buyers = new Map()
  /** Paid rows per buyer: a repeat buyer here paid more than once, not registered twice. */
  const paidBuyers = new Map()
  const statuses = new Map()
  const emptyProducts = []
  const nameMismatches = []
  const fees = { affiliate: 0, notif: 0, convenience: 0 }
  let namesChecked = 0
  let revenue = 0
  let orders = 0
  let units = 0
  let vouchers = 0
  let paidOrders = 0
  let paidRevenue = 0
  let freeOrders = 0
  let voucheredOrders = 0
  let listMissing = 0
  let sheetsWithData = 0
  let firstDay = ''
  let lastDay = ''

  for (const entry of readings) {
    const rows = Array.isArray(entry.rows) ? entry.rows : []
    if (!rows.length) {
      emptyProducts.push({
        name: entry.name,
        key: entry.id,
        sheetUrl: landing.sheetUrl(entry.id),
        landingUrl: landingOf(entry.id),
      })
      continue
    }
    sheetsWithData += 1
    const product = products.get(entry.id) || {
      key: entry.id,
      name: entry.name,
      revenue: 0,
      orders: 0,
      units: 0,
      freeOrders: 0,
      paidOrders: 0,
      paidRevenue: 0,
      firstSale: null,
      lastSale: null,
    }
    const titles = new Map()
    for (const row of rows) {
      statuses.set(row.status, (statuses.get(row.status) || 0) + 1)
      /* Every parsed row counts towards the name check, paid or not: the title is in
         the file either way. */
      if (row.title) titles.set(row.title, (titles.get(row.title) || 0) + 1)
      /* Revenue is the SUCCESS rule, nothing else. A cancelled order is a fact for
         `statuses` and a zero for every money column. */
      if (row.status !== SUCCESS) continue

      const amount = Number(row.total) || 0
      const qty = Number(row.qty) || 0
      const bucket = orderBucket(row)
      if (bucket === 'paid') {
        product.paidOrders += 1
        product.paidRevenue += amount
        paidOrders += 1
        paidRevenue += amount
        paidBuyers.set(row.buyer, (paidBuyers.get(row.buyer) || 0) + 1)
      } else if (bucket === 'free') {
        product.freeOrders += 1
        freeOrders += 1
      } else {
        voucheredOrders += 1
      }
      if (row.list === null || row.list === undefined) listMissing += 1

      product.revenue += amount
      product.orders += 1
      product.units += qty
      product.firstSale = !product.firstSale || row.day < product.firstSale ? row.day : product.firstSale
      product.lastSale = !product.lastSale || row.day > product.lastSale ? row.day : product.lastSale

      revenue += amount
      orders += 1
      units += qty
      vouchers += Number(row.voucher) || 0
      fees.affiliate += Number(row.fees?.affiliate) || 0
      fees.notif += Number(row.fees?.notif) || 0
      fees.convenience += Number(row.fees?.convenience) || 0
      firstDay = !firstDay || row.day < firstDay ? row.day : firstDay
      lastDay = !lastDay || row.day > lastDay ? row.day : lastDay

      const month = monthKey(row.day)
      const monthBucket = months.get(month) || { revenue: 0, orders: 0, units: 0 }
      monthBucket.revenue += amount
      monthBucket.orders += 1
      monthBucket.units += qty
      months.set(month, monthBucket)

      const dayBucket = days.get(row.day) || { revenue: 0, orders: 0 }
      dayBucket.revenue += amount
      dayBucket.orders += 1
      days.set(row.day, dayBucket)

      const byDay = productDays.get(entry.id) || new Map()
      const productDay = byDay.get(row.day) || { revenue: 0, orders: 0, units: 0 }
      productDay.revenue += amount
      productDay.orders += 1
      productDay.units += qty
      byDay.set(row.day, productDay)
      productDays.set(entry.id, byDay)

      const buyer = buyers.get(row.buyer) || { first: row.day, last: row.day, count: 0, spend: 0, products: new Map(), months: new Set(), name: '' }
      buyer.first = row.day < buyer.first ? row.day : buyer.first
      buyer.last = row.day > buyer.last ? row.day : buyer.last
      buyer.count += 1
      buyer.spend += amount
      if (!buyer.name && row.name) buyer.name = row.name
      const bought = buyer.products.get(row.title) || { units: 0, paid: 0, last: row.day }
      bought.units += qty
      bought.paid += amount
      bought.last = row.day > bought.last ? row.day : bought.last
      buyer.products.set(row.title, bought)
      buyer.months.add(month)
      buyers.set(row.buyer, buyer)
    }
    const verdict = landing.checkSheetName(
      entry.name,
      [...titles].map(([title, count]) => ({ title, rows: count })),
    )
    if (verdict.kind !== 'unchecked') namesChecked += 1
    if (verdict.kind === 'mismatch') {
      nameMismatches.push({
        key: entry.id,
        sheet: entry.name,
        title: verdict.title,
        titles: verdict.titles,
        rows: verdict.rows,
        sheetUrl: landing.sheetUrl(entry.id),
      })
    }
    products.set(entry.id, product)
  }

  /* Pareto: `A` while the revenue accumulated *before* a product is still under 80 %,
     so the first-ranked product is always core. */
  let cumulative = 0
  const ranked = [...products.values()]
    .filter((product) => product.orders > 0)
    .sort((a, b) => b.revenue - a.revenue || b.orders - a.orders)
    .map((product) => {
      const share = shareOf(product.revenue, revenue)
      const row = {
        key: product.key,
        name: product.name,
        revenue: product.revenue,
        orders: product.orders,
        units: product.units,
        aov: product.orders ? Math.round(product.revenue / product.orders) : 0,
        share,
        cumulativeShare: 0,
        pareto: (cumulative / (revenue || 1)) * 100 < 80 ? 'A' : 'B',
        firstSale: product.firstSale,
        lastSale: product.lastSale,
        freeOrders: product.freeOrders,
        paidOrders: product.paidOrders,
        paidRevenue: product.paidRevenue,
        free: product.paidOrders === 0 && product.freeOrders > 0,
        mixed: product.paidOrders > 0 && product.freeOrders > 0,
        /* ~300 small objects across 18 products: a period filter with no request. */
        series: [...(productDays.get(product.key)?.entries() || [])]
          .map(([day, bucket]) => ({ day, revenue: bucket.revenue, units: bucket.units, orders: bucket.orders }))
          .sort((a, b) => (a.day < b.day ? -1 : 1)),
        sheetUrl: landing.sheetUrl(product.key),
        landingUrl: landingOf(product.key),
      }
      cumulative += product.revenue
      return { ...row, cumulativeShare: shareOf(cumulative, revenue) }
    })
  /* A file whose tab had rows but all of them were cancelled still earns a row: its
     money column says `Rp 0` rather than disappearing. */

  const newestMonth = [...months.keys()].sort().pop() || ''
  const frequency = { one: 0, two: 0, threeToFive: 0, sixPlus: 0 }
  const recency = {
    active: { buyers: 0, orders: 0, revenue: 0 },
    drifting: { buyers: 0, orders: 0, revenue: 0 },
    lapsed: { buyers: 0, orders: 0, revenue: 0 },
  }
  const monthsNew = new Map()
  const monthsActive = new Map()
  const spends = []
  const buyerRows = []
  let multiProduct = 0
  let gapSum = 0

  for (const buyer of buyers.values()) {
    /* Fixed buckets (1 / 2 / 3–5 / 6+) instead of a full histogram: the tail is noise
       at this size. */
    if (buyer.count >= 6) frequency.sixPlus += 1
    else if (buyer.count >= 3) frequency.threeToFive += 1
    else if (buyer.count === 2) frequency.two += 1
    else frequency.one += 1

    const firstMonth = buyer.first.slice(0, 7)
    monthsNew.set(firstMonth, (monthsNew.get(firstMonth) || 0) + 1)
    for (const seen of buyer.months) monthsActive.set(seen, (monthsActive.get(seen) || 0) + 1)

    if (buyer.products.size > 1) multiProduct += 1
    if (buyer.spend > 0) spends.push(buyer.spend)
    /* Telescoping mean: (last − first) / (count − 1) keeps no per-buyer history and
       understates a burst-then-silence buyer. */
    if (buyer.count >= 2) {
      gapSum +=
        (Date.parse(`${buyer.last}T00:00:00Z`) - Date.parse(`${buyer.first}T00:00:00Z`)) / 86_400_000 / (buyer.count - 1)
    }

    /* The band is measured from the folder's own last sale, never this machine's
       clock: a stored answer must not age its buyers by six hours twice. */
    const idle = lastDay
      ? Math.round((Date.parse(`${lastDay}T00:00:00Z`) - Date.parse(`${buyer.last}T00:00:00Z`)) / 86_400_000)
      : 0
    const band = idle <= 60 ? 'active' : idle <= 120 ? 'drifting' : 'lapsed'
    const bucket = recency[band]
    bucket.buyers += 1
    bucket.orders += buyer.count
    bucket.revenue += buyer.spend

    const productList = [...buyer.products.entries()]
      .map(([title, bought]) => ({ title, units: bought.units, paid: bought.paid, last: bought.last }))
      .sort((a, b) => b.paid - a.paid || a.title.localeCompare(b.title))
      .slice(0, MAX_LISTED_PRODUCTS)
    buyerRows.push({
      name: buyer.name || null,
      orders: buyer.count,
      spend: buyer.spend,
      products: buyer.products.size,
      productList,
      productsOmitted: buyer.products.size - productList.length,
      firstMonth,
      lastMonth: buyer.last.slice(0, 7),
      band,
    })
  }

  /* Ranked by what they paid: paying buyers only, top 20, with the sheet's optional
     name and the products behind the count. No hash, no address, no phone, no id. */
  const leaderboard = buyerRows
    .filter((row) => row.spend > 0)
    .sort((a, b) => b.spend - a.spend || b.orders - a.orders)
    .slice(0, 20)
    .map((row, index) => ({ rank: index + 1, ...row }))

  const repeat = frequency.two + frequency.threeToFive + frequency.sixPlus
  const churn = {
    low: recency.active.buyers,
    medium: recency.drifting.buyers,
    high: recency.lapsed.buyers,
  }

  /* Concentration is measured over paying buyers only, and `payingBuyers` is emitted
     so the denominator is never guessed. */
  spends.sort((a, b) => b - a)
  const spendShare = (fraction) => {
    if (!spends.length || !revenue) return 0
    const count = Math.max(1, Math.ceil(spends.length * fraction))
    return Math.round((spends.slice(0, count).reduce((sum, value) => sum + value, 0) / revenue) * 100)
  }
  const thisMonthNew = [...buyers.values()].filter((buyer) => buyer.first.startsWith(newestMonth)).length
  const monthStart = `${newestMonth}-01`
  const thisMonthReturning = [...buyers.values()].filter(
    (buyer) => buyer.last.startsWith(newestMonth) && buyer.first < monthStart,
  ).length
  const paidRepeat = [...paidBuyers.values()].filter((count) => count >= 2).length

  /* Twelve months ending on the folder's own last sale, so the series and the table
     cover the same period even when the store was quiet last week. */
  const seriesMonths = []
  const anchor = lastDay || new Date().toISOString().slice(0, 10)
  const until = new Date(`${anchor}T00:00:00Z`)
  for (let back = MONTHS - 1; back >= 0; back -= 1) {
    const cursor = new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth() - back, 1))
    const key = cursor.toISOString().slice(0, 7)
    const bucket = months.get(key) || { revenue: 0, orders: 0, units: 0 }
    seriesMonths.push({ key, label: monthLabel(key), ...bucket, aov: bucket.orders ? Math.round(bucket.revenue / bucket.orders) : 0 })
  }

  const sheets = {
    total: readings.length,
    withTab: readings.filter((entry) => entry.tab).length,
    empty: readings.filter((entry) => !entry.tab).length,
    unreadable: readings.filter((entry) => entry.reason === 'unreadable').length,
    failed: Number(value?.failed) || 0,
  }

  return {
    /* The whole folder, never a slice of it: `days` is the caller's hint, and the
       renderer cuts its own window out of `days[]` and each product's `series`. */
    window: {
      days: daySpan(firstDay, lastDay),
      since: firstDay,
      until: lastDay,
      firstDay,
      lastDay,
    },
    totals: {
      revenue,
      orders,
      units,
      aov: orders ? Math.round(revenue / orders) : 0,
      fees,
      vouchers,
      sheets: readings.length,
      sheetsWithData,
      /* Legacy alias, kept because the Overview card prints it under the AOV: the
         count of orders that carried money. */
      paid: paidOrders,
    },
    paid: {
      orders: paidOrders,
      revenue: paidRevenue,
      aov: paidOrders ? Math.round(paidRevenue / paidOrders) : 0,
      buyers: paidBuyers.size,
      repeat: paidRepeat,
      repeatRate: paidBuyers.size ? Math.round((paidRepeat / paidBuyers.size) * 100) : 0,
      freeOrders,
      voucheredOrders,
      listMissing,
    },
    days: [...days.entries()].map(([day, bucket]) => ({ day, ...bucket })).sort((a, b) => (a.day < b.day ? -1 : 1)),
    months: [...months.entries()]
      .map(([key, bucket]) => ({
        key,
        label: monthLabel(key),
        revenue: bucket.revenue,
        orders: bucket.orders,
        units: bucket.units,
        aov: bucket.orders ? Math.round(bucket.revenue / bucket.orders) : 0,
      }))
      .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0)),
    seriesMonths,
    products: ranked,
    buyers: {
      total: buyers.size,
      repeat,
      repeatRate: buyers.size ? Math.round((repeat / buyers.size) * 100) : 0,
      churn,
      thisMonthNew,
      thisMonthReturning,
      /* Legacy keys the Overview card reads: `twice` is the repeat count and the
         three bands are the 60/120 cut above. */
      twice: repeat,
      active: recency.active.buyers,
      drifting: recency.drifting.buyers,
      lapsed: recency.lapsed.buyers,
    },
    customers: {
      orders: frequency,
      months: [...monthsActive.entries()]
        .map(([key, active]) => ({
          key,
          label: monthLabel(key),
          newBuyers: monthsNew.get(key) || 0,
          returningBuyers: active - (monthsNew.get(key) || 0),
        }))
        .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0)),
      recency,
      breadth: { multiProduct, of: buyers.size },
      value: {
        payingBuyers: spends.length,
        perBuyer: spends.length ? Math.round(revenue / spends.length) : 0,
        top10: spendShare(0.1),
        top25: spendShare(0.25),
        gapDays: repeat ? Math.round(gapSum / repeat) : null,
      },
      leaderboard,
    },
    statuses: [...statuses.entries()]
      .map(([status, count]) => ({ status, orders: count }))
      .sort((a, b) => b.orders - a.orders),
    /* The folder's own census, kept under its old name because the Overview card
       reads it: how many spreadsheets there are, how many carry the tab, and how many
       of those could not be read. */
    sheets,
    emptyProducts: emptyProducts.sort((a, b) => a.name.localeCompare(b.name)),
    names: {
      checked: namesChecked,
      sheets: nameMismatches.sort((a, b) => b.rows - a.rows || a.sheet.localeCompare(b.sheet)),
    },
    /* The two links a row can carry, resolved by id: a file is renamed, its id is not. */
    links: {
      url: landing.folderUrl(value?.folderId),
      at: String(value?.links?.at || ''),
      resolved: value?.links?.ok === true,
      /* A row with no landing link has one of two reasons, and the page must be able
         to name it: no marketplace is configured (nothing was asked for), or one is
         and this product did not match it. */
      marketplace: Boolean(landing.marketplaceHost(value?.marketplaceUrl)),
    },
    repeatPct: buyers.size ? repeat / buyers.size : 0,
    readMs: Number(value?.ms) || 0,
    cacheTtlMs: CACHE_MS,
    folderId: value?.folderId || '',
    suffix: value?.suffix || '',
  }
}

/**
 * The dashboard: every ` - Transactions` tab in the folder, added up.
 *
 * `force` skips the cache, which is `Refresh` and nothing else. `days` is accepted
 * for callers that still pass it and is deliberately ignored by the read: the answer
 * is the whole folder, and a chip slices it (rule 7).
 */
async function dashboard({
  workspace = '',
  id = 'lynk',
  folderId = '',
  suffix = '',
  marketplaceUrl = '',
  force = false,
} = {}) {
  if (!folderId) {
    const error = new Error('Dashboard needs a Drive folder — pick one on Overview.')
    error.locked = 'folder'
    throw error
  }
  /* The marketplace URL is part of the key, not just of the read: it decides which
     links every row carries, so pointing at another document is a different answer
     even when the spreadsheets are identical. */
  const key = `${workspace}|${id}|${folderId}|${suffix}|${marketplaceUrl}`
  const hit = force ? null : readCache()
  if (hit && hit.key === key && Date.now() - hit.at < CACHE_MS) {
    /* A stored answer is the same arithmetic over the same rows — and no request, not
       even for the landing links, which travel with the readings. */
    return { ...aggregate(hit.value), cached: true, reads: 0, readAt: new Date(hit.at).toISOString() }
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
  /* One request per spreadsheet that is new or changed, then everything comes off
     this machine's disk. `force` — the Refresh button — throws the copies away first,
     which is the only path that spends a download per file on purpose. */
  progress.phase = 'downloading'
  progress.total = files.length
  progress.read = 0
  const copied = await local.ensure(files, {
    folderId,
    token,
    force,
    onEach: (done) => {
      progress.read = done
    },
  })
  progress.phase = 'reading'
  progress.read = 0
  const readings = files.map((file) => readSheet(file, suffix, folderId))
  progress.phase = ''

  /* A file that could not be copied is not a silent zero: it is named in the answer,
     and the page says which one, exactly as an unreadable sheet did. */
  const failed = copied.failed.map((entry) => `${entry.name}: ${String(entry.error?.message || entry.error)}`)
  /* Every file failing is not a dashboard with no sales: it is a token, a folder or a
     network that did not work, and the page has a sentence and a button for that. */
  if (files.length && copied.failed.length === files.length) throw refusal(copied.failed[0].error)

  /* The marketplace is a nicety: a failed fetch keeps the links the previous read
     resolved, and the numbers never depend on it.

     The names handed to `linkMap` are the readings' — each one already decoded and
     stripped of the ` - Transactions` suffix — not `files[].name`, which is the raw
     Drive label (`Kreasi AI &amp; Co - Transactions`). A raw name never matches a
     marketplace title, so passing it resolved nothing: 0 of 70 products had a
     landing link. With the stripped, decoded name, the match is a match. */
  const hosts = landing.landingHosts(marketplaceUrl)
  const links = landing.linkMap(
    readings.map((reading) => ({ id: reading.id, name: reading.name })),
    await landing.readMarketplace({ url: marketplaceUrl }),
    hit?.value?.links,
    hosts,
  )
  const value = {
    readings,
    files: files.map((file) => ({ id: file.id, name: file.name })),
    links,
    failed: copied.failed.length,
    ms: Date.now() - started,
    folderId,
    suffix,
    marketplaceUrl,
  }
  writeCache(key, value)
  return {
    ...aggregate(value),
    cached: false,
    reads: files.length,
    downloads: { pulled: copied.downloaded, reused: copied.reused },
    failed,
    readAt: new Date().toISOString(),
  }
}

module.exports = { folders, testFolder, dashboard, forgetCache, progressOf, cacheTtlMs, CACHE_MS, aggregate, rowsOf, readableHeader }
