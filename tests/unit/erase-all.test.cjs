/**
 * "Erase all" on Workspace → Chats / Artifacts.
 *
 * The two verbs are destructive and have no undo, so what they must not do is as
 * important as what they do: leave a thread that belongs to another account
 * behind, leave the archive and the trash on the disk while the card says the
 * shelf is empty, and erase anything while a turn is still writing.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-erase-all-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('../../electron/workspace-store.cjs')
const entities = require('../../electron/entity-store.cjs')
const chats = require('../../electron/chat-store.cjs')
const artifacts = require('../../electron/artifact-store.cjs')
const artifactRetention = require('../../electron/artifact-retention-store.cjs')

let seq = 0

function room() {
  const created = workspaces.create({ label: `erase-${++seq}` })
  entities.scaffold({ workspace: created.id, name: 'chief-of-staff', harness: 'claude' })
  return workspaces.open(created.id)
}

function threads(record, count = 3) {
  return Array.from({ length: count }, () =>
    chats.create({ workspace: record.id, entity: 'chief-of-staff', harness: 'claude' }),
  )
}

test('erase all removes every thread in the workspace, archived ones included', () => {
  const record = room()
  const created = threads(record)
  chats.archive({ workspace: record.id, id: created[0].id, archived: true })
  const dir = path.join(record.path, 'chats')

  assert.equal(fs.readdirSync(dir).filter((file) => file.endsWith('.json')).length, 3)
  const result = chats.eraseAll({ workspace: record.id })
  assert.equal(result.removed, 3)
  assert.deepEqual(chats.list({ workspace: record.id }), [])
  assert.deepEqual(
    fs.readdirSync(dir).filter((file) => file.endsWith('.json')),
    [],
    'the folder keeps no thread file behind',
  )
})

test('erase all leaves a folder that was never written alone', () => {
  const record = room()
  assert.deepEqual(chats.eraseAll({ workspace: record.id }), { removed: 0, bytes: 0 })
  assert.deepEqual(chats.list({ workspace: record.id }), [])
})

test('a thread another account started is not this person\'s history', () => {
  const record = room()
  /* One account writes two threads; a colleague's single thread lives beside
     them in the same folder. The erase is this person's, so the colleague's row
     has to survive it. */
  chats.setIdentityResolver(() => ({ email: 'avery@example.test' }))
  try {
    threads(record, 2)
    chats.setIdentityResolver(() => ({ email: 'blake@example.test' }))
    const colleague = threads(record, 1)[0]
    const file = path.join(record.path, 'chats', `${colleague.id}.json`)

    chats.setIdentityResolver(() => ({ email: 'avery@example.test' }))
    const result = chats.eraseAll({ workspace: record.id })
    assert.equal(result.removed, 2, 'the two rows this account can read')
    assert.ok(fs.existsSync(file), "a colleague's thread is not this person's to erase")
  } finally {
    chats.setIdentityResolver(null)
  }
})

test('erase all removes the shelf, its archive, its trash and a personal shelf', () => {
  const record = room()
  const shared = artifacts.artifactsDir(record)
  fs.mkdirSync(path.join(shared, '.archive'), { recursive: true })
  fs.mkdirSync(path.join(shared, '.trash'), { recursive: true })
  artifacts.saveText({ workspace: record.id, name: 'note.md', text: '# Note\n' })
  artifacts.share({ workspace: record.id, id: 'note.md' })
  const archived = path.join(shared, '.archive', 'old.md')
  fs.writeFileSync(archived, 'old\n')
  fs.writeFileSync(path.join(shared, '.trash', 'gone.md'), 'gone\n')
  fs.writeFileSync(artifactRetention.stampsFile(record), JSON.stringify({ 'old.md': new Date().toISOString() }))
  const personal = artifacts.personalDir(record)
  fs.mkdirSync(personal, { recursive: true })
  fs.writeFileSync(path.join(personal, 'mine.md'), 'mine\n')

  /* The sweep's archive and trash are dot folders the shelf walk skips: they are
     the reason a "erase everything" that only listed the shelf would lie. */
  const state = artifactRetention.analyse({ workspace: record.id })
  assert.ok(state.meta.archived >= 0)

  const result = artifacts.eraseAll({ workspace: record.id, scope: 'all' })
  assert.equal(result.scope, 'all')
  assert.ok(result.removed >= 4, `expected every file to go, removed ${result.removed}`)
  assert.deepEqual(artifacts.list({ workspace: record.id }).items, [])
  assert.equal(fs.existsSync(archived), false)
  assert.equal(fs.existsSync(path.join(personal, 'mine.md')), false)
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(shared, '.scope.json'), 'utf8')).shared,
    {},
    'the scope index names no file that is gone',
  )
})

test('the shared scope leaves every personal shelf where it is', () => {
  const record = room()
  const shared = artifacts.artifactsDir(record)
  fs.mkdirSync(path.join(shared, '.archive'), { recursive: true })
  artifacts.saveText({ workspace: record.id, name: 'note.md', text: '# Note\n' })
  artifacts.share({ workspace: record.id, id: 'note.md' })
  fs.writeFileSync(path.join(shared, '.archive', 'old.md'), 'old\n')
  const personal = artifacts.personalDir(record)
  fs.mkdirSync(personal, { recursive: true })
  fs.writeFileSync(path.join(personal, 'mine.md'), 'mine\n')

  const result = artifacts.eraseAll({ workspace: record.id, scope: 'shared' })
  /* the shelf file, the archived one, and the scope index that named them */
  assert.ok(result.removed >= 2, `removed ${result.removed}`)
  assert.equal(fs.existsSync(path.join(shared, 'note.md')), false)
  assert.equal(fs.existsSync(path.join(shared, '.archive', 'old.md')), false)
  assert.equal(fs.existsSync(path.join(personal, 'mine.md')), true, 'a personal shelf is not shared')
})

test('the personal scope leaves the shared shelf where it is, and a colleague\'s shelf too', () => {
  const record = room()
  const shared = artifacts.artifactsDir(record)
  fs.mkdirSync(shared, { recursive: true })
  artifacts.saveText({ workspace: record.id, name: 'note.md', text: '# Note\n' })
  artifacts.share({ workspace: record.id, id: 'note.md' })
  const personal = artifacts.personalDir(record)
  fs.mkdirSync(personal, { recursive: true })
  fs.writeFileSync(path.join(personal, 'mine.md'), 'mine\n')
  /* Another account's shelf is never on this page, so "erase personal" must not
     reach it either. */
  const colleague = path.join(record.path, '.personal', 'blake-example-test', 'artifacts')
  fs.mkdirSync(colleague, { recursive: true })
  fs.writeFileSync(path.join(colleague, 'theirs.md'), 'theirs\n')

  const result = artifacts.eraseAll({ workspace: record.id, scope: 'personal' })
  assert.equal(result.removed, 1)
  assert.equal(fs.existsSync(path.join(personal, 'mine.md')), false)
  assert.equal(fs.existsSync(path.join(shared, 'note.md')), true, 'the shared shelf is not personal')
  assert.equal(fs.existsSync(path.join(colleague, 'theirs.md')), true, 'a colleague\'s shelf is not yours')
})

test('an unknown scope is an error, never a silent erase-everything', () => {
  const record = room()
  artifacts.saveText({ workspace: record.id, name: 'note.md', text: '# Note\n' })
  assert.throws(() => artifacts.eraseAll({ workspace: record.id, scope: 'everything' }), /scope/i)
  assert.equal(artifacts.list({ workspace: record.id }).items.length, 1, 'nothing was removed')
})

test('erase all leaves a shelf that was never written alone', () => {
  const record = room()
  assert.deepEqual(artifacts.eraseAll({ workspace: record.id }), {
    scope: 'all',
    removed: 0,
    bytes: 0,
  })
  assert.deepEqual(artifacts.list({ workspace: record.id }).items, [])
})
