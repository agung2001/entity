/**
 * The window's half of a cross-workspace copy.
 *
 * A pinned run can only park a request. Approval re-reads the source, compares
 * the hash the run recorded, and writes the target only when they still agree;
 * an edit between the two makes the card stale rather than approving content
 * the person never saw.
 */
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-clone-consent-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('../../electron/workspace-store.cjs')
const entities = require('../../electron/entity-store.cjs')
const pendingClones = require('../../electron/pending-clone.cjs')
const { createRpc } = require('../../electron/rpc.cjs')

test('approval copies only the content hash the person was shown', async (t) => {
  const source = workspaces.create({ label: 'consent-source' })
  const target = workspaces.create({ label: 'consent-target' })
  entities.scaffold({ workspace: source.id, name: 'agent', harness: 'pi' })
  const sourceFile = entities.locate({ workspace: source.id, name: 'agent' })
  const record = workspaces.open(source.id)

  const request = () => {
    const sha256 = crypto
      .createHash('sha256')
      .update(fs.readFileSync(sourceFile))
      .digest('hex')
    return pendingClones.write(record, {
      at: new Date().toISOString(),
      from: source.id,
      to: target.id,
      name: 'agent',
      nextName: '',
      sha256,
      bytes: fs.statSync(sourceFile).size,
      summary: 'A test agent.',
      mark: null,
      requestedBy: 'lead',
    })
  }

  const rpc = createRpc({ emit: () => {} })
  t.after(() => rpc.closeAll())

  const first = request()
  const pending = await rpc.call('clone.pending', { workspace: source.id })
  assert.equal(pending.ok, true)
  assert.equal(pending.data.id, first.id)

  /* The source changes after the ask: approval must not publish the new body. */
  fs.appendFileSync(sourceFile, '\n# edited after the request\n')
  const changed = await rpc.call('clone.approve', { workspace: source.id, id: first.id })
  assert.equal(changed.ok, false)
  assert.match(changed.error, /changed since the request/)
  assert.equal(fs.existsSync(path.join(target.path, 'entities', 'agent.md')), false)
  assert.equal(pendingClones.read(record), null)

  /* A fresh request over the current bytes is approved and clears the card. */
  const second = request()
  const approved = await rpc.call('clone.approve', { workspace: source.id, id: second.id })
  assert.equal(approved.ok, true, approved.error)
  assert.equal(approved.data.name, 'agent')
  assert.equal(fs.existsSync(path.join(target.path, 'entities', 'agent.md')), true)
  assert.equal(pendingClones.read(record), null)
})
