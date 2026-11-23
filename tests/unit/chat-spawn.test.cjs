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
const harnesses = require('../../electron/harness-store.cjs')

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

/* What the window's Retry button stands on. A retry re-runs the question already
   in the thread, so `chat.send` with `retry` refuses anything whose last row is
   not an error with a question above it — and that is the same pair the rail
   derives `failed` from. One fact, two readers. */
test('a failed session is exactly what a retry can pick up', () => {
  const record = workspaceWith()
  const parent = parentIn(record)
  const session = chats.spawnMentionSession(
    record,
    parent,
    mentionOf({ status: 'error', answer: '', note: '@secretary failed: not signed in' }),
  )
  const read = chats.read({ workspace: record.id, id: session.id })
  const last = read.messages[read.messages.length - 1]
  assert.equal(last.who, 'sys')
  assert.equal(last.error, true, 'the error row is what a retry replaces')
  assert.equal(last.hold, undefined, 'a held plan is a decision, not a failure')
  assert.ok(
    read.messages.some((entry) => entry.who === 'me'),
    'the question above it is what a retry re-asks',
  )
  const row = chats.list({ workspace: record.id }).find((entry) => entry.id === session.id)
  assert.equal(row.failed, true, 'the rail row says what the retry needs')
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

test('three spawned sessions are told apart by their share', () => {
  const record = workspaceWith()
  const parent = parentIn(record)
  const titles = [1, 2, 3].map(
    (index) =>
      chats.spawnMentionSession(
        record,
        parent,
        mentionOf({ job: 'write a poem', share: `${index}/3` }),
      ).title,
  )
  assert.deepEqual(titles, [
    'write a poem · 1/3',
    'write a poem · 2/3',
    'write a poem · 3/3',
  ])
  /* the message the person would see is still their own sentence */
  const first = chats.list({ workspace: record.id }).find((row) => row.title === titles[0])
  assert.match(first.spawnedFrom.id, /^t_/)
  assert.equal(chats.read({ workspace: record.id, id: first.id }).messages[0].text, 'write a poem')
})

test('a fanned-out run is titled by its row, not by the shared instruction', () => {
  const record = workspaceWith()
  const parent = parentIn(record)
  const session = chats.spawnMentionSession(
    record,
    parent,
    mentionOf({
      job: 'ENTITY-14 — Sync evaluator aborts the sync\n\nfix it',
      row: 'ENTITY-14 — Sync evaluator aborts the sync',
      share: '3/7',
    }),
  )
  /* seven issues must read as seven titles in the tree */
  assert.equal(session.title, 'ENTITY-14 — Sync evaluator aborts the sync')
  const read = chats.read({ workspace: record.id, id: session.id })
  assert.equal(read.messages[0].text, 'ENTITY-14 — Sync evaluator aborts the sync\n\nfix it')
  /* and the link back still holds, so it sits under its parent's count */
  const summary = chats.list({ workspace: record.id }).find((row) => row.id === session.id)
  assert.deepEqual(summary.spawnedFrom, { workspace: record.id, id: parent.id })
})

/* ── the turn is visible while it delegates ───────────────────────────
   Resolving an `@…` mention runs every delegated harness to completion inside
   `chat.send`, and a fan-out is minutes of it. The question used to be written
   only after that, so the thread file stayed empty for the whole of the turn's
   longest phase: a reload read a conversation with no question, no `working`
   flag and no way to stop the run that was still going. One real thread sat at
   `messages: []` with a `designer · mention` child alive for 35 minutes. */

const POSIX = process.platform !== 'win32'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function onDisk(record, id) {
  return JSON.parse(fs.readFileSync(path.join(record.path, 'chats', `${id}.json`), 'utf8'))
}

async function mentionInFlight(t, label) {
  const workspace = workspaces.create({ label: `visible-${label}-${++seq}` })
  const record = workspaces.open(workspace.id)
  /* both roles run the stub, so the delegated run is the one holding the turn */
  for (const name of ['chief-of-staff', 'secretary']) {
    entities.scaffold({ workspace: record.id, name, harness: 'pi' })
  }
  const parent = chats.create({ workspace: record.id, entity: 'chief-of-staff', harness: 'pi' })
  const child = path.join(PROFILE, `mention-${label}-pi`)
  fs.writeFileSync(
    child,
    '#!/bin/sh\ncat > /dev/null\nsleep 30\nprintf \'{"type":"result","subtype":"success","result":"done"}\\n\'\n',
    { mode: 0o755 },
  )
  harnesses.setPath({ id: 'pi', path: child })
  t.after(() => chats.closeAll())
  return { record, parent, child }
}

test('the question is on disk while its mention is still resolving', { skip: !POSIX }, async (t) => {
  const { record, parent } = await mentionInFlight(t, 'visible')
  const turn = chats.send({
    workspace: record.id,
    id: parent.id,
    text: '@secretary check the site',
    /* the stand-in never speaks, so the classifier is not asked anything */
    intent: null,
  })

  /* the plan gate comes first, and the question is already in the file while it
     waits — nothing has run and the person may still leave the page */
  for (let i = 0; i < 100 && !chats.heldPlan(parent.id); i += 1) await sleep(20)
  assert.ok(chats.heldPlan(parent.id), 'the plan is waiting for an answer')
  assert.equal(onDisk(record, parent.id).messages[0].text, '@secretary check the site')

  /* Run: the delegated harness is now the turn, and the file already says so */
  chats.decideHold({ workspace: record.id, id: parent.id, action: 'run' })
  for (let i = 0; i < 100 && chats.activeCount() === 0; i += 1) await sleep(20)
  assert.ok(chats.activeCount() > 0, 'the mention is running')

  const saved = onDisk(record, parent.id)
  assert.equal(saved.messages.length, 1, 'one question, already in the file')
  assert.equal(saved.messages[0].who, 'me')

  /* and the row a reload paints says the turn is live, so Stop is offered */
  const row = chats.list({ workspace: record.id }).find((entry) => entry.id === parent.id)
  assert.equal(row.messageCount, 1)
  assert.equal(row.working, true)

  chats.cancel({ workspace: record.id, id: parent.id })
  const updated = await turn
  /* one question, one answer: the early row is filled in, never duplicated */
  assert.equal(updated.messages.filter((message) => message.who === 'me').length, 1)
  assert.equal(updated.messages.at(-1).text, 'Stopped by you.')
})

test('a second message is refused while the mention is resolving', { skip: !POSIX }, async (t) => {
  const { record, parent } = await mentionInFlight(t, 'lock')
  const turn = chats.send({
    workspace: record.id,
    id: parent.id,
    text: '@secretary check the site',
    intent: null,
  })
  /* the plan gate is where this turn waits, and the lock is already held there */
  for (let i = 0; i < 100 && !chats.heldPlan(parent.id); i += 1) await sleep(20)
  assert.ok(chats.heldPlan(parent.id))

  /* the lock is taken before the mention resolves, not after it: a second send
     while the fan-out is still going would race this one on the same file */
  await assert.rejects(
    chats.send({
      workspace: record.id,
      id: parent.id,
      text: 'one more thing',
      intent: null,
    }),
    /already answering/,
  )

  chats.cancel({ workspace: record.id, id: parent.id })
  await turn
})

test('a refused mention leaves no question behind', () => {
  const record = workspaceWith(['chief-of-staff'])
  const parent = chats.create({ workspace: record.id, entity: 'chief-of-staff', harness: 'claude' })
  /* `@nobody` is not an entity: the message never went anywhere, so the row the
     early write put on disk has to come back off it */
  return assert
    .rejects(
      () =>
        chats.send({
          workspace: record.id,
          id: parent.id,
          text: '@nobody check the site',
          intent: null,
        }),
      /not an entity in this workspace/,
    )
    .then(() => {
      const saved = onDisk(record, parent.id)
      assert.deepEqual(saved.messages, [], 'no half-turn survives a refusal')
      const row = chats.list({ workspace: record.id }).find((entry) => entry.id === parent.id)
      assert.equal(row.working, false, 'the lock is released with the row')
    })
})

test('a Stop that lands before the harness starts does not cancel the next turn', { skip: !POSIX }, async (t) => {
  const { record, parent } = await mentionInFlight(t, 'no-leak')
  const first = chats.send({
    workspace: record.id,
    id: parent.id,
    text: '@secretary check the site',
    intent: null,
  })
  for (let i = 0; i < 100 && !chats.heldPlan(parent.id); i += 1) await sleep(20)
  assert.ok(chats.heldPlan(parent.id))

  /* Stop while the plan is held: the turn ends, nothing started, and the flag it
     armed must die with it rather than cancel the next question on this thread */
  chats.cancel({ workspace: record.id, id: parent.id })
  await first

  const again = chats.send({
    workspace: record.id,
    id: parent.id,
    text: '@secretary try once more',
    intent: null,
  })
  for (let i = 0; i < 100 && !chats.heldPlan(parent.id); i += 1) await sleep(20)
  assert.ok(chats.heldPlan(parent.id), 'the next turn still waits for its own answer')

  const updated = await (async () => {
    chats.decideHold({ workspace: record.id, id: parent.id, action: 'cancel' })
    return again
  })()
  assert.equal(updated.messages.at(-1).text, 'Delegation cancelled — nothing was sent to @secretary.')
})
