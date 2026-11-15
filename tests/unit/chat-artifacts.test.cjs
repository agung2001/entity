/**
 * A remote turn stages the whole workspace and copies artifacts back, so every
 * shelf file gets a fresh mtime on every turn. Attachment must not infer from
 * time there: only a file the answer names belongs to the turn.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-artifacts-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('../../electron/workspace-store.cjs')
const entities = require('../../electron/entity-store.cjs')
const chats = require('../../electron/chat-store.cjs')

let seq = 0

function remoteThreadWithShot() {
  const workspace = workspaces.create({ label: `artifacts-${++seq}` })
  entities.scaffold({ workspace: workspace.id, name: 'chief-of-staff', harness: 'pi' })
  const record = workspaces.open(workspace.id)
  fs.mkdirSync(path.join(record.path, 'artifacts'), { recursive: true })
  fs.writeFileSync(path.join(record.path, 'artifacts', 'shot.png'), 'png bytes')

  /* `create` rejects an unknown remote host; the rewrite below is the remote
     thread this test is about. */
  const created = chats.create({
    workspace: record.id,
    entity: 'chief-of-staff',
    harness: 'pi',
  })
  const file = path.join(record.path, 'chats', `${created.id}.json`)
  const thread = JSON.parse(fs.readFileSync(file, 'utf8'))
  thread.machine = 'root-ubuntu'
  thread.messages = [
    { who: 'me', text: 'Where are you right now?', at: new Date().toISOString() },
    {
      who: 'agent',
      text: 'I am on the Ubuntu host, in the staged workspace.',
      at: new Date().toISOString(),
    },
  ]
  fs.writeFileSync(file, JSON.stringify(thread, null, 2))
  return { record, id: created.id, file }
}

test('a remote turn does not claim every artifact by modification time', () => {
  const { record, id } = remoteThreadWithShot()
  const read = chats.read({ workspace: record.id, id })
  assert.equal(read.messages[1].artifacts, undefined)
})

test('a remote turn claims the artifact its answer names', () => {
  const { record, id, file } = remoteThreadWithShot()
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  raw.messages[1].text = 'Saved it as artifact://shot.png'
  fs.writeFileSync(file, JSON.stringify(raw, null, 2))

  const read = chats.read({ workspace: record.id, id })
  assert.equal(read.messages[1].artifacts?.[0]?.id, 'shot.png')
})
