const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-oauth-callback-page-'))
process.env.ENTITY_HOME = PROFILE

const { callbackPage } = require('../../electron/oauth-accounts.cjs')

const success = {
  kicker: 'Account connected',
  title: 'Gmail is connected',
  heading: 'Gmail is connected',
  facts: [
    ['Account', 'avery@example.test'],
    ['Access', 'Read mail — Read messages and threads. Cannot send, reply, or change anything.'],
    ['Token', 'This machine only. It never enters the workspace.'],
  ],
  body: 'Nothing else was requested from Google.',
  href: 'entity://open/#/demo-workspace/connectors/gmail',
  action: 'Open Entity',
  quiet: 'or close this tab — nothing else is needed here.',
}

test('the document is self-contained: no script, no request, one inlined face', () => {
  const html = callbackPage(success)
  assert.ok(html.startsWith('<!doctype html>'))
  assert.equal(html.includes('<script'), false)
  assert.equal(/\ssrc\s*=/.test(html), false)
  assert.equal(html.includes('@import'), false)
  /* The loopback server serves this document and nothing else, so `url(` may appear
     once — the inlined Geist face — or the page requests something that 404s (§9.4) */
  const urls = html.match(/url\([^)]*\)/g) || []
  assert.equal(urls.length, 1)
  assert.ok(urls[0].startsWith('url(data:font/woff2;base64,'))
})

test('a value on the callback URL cannot become markup', () => {
  const html = callbackPage({
    ...success,
    tone: 'fail',
    facts: [],
    body: 'Google answered something unexpected.',
    trace: '"><script>alert(1)</script>',
  })
  assert.ok(html.includes('&lt;script&gt;'))
  assert.equal(html.includes('<script'), false)
})

test('the receipt is Account, Access, Token in that order, and one real link', () => {
  const html = callbackPage(success)
  assert.deepEqual([...html.matchAll(/<dt>(.*?)<\/dt>/g)].map((match) => match[1]), ['Account', 'Access', 'Token'])
  assert.ok(html.includes('<b>avery@example.test</b>'))
  const anchors = [...html.matchAll(/<a\b[^>]*href="([^"]*)"/g)]
  assert.equal(anchors.length, 1)
  assert.ok(anchors[0][1].startsWith('entity://open/#/'))
  assert.ok(anchors[0][1].endsWith('/connectors/gmail'))
})
