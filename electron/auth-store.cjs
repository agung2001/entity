/**
 * The hub's one account, stored on disk rather than in the renderer.
 *
 *   ~/.entity/auth.json   public identity + password verifier + encrypted password
 *   ~/.entity/auth.key    AES-256 key, mode 0600, used when Electron safeStorage
 *                         is unavailable (the browser dev server, or a CLI)
 *
 * The password is never returned to the renderer and never stored in plain
 * text. Verification uses scrypt; the encrypted copy exists so the credential
 * file can carry the credential itself without a second secret store, and it
 * is written with the same atomic-write discipline as every other workspace
 * file. `safeStorage` is preferred in Electron because it rides the OS keychain.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const ROOT = process.env.ENTITY_HOME
  ? path.resolve(process.env.ENTITY_HOME)
  : path.join(os.homedir(), '.entity')
const AUTH_FILE = path.join(ROOT, 'auth.json')
const KEY_FILE = path.join(ROOT, 'auth.key')
const SCHEMA = 1
const ROLES = new Set(['owner', 'admin', 'member'])

function ensureRoot() {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 })
}

function protect(file) {
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* filesystems without POSIX modes are the OS's business */
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

function safeStorage() {
  try {
    /* In Electron this is the keychain-backed implementation. In the Vite
       server (plain Node) the module is not the Electron API, so this falls
       through to the local AES key. */
    const electron = require('electron')
    if (
      electron &&
      electron.safeStorage &&
      typeof electron.safeStorage.isEncryptionAvailable === 'function' &&
      electron.safeStorage.isEncryptionAvailable()
    ) {
      return electron.safeStorage
    }
  } catch {
    /* no Electron shell */
  }
  return null
}

function aesKey() {
  ensureRoot()
  try {
    const key = fs.readFileSync(KEY_FILE)
    if (key.length === 32) return key
  } catch {
    /* create below */
  }
  const key = crypto.randomBytes(32)
  fs.writeFileSync(KEY_FILE, key, { mode: 0o600 })
  protect(KEY_FILE)
  return key
}

function encryptPassword(password) {
  const text = String(password)
  const safe = safeStorage()
  if (safe) {
    try {
      return {
        scheme: 'safeStorage',
        data: safe.encryptString(text).toString('base64'),
      }
    } catch {
      /* keychain unavailable at this moment — use the local key */
    }
  }
  const key = aesKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return {
    scheme: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
}

function decryptPassword(secret) {
  if (!secret || secret.scheme !== 'aes-256-gcm') return ''
  try {
    const key = fs.readFileSync(KEY_FILE)
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(secret.iv, 'base64'),
    )
    decipher.setAuthTag(Buffer.from(secret.tag, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(secret.data, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    return ''
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex')
  return { salt, hash }
}

function legacySha256(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex')
}

function timingEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'hex')
  const right = Buffer.from(String(b || ''), 'hex')
  if (left.length !== right.length || !left.length) return false
  return crypto.timingSafeEqual(left, right)
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+$/.test(String(value || '').trim())
}

function publicUser(user) {
  if (!user) return null
  return {
    username: String(user.username || ''),
    email: String(user.email || ''),
    role: ROLES.has(user.role) ? user.role : 'owner',
    registered: user.registered !== false,
    createdAt: user.createdAt || null,
    updatedAt: user.updatedAt || null,
  }
}

function readAuth() {
  const raw = readJson(AUTH_FILE, null)
  if (!raw || raw.schema !== SCHEMA || !raw.user || typeof raw.user !== 'object') return null
  if (typeof raw.user.username !== 'string' || !raw.user.username) return null
  return raw
}

function writeUser(user) {
  writeJson(AUTH_FILE, {
    schema: SCHEMA,
    user,
    updatedAt: new Date().toISOString(),
  })
  return publicUser(user)
}

function status() {
  const raw = readAuth()
  return { exists: Boolean(raw), user: raw ? publicUser(raw.user) : null, path: AUTH_FILE }
}

function get() {
  const raw = readAuth()
  return raw ? publicUser(raw.user) : null
}

function exists() {
  return Boolean(readAuth())
}

function register({ email, name = '', password, role = 'owner' } = {}) {
  if (exists()) throw new Error('An account already exists on this machine.')
  const mail = String(email || '').trim()
  if (!validEmail(mail)) throw new Error('Enter a valid email address.')
  const pass = String(password || '')
  if (pass.length < 1) throw new Error('A password is required.')
  const local = mail.split('@')[0].replace(/[^a-z0-9._-]+/gi, '') || mail
  const now = new Date().toISOString()
  const { salt, hash } = hashPassword(pass)
  const user = {
    id: crypto.randomUUID(),
    username: String(name || local).trim() || local,
    email: mail,
    role: ROLES.has(role) ? role : 'owner',
    passwordHash: hash,
    passwordSalt: salt,
    passwordCipher: encryptPassword(pass),
    registered: true,
    createdAt: now,
    updatedAt: now,
  }
  return writeUser(user)
}

/** A workspace owner read from disk can seed the first account. */
function adopt({ email, name = '', password = '123456', role = 'owner' } = {}) {
  if (exists()) return get()
  return register({ email, name, password, role })
}

/** Import the old renderer localStorage credential (sha256 only). */
function importLegacy({ username, email, role = 'owner', hash, registered = true } = {}) {
  if (exists()) return get()
  if (!/^[a-f0-9]{64}$/i.test(String(hash || ''))) {
    throw new Error('The old credential hash is not readable.')
  }
  const now = new Date().toISOString()
  const mail = String(email || '').trim() || `${String(username || 'owner').trim()}@studio-mac`
  return writeUser({
    id: crypto.randomUUID(),
    username: String(username || 'owner').trim() || 'owner',
    email: mail,
    role: ROLES.has(role) ? role : 'owner',
    legacyHash: String(hash).toLowerCase(),
    registered: Boolean(registered),
    createdAt: now,
    updatedAt: now,
  })
}

function verify({ ident, password } = {}) {
  const raw = readAuth()
  if (!raw) return { ok: false, message: 'No account exists on this machine yet.' }
  const user = raw.user
  const value = String(ident || '').trim().toLowerCase()
  const byName = value === String(user.username || '').toLowerCase()
  const byEmail = Boolean(user.email) && value === String(user.email).toLowerCase()
  if (!byName && !byEmail) {
    return { ok: false, message: 'No account with that email or handle on this hub.' }
  }

  let valid = false
  if (user.passwordHash && user.passwordSalt) {
    valid = timingEqual(hashPassword(password, user.passwordSalt).hash, user.passwordHash)
  } else if (user.legacyHash) {
    valid = timingEqual(legacySha256(password), user.legacyHash)
  }
  if (!valid) return { ok: false, message: 'That password does not match.' }

  /* A legacy record becomes an encrypted, scrypt record on the first good
     sign-in. The renderer never sees the password or the verifier. */
  if (user.legacyHash || !user.passwordCipher) {
    const { salt, hash } = hashPassword(password)
    const next = {
      ...user,
      passwordHash: hash,
      passwordSalt: salt,
      passwordCipher: encryptPassword(password),
      legacyHash: undefined,
      registered: true,
      updatedAt: new Date().toISOString(),
    }
    delete next.legacyHash
    writeUser(next)
    return { ok: true, user: publicUser(next), upgraded: true, mustChange: false }
  }

  return { ok: true, user: publicUser(user), mustChange: Boolean(user.mustChange) }
}

function update({ username, email } = {}) {
  const raw = readAuth()
  if (!raw) throw new Error('No account exists on this machine yet.')
  const handle = String(username || raw.user.username || '').trim()
  const mail = String(email || raw.user.email || '').trim()
  if (!handle) throw new Error('A username is required.')
  if (mail && !validEmail(mail)) throw new Error('Enter a valid email address.')
  const next = {
    ...raw.user,
    username: handle,
    email: mail,
    registered: true,
    updatedAt: new Date().toISOString(),
  }
  return writeUser(next)
}

/** Used after a verified sign-in (the old forced-change flow). */
function setPassword({ password } = {}) {
  const raw = readAuth()
  if (!raw) throw new Error('No account exists on this machine yet.')
  const pass = String(password || '')
  if (pass.length < 6) throw new Error('Use at least 6 characters.')
  const { salt, hash } = hashPassword(pass)
  const next = {
    ...raw.user,
    passwordHash: hash,
    passwordSalt: salt,
    passwordCipher: encryptPassword(pass),
    legacyHash: undefined,
    mustChange: false,
    registered: true,
    updatedAt: new Date().toISOString(),
  }
  delete next.legacyHash
  return writeUser(next)
}

function changePassword({ current, next: nextPassword } = {}) {
  const raw = readAuth()
  if (!raw) return { ok: false, message: 'No account exists on this machine yet.' }
  const user = raw.user
  const valid = user.passwordHash
    ? timingEqual(hashPassword(current, user.passwordSalt).hash, user.passwordHash)
    : timingEqual(legacySha256(current), user.legacyHash)
  if (!valid) return { ok: false, message: 'That password does not match the current one.' }
  if (String(nextPassword || '').length < 6) {
    return { ok: false, message: 'Use at least 6 characters.' }
  }
  const { salt, hash } = hashPassword(nextPassword)
  const next = {
    ...user,
    passwordHash: hash,
    passwordSalt: salt,
    passwordCipher: encryptPassword(nextPassword),
    legacyHash: undefined,
    mustChange: false,
    registered: true,
    updatedAt: new Date().toISOString(),
  }
  delete next.legacyHash
  return { ok: true, user: writeUser(next) }
}

module.exports = {
  ROOT,
  AUTH_FILE,
  KEY_FILE,
  status,
  get,
  exists,
  register,
  adopt,
  importLegacy,
  verify,
  update,
  setPassword,
  changePassword,
  decryptPassword,
}
