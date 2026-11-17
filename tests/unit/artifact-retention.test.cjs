/* Artifact retention (ENTITY-16) — two clocks, a one-time archive stamp, the protection a live chat applies. */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
process.env.ENTITY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-artifact-retention-'))

const workspaces = require('../../electron/workspace-store.cjs')
const artifacts = require('../../electron/artifact-store.cjs')
const retention = require('../../electron/artifact-retention-store.cjs')
const DAY = 24 * 60 * 60 * 1000

/* One workspace with files whose age in days is their mtime. */
function shelfWith(files) {
  const workspace = workspaces.create({ label: `shelf-${Math.random().toString(36).slice(2, 8)}` })
  const record = workspaces.open(workspace.id)
  const dir = artifacts.artifactsDir(record)
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, age] of files) {
    const file = path.join(dir, name)
    fs.writeFileSync(file, '# file\n')
    const at = new Date(Date.now() - age * DAY)
    fs.utimesSync(file, at, at)
  }
  return { workspace, record, dir }
}

test('a file past ① archives once, and its archive date is stamped once', async () => {
  const { workspace, record, dir } = shelfWith([['old.md', 40], ['young.md', 2]])
  assert.equal(retention.analyse({ workspace: workspace.id }).forecast.archive.files, 1)
  const pass = await retention.run({ workspace: workspace.id })
  assert.deepEqual(pass.archived, ['old.md'])
  assert.ok(fs.existsSync(path.join(dir, '.archive', 'old.md')), 'the file moved out of the shelf')
  const stamp = () => JSON.parse(fs.readFileSync(retention.stampsFile(record), 'utf8'))['old.md']
  const first = stamp()
  assert.deepEqual((await retention.run({ workspace: workspace.id })).archived, [])
  assert.equal(stamp(), first, 'a second pass does not reset the clock ② counts')
})

test('the delete line is ① + ② days of age, not ② alone', () => {
  const { workspace, record, dir } = shelfWith([])
  assert.equal(retention.analyse({ workspace: workspace.id }).thresholds.deathDays, 120)
  const archive = path.join(dir, '.archive')
  fs.mkdirSync(archive, { recursive: true })
  for (const name of ['gone.md', 'safe.md']) fs.writeFileSync(path.join(archive, name), 'x')
  const at = (days) => new Date(Date.now() - days * DAY).toISOString()
  fs.writeFileSync(retention.stampsFile(record), JSON.stringify({ 'gone.md': at(95), 'safe.md': at(85) }))
  const later = retention.analyse({ workspace: workspace.id })
  assert.equal(later.forecast.delete.files, 1, 'only the file past ② is due')
  assert.deepEqual(later.forecast.list.map((row) => row.id), ['gone.md'])
})

test('a file a live chat still names is held back', async () => {
  const { workspace } = shelfWith([['named.md', 40], ['unloved.md', 40]])
  retention.configure({ referenced: () => ['named.md'] })
  const state = retention.analyse({ workspace: workspace.id })
  assert.equal(state.forecast.held.referenced, 1)
  assert.deepEqual(state.forecast.list.map((row) => row.id), ['unloved.md'])
  assert.deepEqual((await retention.run({ workspace: workspace.id })).archived, ['unloved.md'])
  retention.configure({ referenced: null })
})

test('a workspace nobody opened on this tab is never swept', async () => {
  const { record, dir } = shelfWith([['silent.md', 900]])
  assert.equal(fs.existsSync(retention.settingsFile(record)), false, 'reading the tab creates the rule')
  await retention.tick({ now: new Date() })
  assert.equal(fs.existsSync(retention.settingsFile(record)), false)
  assert.ok(fs.existsSync(path.join(dir, 'silent.md')), 'the file was left alone')
})
