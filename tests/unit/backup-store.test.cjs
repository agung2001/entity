/**
 * Backups are ZIP files with a retention policy. These tests use a throwaway
 * ENTITY_HOME (set before the stores are required) so they never see a real
 * workspace.
 */
process.env.ENTITY_HOME = require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'entity-backups-'),
)

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const unzipper = require('unzipper')

const workspaces = require('../../electron/workspace-store.cjs')
const backups = require('../../electron/backup-store.cjs')

let nextLabel = 0

function makeWorkspace() {
  nextLabel += 1
  const record = workspaces.create({ label: `backup-test-${nextLabel}`, seed: false })
  const file = (rel, value) => {
    const full = path.join(record.path, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, value)
    return full
  }
  file('entities/agent.md', '---\nname: agent\nharness: pi\ndir: /tmp\n---\n\nBe brief.\n')
  file('chats/t1.json', JSON.stringify({ schema: 1, id: 't1', messages: [] }))
  file('artifacts/shot.bin', Buffer.from([0, 1, 2, 3]))
  file('runs/run.jsonl', '{"kind":"run"}\n')
  file('.bin/entity', '#!/bin/sh\n')
  file('.remote.json', '{"schema":1}')
  file('.remote.token', 'secret')
  file('audit.jsonl', '{"verb":"entity.write"}\n')
  fs.mkdirSync(path.join(record.path, 'empty-dir'))

  const raw = JSON.parse(fs.readFileSync(path.join(record.path, 'workspace.json'), 'utf8'))
  fs.writeFileSync(
    path.join(record.path, 'workspace.json'),
    `${JSON.stringify({ ...raw, context: 'Keep this context.' }, null, 2)}\n`,
  )

  /* A workspace skill is a link to a library entry, not a copy. */
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-skill-'))
  fs.writeFileSync(path.join(target, 'SKILL.md'), '# skill\n')
  let linked = false
  try {
    fs.symlinkSync(target, path.join(record.path, 'skills', 'demo'))
    linked = true
  } catch {
    /* Windows without developer mode: the link is optional for this test */
  }
  return { record, linked, skillTarget: target }
}

async function zipEntries(file) {
  const directory = await unzipper.Open.file(file)
  const out = new Map()
  for (const entry of directory.files) {
    if (entry.type === 'Directory') {
      out.set(entry.path, null)
      continue
    }
    const mode = Number(entry.externalFileAttributes || 0) >>> 16
    if ((mode & 0o170000) === 0o120000) {
      out.set(entry.path, { link: (await entry.buffer()).toString('utf8') })
      continue
    }
    out.set(entry.path, await entry.buffer())
  }
  return out
}

test('a ZIP snapshot carries the workspace and leaves secrets and transients out', async () => {
  const { record, linked } = makeWorkspace()
  const snapshot = await backups.createSnapshot(record, { reason: 'manual', mode: 'smart' })
  assert.match(snapshot.name, /\.zip$/)

  const dir = path.join(backups.ROOT, record.id)
  const file = path.join(dir, snapshot.name)
  assert.equal(fs.existsSync(file), true)
  assert.equal(snapshot.reason, 'manual')
  assert.equal(snapshot.mode, 'smart')
  assert.equal(snapshot.files > 0, true)
  assert.equal(snapshot.bytes > 0, true)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  }

  const entries = await zipEntries(file)
  assert.match(entries.get('entities/agent.md').toString(), /Be brief/)
  assert.match(entries.get('chats/t1.json').toString(), /schema/)
  assert.deepEqual([...entries.get('artifacts/shot.bin')], [0, 1, 2, 3])
  assert.match(entries.get('workspace.json').toString(), /Keep this context/)
  assert.match(entries.get('audit.jsonl').toString(), /entity.write/)

  assert.equal(entries.has('runs/run.jsonl'), false)
  assert.equal(entries.has('.bin/entity'), false)
  assert.equal(entries.has('.remote.json'), false)
  assert.equal(entries.has('.remote.token'), false)

  const manifest = JSON.parse(entries.get('backup.json').toString('utf8'))
  assert.equal(manifest.format, 'zip')
  assert.equal(manifest.kind, 'entity.workspace.backup')
  assert.equal(manifest.files, snapshot.files)
  assert.ok(manifest.dirs.includes('empty-dir'))
  /* The link was materialised before the walk: the ZIP carries the bytes. */
  assert.equal(manifest.links.length, 0)
  assert.equal(entries.has('skills/demo'), false)
  if (linked) assert.match(entries.get('skills/demo/SKILL.md').toString(), /# skill/)
})

test('default mode is smart, a run updates status, and manual-only stops the timer', async () => {
  const { record } = makeWorkspace()
  let status = await backups.status()
  let entry = status.workspaces.find((row) => row.id === record.id)
  assert.equal(status.defaultMode, 'smart')
  assert.equal(status.root, backups.ROOT)
  assert.equal(entry.mode, 'smart')
  assert.equal(entry.defaultDirectory, true)
  assert.equal(entry.due, true)
  assert.deepEqual(entry.items, [])

  entry = await backups.runNow(record.id)
  assert.equal(entry.items.length, 1)
  assert.match(entry.items[0].name, /\.zip$/)
  assert.ok(entry.lastBackupAt)
  assert.equal(entry.running, false)
  assert.equal(entry.due, false)

  entry = await backups.setMode({ id: record.id, mode: 'manual' })
  assert.equal(entry.mode, 'manual')
  assert.equal(entry.automatic, false)
  assert.equal(entry.due, false)
  assert.equal(entry.nextDueAt, '')
})

test('the target folder can change and moves the existing ZIPs with it', async () => {
  const { record } = makeWorkspace()
  const first = await backups.runNow(record.id)
  assert.equal(first.items.length, 1)

  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-backup-target-'))
  const entry = await backups.setDirectory({ id: record.id, directory: target })
  const realTarget = fs.realpathSync(target)
  assert.equal(entry.directory, realTarget)
  assert.equal(entry.defaultDirectory, false)
  assert.equal(entry.backupDir, path.join(realTarget, record.id))
  assert.equal(entry.items.length, 1)

  const moved = fs.readdirSync(path.join(target, record.id)).filter((name) => name.endsWith('.zip'))
  assert.deepEqual(moved, [first.items[0].name])
  assert.equal(fs.existsSync(path.join(backups.ROOT, record.id, first.items[0].name)), false)

  await backups.setMode({ id: record.id, mode: 'manual' })
  const second = await backups.runNow(record.id)
  assert.equal(second.items.length, 2)
  assert.equal(second.directory, realTarget)

  await assert.rejects(
    () => backups.setDirectory({ id: record.id, directory: path.join(record.path, 'inside') }),
    /outside this workspace/,
  )
  await assert.rejects(
    () => backups.setDirectory({ id: record.id, directory: 'relative/folder' }),
    /absolute folder path/,
  )

  if (process.platform !== 'win32') {
    /* A symlink that looks outside but resolves into the workspace must not
       become the backup target. */
    const link = path.join(os.tmpdir(), `entity-ws-link-${process.pid}`)
    fs.rmSync(link, { force: true })
    fs.symlinkSync(record.path, link)
    await assert.rejects(
      () => backups.setDirectory({ id: record.id, directory: link }),
      /outside this workspace/,
    )
    fs.rmSync(link, { force: true })
  }
})

test('smart retention: 7 daily, a week of this month, a month of this year', () => {
  const now = new Date('2026-03-15T12:00:00Z')
  const item = (name, iso) => ({ name, date: new Date(iso) })
  const items = [
    item('d15b', '2026-03-15T11:00:00Z'),
    item('d15a', '2026-03-15T09:00:00Z'),
    item('d14', '2026-03-14T09:00:00Z'),
    item('d13', '2026-03-13T09:00:00Z'),
    item('d12', '2026-03-12T09:00:00Z'),
    item('d11', '2026-03-11T09:00:00Z'),
    item('d10', '2026-03-10T09:00:00Z'),
    item('d09', '2026-03-09T09:00:00Z'),
    item('d08', '2026-03-08T09:00:00Z'),
    item('w02', '2026-03-02T09:00:00Z'),
    item('w01', '2026-03-01T09:00:00Z'),
    item('f20', '2026-02-20T09:00:00Z'),
    item('f05', '2026-02-05T09:00:00Z'),
    item('j20', '2026-01-20T09:00:00Z'),
    item('old', '2025-12-20T09:00:00Z'),
  ]

  const keep = backups.retentionKeep(items, 'smart', now)
  for (const name of ['d15b', 'd14', 'd13', 'd12', 'd11', 'd10', 'd09', 'd08', 'w01', 'f20', 'j20']) {
    assert.ok(keep.has(name), `${name} should be kept`)
  }
  assert.equal(keep.has('d15a'), false)
  assert.equal(keep.has('w02'), false)
  assert.equal(keep.has('f05'), false)
  assert.equal(keep.has('old'), false)
})

test('the other policies keep their stated window and stay finite', () => {
  const now = new Date('2026-03-15T12:00:00Z')
  const items = Array.from({ length: 40 }, (_, index) => ({
    name: `b${index}`,
    date: new Date(now.getTime() - index * 24 * 60 * 60 * 1000),
  }))

  assert.ok(backups.retentionKeep(items, 'daily', now).size <= 14)
  assert.ok(backups.retentionKeep(items, 'weekly', now).size <= 12)
  assert.ok(backups.retentionKeep(items, 'monthly', now).size <= 12)
  assert.equal(backups.retentionKeep(items, 'manual', now).size, 20)

  const today = [{ name: 'today', date: now }]
  assert.equal(backups.shouldRun('smart', today, now), false)
  assert.equal(backups.shouldRun('daily', today, now), false)
  assert.equal(backups.shouldRun('weekly', today, now), false)
  assert.equal(backups.shouldRun('monthly', today, now), false)
  assert.equal(backups.shouldRun('manual', [], now), false)

  const yesterday = [{ name: 'yesterday', date: new Date(now.getTime() - 24 * 60 * 60 * 1000) }]
  assert.equal(backups.shouldRun('smart', yesterday, now), true)
  const next = new Date(backups.nextDueAt('smart', today, now))
  assert.equal(next.getHours(), 0)
  assert.equal(next.getMinutes(), 5)
})

test('restore extracts a ZIP into a new workspace and never touches the live one', async () => {
  const { record, linked } = makeWorkspace()
  const snapshot = await backups.createSnapshot(record, { reason: 'manual', mode: 'smart' })

  fs.rmSync(path.join(record.path, 'entities/agent.md'))
  assert.equal(fs.existsSync(path.join(record.path, 'entities/agent.md')), false)

  const restored = await backups.restore({ id: record.id, name: snapshot.name })
  const copy = restored.record
  assert.notEqual(copy.id, record.id)
  assert.match(copy.label, /\(restored\)$/)
  assert.equal(restored.source.workspace, record.id)

  const entity = path.join(copy.path, 'entities/agent.md')
  assert.match(fs.readFileSync(entity, 'utf8'), /Be brief/)
  assert.equal(fs.existsSync(path.join(copy.path, 'backup.json')), false)
  assert.equal(fs.existsSync(path.join(copy.path, 'runs')), true)
  assert.equal(fs.existsSync(path.join(copy.path, 'empty-dir')), true)
  assert.equal(fs.existsSync(path.join(copy.path, '.remote.token')), false)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(copy.path, 'mcp.json')).mode & 0o777, 0o600)
  }

  const workspace = JSON.parse(fs.readFileSync(path.join(copy.path, 'workspace.json'), 'utf8'))
  assert.equal(workspace.id, copy.id)
  assert.match(workspace.label, /\(restored\)$/)
  assert.equal(workspace.context, 'Keep this context.')
  const members = JSON.parse(fs.readFileSync(path.join(copy.path, 'members.json'), 'utf8'))
  assert.equal(members.workspace, copy.id)

  if (linked) {
    const skill = path.join(copy.path, 'skills', 'demo')
    assert.equal(fs.lstatSync(skill).isSymbolicLink(), false)
    assert.match(fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8'), /# skill/)
  }

  assert.equal(fs.existsSync(path.join(record.path, 'entities/agent.md')), false)
})

test('a backup does not depend on the library link target, and bad names are refused', async () => {
  const { record, linked, skillTarget } = makeWorkspace()
  const snapshot = await backups.createSnapshot(record, { reason: 'manual', mode: 'smart' })

  if (linked) {
    /* The library entry can disappear; the snapshot already has the bytes. */
    fs.rmSync(skillTarget, { recursive: true, force: true })
    const restored = await backups.restore({ id: record.id, name: snapshot.name })
    assert.match(
      fs.readFileSync(path.join(restored.record.path, 'skills', 'demo', 'SKILL.md'), 'utf8'),
      /# skill/,
    )
  }

  await assert.rejects(() => backups.restore({ id: record.id, name: '../escape.zip' }), /ZIP name/)
  await assert.rejects(
    () => backups.removeSnapshot({ id: record.id, name: '.hidden.zip' }),
    /ZIP name/,
  )
})

test('remove deletes one ZIP and the scheduler backs up a due workspace', async () => {
  const { record } = makeWorkspace()
  const first = await backups.createSnapshot(record, { reason: 'manual', mode: 'manual' })
  const second = await backups.createSnapshot(record, { reason: 'manual', mode: 'manual' })
  const entry = await backups.removeSnapshot({ id: record.id, name: first.name })
  assert.equal(entry.items.some((item) => item.name === first.name), false)
  assert.equal(entry.items.some((item) => item.name === second.name), true)

  const fresh = makeWorkspace()
  const lines = []
  await backups.tick({ log: (line) => lines.push(line) })
  const after = (await backups.status()).workspaces.find(
    (row) => row.id === fresh.record.id,
  )
  assert.equal(after.items.length >= 1, true)
  assert.ok(lines.some((line) => line.includes(fresh.record.id)))
})
