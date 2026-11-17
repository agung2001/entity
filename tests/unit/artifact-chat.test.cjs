const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/* `workspace-store` resolves ROOT at require time, so this has to come first. */
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-artifacts-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('../../electron/workspace-store.cjs')
const artifacts = require('../../electron/artifact-store.cjs')
const chats = require('../../electron/chat-store.cjs')

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
  /* A chip is earned by the transcript, not by the clock: the answer names the
     file it saved. The shelf is re-read on every open, so a chip whose file
     predates its own turn is a guess and is dropped (see chat-artifacts.test). */
  const askedAt = new Date(Date.now() - 90_000)
  const savedAt = new Date(Date.now() - 60_000)
  const answeredAt = new Date(Date.now() - 30_000)
  fs.utimesSync(file, savedAt, savedAt)
  fs.writeFileSync(
    path.join(chatsDir, 't_artifact.json'),
    JSON.stringify({
      schema: 1,
      id: 't_artifact',
      entity: 'inbox-triage',
      machine: 'local',
      harness: 'pi',
      createdAt: askedAt.toISOString(),
      updatedAt: answeredAt.toISOString(),
      messages: [
        { who: 'me', text: 'take a screenshot', at: askedAt.toISOString() },
        {
          who: 'agent',
          text: 'Here it is — artifact://shots/login.png',
          at: answeredAt.toISOString(),
          execution: { harness: 'pi', endedAt: answeredAt.toISOString(), status: 'ok' },
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

test('an unanswered turn does not guess what it saved', () => {
  const second = workspaces.create({ label: 'artifact-backfill' })
  const folder = workspaces.open(second.id)
  const shots = path.join(folder.path, 'artifacts', 'shots')
  fs.mkdirSync(shots, { recursive: true })
  const image = path.join(shots, 'page.png')
  fs.writeFileSync(image, Buffer.from('not really a png'))

  const asked = new Date(Date.now() - 120_000)
  const saved = new Date(Date.now() - 90_000)
  const askedAgain = new Date(Date.now() - 30_000)
  fs.utimesSync(image, saved, saved)

  const chatsDir = path.join(folder.path, 'chats')
  fs.mkdirSync(chatsDir, { recursive: true })
  fs.writeFileSync(
    path.join(chatsDir, 't_backfill.json'),
    JSON.stringify({
      schema: 1,
      id: 't_backfill',
      entity: 'inbox-triage',
      machine: 'local',
      harness: 'pi',
      createdAt: asked.toISOString(),
      updatedAt: askedAgain.toISOString(),
      messages: [
        { who: 'me', text: 'take a screenshot', at: asked.toISOString() },
        { who: 'me', text: 'are you there?', at: askedAgain.toISOString() },
      ],
    }),
    'utf8',
  )

  /* The file landed in the first request's window, but that turn never said a
     word: a second process could have written it (this shelf is shared with the
     machine), so nothing is invented for it. */
  const blind = chats.read({ workspace: second.id, id: 't_backfill' })
  assert.equal(blind.messages[0].artifacts, undefined)

  /* The same file is the turn's as soon as the turn says so — the wording a
     platform brief asks for, and the backfill the old rule existed for. */
  const file = path.join(chatsDir, 't_backfill.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  raw.messages.push({
    who: 'agent',
    text: 'Saved — artifact://shots/page.png',
    at: new Date().toISOString(),
    execution: { harness: 'pi', endedAt: new Date().toISOString(), status: 'ok' },
  })
  fs.writeFileSync(file, JSON.stringify(raw, null, 2))

  const named = chats.read({ workspace: second.id, id: 't_backfill' })
  assert.equal(named.messages[2].artifacts?.length, 1)
  assert.equal(named.messages[2].artifacts[0].id, 'shots/page.png')
  assert.equal(named.messages[0].artifacts, undefined)
})
