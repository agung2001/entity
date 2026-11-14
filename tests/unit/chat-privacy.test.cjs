const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-chat-privacy-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('../../electron/workspace-store.cjs')
const entities = require('../../electron/entity-store.cjs')
const chats = require('../../electron/chat-store.cjs')
const auth = require('../../electron/auth-store.cjs')

test('chat history is visible only to the account that created it', (t) => {
  const record = workspaces.create({ label: 'private' })
  const workspace = record.id
  entities.scaffold({ workspace, name: 'private-agent', harness: 'pi' })

  const original = auth.get
  t.after(() => {
    auth.get = original
  })
  auth.get = () => ({ username: 'alice', email: 'alice@example.com', role: 'owner' })
  const aliceThread = chats.create({ workspace, entity: 'private-agent', harness: 'pi' })

  assert.equal(chats.list({ workspace }).length, 1)
  assert.ok(chats.read({ workspace, id: aliceThread.id }))

  auth.get = () => ({ username: 'bob', email: 'bob@example.com', role: 'member' })
  assert.deepEqual(chats.list({ workspace }), [])
  assert.equal(chats.read({ workspace, id: aliceThread.id }), null)
  assert.throws(() => chats.rename({ workspace, id: aliceThread.id, title: 'stolen' }), /no longer exists/)
  assert.deepEqual(chats.remove({ workspace, id: aliceThread.id }), { removed: false })

  const bobThread = chats.create({ workspace, entity: 'private-agent', harness: 'pi' })
  assert.deepEqual(
    chats.list({ workspace }).map((thread) => thread.id),
    [bobThread.id],
  )

  auth.get = () => ({ username: 'alice', email: 'alice@example.com', role: 'owner' })
  assert.deepEqual(
    chats.list({ workspace }).map((thread) => thread.id),
    [aliceThread.id],
  )

  auth.get = original
})
