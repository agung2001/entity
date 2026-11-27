/**
 * The app's own LAN server: the built renderer, the call table, and the run
 * events, on every interface.
 *
 * Why it exists. The Tailscale card starts `npm run dev:lan` — the checkout's own
 * Vite server — which is right where there is a checkout and impossible in the app
 * a person downloads. A packaged build has no `node_modules`, no `npm`, and its
 * `package.json` lives *inside* `app.asar`, which is a file: `spawn(npm, …, { cwd:
 * …/app.asar })` throws `ENOTDIR` before Vite is ever consulted. That was the first
 * shape of this feature, and every Start in the shipped app failed with
 * `spawn ENOTDIR` — a stack trace where a page should be.
 *
 * A phone does not want HMR; it wants the page. So when there is no checkout, this
 * serves `dist/` — the same bundle the window is running — and answers the two
 * endpoints the renderer's browser bridge already speaks:
 *
 *   POST /__entity/call     the whole call table, exactly as Vite mounts it
 *   GET  /__entity/events   the run events, as Server-Sent Events
 *
 * Trust. This binds every interface and authenticates nobody, which is precisely
 * what the dev server it replaces did — that is why the card says so, in place, and
 * offers Stop. The `Host` header is checked the way Vite checks `allowedHosts`: a
 * name that is not `localhost`, a literal IP, or a tailnet name is refused with 403.
 * Without that check a DNS name pointing at this machine could read the call table
 * from a browser on the LAN — the rebinding hole the check exists to close.
 *
 * Nothing here reaches the network itself, writes a setting, or knows a
 * credential: it is a file server and a socket for the table this process already
 * has.
 */
const http = require('node:http')
const net = require('node:net')
const { createStatic } = require('../../../server/static.cjs')

/* A prompt is text; 2 MB matches the limit `vite.config.js` enforces. */
const BODY_LIMIT = 2 * 1024 * 1024
/* Every MagicDNS name ends in `.ts.net` (one length-prefixed label per tailnet),
   so this one entry covers a tailnet whose suffix the daemon did not name. */
const TAILNET_SUFFIX = 'ts.net'
const BLOCKED = 'Blocked request. This host is not allowed.\n'
const TOO_BIG = 'Request body too large.'

/** `Host` with its port and IPv6 brackets taken off, lowercased. */
function bareHost(header) {
  const raw = String(header || '').trim().toLowerCase()
  if (!raw) return ''
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(raw)
  if (bracketed) return bracketed[1]
  /* A bare IPv6 literal has no `host:port` shape to strip — and no port either. */
  if (net.isIPv6(raw)) return raw
  return raw.replace(/:\d+$/, '')
}

/**
 * Would Vite have served this request? `localhost`, a literal IP (what
 * `npm run dev:lan` prints and what the QR falls back to) and any name under a
 * tailnet suffix are allowed; everything else is a name somebody pointed here.
 */
function hostAllowed(header, suffixes = []) {
  const host = bareHost(header)
  if (!host) return false
  if (host === 'localhost') return true
  if (net.isIP(host)) return true
  return [TAILNET_SUFFIX, ...suffixes]
    .map((suffix) => String(suffix || '').trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean)
    .some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        const error = new Error(TOO_BIG)
        error.code = 'E_BODY'
        reject(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Build the server without listening: `listen(port)` is a separate step so the
 * caller can report a taken port in its own words.
 *
 * `call` is the process's call table (`rpc.call`), not a copy of it. `publish` is
 * handed to every open stream; whoever owns the table calls it once per event.
 */
function createLanServer({ distDir, suffixes = [], call = null } = {}) {
  const statics = createStatic({ distDir })
  const clients = new Set()

  function publish(event) {
    if (!clients.size) return
    const frame = `data: ${JSON.stringify(event)}\n\n`
    for (const res of clients) {
      try {
        res.write(frame)
      } catch {
        clients.delete(res)
      }
    }
  }

  function json(res, status, payload) {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  }

  async function entity(req, res, url) {
    if (url.pathname === '/__entity/events') {
      res.statusCode = 200
      res.setHeader('content-type', 'text/event-stream; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.setHeader('connection', 'keep-alive')
      res.write(': connected\n\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }
    if (url.pathname === '/__entity/call' && req.method === 'POST') {
      if (typeof call !== 'function') {
        return json(res, 503, { ok: false, error: 'This build has no call table to answer with.' })
      }
      let payload = {}
      try {
        const raw = await readBody(req)
        payload = raw ? JSON.parse(raw) : {}
      } catch (error) {
        return json(res, 400, { ok: false, error: error?.code === 'E_BODY' ? TOO_BIG : 'Malformed JSON body.' })
      }
      const result = await call(payload?.fn, payload?.args)
      return json(res, result?.ok ? 200 : 400, result || { ok: false, error: 'That call answered nothing.' })
    }
    return json(res, 404, { ok: false, error: 'Unknown local endpoint.' })
  }

  async function handle(req, res) {
    if (!hostAllowed(req.headers.host, suffixes)) {
      res.statusCode = 403
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(BLOCKED)
      return
    }
    let url
    try {
      url = new URL(req.url || '/', 'http://localhost')
    } catch {
      res.statusCode = 400
      res.end()
      return
    }
    if (url.pathname.startsWith('/__entity/')) return entity(req, res, url)
    if (statics.serve(req, res, url)) return
    res.statusCode = 404
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end('Not found.\n')
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.statusCode = 500
      res.end()
    })
  })
  /* A client that hangs up mid-request is normal on a phone; it is not an error
     this process should log or throw. */
  server.on('clientError', (_error, socket) => socket.destroy())

  return {
    publish,
    listen(port) {
      return new Promise((resolve, reject) => {
        const failed = (error) => {
          server.off('listening', done)
          reject(error)
        }
        const done = () => {
          server.off('error', failed)
          resolve()
        }
        server.once('error', failed)
        server.once('listening', done)
        server.listen({ host: '0.0.0.0', port })
      })
    },
    /* Every open event stream would otherwise hold `close()` forever. */
    close() {
      for (const res of clients) {
        try {
          res.end()
        } catch {
          /* already gone */
        }
      }
      clients.clear()
      return new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
    address: () => server.address(),
  }
}

module.exports = { createLanServer, hostAllowed, bareHost, BLOCKED }
