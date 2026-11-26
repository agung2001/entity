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
    schema: 2,
    key: `ws|lynk|${FOLDER}|${SUFFIX}`,
    at: Date.now(),
    value: {
      sheets: { total: 2, withTab: 2, empty: 0, unreadable: 0, failed: 0 },
      ms: 4200,
      folderId: FOLDER,
      suffix: SUFFIX,
      products: [{ name: 'Sticker Pack', id: 's1' }, { name: 'Free Sampler', id: 's2' }],
      rows: [
        { p: 'Sticker Pack', d: '2026-03-02', a: 75_000, b: 'ada@example.test' },
        { p: 'Free Sampler', d: '2026-03-03', a: 0, b: 'blake@example.test' },
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

  /* Another folder is another question, and so is another tab suffix: neither may
     be served this answer, so both go looking for a token and find no account. */
  const miss = /needs a Google account/
  await assert.rejects(lynk.dashboard({ workspace: 'ws', folderId: 'otherFolderId', suffix: SUFFIX }), miss)
  await assert.rejects(lynk.dashboard({ workspace: 'ws', folderId: FOLDER, suffix: ' - Sales' }), miss)
})
