/**
 * The window's half of an instruction rewrite.
 *
 * A run may only park the proposal. Approval runs the same verb from the window,
 * which is nobody's run, and passes back the stamp the proposal was read at: a
 * file edited between the request and the click is a conflict, not an overwrite
 * of a line the person never saw.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-write-consent-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('../../electron/workspace-store.cjs')
const entities = require('../../electron/entity-store.cjs')
const pendingWrites = require('../../electron/pending-write.cjs')
const platform = require('../../electron/platform-core.cjs')
const { createRpc } = require('../../electron/rpc.cjs')

test('approval writes only the body the person was shown', async (t) => {
  const workspace = workspaces.create({ label: 'write-consent' })
  const record = workspaces.open(workspace.id)
  entities.scaffold({ workspace: workspace.id, name: 'researcher', harness: 'pi' })
  const file = entities.locate({ workspace: workspace.id, name: 'researcher' })
  const before = fs.readFileSync(file, 'utf8')

  /* The run's own call parks; nothing is written. */
  process.env.ENTITY_ENTITY = 'researcher'
  let parked
  try {
    parked = platform.call('entity.setInstructions', {
      workspace: workspace.id,
      name: 'researcher',
      body: `${before}\n\nCite the counter-paper.\n`,
    })
  } finally {
    delete process.env.ENTITY_ENTITY
  }
  assert.equal(parked.ok, false)
  assert.equal(parked.code, 'needs_consent')
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the run wrote without consent')
  assert.equal(pendingWrites.read(record)?.name, 'researcher')

  const rpc = createRpc({ emit: () => {} })
  t.after(() => rpc.closeAll())

  const pending = await rpc.call('write.pending', { workspace: workspace.id })
  assert.equal(pending.ok, true)
  assert.equal(pending.data.id, pendingWrites.read(record).id)
  assert.equal(pending.data.body, undefined, 'pending is metadata only')

  /* The file moves after the ask: approval must refuse, not overwrite — and the
     card keeps the request so it can say `stale` and `Not now` still works. */
  fs.appendFileSync(file, '\n# edited after the request\n')
  const changed = await rpc.call('write.approve', { workspace: workspace.id, id: pending.data.id })
  assert.equal(changed.ok, false)
  assert.match(changed.error, /changed since you read it/)
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /Cite the counter-paper/)
  assert.equal(pendingWrites.read(record)?.id, pending.data.id, 'a conflict cleared the request')
  assert.equal((await rpc.call('write.dismiss', { workspace: workspace.id, id: pending.data.id })).data.dismissed, true)

  /* A fresh proposal over the current bytes is applied and clears the card. */
  const proposal = pendingWrites.write(record, {
    at: new Date().toISOString(),
    workspace: workspace.id,
    name: 'researcher',
    body: `${before}\n\nCite the counter-paper.\n`,
    previousBody: before,
    previousBytes: Buffer.byteLength(before),
    bytes: 1,
    sha256: 'x',
    stamp: platform.call('entity.get', { workspace: workspace.id, name: 'researcher' }).data.stamp,
    requestedBy: 'researcher',
  })
  const read = await rpc.call('write.proposal', { workspace: workspace.id, id: proposal.id })
  assert.equal(read.data.previousBody, before)
  assert.equal(read.data.body, proposal.body)

  const applied = await rpc.call('write.approve', { workspace: workspace.id, id: proposal.id })
  assert.equal(applied.ok, true, applied.error)
  assert.equal(applied.data.name, 'researcher')
  assert.match(fs.readFileSync(file, 'utf8'), /Cite the counter-paper/)
  assert.equal(pendingWrites.read(record), null)

  /* Dismiss clears only the id it was given. */
  const first = pendingWrites.write(record, { ...proposal, sha256: 'a' })
  assert.equal((await rpc.call('write.dismiss', { workspace: workspace.id, id: 'stale' })).data.dismissed, false)
  assert.equal(pendingWrites.read(record)?.id, first.id)
  assert.equal((await rpc.call('write.dismiss', { workspace: workspace.id, id: first.id })).data.dismissed, true)
  assert.equal(pendingWrites.read(record), null)
})
