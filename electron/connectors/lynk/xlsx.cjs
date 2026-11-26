/**
 * A workbook, read on this machine.
 *
 * **Why this exists.** Sheets' quota is 60 read requests a minute for one person, and
 * a folder of seventy spreadsheets is *two* reads each — one `spreadsheets.get` to find
 * the ` - Transactions` tab, one `values.get` to read it. That is 140 reads for one
 * dashboard, so the tab either crawls under a self-imposed pace or answers `429
 * RESOURCE_EXHAUSTED`. Drive's export endpoint is **one request per file** against a
 * quota a hundred times larger, so the bytes come down once, land on disk, and this
 * file reads them.
 *
 * **No dependency.** An `.xlsx` is a ZIP of XML: `node:zlib` inflates the entries and
 * the three parts we need — the workbook, its relationships, and one worksheet plus
 * the shared-string table — are regular enough to parse directly. That keeps the
 * install as it is, and it means the reader is small enough to test with a fixture
 * built in the test itself (`yazl`, already a dependency, writes it).
 *
 * **What it deliberately is not.** A spreadsheet engine. It returns raw cells —
 * strings, numbers, booleans — and does not apply number formats: a date is the serial
 * the file stores, and `serialDay()` turns it into a civil date when the caller knows
 * the column is a date. Guessing a format from `styles.xml` would be a second, worse
 * copy of the sheet's own meaning.
 */
const zlib = require('node:zlib')

/* ── the zip ─────────────────────────────────────────────────────────────
   Only what a workbook needs: the central directory is authoritative for sizes (a
   local header may carry zeroes and a trailing data descriptor), so entries are
   located from the directory and read from their local headers. */

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

/** The end-of-central-directory record, found from the end because it is last. */
function endOfDirectory(buffer) {
  /* 22 bytes of record plus a comment of at most 64 KiB. */
  const floor = Math.max(0, buffer.length - 66_000)
  for (let at = buffer.length - 22; at >= floor; at -= 1) {
    if (buffer.readUInt32LE(at) === EOCD) {
      return { count: buffer.readUInt16LE(at + 10), offset: buffer.readUInt32LE(at + 16) }
    }
  }
  throw new Error('This file is not a readable .xlsx — no zip directory was found.')
}

/** Every entry's name, method and byte range, in one pass over the directory. */
function entries(buffer) {
  const end = endOfDirectory(buffer)
  const found = new Map()
  let at = end.offset
  for (let index = 0; index < end.count; index += 1) {
    if (buffer.readUInt32LE(at) !== CENTRAL) break
    const method = buffer.readUInt16LE(at + 10)
    const compressed = buffer.readUInt32LE(at + 20)
    const size = buffer.readUInt32LE(at + 24)
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    const local = buffer.readUInt32LE(at + 42)
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength)
    found.set(name, { method, compressed, size, local })
    at += 46 + nameLength + extraLength + commentLength
  }
  return found
}

/**
 * One entry's bytes.
 *
 * A directory of names is parsed once and handed back, because a workbook reads
 * several parts of the same archive and re-scanning it per part is the slow way to
 * do the same work twice.
 */
function entryBytes(buffer, directory, name) {
  const entry = directory.get(name)
  if (!entry) return null
  const localNameLength = buffer.readUInt16LE(entry.local + 26)
  const localExtraLength = buffer.readUInt16LE(entry.local + 28)
  const start = entry.local + 30 + localNameLength + localExtraLength
  const raw = buffer.subarray(start, start + entry.compressed)
  /* Method 0 is stored, 8 is deflate; anything else (LZMA, zstd) is not a workbook
     this app wrote or Google exported. */
  if (entry.method === 0) return raw
  if (entry.method === 8) return zlib.inflateRawSync(raw)
  throw new Error(`This .xlsx entry uses an unreadable compression method (${entry.method}).`)
}

/* ── the xml ─────────────────────────────────────────────────────────────
   Attribute-order-independent tag reading, and the five entities plus numeric
   references. Text cells are the only place a workbook carries prose, and an
   unescaped `&amp;` in a product name is a row that would otherwise vanish. */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name] ?? whole
  })
}

/** The attributes of one tag, as a plain object. */
function attrs(tag) {
  const out = {}
  const pattern = /([\w:.-]+)\s*=\s*"([^"]*)"/g
  let match
  while ((match = pattern.exec(tag))) out[match[1]] = decode(match[2])
  return out
}

/** Every `<t>` inside a fragment, joined: a rich-text `si` is several runs. */
function textOf(fragment) {
  let out = ''
  const pattern = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g
  let match
  while ((match = pattern.exec(fragment))) out += decode(match[1])
  return out
}

/* ── the parts ─────────────────────────────────────────────────────────── */

/** `xl/_rels/workbook.xml.rels`: rId → part path, resolved against `xl/`. */
function relationships(xml) {
  const rels = new Map()
  const pattern = /<Relationship\b[^>]*>/g
  let match
  while ((match = pattern.exec(xml))) {
    const said = attrs(match[0])
    if (!said.Id || !said.Target) continue
    if (String(said.TargetMode || '').toLowerCase() === 'external') continue
    const target = said.Target.startsWith('/') ? said.Target.slice(1) : `xl/${said.Target}`
    /* `../worksheets/…` appears in workbooks written by other tools; normalise it. */
    rels.set(said.Id, target.replace(/[^/]+\/\.\.\//g, ''))
  }
  return rels
}

/**
 * The workbook: whether it counts dates from 1904, and its sheets in tab order.
 *
 * `path` is the worksheet part inside the archive, already resolved through the
 * relationships — a `<sheet>` names an `r:id`, never a file.
 */
function workbook(buffer) {
  const directory = entries(buffer)
  const book = entryBytes(buffer, directory, 'xl/workbook.xml')
  if (!book) throw new Error('This .xlsx has no workbook part, so it is not a spreadsheet.')
  const bookXml = book.toString('utf8')
  const relsXml = (entryBytes(buffer, directory, 'xl/_rels/workbook.xml.rels') || Buffer.from('')).toString('utf8')
  const rels = relationships(relsXml)
  const pr = /<workbookPr\b[^>]*>/.exec(bookXml)
  const date1904 = pr ? /date1904\s*=\s*"(1|true)"/i.test(pr[0]) : false

  const sheets = []
  const pattern = /<sheet\b[^>]*>/g
  let match
  while ((match = pattern.exec(bookXml))) {
    const said = attrs(match[0])
    const rel = said['r:id'] || said.id || ''
    const target = rels.get(rel) || ''
    if (!said.name) continue
    sheets.push({ name: said.name, path: target })
  }
  return { date1904, sheets, directory, buffer }
}

/** The shared-string table, indexed by the number a `t="s"` cell holds. */
function sharedStrings(buffer, directory) {
  const part = entryBytes(buffer, directory, 'xl/sharedStrings.xml')
  if (!part) return []
  const xml = part.toString('utf8')
  const out = []
  const pattern = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g
  let match
  while ((match = pattern.exec(xml))) out.push(textOf(match[1] || ''))
  return out
}

/** `A` → 0, `AA` → 26: the column index a cell reference names. */
function columnOf(ref) {
  const letters = /^([A-Z]+)/.exec(String(ref || '').toUpperCase())
  if (!letters) return -1
  let index = 0
  for (const letter of letters[1]) index = index * 26 + (letter.charCodeAt(0) - 64)
  return index - 1
}

/** The cell's value in the type it was stored as: a string, a number, a boolean. */
function valueOf(cell, shared) {
  const said = attrs(cell)
  const type = String(said.t || '')
  if (type === 'inlineStr') {
    const inner = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(cell)
    return inner ? textOf(inner[1]) : ''
  }
  const value = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cell)
  if (!value) return ''
  const raw = decode(value[1])
  if (type === 's') {
    const index = Number(raw)
    return Number.isInteger(index) ? shared[index] ?? '' : ''
  }
  if (type === 'b') return raw === '1'
  if (type === 'str' || type === 'e') return raw
  /* A plain cell is a number, and a sheet cell holding `0031` is a number too: the
     caller decides what a number means (a count, money, or a date serial). */
  const number = Number(raw)
  return Number.isFinite(number) && raw.trim() !== '' ? number : raw
}

/**
 * One worksheet as rows of cells.
 *
 * Rows and cells are placed by their own references, never by arrival order: an
 * export skips empty cells, and a row that is silently shifted left is a price in
 * the date column. Gaps become `''` so every row is index-aligned with the header.
 */
function rows(buffer, sheetPath, sheet = workbook(buffer)) {
  const directory = sheet.directory || entries(buffer)
  const part = entryBytes(buffer, directory, sheetPath)
  if (!part) return []
  const shared = sharedStrings(buffer, directory)
  const xml = part.toString('utf8')
  const grid = []
  const rowPattern = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g
  let row
  while ((row = rowPattern.exec(xml))) {
    const said = attrs(`<row${row[1]}>`)
    const index = Number(said.r) - 1
    const cells = []
    const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    let cell
    while ((cell = cellPattern.exec(row[2] || ''))) {
      const ref = attrs(`<c${cell[1]}>`).r
      const column = columnOf(ref)
      if (column < 0) {
        cells.push(valueOf(cell[0], shared))
        continue
      }
      while (cells.length < column) cells.push('')
      cells[column] = valueOf(cell[0], shared)
    }
    const target = Number.isInteger(index) && index >= 0 ? index : grid.length
    while (grid.length < target) grid.push([])
    grid[target] = cells
  }
  return grid
}

/**
 * The civil date a workbook's serial stands for.
 *
 * Excel counts from 1899-12-30 because of its two historical leap-year bugs; the
 * 1904 system counts from 1904-01-01. Both are read from the workbook, never assumed,
 * because a four-year offset is indistinguishable from a wrong export.
 *
 * **The integer part is the day and the fraction is the time.** A `Tanggal` cell that
 * reads 46286.95 is 21 September at 22:53, so the day is `floor` — rounding it lands a
 * transaction on the 22nd, which is a report that disagrees with the sheet it came from.
 */
function serialDay(serial, date1904 = false) {
  const value = Number(serial)
  if (!Number.isFinite(value) || value <= 0) return ''
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)
  const at = epoch + Math.floor(value) * 86_400_000
  const date = new Date(at)
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : ''
}

module.exports = { workbook, rows, sharedStrings, serialDay, columnOf, entries }
