/**
 * Machine capability facts are stored per workspace, without credentials.
 * These tests pin the migration away from machines/CONFIG and the remote scan
 * parser the Fleet view depends on.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/* `workspace-store` resolves ROOT at require time. */
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-facts-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('./workspace-store.cjs')
const machineScan = require('./machine-scan.cjs')

test('opening a legacy workspace removes the copied ssh config and key', () => {
  const record = workspaces.create({ label: 'legacy' })
  const dir = path.join(record.path, 'machines')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'CONFIG'), 'Host old\n')
  fs.writeFileSync(path.join(dir, 'id_ed25519'), 'not-a-real-key', { mode: 0o600 })

  workspaces.open(record.id)
  assert.equal(fs.existsSync(dir), false)
})

test('facts are stored, counted and forgotten without touching ssh data', () => {
  const record = workspaces.create({ label: 'scanned', owner: { name: 'T', email: 't@example.com' } })
  assert.equal(record.kind, 'local')
  assert.equal(record.counts.machines, 0)

  const facts = {
    alias: 'build',
    label: 'build',
    status: 'ok',
    source: 'ssh',
    checkedAt: new Date().toISOString(),
    hostname: 'build.internal',
    platform: 'linux',
    arch: 'x64',
    harnesses: [{ id: 'pi', label: 'pi', path: '/usr/bin/pi', models: ['a/b'], default: 'a/b', source: 'cli' }],
  }
  const saved = workspaces.saveMachineFacts({ id: record.id, alias: 'build', facts })
  assert.deepEqual(Object.keys(saved.hosts), ['build'])
  assert.equal(workspaces.list().find((item) => item.id === record.id).counts.machines, 1)
  assert.equal(workspaces.machineFacts(record.id).hosts.build.hostname, 'build.internal')
  assert.equal(fs.existsSync(path.join(record.path, 'machines')), false)

  workspaces.forgetMachineFacts({ id: record.id, alias: 'build' })
  assert.deepEqual(workspaces.machineFacts(record.id).hosts, {})
})

test('the remote TSV is parsed into ordered harnesses and defaults', () => {
  const facts = machineScan.parseScan(
    [
      'meta\tbuild\tLinux\tx86_64',
      'harness\tpi\tpi\t/usr/local/bin/pi',
      'model\tpi\topenrouter/a',
      'default\tpi\topenrouter/a',
      'harness\topencode\topencode\t/usr/local/bin/opencode',
      'model\topencode\topencode/b',
      'done',
    ].join('\n'),
  )
  assert.equal(facts.hostname, 'build')
  assert.equal(facts.platform, 'Linux')
  assert.deepEqual(facts.harnesses.map((entry) => entry.id), ['opencode', 'pi'])
  const pi = facts.harnesses.find((entry) => entry.id === 'pi')
  assert.equal(pi.default, 'openrouter/a')
  assert.deepEqual(pi.models, ['openrouter/a'])
  assert.equal(pi.source, 'cli')
})

test('a report without metadata is rejected', () => {
  assert.throws(() => machineScan.parseScan('harness\tpi\tpi\t/bin/pi\n'), /capability report/)
})
