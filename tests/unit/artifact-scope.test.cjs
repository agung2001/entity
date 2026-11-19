/**
 * A personal artifact lives on your own shelf and nowhere else: `<ws>/.personal/
 * <account>/artifacts`, which no export and no sync can reach. Sharing is a
 * rename into `<ws>/artifacts`, the one tree both of them carry — so one file
 * exists in one place, and "only I can see it" is a location, not a flag.
 *
 * Who may take a file back is decided here, from the account on this machine and
 * the workspace roster, never from the renderer.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-artifact-scope-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('../../electron/workspace-store.cjs')
const artifacts = require('../../electron/artifact-store.cjs')
const manifest = require('../../electron/remote-manifest.cjs')

/** Be a different signed-in account; `auth.json`'s public shape is the contract. */
function beActor(username, email) {
  fs.writeFileSync(
    path.join(PROFILE, 'auth.json'),
    JSON.stringify({ schema: 1, user: { username, email } }),
  )
}

const png = (text) => `data:image/png;base64,${Buffer.from(text).toString('base64')}`
const shelf = (id) => artifacts.list({ workspace: id })
const personalPath = (id, name) => path.join(artifacts.personalDir(workspaces.open(id)), name)
const sharedPath = (id, name) => path.join(artifacts.artifactsDir(workspaces.open(id)), name)

const record = workspaces.create({
  label: 'scope-shelf',
  owner: { name: 'Avery', email: 'avery@example.test' },
})
workspaces.update({
  id: record.id,
  members: [
    { name: 'Avery', email: 'avery@example.test', role: 'owner' },
    { name: 'Blake', email: 'blake@example.test', role: 'admin' },
    { name: 'Casey', email: 'casey@example.test', role: 'member' },
  ],
})
beActor('Avery', 'avery@example.test')

test('a saved file lands on your own shelf, outside the shared tree', () => {
  const saved = artifacts.upload({ workspace: record.id, name: 'shot.png', dataUrl: png('png bytes') })
  assert.equal(saved.scope, 'personal')
  assert.equal(saved.owner, null)
  assert.deepEqual(shelf(record.id).counts, { personal: 1, shared: 0 })
  assert.equal(fs.existsSync(personalPath(record.id, 'shot.png')), true)
  assert.equal(fs.existsSync(sharedPath(record.id, 'shot.png')), false)
})

test('another account on this machine has its own shelf and sees none of it', () => {
  beActor('Casey', 'casey@example.test')
  assert.deepEqual(shelf(record.id).counts, { personal: 0, shared: 0 })
  assert.deepEqual(shelf(record.id).items, [])
  assert.equal(fs.existsSync(personalPath(record.id, 'shot.png')), false)
  beActor('Avery', 'avery@example.test')
})

test('sharing moves the file to the workspace shelf and stamps the owner', () => {
  const shared = artifacts.share({ workspace: record.id, id: 'shot.png' })
  assert.equal(shared.scope, 'shared')
  assert.deepEqual(shared.owner, { name: 'Avery', email: 'avery@example.test' })
  assert.deepEqual(shelf(record.id).counts, { personal: 0, shared: 1 })
  assert.equal(fs.existsSync(sharedPath(record.id, 'shot.png')), true)
  assert.equal(fs.existsSync(personalPath(record.id, 'shot.png')), false)
})

test('a plain member cannot take back a file someone else shared; an admin can', () => {
  beActor('Casey', 'casey@example.test')
  assert.throws(
    () => artifacts.unshare({ workspace: record.id, id: 'shot.png' }),
    /owner or a workspace owner\/admin/,
  )
  assert.deepEqual(shelf(record.id).counts, { personal: 0, shared: 1 })

  /* Taking a file off the workspace shelf puts it in the hands of whoever did
     it — the alternative is deleting it for everyone. */
  beActor('Blake', 'blake@example.test')
  assert.equal(artifacts.unshare({ workspace: record.id, id: 'shot.png' }).scope, 'personal')
  assert.deepEqual(shelf(record.id).counts, { personal: 1, shared: 0 })
  assert.equal(fs.existsSync(personalPath(record.id, 'shot.png')), true)

  beActor('Avery', 'avery@example.test')
  assert.deepEqual(shelf(record.id).counts, { personal: 0, shared: 0 })
})

test('the share travels: the bundle carries the index and the shared file, not your own shelf', () => {
  beActor('Blake', 'blake@example.test')
  artifacts.share({ workspace: record.id, id: 'shot.png' })
  artifacts.upload({ workspace: record.id, name: 'notes.md', dataUrl: 'data:text/markdown;base64,bm90ZXM=' })

  const bundle = workspaces.exportWorkspace({ id: record.id })
  assert.ok(bundle.files['artifacts/.scope.json'], 'the index must be in the bundle')
  assert.ok(bundle.files['artifacts/shot.png'], 'a shared file travels')
  assert.equal(bundle.files['artifacts/notes.md'], undefined, 'a personal file never leaves')
  assert.equal(
    Object.keys(bundle.files).some((rel) => rel.includes('.personal')),
    false,
    'the personal root is not in the bundle',
  )

  const copy = workspaces.importWorkspace({ bundle })
  const imported = shelf(copy.record.id)
  assert.deepEqual(imported.counts, { personal: 0, shared: 1 })
  assert.deepEqual(imported.items[0].owner, { name: 'Blake', email: 'blake@example.test' })
})

test('the scope index is the one hidden file sync carries, and a clash is a union', () => {
  assert.equal(manifest.safeRel('artifacts/.scope.json'), 'artifacts/.scope.json')
  assert.equal(manifest.safeRel('artifacts/.remote.token'), null)
  assert.equal(manifest.safeRel('.personal/agung-test/artifacts/notes.md'), null)

  const local = JSON.stringify({
    schema: 1,
    shared: { 'a.png': { owner: { name: 'Avery', email: 'avery@example.test' }, at: '2026-01-01T00:00:00.000Z' } },
  })
  const remote = JSON.stringify({
    schema: 1,
    shared: {
      'b.png': { owner: { name: 'Casey', email: 'casey@example.test' }, at: '2026-01-01T00:00:01.000Z' },
      'a.png': { owner: { name: 'Casey', email: 'casey@example.test' }, at: '2026-01-01T00:00:02.000Z' },
    },
  })
  const merged = JSON.parse(manifest.mergeScopeIndex(local, remote))
  assert.deepEqual(Object.keys(merged.shared).sort(), ['a.png', 'b.png'])
  /* one file, one owner: the later share is the one that happened */
  assert.equal(merged.shared['a.png'].owner.name, 'Casey')
})

test('a removed file leaves no stale id behind', () => {
  beActor('Blake', 'blake@example.test')
  artifacts.remove({ workspace: record.id, id: 'shot.png' })
  assert.deepEqual(shelf(record.id).counts, { personal: 1, shared: 0 })
  assert.deepEqual(Object.keys(JSON.parse(
    fs.readFileSync(path.join(artifacts.artifactsDir(workspaces.open(record.id)), '.scope.json'), 'utf8'),
  ).shared), [])
})

/* ── the origin index follows the files, not the shelf word ────────────
 *
 * `eraseAll` takes a scope, and `personal` leaves the shared shelf standing. A
 * blanket clear of the origin map there would unattach files that are still on
 * disk; a stale entry is worse — a new file with the same name would be handed
 * to a conversation that ended days ago.
 */
const originFile = (id) => path.join(artifacts.artifactsDir(workspaces.open(id)), '.origin.json')
const origins = (id) => {
  try {
    return JSON.parse(fs.readFileSync(originFile(id), 'utf8')).threads
  } catch {
    return {}
  }
}

test('the origin index is pruned against the files that survived the erase', () => {
  const isPersonalOnly = workspaces.create({ label: 'origin-erase' })
  const saved = artifacts.saveText({ workspace: isPersonalOnly.id, name: 'brief.md', text: 'a' })
  assert.deepEqual(artifacts.stampOrigins({ workspace: isPersonalOnly.id, threadId: 't_alpha', ids: [saved.id] }), [
    'brief.md',
  ])

  /* Erasing one shelf must not unattach a file on the other one. */
  artifacts.share({ workspace: isPersonalOnly.id, id: saved.id })
  artifacts.eraseAll({ workspace: isPersonalOnly.id, scope: 'personal' })
  assert.deepEqual(origins(isPersonalOnly.id), { 'brief.md': 't_alpha' })

  /* Erasing everything must leave no id behind… */
  artifacts.eraseAll({ workspace: isPersonalOnly.id, scope: 'all' })
  assert.deepEqual(origins(isPersonalOnly.id), {})

  /* …so a later file of the same name is nobody's, not the old thread's. */
  artifacts.saveText({ workspace: isPersonalOnly.id, name: 'brief.md', text: 'b' })
  assert.deepEqual(origins(isPersonalOnly.id), {})
})
