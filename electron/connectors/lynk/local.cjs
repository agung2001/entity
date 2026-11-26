/**
 * The folder on this machine: one `.xlsx` per spreadsheet, and the rows inside it.
 *
 * **The problem this answers.** Reading the folder through the Sheets API is two
 * requests per spreadsheet — one for its tabs, one for the tab's values — against a
 * quota of 60 reads a minute for one person. Seventy products is 140 reads, so the
 * dashboard either crawls under a self-imposed pace or answers `429
 * RESOURCE_EXHAUSTED`. `Refresh` made it worse by asking for all of them again.
 *
 * **The shape of the fix.** Drive's export endpoint hands over the whole workbook in
 * **one** request per file, against a quota a hundred times larger, and the bytes are
 * kept: `<ENTITY_HOME>/lynk-sheets/<folder>/<file>.xlsx` plus an index of the
 * `modifiedTime` each copy was taken at. A second visit re-reads the folder listing
 * (one request), sees nothing changed, and opens the local files — no Sheets call at
 * all, which is why the tab now opens instantly and cannot hit the limit.
 *
 * **What invalidates a copy.** Two things, and they are different buttons:
 *
 *   - the file changed in Drive (`modifiedTime` differs) — re-downloaded on the next
 *     read, so an edited sheet is never served from yesterday's bytes;
 *   - `Refresh` (`force`) — the folder's copies are deleted and taken again, because
 *     a person pressing it is saying "I do not believe what is on disk". That is the
 *     one path that spends a download per file, on purpose.
 *
 * **Nothing here decides what a cell means.** Rows come back exactly as the workbook
 * stored them (strings, numbers, booleans) with the sheet's own date system; the
 * column semantics — which cell is a date, which is money — stay in `dashboard.cjs`,
 * where the header names live.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const xlsx = require('./xlsx.cjs')

/* `ENTITY_HOME` first, like every other store: a test must never write the real home. */
const ROOT = process.env.ENTITY_HOME
  ? path.resolve(process.env.ENTITY_HOME)
  : path.join(os.homedir(), '.entity')
const DIR = path.join(ROOT, 'lynk-sheets')
const SCHEMA = 1
/** Google Sheets export to Office XML: one request, whole workbook. */
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
/** How many downloads may be in flight. Drive's ceiling is thousands a minute, so
    this is about being a good citizen rather than staying under a quota. */
const CONCURRENCY = 6
const QUOTA_RETRY_MS = 5_000
const QUOTA = /quota|rate limit|429|resource_exhausted|too many requests/i

/* A Drive id is `[A-Za-z0-9_-]`; anything else in a folder id is a path walking out
   of the cache directory, so the directory is named from the id and nothing else. */
const dirOf = (folderId) => path.join(DIR, String(folderId || '').replace(/[^\w-]/g, '').slice(0, 80) || 'folder')
const bookOf = (folderId, fileId) => path.join(dirOf(folderId), `${String(fileId).replace(/[^\w-]/g, '').slice(0, 80)}.xlsx`)
const indexPath = (folderId) => path.join(dirOf(folderId), 'index.json')

function emptyIndex() {
  return { schema: SCHEMA, at: 0, files: {} }
}

/** The index, honestly read: an unreadable or absent one is "nothing is cached". */
function readIndex(folderId) {
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath(folderId), 'utf8'))
    if (raw?.schema !== SCHEMA || !raw?.files || typeof raw.files !== 'object') return emptyIndex()
    return { schema: SCHEMA, at: Number(raw.at) || 0, files: raw.files }
  } catch {
    return emptyIndex()
  }
}

function writeIndex(folderId, index) {
  const target = indexPath(folderId)
  const staged = `${target}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    fs.writeFileSync(staged, `${JSON.stringify({ ...index, at: Date.now() }, null, 2)}\n`, 'utf8')
    fs.renameSync(staged, target)
  } catch {
    /* A copy that cannot be indexed is a copy the next read takes again. It is not a
       failed page, so nothing is thrown here. */
    try {
      fs.unlinkSync(staged)
    } catch {
      /* nothing was staged */
    }
  }
}

/** The failures a person can act on, in the same three shapes the app already names. */
function refusal(response, said) {
  if (response === 401 || /invalid_grant|Invalid Credentials/i.test(said)) {
    const error = new Error('@lynk: needs a sign-in — Google rejected the token. Sign in on the connector’s page.')
    error.signIn = true
    return error
  }
  if (/insufficient permission|insufficient_scope/i.test(said)) {
    return new Error(
      `@lynk: the connected account cannot download this folder — Google answered 401 ${said.slice(0, 140)}. Re-consent with drive.readonly.`,
    )
  }
  if (/has not been used in project|is disabled/i.test(said)) {
    return new Error(`@lynk: the Drive API is not enabled in this Google Cloud project — ${said.slice(0, 200)}`)
  }
  if (QUOTA.test(said)) {
    const error = new Error(
      `@lynk: Google is rate-limiting the download (${said.slice(0, 120)}). The sheets already on this machine are still usable; try again in a minute.`,
    )
    error.quota = true
    return error
  }
  return new Error(`@lynk: Google answered ${said.slice(0, 200)}`)
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** One workbook, downloaded as bytes. `files.export` is a GET with no range. */
async function download(file, token) {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(XLSX_MIME)}`
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
    if (response.ok) return Buffer.from(await response.arrayBuffer())
    const body = await response.text().catch(() => '')
    /* A quota answer is waited out once — the same rule the Sheets path had, now on
       a quota that a folder this size cannot exhaust. */
    if (attempt < 1 && (response.status === 429 || QUOTA.test(body))) {
      await wait(QUOTA_RETRY_MS)
      continue
    }
    throw refusal(response.status, body)
  }
}

function save(folderId, file, bytes) {
  const target = bookOf(folderId, file.id)
  const staged = `${target}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  fs.writeFileSync(staged, bytes)
  fs.renameSync(staged, target)
  return target
}

/**
 * Make every file available locally, downloading only what is missing or stale.
 *
 * `force` is `Refresh`: the folder's copies are discarded first, so every file is
 * taken again. Per-file failures are collected rather than thrown — one unreadable
 * spreadsheet is a row in the answer, not a dead page.
 */
async function ensure(files, { folderId = '', token = '', force = false, onEach = null } = {}) {
  const dir = dirOf(folderId)
  if (force) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* a directory that is already gone is the state force asked for */
    }
  }
  const index = readIndex(folderId)
  const stats = { downloaded: 0, reused: 0, failed: [] }
  let next = 0

  const one = async (file) => {
    const known = index.files[file.id]
    const book = bookOf(folderId, file.id)
    const fresh = known && known.modifiedTime === file.modifiedTime && fs.existsSync(book)
    if (fresh) {
      stats.reused += 1
      if (onEach) onEach(stats.downloaded + stats.reused)
      return
    }
    try {
      const bytes = await download(file, token)
      save(folderId, file, bytes)
      index.files[file.id] = { name: file.name, modifiedTime: file.modifiedTime, at: Date.now(), bytes: bytes.length }
      writeIndex(folderId, index)
      stats.downloaded += 1
    } catch (error) {
      stats.failed.push({ id: file.id, name: file.name, error })
    }
    if (onEach) onEach(stats.downloaded + stats.reused)
  }

  const run = async () => {
    while (next < files.length) {
      const file = files[next]
      next += 1
      await one(file)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, run))
  return stats
}

/* A parsed workbook is a few hundred kilobytes of objects; keeping the last few saves
   re-inflating the same file twice in one read (a test folder lists, then reads). */
const parsed = new Map()
const PARSED_KEYS = 8

/**
 * The transactions tab, and its rows.
 *
 * **The suffix names the tab, and the header settles it when the export mangles the
 * name.** Google's `.xlsx` export applies Excel's rules to tab names: it truncates to
 * 31 characters and replaces `:` — so `Viral Hook Architect - Transactions` arrives as
 * `Viral Hook Architect - Transact`, and `ClipMotive: AI-Powered …` loses the colon
 * *and* the suffix. Seven of this folder's tabs lost their ` - Transactions` that way,
 * which is why a name match alone read 11 of 18.
 *
 * So candidates are tried in order of how much the name proves — the full
 * `name + suffix`, then anything still ending with the suffix, then any tab whose
 * first row carries a date column and a price column — and `usable` (the caller's
 * header test) says which of them this reader can actually read. A workbook with no
 * such tab is `empty`, never an error: a product that never sold is a fact, and Lynk
 * writes a spreadsheet for it.
 */
function read(file, { folderId = '', suffix = '', usable = null } = {}) {
  const book = bookOf(folderId, file.id)
  let bytes
  try {
    bytes = fs.readFileSync(book)
  } catch {
    return { tab: '', rows: [], date1904: false, reason: 'not downloaded' }
  }
  try {
    const key = `${book}:${bytes.length}`
    let parts = parsed.get(key)
    if (!parts) {
      const workbook = xlsx.workbook(bytes)
      parts = { workbook, bytes }
      if (parsed.size >= PARSED_KEYS) parsed.delete(parsed.keys().next().value)
      parsed.set(key, parts)
    }
    const ending = String(suffix || '')
    const full = `${String(file.name || '').trim()}${ending}`
    const sheets = parts.workbook.sheets
    const order = [
      ...sheets.filter((sheet) => sheet.name === full),
      ...sheets.filter((sheet) => ending && sheet.name.endsWith(ending) && sheet.name !== full),
      ...sheets.filter((sheet) => !(ending && sheet.name.endsWith(ending)) && sheet.name !== full),
    ]
    const unmatched = []
    for (const sheet of order) {
      const grid = xlsx.rows(parts.bytes, sheet.path, parts.workbook)
      if (!usable || usable(grid)) {
        return { tab: sheet.name, rows: grid, date1904: parts.workbook.date1904 }
      }
      unmatched.push(sheet.name)
    }
    /* Nothing usable: the tab whose name still proves it is the honest answer, so the
       dashboard counts it as `unreadable` rather than `empty`. */
    const named = order.find((sheet) => ending && sheet.name.endsWith(ending))
    return { tab: named ? named.name : '', rows: [], date1904: parts.workbook.date1904, unmatched }
  } catch (error) {
    return { tab: '', rows: [], date1904: false, reason: 'unreadable', error }
  }
}

/** Whether every file of this folder is on disk, and when the oldest copy was taken. */
function copyOf(folderId, file) {
  const known = readIndex(folderId).files[file.id]
  return known && known.modifiedTime === file.modifiedTime && fs.existsSync(bookOf(folderId, file.id))
    ? known
    : null
}

/** Forget the copied workbooks — the whole tree, because the folder may have changed. */
function forget() {
  parsed.clear()
  try {
    fs.rmSync(DIR, { recursive: true, force: true })
  } catch {
    /* nothing to forget is the state this asked for */
  }
}

module.exports = { DIR, ensure, forget, read, copyOf, readIndex, download, dirOf }
