/**
 * Server accounts — the multi-user half of the app.
 *
 * The desktop build has exactly one account (`~/.entity/auth.json`). A shared
 * server cannot: a teammate signs in with their own email, and the workspace
 * roster decides what they can open. This module is deliberately separate from
 * `electron/auth-store.cjs`, so the single-account file remains the desktop's
 * source of truth and the server never accidentally authenticates against it.
 *
 *   <ENTITY_HOME>/server-users.json   scrypt verifier, mode 0600
 *   <ENTITY_HOME>/server-secret       32 random bytes, mode 0600 (HMAC key)
 *
 * Sessions are stateless HMAC tokens. The browser gets one in an HttpOnly
 * cookie; a sync client gets the same token in `Authorization: Bearer`. Logout
 * is a cleared cookie — a stolen token lives until it expires, which is why the
 * TTL is measured in days and the secret can be rotated by deleting the file
 * (all sessions die with it).
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const ROOT = process.env.ENTITY_HOME
  ? path.resolve(process.env.ENTITY_HOME)
  : path.join(os.homedir(), '.entity')
const USERS_FILE = path.join(ROOT, 'server-users.json')
const SECRET_FILE = path.join(ROOT, 'server-secret')
const COOKIE = 'entity_session'
const SCHEMA = 1
const ROLES = new Set(['owner', 'admin', 'member'])
const MIN_PASSWORD = 8

function ensureRoot() {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 })
}

function protect(file) {
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* filesystems without POSIX modes */
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  ensureRoot()
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  protect(tmp)
  fs.renameSync(tmp, file)
  protect(file)
  return value
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+$/.test(String(value || '').trim())
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return {
    salt,
    hash: crypto.scryptSync(String(password), salt, 64).toString('hex'),
  }
}

function equal(a, b) {
  const left = Buffer.from(String(a || ''), 'hex')
  const right = Buffer.from(String(b || ''), 'hex')
  if (!left.length || left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

function normaliseUser(user) {
  if (!user || !user.email) return null
  return {
    id: user.id || '',
    email: String(user.email).toLowerCase(),
    name: String(user.name || user.email.split('@')[0]),
    role: ROLES.has(user.role) ? user.role : 'member',
    createdAt: user.createdAt || null,
    updatedAt: user.updatedAt || null,
  }
}

function publicUser(user) {
  const clean = normaliseUser(user)
  return clean
    ? { username: clean.name, name: clean.name, email: clean.email, role: clean.role }
    : null
}

function readStore() {
  const raw = readJson(USERS_FILE, null)
  if (!raw || raw.schema !== SCHEMA || !raw.users || typeof raw.users !== 'object') {
    return { schema: SCHEMA, users: {} }
  }
  return raw
}

function count() {
  return Object.keys(readStore().users).length
}

function findByEmail(email) {
  const store = readStore()
  const key = String(email || '').trim().toLowerCase()
  if (!key) return null
  for (const user of Object.values(store.users)) {
    if (String(user.email || '').toLowerCase() === key) return user
    if (String(user.name || '').toLowerCase() === key) return user
  }
  return null
}

function create({ email, name = '', password, role = 'member' } = {}) {
  const mail = String(email || '').trim().toLowerCase()
  if (!validEmail(mail)) throw new Error('Enter a valid email address.')
  const pass = String(password || '')
  if (pass.length < MIN_PASSWORD) {
    throw new Error(`Use at least ${MIN_PASSWORD} characters for the server password.`)
  }
  const store = readStore()
  if (store.users[mail]) throw new Error('An account with that email already exists.')
  const { salt, hash } = hashPassword(pass)
  const now = new Date().toISOString()
  store.users[mail] = {
    id: crypto.randomUUID(),
    email: mail,
    name: String(name || mail.split('@')[0]).trim() || mail.split('@')[0],
    role: ROLES.has(role) ? role : 'member',
    passwordHash: hash,
    passwordSalt: salt,
    createdAt: now,
    updatedAt: now,
  }
  writeJson(USERS_FILE, store)
  return publicUser(store.users[mail])
}

/**
 * Create the first administrator from the container environment. Running this
 * on every boot is safe: it only touches an empty store, so a later password
 * change made in the UI is not overwritten by a stale compose file.
 */
function ensureAdmin() {
  if (count() > 0) return null
  const email = process.env.ENTITY_ADMIN_EMAIL
  const password = process.env.ENTITY_ADMIN_PASSWORD
  if (!email || !password) return null
  return create({
    email,
    password,
    name: process.env.ENTITY_ADMIN_NAME || '',
    role: 'owner',
  })
}

function list() {
  return Object.values(readStore().users)
    .map(normaliseUser)
    .filter(Boolean)
    .sort((a, b) => a.email.localeCompare(b.email))
}

function remove({ email } = {}) {
  const store = readStore()
  const user = findByEmail(email)
  if (!user) throw new Error('No account with that email on this server.')
  const users = Object.values(store.users)
  const admins = users.filter((entry) => entry.role === 'owner' || entry.role === 'admin')
  if (admins.length <= 1 && admins.some((entry) => entry.email === user.email)) {
    throw new Error('The last administrator cannot be removed.')
  }
  delete store.users[user.email]
  writeJson(USERS_FILE, store)
  return { removed: user.email }
}

/** Administrator reset. The user's next sign-in uses the new password. */
function setPassword({ email, password } = {}) {
  const store = readStore()
  const user = findByEmail(email)
  if (!user) throw new Error('No account with that email on this server.')
  if (String(password || '').length < MIN_PASSWORD) {
    throw new Error(`Use at least ${MIN_PASSWORD} characters.`)
  }
  const { salt, hash } = hashPassword(password)
  const changedAt = new Date().toISOString()
  const updated = {
    ...user,
    passwordHash: hash,
    passwordSalt: salt,
    passwordChangedAt: changedAt,
    updatedAt: changedAt,
  }
  store.users[user.email] = updated
  writeJson(USERS_FILE, store)
  return publicUser(updated)
}

function verify({ ident, email, password } = {}) {
  const user = findByEmail(ident || email)
  if (!user) return { ok: false, message: 'No account with that email on this server.' }
  const valid = equal(hashPassword(password, user.passwordSalt).hash, user.passwordHash)
  if (!valid) return { ok: false, message: 'That password does not match.' }
  return { ok: true, user: publicUser(user) }
}

function update({ email, username, name } = {}) {
  const store = readStore()
  const current = findByEmail(email)
  if (!current) throw new Error('No account with that email on this server.')
  const nextName = String(name || username || current.name).trim()
  if (!nextName) throw new Error('A name is required.')
  const next = { ...current, name: nextName, updatedAt: new Date().toISOString() }
  store.users[current.email] = next
  writeJson(USERS_FILE, store)
  return publicUser(next)
}

function changePassword({ email, current, next } = {}) {
  const store = readStore()
  const user = findByEmail(email)
  if (!user) return { ok: false, message: 'No account with that email on this server.' }
  if (!equal(hashPassword(current, user.passwordSalt).hash, user.passwordHash)) {
    return { ok: false, message: 'That password does not match the current one.' }
  }
  if (String(next || '').length < MIN_PASSWORD) {
    return { ok: false, message: `Use at least ${MIN_PASSWORD} characters.` }
  }
  const { salt, hash } = hashPassword(next)
  const changedAt = new Date().toISOString()
  const updated = {
    ...user,
    passwordHash: hash,
    passwordSalt: salt,
    passwordChangedAt: changedAt,
    updatedAt: changedAt,
  }
  store.users[user.email] = updated
  writeJson(USERS_FILE, store)
  return { ok: true, user: publicUser(updated) }
}

/* ── sessions ─────────────────────────────────────────────────────── */

function secret() {
  ensureRoot()
  try {
    const key = fs.readFileSync(SECRET_FILE)
    if (key.length >= 32) return key
  } catch {
    /* create below */
  }
  const key = crypto.randomBytes(32)
  fs.writeFileSync(SECRET_FILE, key, { mode: 0o600 })
  protect(SECRET_FILE)
  return key
}

function base64url(value) {
  return Buffer.from(value).toString('base64url')
}

function ttlMs() {
  const days = Number(process.env.ENTITY_SESSION_DAYS)
  return (Number.isFinite(days) && days > 0 ? days : 30) * 24 * 60 * 60 * 1000
}

function sign(payload) {
  const body = base64url(JSON.stringify(payload))
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url')
  return `${body}.${mac}`
}

function createSession(user) {
  const now = Date.now()
  const expiresAt = now + ttlMs()
  const token = sign({
    sub: user.id || user.email,
    email: user.email,
    name: user.name || user.username,
    role: user.role || 'member',
    iat: now,
    exp: expiresAt,
  })
  return { token, expiresAt }
}

function verifyToken(token) {
  const text = String(token || '')
  const [body, mac] = text.split('.')
  if (!body || !mac) return null
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url')
  const left = Buffer.from(mac)
  const right = Buffer.from(expected)
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null
  let payload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!payload?.email || !payload?.exp || payload.exp < Date.now()) return null
  return payload
}

function cookieHeader(token, { secure = false } = {}) {
  const maxAge = Math.floor(ttlMs() / 1000)
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

function clearCookie({ secure = false } = {}) {
  const parts = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

function parseCookies(header) {
  const out = {}
  for (const part of String(header || '').split(';')) {
    const at = part.indexOf('=')
    if (at < 0) continue
    out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim())
  }
  return out
}

/** Bearer first (a sync client), then the browser's HttpOnly cookie. */
function authenticate(req) {
  const header = String(req.headers.authorization || '')
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  const token = bearer || parseCookies(req.headers.cookie)[COOKIE] || ''
  if (!token) return null
  const payload = verifyToken(token)
  if (!payload) return null
  /* A deleted account loses its sessions at once, and a password or role
     change invalidates tokens issued before it. The token carries an `iat`;
     the store carries the truth. */
  const account = findByEmail(payload.email)
  if (!account) return null
  const changedAt = Date.parse(account.passwordChangedAt || '')
  if (Number.isFinite(changedAt) && Number(payload.iat) < changedAt) return null
  return {
    id: account.id || payload.sub,
    email: String(account.email).toLowerCase(),
    username: account.name || account.email.split('@')[0],
    name: account.name || account.email.split('@')[0],
    role: ROLES.has(account.role) ? account.role : 'member',
  }
}

module.exports = {
  ROOT,
  USERS_FILE,
  SECRET_FILE,
  COOKIE,
  MIN_PASSWORD,
  count,
  create,
  ensureAdmin,
  findByEmail,
  list,
  remove,
  setPassword,
  verify,
  update,
  changePassword,
  createSession,
  verifyToken,
  authenticate,
  cookieHeader,
  clearCookie,
  parseCookies,
  publicUser,
}
