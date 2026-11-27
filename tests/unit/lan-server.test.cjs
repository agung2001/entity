/* The LAN server a packaged app serves the renderer with: which `Host` headers it
   answers (the DNS-rebinding guard Vite's `allowedHosts` gives a checkout), and
   that the page, the call table and the event stream really answer over HTTP.
   No Tailscale and no daemon — a temp `dist/` and a stub call table. */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { createLanServer, hostAllowed } = require('../../electron/connectors/tailscale/lan-server.cjs')

const SUFFIX = 'acme-demo.ts.net'

test('localhost, a literal IP and a tailnet name answer; a pointed name does not', () => {
  for (const host of ['localhost:5183', '127.0.0.1:5183', '[::1]:5183', '100.101.102.103:5183', `avery.${SUFFIX}:5183`, 'avery.tail1.ts.net']) {
    assert.equal(hostAllowed(host, [SUFFIX]), true, host)
  }
  /* A name a LAN attacker points at this machine — the whole reason for the check
     — and the two ways a suffix check is written wrong. */
  for (const host of ['', undefined, 'evil.example.test', `evil${SUFFIX}.example.test`, 'ts.net.northwind.example']) {
    assert.equal(hostAllowed(host, [SUFFIX]), false, String(host))
  }
})

/** One request with a `Host` this process chooses: `fetch` drops the header. */
function request(port, { method = 'GET', path: target = '/', host = `localhost:${port}`, body, accept = '*/*' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: target, method, headers: { host, accept }, timeout: 5000 },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.once('timeout', () => {
      req.destroy()
      reject(new Error('the LAN server did not answer'))
    })
    req.once('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

async function serving(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-lan-'))
  fs.mkdirSync(path.join(dir, 'assets'))
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Entity</title>')
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1)')
  const calls = []
  const server = createLanServer({
    distDir: dir,
    suffixes: [SUFFIX],
    call: async (fn, args) => {
      calls.push({ fn, args })
      if (fn === 'boom') return { ok: false, error: 'nope', code: 'error' }
      return { ok: true, data: { fn, args } }
    },
  })
  await server.listen(0)
  const port = server.address().port
  try {
    await run({ port, server, calls })
  } finally {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('the page, a deep route and a missing asset answer as they would from Vite', async () => {
  await serving(async ({ port }) => {
    const root = await request(port, { accept: 'text/html' })
    assert.equal(root.status, 200)
    assert.match(root.body, /Entity/)

    /* History mode: a document path is the shell, an extension is a real 404.
       HTML for a missing `.js` is a blank screen with a MIME error. */
    const deep = await request(port, { path: '/acme/overview', accept: 'text/html' })
    assert.equal(deep.status, 200)
    assert.match(deep.body, /Entity/)
    const missing = await request(port, { path: '/assets/nope.js' })
    assert.equal(missing.status, 404)

    const asset = await request(port, { path: '/assets/app.js' })
    assert.equal(asset.status, 200)
    assert.match(asset.type, /javascript/)
  })
})

test('the call table answers, and a refusal keeps its code', async () => {
  await serving(async ({ port, calls }) => {
    const ok = await request(port, {
      method: 'POST',
      path: '/__entity/call',
      body: JSON.stringify({ fn: 'entity.list', args: { workspace: 'acme' } }),
    })
    assert.equal(ok.status, 200)
    assert.deepEqual(JSON.parse(ok.body), { ok: true, data: { fn: 'entity.list', args: { workspace: 'acme' } } })
    assert.equal(calls.length, 1)

    const refused = await request(port, { method: 'POST', path: '/__entity/call', body: JSON.stringify({ fn: 'boom' }) })
    assert.equal(refused.status, 400)
    const payload = JSON.parse(refused.body)
    assert.equal(payload.ok, false)
    /* The renderer picks a field over a band from `code`; dropping it makes every
       refusal look like a bug. */
    assert.equal(payload.code, 'error')

    const broken = await request(port, { method: 'POST', path: '/__entity/call', body: '{' })
    assert.equal(broken.status, 400)
    assert.match(JSON.parse(broken.body).error, /JSON/)
  })
})

test('a name that is not allowed is refused before the call table is reached', async () => {
  await serving(async ({ port, calls }) => {
    const blocked = await request(port, { host: `evil.example.test:${port}`, accept: 'text/html' })
    assert.equal(blocked.status, 403)
    assert.ok(!blocked.body.includes('Entity'))

    const posted = await request(port, {
      method: 'POST',
      path: '/__entity/call',
      host: `evil.example.test:${port}`,
      body: JSON.stringify({ fn: 'entity.list' }),
    })
    assert.equal(posted.status, 403)
    assert.equal(calls.length, 0)
  })
})

test('stop closes the event stream it was holding open', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-lan-'))
  fs.writeFileSync(path.join(dir, 'index.html'), 'ok')
  const server = createLanServer({ distDir: dir, suffixes: [SUFFIX], call: async () => ({ ok: true, data: null }) })
  await server.listen(0)
  const port = server.address().port
  const stream = http.get({ host: '127.0.0.1', port, path: '/__entity/events', headers: { host: `avery.${SUFFIX}` } })
  await new Promise((resolve) => stream.once('response', resolve))
  stream.on('error', () => {})
  /* A phone's SSE stream holds a socket forever; `close()` has to drop it or the
     stop button never settles. */
  await server.close()
  fs.rmSync(dir, { recursive: true, force: true })
  assert.ok(true)
})
