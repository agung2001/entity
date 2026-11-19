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

test('a file with no enabled key lists every harness as enabled', () => {
  seed({ schema: 1, paths: {} })
  assert.deepEqual(harnesses.list().map((row) => row.enabled), [true, true, true, true, true])
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
  seed({ schema: 2, paths: {}, enabled: { claude: false, codex: false, pi: false, hermes: false } })
  const before = fs.readFileSync(harnesses.CONFIG, 'utf8')
  const only = harnesses.list().find((row) => row.enabled)
  assert.equal(only.id, 'antigravity')
  assert.throws(
    () => harnesses.setEnabled({ id: 'antigravity', enabled: false }),
    /Antigravity is the only harness on/,
  )
  assert.equal(fs.readFileSync(harnesses.CONFIG, 'utf8'), before)
  assert.throws(() => harnesses.setEnabled({ id: 'nope', enabled: false }), /Unknown harness/)
})

test('a path write preserves the enabled map', () => {
  seed({ schema: 2, paths: {}, enabled: { claude: false } })
  harnesses.setPath({ id: 'hermes', path: '' })
  assert.deepEqual(read().enabled, { claude: false })
  assert.equal(read().schema, 2)
})
