const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-auth-'))
process.env.ENTITY_HOME = home
const auth = require('../../electron/auth-store.cjs')

test('an account is written with an encrypted password and verified by scrypt', () => {
  const user = auth.register({
    email: 'creator@example.com',
    name: 'creator',
    password: 'correct horse battery',
  })
  assert.equal(user.email, 'creator@example.com')
  assert.equal(auth.status().exists, true)

  const text = fs.readFileSync(auth.AUTH_FILE, 'utf8')
  assert.equal(text.includes('correct horse battery'), false)
  const record = JSON.parse(text).user
  assert.ok(record.passwordHash)
  assert.ok(record.passwordSalt)
  assert.ok(record.passwordCipher)
  assert.equal(auth.decryptPassword(record.passwordCipher), 'correct horse battery')

  assert.equal(auth.verify({ ident: 'creator@example.com', password: 'wrong' }).ok, false)
  assert.equal(auth.verify({ ident: 'creator@example.com', password: 'correct horse battery' }).ok, true)
})

test('a legacy sha256 record is upgraded on the first good sign-in', () => {
  fs.rmSync(auth.AUTH_FILE, { force: true })
  const hash = crypto.createHash('sha256').update('old-password').digest('hex')
  auth.importLegacy({ username: 'old', email: 'old@example.com', hash, registered: true })
  const before = JSON.parse(fs.readFileSync(auth.AUTH_FILE, 'utf8')).user
  assert.equal(Boolean(before.legacyHash), true)
  assert.equal(Boolean(before.passwordCipher), false)

  const result = auth.verify({ ident: 'old', password: 'old-password' })
  assert.equal(result.ok, true)
  const after = JSON.parse(fs.readFileSync(auth.AUTH_FILE, 'utf8')).user
  assert.equal(Boolean(after.legacyHash), false)
  assert.ok(after.passwordHash)
  assert.ok(after.passwordCipher)
})
