/**
 * The server build.
 *
 * One process serves the built renderer, the shared call table and the sync
 * API. It is the same code the desktop app runs — entities, chats, artifacts and
 * the MCP pool are files under `ENTITY_HOME` — with two differences that matter:
 *
 *   1. Every call is authenticated. The Vite preview server has no login; that
 *      is fine on `localhost` and unacceptable on a public hostname.
 *   2. The account store is multi-user (`server-users.json`), not the desktop's
 *      single `auth.json`, so a teammate can sign in as themselves.
 *
 * Environment:
 *   ENTITY_HOME               data directory (default ~/.entity, /data in Docker)
 *   ENTITY_HOST / ENTITY_PORT bind address (default 0.0.0.0:8080)
 *   ENTITY_ADMIN_EMAIL        first administrator, created only on an empty store
 *   ENTITY_ADMIN_PASSWORD     its password (min 8 characters)
 *   ENTITY_ADMIN_NAME         optional display name
 *   ENTITY_SESSION_DAYS       session lifetime (default 30)
 *   ENTITY_SECURE_COOKIE      "true" forces Secure cookies behind a proxy
 *   ENTITY_ALLOWED_ORIGINS    comma-separated extra origins for the call table
 */
const http = require('node:http')
const path = require('node:path')
const { AsyncLocalStorage } = require('node:async_hooks')
const auth = require('./auth.cjs')
const sync = require('./sync.cjs')
const { createStatic } = require('./static.cjs')
const { createRpc } = require('../electron/rpc.cjs')
const workspaces = require('../electron/workspace-store.cjs')

const ROOT = __dirname
const DIST = path.resolve(ROOT, '..', 'dist')
const HOST = process.env.ENTITY_HOST || '0.0.0.0'
const PORT = Number(process.env.ENTITY_PORT || process.env.PORT || 8080)
const CALL_BODY_LIMIT = 2 * 1024 * 1024

const als = new AsyncLocalStorage()
const clients = new Set()
const staticFiles = createStatic({ distDir: DIST })

function log(line) {
  process.stdout.write(`[entity] ${line}\n`)
}

function emit(event) {
  const frame = `data: ${JSON.stringify(event)}\n\n`
  for (const res of clients) {
    try {
      res.write(frame)
    } catch {
      clients.delete(res)
    }
  }
}

const rpc = createRpc({
  emit,
  reveal: () => {},
  identity: () => als.getStore()?.user || null,
})

/* ── shared helpers ───────────────────────────────────────────────── */

function setSecurityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('x-frame-options', 'DENY')
  res.setHeader('referrer-policy', 'same-origin')
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()')
  res.setHeader('cross-origin-opener-policy', 'same-origin')
  res.setHeader(
    'content-security-policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; frame-src 'self' data:; object-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'",
  )
}

function sendJson(res, status, payload, headers = {}) {
  sync.sendJson(res, status, payload, headers)
}

function originAllowed(req) {
  const origin = String(req.headers.origin || '')
  if (!origin) return true
  const allowed = new Set(
    String(process.env.ENTITY_ALLOWED_ORIGINS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  )
  if (allowed.has(origin)) return true
  try {
    const url = new URL(origin)
    /* Host only: `x-forwarded-host` is client-controlled unless the proxy
       overwrites it, and an attacker would use that to forge an Origin match. */
    const host = String(req.headers.host || '')
    return Boolean(host) && url.host === host
  } catch {
    return false
  }
}

function filterWorkspaceList(payload, user) {
  if (!payload || !Array.isArray(payload)) return payload
  return sync.filterList(payload, user)
}

/** The renderer never needs a credential value to draw the pool. */
function redactPool(pool) {
  if (!pool || typeof pool !== 'object') return pool
  const clean = (entry) => {
    if (!entry || typeof entry !== 'object') return entry
    const out = { ...entry }
    for (const field of ['env', 'headers']) {
      if (out[field] && typeof out[field] === 'object' && !Array.isArray(out[field])) {
        out[field] = Object.fromEntries(Object.keys(out[field]).map((key) => [key, '•••']))
      }
    }
    return out
  }
  const servers = Object.fromEntries(
    Object.entries(pool.servers || {}).map(([name, entry]) => [name, clean(entry)]),
  )
  const disabled = Object.fromEntries(
    Object.entries(pool.disabled || {}).map(([name, entry]) => [name, clean(entry)]),
  )
  return { ...pool, servers, disabled }
}

/* ── auth verbs over the call table ───────────────────────────────── */

function handleAuthCall(fn, args, req, res) {
  const secure = sync.secureRequest(req)
  if (fn === 'auth.status') {
    const user = auth.authenticate(req)
    const publicUser = user ? auth.publicUser(user) : null
    return {
      exists: auth.count() > 0,
      user: publicUser,
      path: auth.USERS_FILE,
      displayPath: auth.USERS_FILE,
    }
  }

  if (fn === 'auth.verify') {
    const result = auth.verify({ ident: args.ident, password: args.password })
    if (!result.ok) return result
    const session = auth.createSession(result.user)
    res.setHeader('set-cookie', auth.cookieHeader(session.token, { secure }))
    return { ok: true, user: result.user, mustChange: false }
  }

  if (fn === 'auth.register') {
    if (auth.count() > 0) {
      throw new Error('This server already has accounts. Ask its administrator for an invite.')
    }
    if (String(process.env.ENTITY_ALLOW_FIRST_REGISTER || '') !== 'true') {
      throw new Error(
        'No administrator exists. Set ENTITY_ADMIN_EMAIL and ENTITY_ADMIN_PASSWORD, then restart the server.',
      )
    }
    const user = auth.create({
      email: args.email,
      name: args.name,
      password: args.password,
      role: 'owner',
    })
    const session = auth.createSession(user)
    res.setHeader('set-cookie', auth.cookieHeader(session.token, { secure }))
    return user
  }

  if (fn === 'auth.update') {
    const user = auth.authenticate(req)
    if (!user) throw new Error('Sign in to this server first.')
    if (args.email && String(args.email).toLowerCase() !== user.email) {
      throw new Error(
        'The email is the account key on a shared server. Ask the administrator to create a new account instead.',
      )
    }
    return auth.update({ email: user.email, username: args.username, name: args.name })
  }

  if (fn === 'auth.changePassword') {
    const user = auth.authenticate(req)
    if (!user) throw new Error('Sign in to this server first.')
    const result = auth.changePassword({
      email: user.email,
      current: args.current,
      next: args.next,
    })
    if (result.ok) {
      /* The old token is invalidated by `passwordChangedAt`; the browser needs
         a fresh one or the very next call would sign it out. */
      const session = auth.createSession(result.user)
      res.setHeader('set-cookie', auth.cookieHeader(session.token, { secure }))
    }
    return result
  }

  if (fn === 'auth.setPassword') {
    throw new Error('Use the password form in Account → Profile on this server.')
  }
  if (fn === 'auth.adopt' || fn === 'auth.importLegacy') {
    throw new Error('That account path belongs to the desktop app, not to this server.')
  }
  return undefined
}

/* ── routes ───────────────────────────────────────────────────────── */

async function handleCall(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'POST is required.' })
    return
  }
  if (!originAllowed(req)) {
    sendJson(res, 403, { ok: false, error: 'This origin is not allowed to call the server.' })
    return
  }
  let payload
  try {
    const body = await sync.readRawBody(req, CALL_BODY_LIMIT)
    payload = body.length ? JSON.parse(body.toString('utf8')) : {}
  } catch (error) {
    sendJson(res, error.status || 400, { ok: false, error: String(error.message || error) })
    return
  }

  const fn = String(payload?.fn || '')
  const args = payload?.args && typeof payload.args === 'object' ? payload.args : {}
  if (!fn) {
    sendJson(res, 400, { ok: false, error: 'A call name is required.' })
    return
  }

  if (fn.startsWith('auth.')) {
    try {
      const data = handleAuthCall(fn, args, req, res)
      sendJson(res, 200, { ok: true, data })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: String(error?.message || error) })
    }
    return
  }

  if (fn === 'server.mode') {
    sendJson(res, 200, { ok: true, data: { server: true, accounts: auth.count() } })
    return
  }

  const user = auth.authenticate(req)
  if (!user) {
    sendJson(res, 401, { ok: false, error: 'Sign in to this server first.' })
    return
  }

  try {
    sync.authorizeCall(user, fn, args)
  } catch (error) {
    sendJson(res, error.status || 403, { ok: false, error: String(error.message || error) })
    return
  }

  try {
    /* `identity()` reads this store, so workspace.create and claimOwner write
       the signed-in server user as the owner without threading an argument
       through every handler. */
    let result = await als.run({ user }, () => rpc.call(fn, args))
    if (result.ok && fn === 'workspace.list') {
      result = { ...result, data: filterWorkspaceList(result.data, user) }
    }
    if (result.ok && fn === 'workspace.needsSetup') {
      result = { ...result, data: !filterWorkspaceList(workspaces.list(), user).length }
    }
    if (
      result.ok &&
      ['workspace.mcp', 'workspace.writeMcp', 'workspace.setMcpEnabled'].includes(fn)
    ) {
      result = { ...result, data: redactPool(result.data) }
    }
    sendJson(res, 200, result)
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error?.message || error) })
  }
}

function handleEvents(req, res) {
  const user = auth.authenticate(req)
  if (!user) {
    sendJson(res, 401, { error: 'Sign in to this server first.' })
    return
  }
  res.statusCode = 200
  res.setHeader('content-type', 'text/event-stream; charset=utf-8')
  res.setHeader('cache-control', 'no-store, no-transform')
  res.setHeader('connection', 'keep-alive')
  res.setHeader('x-accel-buffering', 'no')
  res.write(': connected\n\n')
  clients.add(res)
  const keep = setInterval(() => {
    try {
      res.write(': keep-alive\n\n')
    } catch {
      clearInterval(keep)
      clients.delete(res)
    }
  }, 25_000)
  if (typeof keep.unref === 'function') keep.unref()
  req.on('close', () => {
    clearInterval(keep)
    clients.delete(res)
  })
}

async function handle(req, res) {
  setSecurityHeaders(res)
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  try {
    if (url.pathname === '/healthz') {
      sendJson(res, 200, {
        ok: true,
        service: 'entity',
        accounts: auth.count(),
        build: staticFiles.hasBuild(),
      })
      return
    }

    if (url.pathname.startsWith('/api/')) {
      await sync.handle(req, res, url)
      return
    }

    if (url.pathname === '/__entity/call') {
      await handleCall(req, res)
      return
    }

    if (url.pathname === '/__entity/events') {
      handleEvents(req, res)
      return
    }

    if (!staticFiles.hasBuild()) {
      sendJson(res, 503, {
        ok: false,
        error: 'The renderer is not built. Run `npm run build` before starting the server.',
      })
      return
    }

    if (staticFiles.serve(req, res, url)) return
    sendJson(res, 404, { ok: false, error: 'Not found.' })
  } catch (error) {
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.message || error) })
    else res.destroy()
    log(`request failed: ${String(error?.message || error)}`)
  }
}

/* ── boot ─────────────────────────────────────────────────────────── */

let created = null
try {
  created = auth.ensureAdmin()
} catch (error) {
  log(`warning: the administrator could not be created (${error?.message || error}).`)
}
if (created) {
  log(`created the first administrator ${created.email}`)
} else if (auth.count() === 0) {
  log('warning: no server accounts yet. Set ENTITY_ADMIN_EMAIL and ENTITY_ADMIN_PASSWORD, then restart.')
}

if (!staticFiles.hasBuild()) {
  log(`warning: ${path.join('dist', 'index.html')} is missing; run \`npm run build\`.`)
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    log(`unhandled request error: ${String(error?.message || error)}`)
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Internal server error.' })
    else res.destroy()
  })
})

/* A reverse proxy is the expected deployment. The app never trusts a forwarded
   header for authentication; it only uses x-forwarded-proto for the cookie flag. */
server.headersTimeout = 60_000
server.requestTimeout = 0
server.keepAliveTimeout = 65_000

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}`)
  log(`data: ${process.env.ENTITY_HOME || auth.ROOT}`)
  log(`accounts: ${auth.count()}`)
})

let stopping = false
async function shutdown(signal) {
  if (stopping) return
  stopping = true
  log(`${signal}: shutting down`)
  for (const client of clients) {
    try {
      client.end()
    } catch {
      /* already closed */
    }
  }
  clients.clear()
  try {
    await rpc.closeAll()
  } catch {
    /* nothing left to stop */
  }
  server.close(() => process.exit(0))
  const force = setTimeout(() => process.exit(0), 5000)
  if (typeof force.unref === 'function') force.unref()
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown(signal)
  })
}

process.on('exit', () => {
  try {
    require('../electron/child-registry.cjs').stopAllSync()
  } catch {
    /* nothing left to stop */
  }
})

module.exports = { server }
