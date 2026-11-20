/**
 * The turn deadline is a setting now (Account → Chats), not a constant.
 *
 * These pin the four things the page depends on: the file round-trips in
 * milliseconds, a value outside the range is refused instead of silently clamped,
 * `ENTITY_TURN_TIMEOUT_MS` outranks the file (the E2E suite pins it that way),
 * and nothing can produce an unbounded turn.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-turn-'))
process.env.ENTITY_HOME = home
delete process.env.ENTITY_TURN_TIMEOUT_MS
const turn = require('../../electron/turn-timeout-store.cjs')

const read = () => JSON.parse(fs.readFileSync(turn.CONFIG, 'utf8'))

test('a machine that never chose reads the shipped default', () => {
  const status = turn.status()
  assert.equal(status.turnTimeoutMs, 90 * 60_000)
  assert.equal(status.source, 'default')
  assert.equal(status.editable, true)
  assert.equal(turn.turnTimeoutMs(), 90 * 60_000)
})

test('a chosen value round-trips in milliseconds and comes back as the file', () => {
  turn.set({ turnTimeoutMs: 45 * 60_000 })
  assert.equal(read().turnTimeoutMs, 45 * 60_000)
  assert.equal(read().schema, 1)
  const status = turn.status()
  assert.equal(status.turnTimeoutMs, 45 * 60_000)
  assert.equal(status.source, 'file')
  assert.equal(turn.turnTimeoutMs(), 45 * 60_000)
})

test('a value outside the range is refused, not clamped to something nobody chose', () => {
  turn.set({ turnTimeoutMs: 30 * 60_000 })
  const before = read().turnTimeoutMs
  assert.throws(() => turn.set({ turnTimeoutMs: 1000 }), /between 10 and 360 minutes/)
  assert.throws(() => turn.set({ turnTimeoutMs: 99 * 60 * 60_000 }), /between 10 and 360 minutes/)
  assert.throws(() => turn.set({ turnTimeoutMs: 'soon' }), /positive number/)
  assert.equal(read().turnTimeoutMs, before, 'a refused write changes nothing')
})

test('zero is not "no limit": it falls back to the default', () => {
  fs.writeFileSync(turn.CONFIG, JSON.stringify({ schema: 1, turnTimeoutMs: 0 }))
  assert.equal(turn.turnTimeoutMs(), 90 * 60_000)
  fs.writeFileSync(turn.CONFIG, JSON.stringify({ schema: 1, turnTimeoutMs: -5 }))
  assert.equal(turn.read(), 90 * 60_000)
})

test('the environment outranks the file, and the page is told so', () => {
  turn.set({ turnTimeoutMs: 45 * 60_000 })
  process.env.ENTITY_TURN_TIMEOUT_MS = String(20 * 60_000)
  try {
    const status = turn.status()
    assert.equal(status.turnTimeoutMs, 20 * 60_000)
    assert.equal(status.source, 'environment')
    assert.equal(status.editable, false, 'the field must be read-only, not a lie')
    assert.equal(turn.turnTimeoutMs(), 20 * 60_000)
    assert.throws(() => turn.set({ turnTimeoutMs: 30 * 60_000 }), /ENTITY_TURN_TIMEOUT_MS/)
    /* the file is untouched, so removing the variable brings the choice back */
    assert.equal(read().turnTimeoutMs, 45 * 60_000)
  } finally {
    delete process.env.ENTITY_TURN_TIMEOUT_MS
  }
  assert.equal(turn.turnTimeoutMs(), 45 * 60_000)
})

test('the choices the picker offers are inside the range it enforces', () => {
  for (const minutes of turn.CHOICES) {
    assert.ok(minutes * 60_000 >= turn.RANGE_MS.min, `${minutes} is below the minimum`)
    assert.ok(minutes * 60_000 <= turn.RANGE_MS.max, `${minutes} is above the maximum`)
  }
})
