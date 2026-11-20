/**
 * The machine-wide on/off switch lives beside `paths` in ~/.entity/harnesses.json.
 * A file that predates it has no `enabled` key and must keep reading as "all on",
 * and a write of either key must never drop the other.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-harness-'))
process.env.ENTITY_HOME = home
const harnesses = require('../../electron/harness-store.cjs')

const read = () => JSON.parse(fs.readFileSync(harnesses.CONFIG, 'utf8'))
const seed = (value) => {
  fs.mkdirSync(path.dirname(harnesses.CONFIG), { recursive: true })
  fs.writeFileSync(harnesses.CONFIG, `${JSON.stringify(value)}\n`, 'utf8')
}

/* The ids read from `META`, so the assertions keep holding when a CLI is added
   — and the list itself is a test: every one of these has an invocation in
   `runner-local.cjs`, which is what makes its switch mean something. */
const IDS = harnesses.META.map((row) => row.id)
const OFF = Object.fromEntries(IDS.map((id) => [id, false]))

test('the offered harnesses are the ones a run can actually spawn', () => {
  /* Every id here has a `case` in `runner-local.cjs` — that is what makes its
     switch mean something. Adding one is two edits, and this is the second. */
  assert.deepEqual(IDS, [
    'claude',
    'codex',
    'opencode',
    'gemini',
    'ollama',
    'pi',
    'antigravity',
    'hermes',
  ])
})

test('a file with no enabled key lists every harness as enabled', () => {
  seed({ schema: 1, paths: {} })
  assert.deepEqual(harnesses.list().map((row) => row.enabled), IDS.map(() => true))
})

test('turning one off writes schema 2 and comes back with enabled: false', () => {
  seed({ schema: 1, paths: {} })
  const row = harnesses.setEnabled({ id: 'claude', enabled: false })
  assert.equal(row.id, 'claude')
  assert.equal(row.enabled, false)
  assert.equal(read().schema, 2)
  assert.deepEqual(read().enabled, { claude: false })
})

test('the last one on cannot be turned off, and the file is left alone', () => {
  const last = IDS[IDS.length - 1]
  seed({ schema: 2, paths: {}, enabled: { ...OFF, [last]: true } })
  const before = fs.readFileSync(harnesses.CONFIG, 'utf8')
  const only = harnesses.list().find((row) => row.enabled)
  assert.equal(only.id, last)
  assert.throws(() => harnesses.setEnabled({ id: last, enabled: false }), /only harness on/)
  assert.equal(fs.readFileSync(harnesses.CONFIG, 'utf8'), before)
  assert.throws(() => harnesses.setEnabled({ id: 'nope', enabled: false }), /Unknown harness/)
})

test('a path write preserves the enabled map', () => {
  seed({ schema: 2, paths: {}, enabled: { claude: false } })
  harnesses.setPath({ id: 'hermes', path: '' })
  assert.deepEqual(read().enabled, { claude: false })
  assert.equal(read().schema, 2)
})
