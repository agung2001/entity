/**
 * The copied folder, and the two buttons that change it.
 *
 * The read path itself was measured against the real folder: 70 spreadsheets, one
 * Drive export each (11 s cold), then 485 ms with **zero** per-file requests while the
 * numbers stayed identical to the Sheets API's (18 tabs, 73 orders, Rp 3.038.000). This
 * file pins the part that is easy to get wrong and impossible to see from the page:
 * which copies are reused, which are taken again, and what `Refresh` throws away.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const yazl = require('yazl')

/* `local.cjs` resolves ENTITY_HOME at load, so this must be set before the require —
   the same rule every store in `electron/` follows. */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-lynk-'))
process.env.ENTITY_HOME = HOME

const local = require('../../electron/connectors/lynk/local.cjs')

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }))

/** One workbook: a header this reader can read, and one sale. */
function workbookBytes(tabName, price = 49000) {
  const parts = {
    'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr/><sheets><sheet name="${tabName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>Judul</t></is></c><c r="B1" t="inlineStr"><is><t>Harga</t></is></c><c r="C1" t="inlineStr"><is><t>Tanggal</t></is></c></row>
      <row r="2"><c r="A2" t="inlineStr"><is><t>Produk</t></is></c><c r="B2"><v>${price}</v></c><c r="C2"><v>46286.95</v></c></row>
    </sheetData></worksheet>`,
  }
  const file = new yazl.ZipFile()
  for (const [name, body] of Object.entries(parts)) file.addBuffer(Buffer.from(body), name)
  file.end()
  const chunks = []
  file.outputStream.on('data', (chunk) => chunks.push(chunk))
  return new Promise((resolve, reject) => {
    file.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
    file.outputStream.on('error', reject)
  })
}

/* The header test the dashboard hands in: a date column and a price column. */
const usable = (grid) => {
  const head = (grid?.[0] || []).map((cell) => String(cell ?? '').trim())
  return head.some((h) => /tanggal|date/i.test(h)) && head.some((h) => /^harga|^total/i.test(h))
}

/* A Drive export is a GET to `…/files/<id>/export`; the stub counts them and can be
   told to fail one file, which is how a partial read is tested. */
function stubFetch(books) {
  const calls = []
  globalThis.fetch = async (url) => {
    const id = String(url).match(/files\/([^/]+)\/export/)?.[1] || ''
    calls.push(id)
    const bytes = books[id]
    if (!bytes) return { ok: false, status: 404, text: async () => 'not found' }
    return { ok: true, status: 200, arrayBuffer: async () => bytes }
  }
  return calls
}

const FILES = [
  { id: 'aaa', name: 'Obsidian', modifiedTime: '2026-11-01T00:00:00Z' },
  { id: 'bbb', name: 'Viral Hook Architect', modifiedTime: '2026-11-02T00:00:00Z' },
]

test('the first read copies every file, and the second copies none', async () => {
  const books = {
    aaa: await workbookBytes('Obsidian - Transactions'),
    /* Google's export applies Excel's 31-character limit, so this is what a long
       product's tab really looks like. */
    bbb: await workbookBytes('Viral Hook Architect - Transact', 79000),
  }
  const calls = stubFetch(books)

  const first = await local.ensure(FILES, { folderId: 'folder1', token: 'token' })
  assert.deepEqual({ downloaded: first.downloaded, reused: first.reused, failed: first.failed.length }, { downloaded: 2, reused: 0, failed: 0 })
  assert.equal(calls.length, 2, 'one export per file, not one per tab')

  const second = await local.ensure(FILES, { folderId: 'folder1', token: 'token' })
  assert.deepEqual({ downloaded: second.downloaded, reused: second.reused }, { downloaded: 0, reused: 2 })
  assert.equal(calls.length, 2, 'a second visit spends no request on a file it already holds')

  assert.deepEqual(
    local.read(FILES[0], { folderId: 'folder1', suffix: ' - Transactions', usable }).rows[1],
    ['Produk', 49000, 46286.95],
    'the copy reads back the cells the export held',
  )
})

test('a changed file is copied again, and only that one', async () => {
  const calls = stubFetch({
    aaa: await workbookBytes('Obsidian - Transactions'),
    bbb: await workbookBytes('Viral Hook Architect - Transact', 79000),
  })
  const changed = [{ ...FILES[0], modifiedTime: '2026-11-26T00:00:00Z' }, FILES[1]]
  const stats = await local.ensure(changed, { folderId: 'folder1', token: 'token' })
  assert.deepEqual({ downloaded: stats.downloaded, reused: stats.reused }, { downloaded: 1, reused: 1 })
  assert.deepEqual(calls, ['aaa'], 'the untouched file is not downloaded again')
})

test('Refresh throws the folder away and takes every file again', async () => {
  const calls = stubFetch({
    aaa: await workbookBytes('Obsidian - Transactions'),
    bbb: await workbookBytes('Viral Hook Architect - Transact', 79000),
  })
  const stats = await local.ensure(FILES, { folderId: 'folder1', token: 'token', force: true })
  assert.deepEqual({ downloaded: stats.downloaded, reused: stats.reused }, { downloaded: 2, reused: 0 })
  assert.deepEqual(calls.sort(), ['aaa', 'bbb'], 'Refresh is the one path that spends a download per file')
  assert.equal(local.readIndex('folder1').files.aaa.modifiedTime, FILES[0].modifiedTime)
})

test('a tab the export truncated is still the transactions tab', async () => {
  /* `Viral Hook Architect - Transactions` cannot survive as an Excel tab name, so the
     header decides — and the untruncated name still wins when it is there. */
  const book = local.read(FILES[1], { folderId: 'folder1', suffix: ' - Transactions', usable })
  assert.equal(book.tab, 'Viral Hook Architect - Transact')
  assert.equal(book.rows[1][1], 79000)
})

test('one file that cannot be downloaded is a row, not a dead page', async () => {
  const calls = stubFetch({ aaa: await workbookBytes('Obsidian - Transactions') })
  const stats = await local.ensure(FILES, { folderId: 'folder2', token: 'token' })
  assert.equal(stats.downloaded, 1)
  assert.equal(stats.failed.length, 1)
  assert.equal(stats.failed[0].id, 'bbb')
  assert.match(String(stats.failed[0].error.message), /404|answered/i)
  assert.deepEqual(calls.sort(), ['aaa', 'bbb'])
})

test('forgetting the folder deletes the copies, and the index with them', async () => {
  assert.ok(fs.existsSync(path.join(local.DIR, 'folder1')), 'the folder was copied')
  local.forget()
  assert.equal(fs.existsSync(local.DIR), false, 'the whole tree is gone')
  assert.deepEqual(local.readIndex('folder1').files, {}, 'and nothing claims to be cached')
})

test('a folder id cannot walk out of the cache directory', () => {
  const dir = local.dirOf('../../etc')
  assert.equal(dir.startsWith(local.DIR), true, 'the directory is under the cache root')
  assert.equal(dir.includes('..'), false)
})
