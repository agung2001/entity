/**
 * The quiet rule for desktop notifications.
 *
 * The window being focused is not the same as the person watching the thread
 * that finished: replying in a background thread while the entity page is open
 * is exactly when a banner is useful. A canceled turn is not news; a harness
 * failure is.
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const { turnNotification } = require('../../electron/notification-policy.cjs')

const prefs = { enabled: true, replies: true, errors: true, backgroundOnly: true }
const focused = { isDestroyed: () => false, isMinimized: () => false, isFocused: () => true }
const blurred = { ...focused, isFocused: () => false }

function turn(overrides = {}) {
  return {
    kind: 'chat.turn',
    phase: 'done',
    workspace: 'one',
    threadId: 't_1',
    entity: 'chief-of-staff',
    data: {
      message: {
        who: 'agent',
        text: '  All   done.\n The migration is green. ',
        ...overrides.message,
      },
    },
    ...overrides.event,
  }
}

test('a reply in the thread on screen stays quiet', () => {
  const payload = turnNotification(turn(), {
    prefs,
    window: focused,
    activeView: { workspace: 'one', thread: 't_1' },
  })
  assert.equal(payload, null)
})

test('quiet is opt-in: the same thread still notifies when it is off', () => {
  const payload = turnNotification(turn(), {
    prefs: { ...prefs, backgroundOnly: false },
    window: focused,
    activeView: { workspace: 'one', thread: 't_1' },
  })
  assert.equal(payload.title, 'chief-of-staff replied')
})

test('a reply in another thread notifies even when the window is focused', () => {
  const payload = turnNotification(turn(), {
    prefs,
    window: focused,
    activeView: { workspace: 'one', thread: 't_2' },
  })
  assert.equal(payload.title, 'chief-of-staff replied')
  assert.equal(payload.body, 'All done. The migration is green.')
  assert.equal(payload.route, '/one/chat?thread=t_1')
})

test('a reply while the app is away notifies', () => {
  const payload = turnNotification(turn(), {
    prefs,
    window: blurred,
    activeView: { workspace: 'one', thread: 't_1' },
  })
  assert.equal(payload.title, 'chief-of-staff replied')
})

test('a harness failure notifies; a canceled turn does not', () => {
  const failed = turnNotification(
    turn({ message: { who: 'sys', error: true, text: 'Harness error: not signed in' } }),
    { prefs, window: blurred, activeView: {} },
  )
  assert.equal(failed.title, 'chief-of-staff needs attention')
  assert.match(failed.body, /not signed in/)

  const canceled = turnNotification(
    turn({ message: { who: 'sys', error: false, text: 'Stopped by you.' } }),
    { prefs, window: blurred, activeView: {} },
  )
  assert.equal(canceled, null)
})

test('the switches still turn a kind off, and the body is bounded', () => {
  assert.equal(
    turnNotification(turn(), {
      prefs: { ...prefs, replies: false },
      window: blurred,
      activeView: {},
    }),
    null,
  )
  const long = turnNotification(
    turn({ message: { who: 'agent', text: 'x'.repeat(400) } }),
    { prefs, window: blurred, activeView: {} },
  )
  assert.equal(long.body.length, 160)
  assert.match(long.body, /…$/)
})
