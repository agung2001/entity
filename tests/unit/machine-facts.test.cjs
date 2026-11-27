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

const workspaces = require('../../electron/workspace-store.cjs')
const machineScan = require('../../electron/machine-scan.cjs')

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
  /* ordered by harness-store's META, which is the one offer list; an id it does
     not know would sort last */
  assert.deepEqual(facts.harnesses.map((entry) => entry.id), ['opencode', 'pi'])
  const pi = facts.harnesses.find((entry) => entry.id === 'pi')
  assert.equal(pi.default, 'openrouter/a')
  assert.deepEqual(pi.models, ['openrouter/a'])
  assert.equal(pi.source, 'cli')
})

test('a report without metadata is rejected', () => {
  assert.throws(() => machineScan.parseScan('harness\tpi\tpi\t/bin/pi\n'), /capability report/)
})

test('the report TSV becomes five groups and their failures', () => {
  const facts = machineScan.parseScan(
    [
      'meta\tlab\tLinux\tx86_64',
      'ovf\tuptime_sec\t86400',
      'ovf\tcores\t16',
      'ovf\tload1\t0.42',
      'disk\t/\text4\t234G\t98G\t136G\t42',
      'set\tcron\tfiles\t2',
      'cron\t*/15 * * * *\tdeploy\tuser\t/opt/agents/bin/reap --older-than 6h',
      'cron\t0 3 * * 0\troot\tsystem\t/usr/local/sbin/rotate',
      'timer\tagent-sync.timer\t12 Mar 2025, 00:00',
      'set\tdocker\tversion\t27.1.1',
      'docker\tagent-gateway\tghcr.io/acme/gateway:1.8.2\trunning\t127.0.0.1:8080\tUp 4 days',
      'image\tghcr.io/acme/gateway:1.8.2\t412MB',
      'ddisk\tImages\t9\t41.2GB\t6.8GB',
      'skill\t/root/.pi/agent/skills\tresearch\t1',
      'skill\t/root/.pi/agent/skills\ttriage\t0',
      'skillroot\t/root/.pi/agent/skills\t2',
      'worktree\t/app/one\tmain\trunning',
      'anomaly\tfleet-scanner\tstalled-worktree\tno terminal output for 3 h',
      'term\t12\tread the host report\tworking\t2 m',
      'error\torca\torca status exited 2',
      'done',
    ].join('\n'),
  )
  const report = facts.report
  assert.equal(report.overview.cores, 16)
  assert.equal(report.overview.disks[0].usePct, 42)
  assert.equal(report.cron.entries[0].command, '/opt/agents/bin/reap --older-than 6h')
  assert.equal(report.cron.files, 2)
  assert.equal(report.docker.containers[0].state, 'running')
  assert.equal(report.skills.total, 2)
  assert.equal(report.skills.described, 1)
  assert.equal(report.orca.rows[0].path, '/app/one')
  assert.equal(report.orca.rows[0].state, 'running')
  assert.match(report.errors.orca, /exited 2/)
  /* a probe that failed and reported nothing leaves its group null, so the page
     draws the honesty note instead of an empty table */
  const empty = machineScan.parseScan(
    'meta\tlab\tLinux\tx86_64\nerror\tdocker\tnever answered\ndone',
  ).report
  assert.equal(empty.docker, null)
  assert.equal(empty.errors.docker, 'never answered')
  assert.equal(empty.overview, null)
})
