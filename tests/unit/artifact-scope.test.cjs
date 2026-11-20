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

/* ── a path is not consent ─────────────────────────────────────────────
 *
 * The shared tree is what an export bundle and a remote sync carry, and it used
 * to fill two ways: `share()` (a rename plus an index entry) and *anything that
 * wrote a path under `artifacts/`* — an agent told to leave a screenshot on "the
 * workspace artifact shelf", a render script, a hand-run command. Those files
 * were never shared by anyone, yet `list()` called them Shared because of where
 * they sat, so a colleague received them on the next sync.
 *
 * The rule: **a file is on the workspace shelf because someone shared it, not
 * because of its path.** These pin both halves — what the shelf reports, and
 * what the wire carries.
 */
test('a file written into the shared tree was never shared, so it reads as personal', () => {
  const leaky = workspaces.create({ label: 'leaky-shelf' })
  const record = workspaces.open(leaky.id)
  const dir = artifacts.artifactsDir(record)
  fs.mkdirSync(path.join(dir, 'screenshots', 'entity-41'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'agent-shot.png'), 'png bytes')
  fs.writeFileSync(path.join(dir, 'screenshots', 'entity-41', 'leak.png'), 'png bytes')

  const shelfNow = shelf(leaky.id)
  assert.deepEqual(shelfNow.counts, { personal: 2, shared: 0 }, 'nobody shared these')
  assert.equal(shelfNow.unclaimed, 2, 'and the answer says why they look odd')
  for (const item of shelfNow.items) {
    assert.equal(item.scope, 'personal')
    assert.equal(item.unclaimed, true)
    assert.equal(item.owner, null, 'no share means no owner')
  }
})

test('the wire carries what the index claims, never a path an agent wrote', async () => {
  const leaky = workspaces.create({ label: 'leaky-wire' })
  const record = workspaces.open(leaky.id)
  const dir = artifacts.artifactsDir(record)
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'shots', 'leak.png'), 'png bytes')
  fs.writeFileSync(path.join(dir, 'report.md'), 'agent output')

  /* Nothing shared: the manifest carries the shelf's config and no artifact. */
  const empty = await manifest.buildManifest(record.path, manifest.recordInputs(record))
  assert.deepEqual(
    empty.files.map((file) => file.path).filter((rel) => rel.startsWith('artifacts/')),
    [],
    'an unshared file must not travel',
  )

  /* Share one of them; exactly that one travels, and the other still does not. */
  const saved = artifacts.saveText({ workspace: leaky.id, name: 'kept.md', text: '# kept' })
  artifacts.share({ workspace: leaky.id, id: saved.id })
  const shared = await manifest.buildManifest(record.path, manifest.recordInputs(record))
  assert.deepEqual(
    shared.files.map((file) => file.path).filter((rel) => rel.startsWith('artifacts/')).sort(),
    ['artifacts/.scope.json', 'artifacts/kept.md'],
  )
})

test('adoption takes back what nobody shared, and keeps both files on a clash', () => {
  const messy = workspaces.create({ label: 'messy-shelf' })
  const record = workspaces.open(messy.id)
  const dir = artifacts.artifactsDir(record)
  const home = artifacts.personalDir(record)
  fs.mkdirSync(path.join(dir, 'design', 'hero'), { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(dir, 'design', 'hero', 'index.html'), 'agent')
  /* a file the person already has under the same name must survive */
  fs.writeFileSync(path.join(home, 'mine.md'), 'MINE')
  fs.writeFileSync(path.join(dir, 'mine.md'), 'AGENT')

  const first = artifacts.adoptUnclaimed(record)
  assert.equal(first.failed.length, 0)
  assert.equal(first.adopted.length, 2)
  assert.equal(fs.readFileSync(path.join(home, 'mine.md'), 'utf8'), 'MINE', 'the person keeps theirs')
  assert.equal(fs.readFileSync(path.join(home, 'mine-2.md'), 'utf8'), 'AGENT', 'the agent copy is kept')
  assert.equal(fs.existsSync(path.join(home, 'design', 'hero', 'index.html')), true, 'the path is kept')
  assert.equal(fs.existsSync(path.join(dir, 'design', 'hero', 'index.html')), false)

  /* idempotent: a second pass has nothing left to take back */
  assert.deepEqual(artifacts.adoptUnclaimed(record).adopted, [])
  assert.deepEqual(shelf(messy.id).counts, { personal: 3, shared: 0 })
})

test("the sync engine's conflict copies are evidence, not shelf rows", () => {
  const conflicted = workspaces.create({ label: 'conflicted-shelf' })
  const record = workspaces.open(conflicted.id)
  const dir = artifacts.artifactsDir(record)
  fs.mkdirSync(path.join(dir, 'conflicts', 'artifacts'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'conflicts', 'artifacts', 'a.html'), 'local bytes')
  fs.writeFileSync(path.join(dir, 'real.png'), 'png')

  const listed = shelf(conflicted.id)
  assert.deepEqual(listed.items.map((item) => item.id), ['real.png'], 'a conflict copy is not an artifact')
  /* and adoption leaves the record of the disagreement alone */
  artifacts.adoptUnclaimed(record)
  assert.equal(fs.existsSync(path.join(dir, 'conflicts', 'artifacts', 'a.html')), true)
  assert.equal(fs.existsSync(path.join(dir, 'real.png')), false, 'the real file moved home')
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
