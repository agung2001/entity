/**
 * The Dashboard tab's lock, in the only shape anything is allowed to read.
 *
 * These cases exist because one of them shipped: a connector page with no Dashboard
 * tab (Tailscale, an MCP row, a custom connector) asked for its gate, the table
 * answered `undefined`, and `undefined.why` threw on every such page. The strip, the
 * pane and the watcher all read this one shape, so this is where the edge cases are
 * pinned instead of being found by whoever opens the page next.
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const { OPEN, OPEN_GATE, UNREAD, toGate } = require('../../src/connectors/gate.js')

test('a gate with no answer opens the tab instead of throwing', async () => {
  /* The shipped crash: no descriptor at all, so the caller had `undefined`. */
  for (const answer of [undefined, null, OPEN, UNREAD]) {
    assert.deepEqual({ ...toGate(answer) }, { locked: false, why: null, opens: 'overview' })
  }
  assert.equal(toGate(undefined), OPEN_GATE, 'the open answer is one shared object')
})

test('a locked gate keeps its sentence and names the control that fixes it', () => {
  const why = { before: 'Needs ', code: 'gh', after: ' on PATH.', title: 'Needs gh' }
  assert.deepEqual({ ...toGate({ why }) }, { locked: true, why, opens: 'overview' })
  /* The folder lock is the one whose fix is a control on the page. */
  assert.equal(toGate({ why, opens: 'picker' }).opens, 'picker')
})

test('a locked gate with no sentence is still locked, and says nothing it does not know', () => {
  /* A missing sentence must not print `undefined` under the strip: `why: null` makes
     the page fall through to the tab's own hint. */
  assert.deepEqual({ ...toGate({}) }, { locked: true, why: null, opens: 'overview' })
})
