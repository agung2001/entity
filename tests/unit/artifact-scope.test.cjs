/**
 * A file is personal until someone shares it, and the share is a sidecar index
 * entry — not a second folder and not a copy. Who may take it back is decided
 * here, from the account on this machine and the workspace roster, never from
 * the renderer.
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

/** Be a different signed-in account; `auth.json`'s public shape is the contract. */
function beActor(username, email) {
  fs.writeFileSync(
    path.join(PROFILE, 'auth.json'),
    JSON.stringify({ schema: 1, user: { username, email } }),
  )
}

const record = workspaces.create({
  label: 'scope-shelf',
  owner: { name: 'Agung', email: 'agung@artistudio.test' },
})
workspaces.update({
  id: record.id,
  members: [
    { name: 'Agung', email: 'agung@artistudio.test', role: 'owner' },
    { name: 'Sonny', email: 'sonny@artistudio.test', role: 'admin' },
    { name: 'Nadiyya', email: 'nadiyya@artistudio.test', role: 'member' },
  ],
})
fs.writeFileSync(path.join(record.path, 'artifacts', 'shot.png'), 'png bytes')
beActor('Agung', 'agung@artistudio.test')

test('a new file is personal, with both counts real', () => {
  const shelf = artifacts.list({ workspace: record.id })
  assert.equal(shelf.items[0].scope, 'personal')
  assert.equal(shelf.items[0].owner, null)
  assert.deepEqual(shelf.counts, { personal: 1, shared: 0 })
})

test('sharing stamps the resolved owner and moves the counts', () => {
  const shared = artifacts.share({ workspace: record.id, id: 'shot.png' })
  assert.equal(shared.scope, 'shared')
  assert.deepEqual(shared.owner, { name: 'Agung', email: 'agung@artistudio.test' })
  const shelf = artifacts.list({ workspace: record.id })
  assert.deepEqual(shelf.counts, { personal: 0, shared: 1 })
  assert.equal(shelf.items[0].scope, 'shared')
})

test('a plain member cannot take back a file someone else shared', () => {
  beActor('Nadiyya', 'nadiyya@artistudio.test')
  assert.throws(
    () => artifacts.unshare({ workspace: record.id, id: 'shot.png' }),
    /owner or a workspace owner\/admin/,
  )
  assert.deepEqual(artifacts.list({ workspace: record.id }).counts, { personal: 0, shared: 1 })

  beActor('Sonny', 'sonny@artistudio.test')
  const back = artifacts.unshare({ workspace: record.id, id: 'shot.png' })
  assert.equal(back.scope, 'personal')
  assert.deepEqual(artifacts.list({ workspace: record.id }).counts, { personal: 1, shared: 0 })
})

test('a removed file leaves no stale id behind', () => {
  artifacts.share({ workspace: record.id, id: 'shot.png' })
  artifacts.remove({ workspace: record.id, id: 'shot.png' })
  assert.deepEqual(artifacts.list({ workspace: record.id }).counts, { personal: 0, shared: 0 })
})
