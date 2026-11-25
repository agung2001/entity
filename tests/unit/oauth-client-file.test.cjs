const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-oauth-client-file-'))
process.env.ENTITY_HOME = PROFILE

const oauthSecrets = require('../../electron/oauth-secrets.cjs')

const ID = '1234-example.apps.googleusercontent.com'
const SECRET = 'not-a-real-secret-value'
const desktop = JSON.stringify({ installed: { client_id: ID, client_secret: SECRET } })

test('the client-file parser is the main-process trust boundary the issue names', () => {
  /* A Desktop-app `installed` block is accepted, and the preview is the id plus a
     fixed mask — the raw secret never crosses the call table. */
  const preview = oauthSecrets.previewClientFile({ provider: 'google', text: desktop })
  assert.equal(preview.clientId, ID)
  assert.ok(!JSON.stringify(preview).includes(SECRET))
  assert.ok(!JSON.stringify(preview).includes('not-a-real'))

  /* Saving from the file writes the entry the typed form writes, 0600. */
  const saved = oauthSecrets.setClientFromFile({ provider: 'google', text: desktop })
  assert.equal(saved.configured, true)
  assert.equal(oauthSecrets.status({ provider: 'google' }).configured, true)
  assert.equal(fs.statSync(path.join(PROFILE, 'oauth-secrets.json')).mode & 0o777, 0o600)
  assert.equal(oauthSecrets.clientFor('google').clientSecret, SECRET)

  /* A service-account key is a robot identity; nothing may be written for it. */
  const before = fs.readFileSync(path.join(PROFILE, 'oauth-secrets.json'), 'utf8')
  assert.throws(
    () => oauthSecrets.setClientFromFile({ provider: 'google', text: JSON.stringify({ type: 'service_account', private_key: 'x' }) }),
    /service account/i,
  )
  assert.equal(fs.readFileSync(path.join(PROFILE, 'oauth-secrets.json'), 'utf8'), before)

  /* A Web-application client cannot run the loopback round-trip. */
  assert.throws(() => oauthSecrets.parseClientFile(JSON.stringify({ web: {} })), /Desktop app/)

  /* A missing field is named — the field, never a value. */
  assert.throws(() => oauthSecrets.parseClientFile(JSON.stringify({ installed: { client_id: ID } })), /client_secret/)

  /* Not JSON at all. */
  assert.throws(() => oauthSecrets.parseClientFile('hello there'), /not JSON/)

  /* An X client is not a downloadable file. */
  assert.throws(() => oauthSecrets.parseClientFile(desktop, 'x'), /client id instead/)
})
