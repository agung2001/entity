/**
 * The one decision a dynamic client registration makes.
 *
 * Habitify mints a client id per install for the loopback redirect this run will
 * actually use, and a loopback port on an OS-chosen port changes between runs. The
 * rule that matters is therefore not "is there a client" but "is that client valid
 * for *this* redirect" — and getting it wrong is either a broken login on every
 * second connect (if nothing is re-minted) or a fresh registration per keystroke (if
 * it always is). Both cases are asserted here, with no listener and no browser.
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const { needsRegistration } = require('../../electron/oauth-accounts.cjs')

const REDIRECT = 'http://127.0.0.1:53111/oauth/callback'

test('a stored registration whose redirect matches is reused', () => {
  assert.equal(
    needsRegistration({
      stored: { clientId: 'CH_registered', redirectUri: REDIRECT },
      redirectUri: REDIRECT,
      dynamicClient: true,
    }),
    false,
  )
})

test('a stored registration for a different redirect is re-minted', () => {
  assert.equal(
    needsRegistration({
      stored: { clientId: 'CH_registered', redirectUri: 'http://127.0.0.1:62000/oauth/callback' },
      redirectUri: REDIRECT,
      dynamicClient: true,
    }),
    true,
  )
  /* The port that moved back is still a mismatch for the newer registration. */
  assert.equal(
    needsRegistration({
      stored: { clientId: 'CH_registered', redirectUri: REDIRECT },
      redirectUri: 'http://127.0.0.1:62000/oauth/callback',
      dynamicClient: true,
    }),
    true,
  )
})

test('nothing stored, and a provider that does not register, both answer false', () => {
  assert.equal(needsRegistration({ stored: null, redirectUri: REDIRECT, dynamicClient: true }), true)
  /* Google and X hold a pasted client: a missing redirect on the record is not a
     reason to go and register one. */
  assert.equal(
    needsRegistration({ stored: { clientId: 'x-client' }, redirectUri: REDIRECT, dynamicClient: false }),
    false,
  )
})
