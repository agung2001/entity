/**
 * One news read, five things it must not get wrong.
 *
 * `fetch` is the only stub: the store's own rules (HTML refusal, per-feed failure
 * isolation, snapshot atomicity) are what is under test, and a fake HTTP layer
 * would test the fake instead. `node --test tests/unit/news-feed.test.cjs`.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-news-'))
process.env.ENTITY_HOME = HOME
const workspaces = require('../../electron/workspace-store.cjs')
const connectors = require('../../electron/connector-store.cjs')
const news = require('../../electron/news-store.cjs')
const FILE = path.join(HOME, 'workspaces', 'acme', news.FILE)

const RSS = `<rss version="2.0" xmlns:ht="https://trends.google.com/"><channel><title>Daily</title>
<item><title>Kereta cepat</title><link>https://example.test/a</link><pubDate>Tue, 09 Feb 2027 09:31:00 GMT</pubDate><ht:approx_traffic>+5,000%</ht:approx_traffic></item>
<item><title>Second</title><link>https://example.test/b</link><pubDate>Tue, 09 Feb 2027 08:00:00 GMT</pubDate></item></channel></rss>`
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom one</title>
<link rel="alternate" href="https://example.test/c"/><published>2027-02-10T01:00:00Z</published></entry></feed>`

/* The whole network in one place: a URL names its answer, nothing leaves here. */
let routes = {}
global.fetch = async (url) => {
  const hit = routes[url]
  if (hit instanceof Error) throw hit
  return new Response(hit.body, { status: hit.status || 200, statusText: hit.statusText || 'OK' })
}
const seed = (feeds) => {
  fs.rmSync(path.join(HOME, 'workspaces', 'acme'), { recursive: true, force: true })
  workspaces.create({ label: 'acme' })
  for (const [id, url] of Object.entries(feeds)) connectors.add({ workspace: 'acme', id, label: id, kind: 'rss', url })
}

test('RSS parses to rank, link, ISO date, and no invented volume', async () => {
  seed({ daily: 'https://example.test/rss' })
  routes = { 'https://example.test/rss': { body: RSS } }
  const read = await news.read({ workspace: 'acme' })
  assert.equal(read.feeds[0].status, 'ok')
  assert.deepEqual(read.items.map((item) => item.rank), [1, 2])
  assert.equal(read.items[0].title, 'Kereta cepat')
  assert.equal(read.items[0].url, 'https://example.test/a')
  assert.equal(read.items[0].published, '2027-02-09T09:31:00.000Z')
  assert.equal(read.items[0].volume, '')
  /* One ceiling per feed, applied between the parse and the snapshot: a feed that
     carries two items and is told to carry one contributes one. */
  connectors.setFields({ workspace: 'acme', id: 'daily', fields: { itemLimit: 1 } })
  const capped = await news.read({ workspace: 'acme', refresh: true })
  assert.equal(capped.items.length, 1, 'the feed’s own item limit caps what enters the snapshot')
  assert.equal(capped.feeds[0].count, 1, 'the chip counts the items that entered, not the ones the feed holds')
})

test('Atom entries parse without an XML library', async () => {
  seed({ atom: 'https://example.test/atom' })
  routes = { 'https://example.test/atom': { body: ATOM } }
  const read = await news.read({ workspace: 'acme' })
  assert.deepEqual(
    read.items.map((item) => [item.title, item.url, item.published]),
    [['Atom one', 'https://example.test/c', '2027-02-10T01:00:00.000Z']],
  )
})

test('a page that answers HTML is refused with the reason on the row', async () => {
  seed({ page: 'https://example.test/page' })
  routes = { 'https://example.test/page': { body: '<!doctype html><html>hi</html>' } }
  const read = await news.read({ workspace: 'acme', refresh: true })
  assert.equal(read.items.length, 0)
  assert.match(read.feeds[0].error, /^page answered HTML, not a feed$/)
})

test('one feed failing leaves the other feed readable', async () => {
  seed({ good: 'https://example.test/good', bad: 'https://example.test/bad' })
  routes = {
    'https://example.test/good': { body: RSS },
    'https://example.test/bad': { body: '', status: 429, statusText: 'Too Many Requests' },
  }
  const read = await news.read({ workspace: 'acme', refresh: true })
  assert.equal(read.items.length, 2)
  assert.match(read.feeds.find((feed) => feed.id === 'bad').error, /^bad returned 429 Too Many Requests$/)
})

test('every feed failing keeps the last good snapshot instead of blanking it', async () => {
  seed({ good: 'https://example.test/good' })
  routes = { 'https://example.test/good': { body: RSS } }
  const first = await news.read({ workspace: 'acme' })
  routes = { 'https://example.test/good': new Error('getaddrinfo ENOTFOUND') }
  const again = await news.read({ workspace: 'acme', refresh: true })
  assert.equal(again.stale, true)
  assert.equal(again.readAt, first.readAt)
  assert.equal(again.items.length, 2)
  assert.equal(JSON.parse(fs.readFileSync(FILE, 'utf8')).readAt, first.readAt)
})
