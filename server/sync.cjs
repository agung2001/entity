/**
 * The server half of remote workspace sync.
 *
 * Routes (all JSON, authenticated):
 *
 *   POST /api/auth/login            email + password → bearer token (+ cookie)
 *   POST /api/auth/logout
 *   GET  /api/me
 *   GET  /api/workspaces            the workspaces this account may open
 *   GET  /api/workspaces/:id/manifest
 *   GET  /api/workspaces/:id/blob?path=…
 *   PUT  /api/workspaces/:id/blob?path=…     conditional via x-entity-base
 *   DELETE /api/workspaces/:id/blob?path=…
 *
 * A workspace is a directory on the server, exactly like a local one, so the
 * existing store is the storage layer. The manifest module is the same code the
 * client runs, which is what keeps the two ends from disagreeing about what a
 * workspace contains.
 *
 * Writes are conditional: `x-entity-base` names the sha the client believes is
 * there (empty means "must not exist"). A mismatch is 409, not a lost edit.
 * Deletes move the file to `<ENTITY_HOME>/trash/…` first.
 */
const fs = require('node:fs')
const path = require('node:path')
const auth = require('./auth.cjs')
const manifest = require('../electron/remote-manifest.cjs')
const workspaces = require('../electron/workspace-store.cjs')

const MAX_BODY = manifest.MAX_FILE_BYTES + 1024 * 1024
const LOGIN_WINDOW_MS = 5 * 60 * 1000
const LOGIN_LIMIT = 12
const loginAttempts = new Map()

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value, { mode } = {}) {
  manifest.writeAtomic(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'), {
    mode,
  })
}

function nowIso() {
  return new Date().toISOString()
}

function stamp() {
  return nowIso().replace(/[-:.]/g, '')
}

function secureRequest(req) {
  if (String(process.env.ENTITY_SECURE_COOKIE || '') === 'true') return true
  return (
    String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ||
    Boolean(req.socket?.encrypted)
  )
}

/* ── access ───────────────────────────────────────────────────────── */

function emailOf(user) {
  return String(user?.email || '').toLowerCase()
}

function nameOf(user) {
  return String(user?.username || user?.name || '').toLowerCase()
}

/**
 * `owner` / `admin` / `member` for this workspace, or ''.
 *
 * A server-wide owner or admin may open every workspace (that is what an
 * administrator is for); a member only the workspaces whose roster names them.
 */
function roleFor(record, user) {
  if (!record || !user) return ''
  if (user.role === 'owner' || user.role === 'admin') return user.role === 'owner' ? 'owner' : 'admin'
  const mail = emailOf(user)
  const name = nameOf(user)
  const owner = record.owner
  if (owner && ((owner.email && String(owner.email).toLowerCase() === mail) ||
    (owner.name && String(owner.name).toLowerCase() === name))) {
    return 'owner'
  }
  for (const member of Array.isArray(record.members) ? record.members : []) {
    if (member.email && String(member.email).toLowerCase() === mail) {
      return ['owner', 'admin', 'member'].includes(member.role) ? member.role : 'member'
    }
    if (!member.email && member.name && String(member.name).toLowerCase() === name) {
      return ['owner', 'admin', 'member'].includes(member.role) ? member.role : 'member'
    }
  }
  return ''
}

function canWrite(role) {
  return Boolean(role)
}

function canAdminister(role) {
  return role === 'owner' || role === 'admin'
}

function openFor(user, id) {
  const record = workspaces.open(id)
  const role = roleFor(record, user)
  if (!role) {
    const error = new Error('This account is not a member of that workspace.')
    error.status = 403
    throw error
  }
  return { record, role }
}

/* ── sidecar skills ───────────────────────────────────────────────── */

function sidecarPath(record) {
  return path.join(record.path, 'sync-skills.json')
}

function readSkills(record) {
  const sidecar = readJson(sidecarPath(record), null)
  const side = manifest.normaliseSkills(sidecar?.skills)
  const linked = manifest.readAttachedSkills(record.path)
  return manifest.normaliseSkills([...side, ...linked])
}

/* ── manifest ─────────────────────────────────────────────────────── */

function buildFor(record) {
  const inputs = manifest.recordInputs(record)
  inputs.skills = manifest.normaliseSkills([...readSkills(record), ...inputs.skills])
  return manifest.buildManifest(record.path, inputs)
}

function virtualContent(built, rel) {
  return built.virtual[rel] || null
}

function currentSha(built, rel) {
  return built.byPath.get(rel)?.sha256 || ''
}

/** Only the path being written is hashed, not the whole workspace. */
async function targetSha(record, rel) {
  if (manifest.isVirtual(rel)) {
    return currentSha(await buildFor(record), rel)
  }
  try {
    return await manifest.hashFile(manifest.absoluteFor(record.path, rel))
  } catch {
    return ''
  }
}

/* ── merge rules ──────────────────────────────────────────────────── */

function applyMeta(record, incoming, role) {
  if (!canAdminister(role)) {
    const error = new Error('Only a workspace owner or admin can change the roster.')
    error.status = 403
    throw error
  }
  const current = readJson(path.join(record.path, 'workspace.json'), {}) || {}
  const owner = incoming.owner && (incoming.owner.email || incoming.owner.name)
    ? incoming.owner
    : current.owner || null
  const members = manifest.sortMembers(
    Array.isArray(incoming.members) ? incoming.members : current.members || record.members,
  )
  if (owner && (owner.email || owner.name)) {
    const key = String(owner.email || owner.name).toLowerCase()
    if (!members.some((entry) => String(entry.email || entry.name).toLowerCase() === key)) {
      members.unshift({ name: owner.name || owner.email, email: owner.email || '', role: 'owner' })
    }
  }
  const next = {
    ...current,
    schema: 1,
    id: record.id,
    label: String(incoming.label || current.label || record.label).slice(0, 120),
    kind: current.kind === 'remote' ? 'remote' : 'local',
    createdAt: current.createdAt || record.createdAt,
    mcpStrict: incoming.mcpStrict !== false,
    context: String(incoming.context || '').slice(0, 200_000),
    ...(owner ? { owner } : {}),
    members,
  }
  writeJson(path.join(record.path, 'workspace.json'), next)
  writeJson(
    path.join(record.path, 'members.json'),
    {
      schema: 1,
      workspace: record.id,
      owner: owner || null,
      members,
      updatedAt: nowIso(),
    },
    { mode: 0o644 },
  )
}

function applyMcp(record, incoming) {
  const file = path.join(record.path, 'mcp.json')
  const current = readJson(file, { schema: 1, servers: {}, disabled: {} })
  const servers = current?.servers && typeof current.servers === 'object' ? { ...current.servers } : {}
  const disabled = current?.disabled && typeof current.disabled === 'object' ? { ...current.disabled } : {}
  const incomingServers =
    incoming?.servers && typeof incoming.servers === 'object' ? incoming.servers : {}

  for (const [name, entry] of Object.entries(incomingServers)) {
    if (!entry || (!entry.command && !entry.url)) continue
    servers[name] = servers[name] ? manifest.mergeServer(servers[name], entry) : entry
  }
  writeJson(file, { schema: 1, servers, disabled }, { mode: 0o600 })
}

function applySkills(record, incoming) {
  const merged = manifest.normaliseSkills([
    ...readSkills(record),
    ...manifest.normaliseSkills(incoming?.skills),
  ])
  writeJson(sidecarPath(record), { schema: 1, skills: merged })
}

/* ── blob I/O ─────────────────────────────────────────────────────── */

function checkCondition(current, header) {
  const base = header === undefined ? null : String(header)
  if (base === null) return
  if (base === '') {
    if (current) {
      const error = new Error('That file already exists on the server.')
      error.status = 409
      error.sha256 = current
      throw error
    }
    return
  }
  if (current !== base) {
    const error = new Error('The server copy changed since this sync started.')
    error.status = 409
    error.sha256 = current
    throw error
  }
}

function trashFile(record, rel) {
  const source = manifest.absoluteFor(record.path, rel)
  const target = path.join(
    process.env.ENTITY_HOME ? path.resolve(process.env.ENTITY_HOME) : workspaces.ROOT,
    'trash',
    record.id,
    stamp(),
    ...rel.split('/'),
  )
  manifest.writeAtomic(target, fs.readFileSync(source))
}

/* ── HTTP glue ────────────────────────────────────────────────────── */

function sendJson(res, status, payload, headers = {}) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value)
  res.end(JSON.stringify(payload))
}

function readRawBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large.'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJsonBody(req, limit = 1024 * 1024) {
  const buffer = await readRawBody(req, limit)
  try {
    return buffer.length ? JSON.parse(buffer.toString('utf8')) : {}
  } catch {
    throw Object.assign(new Error('Malformed JSON body.'), { status: 400 })
  }
}

function clientKey(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  return forwarded || req.socket?.remoteAddress || 'unknown'
}

function checkLoginRate(req) {
  const key = clientKey(req)
  const now = Date.now()
  const entry = loginAttempts.get(key)
  if (!entry || now > entry.reset) {
    loginAttempts.set(key, { count: 1, reset: now + LOGIN_WINDOW_MS })
    return true
  }
  entry.count += 1
  return entry.count <= LOGIN_LIMIT
}

function clearLoginRate(req) {
  loginAttempts.delete(clientKey(req))
}

/**
 * Handle every `/api/*` request. Returns true when it owned the request.
 */
async function handle(req, res, url) {
  const pathname = url.pathname
  if (!pathname.startsWith('/api/')) return false

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    if (!checkLoginRate(req)) {
      sendJson(res, 429, { error: 'Too many sign-in attempts. Try again in a few minutes.' })
      return true
    }
    const body = await readJsonBody(req)
    const result = auth.verify({ ident: body.email || body.ident, password: body.password })
    if (!result.ok) {
      sendJson(res, 401, { error: result.message })
      return true
    }
    clearLoginRate(req)
    const session = auth.createSession(result.user)
    const wantsToken = String(req.headers['x-entity-client'] || '') === 'sync'
    sendJson(
      res,
      200,
      {
        ok: true,
        user: result.user,
        expiresAt: new Date(session.expiresAt).toISOString(),
        ...(wantsToken ? { token: session.token } : {}),
      },
      { 'set-cookie': auth.cookieHeader(session.token, { secure: secureRequest(req) }) },
    )
    return true
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    sendJson(res, 200, { ok: true }, {
      'set-cookie': auth.clearCookie({ secure: secureRequest(req) }),
    })
    return true
  }

  const user = auth.authenticate(req)
  if (!user) {
    sendJson(res, 401, { error: 'Sign in to this server first.' })
    return true
  }

  if (pathname === '/api/me' && req.method === 'GET') {
    sendJson(res, 200, { user: auth.publicUser(user) })
    return true
  }

  if (pathname === '/api/users' || pathname.startsWith('/api/users/')) {
    if (user.role !== 'owner' && user.role !== 'admin') {
      sendJson(res, 403, { error: 'Only a server administrator can manage accounts.' })
      return true
    }
    if (pathname === '/api/users' && req.method === 'GET') {
      sendJson(res, 200, { users: auth.list() })
      return true
    }
    if (pathname === '/api/users' && req.method === 'POST') {
      const body = await readJsonBody(req)
      try {
        const created = auth.create({
          email: body.email,
          name: body.name,
          password: body.password,
          role: body.role === 'admin' ? 'admin' : 'member',
        })
        sendJson(res, 200, { user: created })
      } catch (error) {
        sendJson(res, 400, { error: error.message })
      }
      return true
    }
    const match = pathname.match(/^\/api\/users\/([^/]+)$/)
    if (match && req.method === 'DELETE') {
      try {
        sendJson(res, 200, auth.remove({ email: decodeURIComponent(match[1]) }))
      } catch (error) {
        sendJson(res, 400, { error: error.message })
      }
      return true
    }
    if (match && req.method === 'PUT') {
      const body = await readJsonBody(req)
      try {
        sendJson(res, 200, { user: auth.setPassword({ email: decodeURIComponent(match[1]), password: body.password }) })
      } catch (error) {
        sendJson(res, 400, { error: error.message })
      }
      return true
    }
    sendJson(res, 405, { error: 'That method is not allowed here.' })
    return true
  }

  if (pathname === '/api/workspaces' && req.method === 'GET') {
    const roster = workspaces
      .list()
      .map((record) => ({ record, role: roleFor(record, user) }))
      .filter((entry) => entry.role)
      .map(({ record, role }) => ({
        id: record.id,
        label: record.label,
        kind: record.kind,
        createdAt: record.createdAt,
        updatedAt: record.exportedAt || record.createdAt,
        owner: record.owner,
        members: record.members,
        role,
        counts: record.counts,
      }))
    sendJson(res, 200, { workspaces: roster })
    return true
  }

  const workspaceRoute = pathname.match(/^\/api\/workspaces\/([^/]+)(?:\/(manifest|blob))?$/)
  if (!workspaceRoute) {
    sendJson(res, 404, { error: 'Unknown API endpoint.' })
    return true
  }

  const id = decodeURIComponent(workspaceRoute[1])
  const action = workspaceRoute[2] || ''
  let opened
  try {
    opened = openFor(user, id)
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message })
    return true
  }
  const { record, role } = opened

  try {
    if (action === 'manifest' && req.method === 'GET') {
      const built = await buildFor(record)
      sendJson(res, 200, {
        rev: built.rev,
        files: built.files,
        skipped: built.skipped,
        updatedAt: nowIso(),
        meta: manifest.canonicalMeta(record),
        skills: readSkills(record),
      })
      return true
    }

    if (action === 'blob' && req.method === 'GET') {
      const rel = manifest.safeRel(url.searchParams.get('path'))
      if (!rel) {
        sendJson(res, 400, { error: 'That is not a syncable path.' })
        return true
      }
      if (manifest.isVirtual(rel)) {
        const built = await buildFor(record)
        const buffer = virtualContent(built, rel)
        if (!buffer) {
          sendJson(res, 404, { error: 'No such virtual file.' })
          return true
        }
        sendBlob(res, rel, buffer)
        return true
      }
      const file = manifest.absoluteFor(record.path, rel)
      let stat
      try {
        stat = fs.statSync(file)
      } catch {
        sendJson(res, 404, { error: 'No such file.' })
        return true
      }
      if (!stat.isFile() || stat.size > manifest.MAX_FILE_BYTES) {
        sendJson(res, 413, { error: 'That file is over the sync cap.' })
        return true
      }
      sendBlob(res, rel, await fs.promises.readFile(file))
      return true
    }

    if (action === 'blob' && req.method === 'PUT') {
      if (!canWrite(role)) {
        sendJson(res, 403, { error: 'This account is read-only here.' })
        return true
      }
      const rel = manifest.safeRel(url.searchParams.get('path'))
      if (!rel) {
        sendJson(res, 400, { error: 'That is not a syncable path.' })
        return true
      }
      const base = req.headers['x-entity-base']
      try {
        checkCondition(await targetSha(record, rel), base)
      } catch (error) {
        sendJson(res, error.status || 409, { error: error.message, sha256: error.sha256 || '' })
        return true
      }
      const body = await readRawBody(req)
      if (body.length > manifest.MAX_FILE_BYTES) {
        sendJson(res, 413, { error: 'That file is over the sync cap.' })
        return true
      }
      const claimed = String(req.headers['x-entity-sha256'] || '').toLowerCase()
      const digest = manifest.sha256(body)
      if (claimed && claimed !== digest) {
        sendJson(res, 400, { error: 'The body does not match its checksum.' })
        return true
      }

      if (rel === 'workspace.json') {
        let parsed
        try {
          parsed = JSON.parse(body.toString('utf8'))
        } catch {
          sendJson(res, 400, { error: 'workspace.json is not valid JSON.' })
          return true
        }
        applyMeta(record, parsed, role)
      } else if (rel === 'mcp.json') {
        let parsed
        try {
          parsed = JSON.parse(body.toString('utf8'))
        } catch {
          sendJson(res, 400, { error: 'mcp.json is not valid JSON.' })
          return true
        }
        applyMcp(record, parsed)
      } else if (rel === 'skills.json') {
        let parsed
        try {
          parsed = JSON.parse(body.toString('utf8'))
        } catch {
          sendJson(res, 400, { error: 'skills.json is not valid JSON.' })
          return true
        }
        applySkills(record, parsed)
      } else {
        manifest.writeAtomic(manifest.absoluteFor(record.path, rel), body, { mode: 0o644 })
      }

      const sha = manifest.isVirtual(rel)
        ? currentSha(await buildFor(record), rel) || manifest.sha256(body)
        : manifest.sha256(body)
      sendJson(res, 200, { path: rel, sha256: sha, size: body.length })
      return true
    }

    if (action === 'blob' && req.method === 'DELETE') {
      if (!canWrite(role)) {
        sendJson(res, 403, { error: 'This account is read-only here.' })
        return true
      }
      const rel = manifest.safeRel(url.searchParams.get('path'))
      if (!rel) {
        sendJson(res, 400, { error: 'That is not a syncable path.' })
        return true
      }
      if (manifest.isVirtual(rel)) {
        sendJson(res, 400, { error: 'Configuration entries are merged, not deleted.' })
        return true
      }
      try {
        checkCondition(await targetSha(record, rel), req.headers['x-entity-base'])
      } catch (error) {
        sendJson(res, error.status || 409, { error: error.message, sha256: error.sha256 || '' })
        return true
      }
      const file = manifest.absoluteFor(record.path, rel)
      if (!fs.existsSync(file)) {
        sendJson(res, 404, { error: 'No such file.' })
        return true
      }
      /* Stage the trash copy first: a delete that cannot be undone is worse
         than a failed delete. */
      trashFile(record, rel)
      fs.rmSync(file, { force: true })
      sendJson(res, 200, { path: rel, deleted: true })
      return true
    }

    sendJson(res, 405, { error: 'That method is not allowed here.' })
    return true
  } catch (error) {
    sendJson(res, error.status || 500, { error: String(error?.message || error) })
    return true
  }
}

function sendBlob(res, rel, buffer) {
  res.statusCode = 200
  res.setHeader('content-type', 'application/octet-stream')
  res.setHeader('content-length', String(buffer.length))
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-entity-sha256', manifest.sha256(buffer))
  res.setHeader('x-entity-path', rel)
  res.end(buffer)
}

/* ── RPC authorization ────────────────────────────────────────────── */

const WORKSPACE_CALLS = new Set([
  'workspace.open',
  'workspace.update',
  'workspace.remove',
  'workspace.machineFacts',
  'workspace.forgetMachineFacts',
  'workspace.skills',
  'workspace.attachSkill',
  'workspace.detachSkill',
  'workspace.skillRead',
  'workspace.mcp',
  'workspace.writeMcp',
  'workspace.setMcpEnabled',
  'workspace.context',
  'workspace.setContext',
  'workspace.claimOwner',
  'workspace.export',
  'workspace.import',
])

const HOST_ONLY_CALLS = new Set([
  'mcpServer.status',
  'mcpServer.save',
  'mcpServer.rotate',
  'mcpServer.test',
  'mcp.globals',
  'mcp.tools',
  'harness.setPath',
  'ssh.hosts',
  'ssh.probe',
  'workspace.scanMachine',
])

const ADMIN_CALLS = new Set([
  'workspace.update',
  'workspace.remove',
  'workspace.forgetMachineFacts',
  'workspace.attachSkill',
  'workspace.detachSkill',
  'workspace.writeMcp',
  'workspace.setMcpEnabled',
  'workspace.setContext',
  /* The export walks `chats/`, which is per-account. A member must not receive
     a teammate's transcripts through a bundle. */
  'workspace.export',
])

/**
 * Authorization for the shared call table. The desktop has one account and does
 * not need this; the server does, because every call arrives from a network the
 * app does not control.
 */
function authorizeCall(user, fn, args = {}) {
  if (!user) {
    const error = new Error('Sign in to this server first.')
    error.status = 401
    throw error
  }
  if (fn.startsWith('remote.')) {
    const error = new Error('Remote sync runs on a client, not on the server.')
    error.status = 400
    throw error
  }
  if (fn === 'workspace.list' || fn === 'workspace.needsSetup' || fn === 'workspace.create') {
    return
  }
  if (fn === 'workspace.samples' || fn === 'workspace.home') return

  if (user.role !== 'owner' && user.role !== 'admin') {
    if (HOST_ONLY_CALLS.has(fn)) {
      const error = new Error('Only a server administrator can do that.')
      error.status = 403
      throw error
    }
  }

  /* `platform.call` is the agent-facing call table: the workspace is one level
     down, in its own argument object. */
  let id = args.workspace || args.id
  if (fn === 'platform.call' && args.args && typeof args.args === 'object') {
    id = args.args.workspace || args.args.id || id
  }
  /* `entity.write` carries the whole entity, workspace included. Without this
     a member could write into a workspace they cannot open. */
  if (fn === 'entity.write' && args.entity && typeof args.entity === 'object') {
    id = args.entity.workspace || id
  }
  if (!id && (fn.startsWith('entity.') || fn.startsWith('chat.') || fn.startsWith('artifact.'))) {
    /* these always name a workspace; a missing one is a bug, not a bypass */
    const error = new Error('That call needs a workspace you are a member of.')
    error.status = 403
    throw error
  }
  if (!id) return
  const record = workspaces.open(id)
  const role = roleFor(record, user)
  if (!role) {
    const error = new Error('This account is not a member of that workspace.')
    error.status = 403
    throw error
  }
  if (WORKSPACE_CALLS.has(fn) && ADMIN_CALLS.has(fn) && !canAdminister(role)) {
    const error = new Error('Only a workspace owner or admin can do that.')
    error.status = 403
    throw error
  }
}

/** `workspace.list` returns the whole disk; the server returns what you may see. */
function filterList(items, user) {
  return items.filter((record) => Boolean(roleFor(record, user)))
}

module.exports = {
  handle,
  authorizeCall,
  filterList,
  roleFor,
  sendJson,
  readJsonBody,
  readRawBody,
  secureRequest,
  buildFor,
  readSkills,
  MAX_BODY,
}
