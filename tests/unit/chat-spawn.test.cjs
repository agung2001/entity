/**
 * A delegated mention leaves a session behind.
 *
 * `@entity <job>` still runs inside the turn — that is what lets the reply above
 * it use the answer — but the run is now also a real thread: the job, the answer,
 * its steps and its timing, linked to the conversation it came from. The card in
 * the transcript can continue there, and the parent's rail row counts it.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-session-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('../../electron/workspace-store.cjs')
const entities = require('../../electron/entity-store.cjs')
const chats = require('../../electron/chat-store.cjs')

let seq = 0

function workspaceWith(names = ['chief-of-staff', 'secretary']) {
  const workspace = workspaces.create({ label: `session-${++seq}` })
  for (const name of names) entities.scaffold({ workspace: workspace.id, name, harness: 'claude' })
  return workspaces.open(workspace.id)
}

const parentIn = (record) =>
  chats.create({ workspace: record.id, entity: 'chief-of-staff', harness: 'claude' })

const mentionOf = (over = {}) => ({
  kind: 'entity',
  token: '@secretary',
  name: 'secretary',
  job: 'check the site',
  answer: 'It is a portfolio.',
  items: [],
  status: 'ok',
  ms: 1200,
  execution: {
    harness: 'claude',
    model: 'sonnet-4.6',
    cwd: '/tmp',
    startedAt: '2026-11-17T10:00:00.000Z',
    endedAt: '2026-11-17T10:00:01.200Z',
    status: 'ok',
  },
  ...over,
})

test('a delegated mention becomes a session with a link back', () => {
  const record = workspaceWith()
  const parent = parentIn(record)
  const session = chats.spawnMentionSession(record, parent, mentionOf())

  assert.ok(session, 'a session is written')
  assert.deepEqual(session.spawnedFrom, { workspace: record.id, id: parent.id })
  assert.equal(session.entity, 'secretary')
  /* the harness and model that actually answered, so continuing sounds the same */
  assert.equal(session.harness, 'claude')
  assert.equal(session.model, 'sonnet-4.6')
  /* the job names the conversation, the way a first message names a thread */
  assert.equal(session.title, 'check the site')
  assert.equal(session.titleSource, 'auto')

  const read = chats.read({ workspace: record.id, id: session.id })
  assert.deepEqual(
    read.messages.map((message) => [message.who, message.text]),
    [
      ['me', 'check the site'],
      ['agent', 'It is a portfolio.'],
    ],
  )
  /* the timing travels, so the child's own timeline explains itself */
  assert.equal(read.messages[1].execution.harness, 'claude')
  assert.equal(read.messages[1].execution.ms, undefined)
})

test('the session is a row the parent can count, and the link survives a read', () => {
  const record = workspaceWith()
  const parent = parentIn(record)
  const session = chats.spawnMentionSession(record, parent, mentionOf())

  const rows = chats.list({ workspace: record.id })
  const child = rows.find((row) => row.id === session.id)
  assert.deepEqual(child.spawnedFrom, { workspace: record.id, id: parent.id })
  assert.equal(rows.filter((row) => row.spawnedFrom?.id === parent.id).length, 1)
  /* a root row answers null, so the rail can test one field */
  assert.equal(rows.find((row) => row.id === parent.id).spawnedFrom, null)
})

test('a failed delegation leaves the reason, not an empty answer', () => {
  const record = workspaceWith()
  const parent = parentIn(record)
  const session = chats.spawnMentionSession(
    record,
    parent,
    mentionOf({ status: 'error', answer: '', note: '@secretary failed: not signed in' }),
  )
  const read = chats.read({ workspace: record.id, id: session.id })
  assert.equal(read.messages[1].who, 'sys')
  assert.equal(read.messages[1].error, true)
  assert.match(read.messages[1].text, /not signed in/)
})

test('a reference or a non-entity mention is not a conversation', () => {
  const record = workspaceWith()
  const parent = parentIn(record)
  assert.equal(chats.spawnMentionSession(record, parent, mentionOf({ reference: true, job: '' })), null)
  assert.equal(chats.spawnMentionSession(record, parent, mentionOf({ job: '' })), null)
  assert.equal(chats.spawnMentionSession(record, parent, mentionOf({ kind: 'artifact' })), null)
  assert.equal(chats.list({ workspace: record.id }).length, 1, 'only the parent exists')
})

test('a session’s thread is continuable: a second turn keeps the link', () => {
  const record = workspaceWith()
  const parent = parentIn(record)
  const session = chats.spawnMentionSession(record, parent, mentionOf())
  chats.update({ workspace: record.id, id: session.id, model: 'opus[1m]' })
  chats.tags({ workspace: record.id, id: session.id, tags: ['vendor'] })
  const read = chats.read({ workspace: record.id, id: session.id })
  assert.deepEqual(read.spawnedFrom, { workspace: record.id, id: parent.id })
  assert.equal(read.model, 'opus[1m]')
  assert.deepEqual(read.tags, ['vendor'])
})
