const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-chat-cancel-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('./workspace-store.cjs')
const entities = require('./entity-store.cjs')
const chats = require('./chat-store.cjs')
const harnesses = require('./harness-store.cjs')

test('stopping a live turn records a stopped message, not a harness failure', async (t) => {
  const record = workspaces.create({ label: 'cancel' })
  const workspace = record.id
  entities.scaffold({ workspace, name: 'slow-agent', harness: 'pi' })

  const fake = path.join(PROFILE, 'slow-pi')
  fs.writeFileSync(fake, '#!/bin/sh\nsleep 60\n', { mode: 0o755 })
  harnesses.setPath({ id: 'pi', path: fake })

  const thread = await chats.create({ workspace, entity: 'slow-agent', harness: 'pi' })
  const turn = chats.send({ workspace, id: thread.id, text: 'Take your time.' })
  t.after(() => chats.closeAll())

  for (let i = 0; i < 50 && chats.activeCount() === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(chats.activeCount(), 1)

  const stopped = chats.cancel({ workspace, id: thread.id })
  assert.equal(stopped.canceled, true)
  const updated = await turn
  const last = updated.messages.at(-1)
  assert.equal(last.who, 'sys')
  assert.equal(last.text, 'Stopped by you.')
  assert.equal(last.error, undefined)
  assert.equal(last.execution.status, 'canceled')
})
