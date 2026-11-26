/**
 * The workbook reader, pinned with a workbook the test writes itself.
 *
 * The fixture is a real `.xlsx` — a ZIP of XML built with `yazl`, which the app
 * already ships — so these assertions exercise the same path a Drive export takes:
 * central directory, deflate, relationships, shared strings, cell references. What
 * they protect is the failure that sent this file into existence: a folder of seventy
 * spreadsheets read through the Sheets API is 140 reads against a 60-a-minute quota,
 * and the local copy is only a fix if it parses the same values the API answered.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const yazl = require('yazl')

const xlsx = require('../../electron/connectors/lynk/xlsx.cjs')

/** Build an `.xlsx` in memory: `{ path: xml }` → Buffer. */
function zip(parts) {
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

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <workbookPr/>
  <sheets>
    <sheet name="Products" sheetId="1" r:id="rId1"/>
    <sheet name="Nov 2026 - Transactions" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://lynk.id" TargetMode="External"/>
</Relationships>`

const SHARED = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">
  <si><t>Tanggal</t></si>
  <si><t>Total</t></si>
  <si><t>Andi &amp; Budi</t></si>
  <si><r><t>Split</t></r><r><t xml:space="preserve"> Name</t></r></si>
</sst>`

/* Cells are deliberately out of order (`A`, `C`, then `B`) and one row is skipped:
   an export writes sparse, and a reader that trusts arrival order puts a price under
   the date. */
const SHEET2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>Email</t></is></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2"><v>46000</v></c><c r="C2" t="s"><v>2</v></c><c r="B2"><v>3000000</v></c></row>
    <row r="3"><c r="A3" t="inlineStr"><is><t>2026-11-02</t></is></c><c r="B3" t="s"><v>3</v></c></row>
    <row r="5"><c r="A5" t="inlineStr"><is><t>after a gap</t></is></c></row>
  </sheetData>
</worksheet>`

const SHEET1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`

async function fixture({ without = [] } = {}) {
  const parts = {
    '[Content_Types].xml': CONTENT_TYPES,
    'xl/workbook.xml': WORKBOOK,
    'xl/_rels/workbook.xml.rels': RELS,
    'xl/sharedStrings.xml': SHARED,
    'xl/worksheets/sheet1.xml': SHEET1,
    'xl/worksheets/sheet2.xml': SHEET2,
  }
  for (const name of without) delete parts[name]
  return zip(parts)
}

test('the workbook names its sheets and resolves each to a part', async () => {
  const book = xlsx.workbook(await fixture())
  assert.deepEqual(
    book.sheets.map((sheet) => sheet.name),
    ['Products', 'Nov 2026 - Transactions'],
    'sheet names, in tab order',
  )
  assert.equal(book.sheets[1].path, 'xl/worksheets/sheet2.xml', 'an r:id resolves to a part')
  assert.equal(book.date1904, false, 'the 1900 date system is the default')
})

test('a worksheet reads by cell reference, not by arrival order', async () => {
  const buffer = await fixture()
  const book = xlsx.workbook(buffer)
  const grid = xlsx.rows(buffer, book.sheets[1].path, book)
  assert.deepEqual(grid[0], ['Tanggal', 'Total', 'Email'], 'header, placed by column')
  assert.deepEqual(grid[1], [46000, 3000000, 'Andi & Budi'], 'numbers stay numbers, entities decode')
  assert.deepEqual(grid[2], ['2026-11-02', 'Split Name'], 'rich text runs join, a text date stays text')
  /* Row 4 is absent from the file and must stay absent rather than shift row 5 up. */
  assert.deepEqual(grid[3], [])
  assert.deepEqual(grid[4], ['after a gap'])
})

test('a date column is a serial the caller turns into a civil day', () => {
  assert.equal(xlsx.serialDay(46000), '2025-12-09', '1900 system, counted from 1899-12-30')
  assert.equal(xlsx.serialDay(46000, true), '2029-12-10', 'the 1904 system is four years and a day later')
  /* A `Tanggal` cell carries a time of day in the fraction: 46286.95 is the 21st at
     22:53, and rounding it would file the sale on the 22nd. */
  assert.equal(xlsx.serialDay(46286.95), '2026-09-21', 'the integer part is the day')
  assert.equal(xlsx.serialDay(46286.0001), '2026-09-21')
  /* Excel keeps a fake 1900-02-29; the civil date it collides with is the honest one. */
  assert.equal(xlsx.serialDay(60), '1900-02-28')
  for (const empty of [0, -1, '', null, undefined, Number.NaN]) {
    assert.equal(xlsx.serialDay(empty), '', `${String(empty)} is not a day`)
  }
})

test('a workbook without a workbook part says so, instead of answering empty', async () => {
  assert.throws(() => xlsx.workbook(Buffer.from('not a zip at all')), /not a readable \.xlsx/)
  const empty = await zip({ '[Content_Types].xml': CONTENT_TYPES })
  assert.throws(() => xlsx.workbook(empty), /no workbook part/)
})

test('a missing part is empty, never an exception', async () => {
  const buffer = await fixture({ without: ['xl/sharedStrings.xml'] })
  const book = xlsx.workbook(buffer)
  const grid = xlsx.rows(buffer, book.sheets[1].path, book)
  /* No shared table: the `t="s"` cells have no string to point at, so they are blank
     and the literal cells still read. */
  assert.deepEqual(grid[0], ['', '', 'Email'])
  assert.equal(grid[1][2], '')
  assert.equal(grid[1][1], 3000000)
})
