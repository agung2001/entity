const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/* `workspace-store` resolves ROOT at require time, so this has to come first. */
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-artifacts-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('./workspace-store.cjs')
const artifacts = require('./artifact-store.cjs')
const chats = require('./chat-store.cjs')

const workspace = workspaces.create({ label: 'artifact-chat' })
const record = workspaces.open(workspace.id)
const dir = path.join(record.path, 'artifacts', 'shots')
fs.mkdirSync(dir, { recursive: true })
const file = path.join(dir, 'login.png')
fs.writeFileSync(file, Buffer.from('not really a png'))
const old = new Date(Date.now() - 60_000)
fs.utimesSync(file, old, old)

test('an artifact written during a turn is recent output, not shelf history', () => {
  assert.equal(artifacts.recent({ workspace: workspace.id, since: Date.now() - 5_000 }).length, 0)
  const rows = artifacts.recent({ workspace: workspace.id, since: Date.now() - 120_000 })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'shots/login.png')
})

test('a thread keeps attached artifacts through a read', () => {
  const chatsDir = path.join(record.path, 'chats')
  fs.mkdirSync(chatsDir, { recursive: true })
  fs.writeFileSync(
    path.join(chatsDir, 't_artifact.json'),
    JSON.stringify({
      schema: 1,
      id: 't_artifact',
      entity: 'inbox-triage',
      machine: 'local',
      harness: 'pi',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        { who: 'me', text: 'take a screenshot', at: new Date().toISOString() },
        {
          who: 'agent',
          text: 'Here it is.',
          at: new Date().toISOString(),
          artifacts: [
            {
              id: 'shots/login.png',
              name: 'login.png',
              kind: 'image',
              mime: 'image/png',
              size: 15,
            },
          ],
        },
      ],
    }),
    'utf8',
  )
  const thread = chats.read({ workspace: workspace.id, id: 't_artifact' })
  assert.equal(thread.messages[1].artifacts.length, 1)
  assert.equal(thread.messages[1].artifacts[0].id, 'shots/login.png')
  assert.equal(thread.messages[1].artifacts[0].kind, 'image')
})
