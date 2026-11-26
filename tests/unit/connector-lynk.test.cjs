/**
 * The two decisions a passing screen would hide: **the folder is the cache key**
 * (two workspaces pointing at two folders never share numbers) and **a free row
 * stays in the table** (a product that took no money is an order worth `Rp 0`).
 * Both are asserted against a hand-written cache file — no token, no network.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lynk-dash-'))
process.env.ENTITY_HOME = HOME
const lynk = require('../../electron/connectors/lynk/dashboard.cjs')

const FOLDER = '1AbCdEfGhIjKlMnOpQrStUvWxYz'
const SUFFIX = ' - Transactions'

fs.writeFileSync(
  path.join(HOME, 'lynk-dashboard.json'),
  JSON.stringify({
    /* The store's own schema: a hand-written answer has to be one the reader accepts,
       and bumping this number is what retires an answer written before a change. */
    schema: 3,
    /* `workspace|id|folder|suffix|marketplaceUrl` — the marketplace is part of the
       key because it decides what landing link every row carries. Empty is the
       default: this fixture's store has configured no marketplace document. */
    key: `ws|lynk|${FOLDER}|${SUFFIX}|`,
    at: Date.now(),
    value: {
      ms: 4200,
      folderId: FOLDER,
      suffix: SUFFIX,
      failed: 0,
      links: { ok: true, at: '2026-03-04T00:00:00.000Z', urls: {} },
      files: [{ id: 's1', name: 'Sticker Pack' }, { id: 's2', name: 'Free Sampler' }],
      /* One reading per spreadsheet, exactly the shape `readSheet()` writes: the
         report is derived from these, so a fixture that skips the long row shape is
         not testing the report. */
      readings: [
        {
          id: 's1',
          name: 'Sticker Pack',
          tab: 'Sticker Pack - Transactions',
          reason: '',
          rows: [
            { day: '2026-03-02', total: 75_000, qty: 1, title: 'Sticker Pack', variant: 'A3', status: 'SUCCESS', buyer: 'ada@example.test', name: 'Ada', list: 75_000, voucher: 0, fees: { affiliate: 0, notif: 0, convenience: 0 }, ref: 'REF-1' },
          ],
        },
        {
          id: 's2',
          name: 'Free Sampler',
          tab: 'Free Sampler - Transactions',
          reason: '',
          rows: [
            { day: '2026-03-03', total: 0, qty: 1, title: 'Free Sampler', variant: '', status: 'SUCCESS', buyer: 'blake@example.test', name: '', list: 0, voucher: 0, fees: { affiliate: 0, notif: 0, convenience: 0 }, ref: null },
          ],
        },
      ],
    },
  }),
)

test('a free row is an order worth Rp 0, and the folder is the cache key', async () => {
  const answer = await lynk.dashboard({ workspace: 'ws', folderId: FOLDER, suffix: SUFFIX, days: 90 })
  assert.equal(answer.cached, true)
  assert.equal(answer.totals.revenue, 75_000)
  assert.equal(answer.totals.orders, 2)
  assert.equal(answer.totals.paid, 1)

  const free = answer.products.find((product) => product.name === 'Free Sampler')
  assert.equal(free.revenue, 0)
  assert.equal(free.orders, 1)
  assert.equal(free.freeOrders, 1)

  /* Another folder is another question, so is another tab suffix, and so is another
     marketplace document — every row's landing link is resolved against it. None of
     the three may be served this answer, so all three go looking for a token and
     find no account. */
  const miss = /needs a Google account/
  await assert.rejects(lynk.dashboard({ workspace: 'ws', folderId: 'otherFolderId', suffix: SUFFIX }), miss)
  await assert.rejects(lynk.dashboard({ workspace: 'ws', folderId: FOLDER, suffix: ' - Sales' }), miss)
  await assert.rejects(
    lynk.dashboard({ workspace: 'ws', folderId: FOLDER, suffix: SUFFIX, marketplaceUrl: 'https://shop.example.test/m.json' }),
    miss,
  )
})
