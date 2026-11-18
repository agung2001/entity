const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-chat-cancel-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('../../electron/workspace-store.cjs')
const entities = require('../../electron/entity-store.cjs')
const chats = require('../../electron/chat-store.cjs')
const harnesses = require('../../electron/harness-store.cjs')

/* The stand-ins are POSIX shell scripts (`#!/bin/sh`), and a run is spawned with
   an argv array (never through a shell), so they cannot execute on Windows. */
const POSIX = process.platform !== 'win32'

test('stopping a live turn records a stopped message, not a harness failure', { skip: !POSIX }, async (t) => {
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

test('a thread that is answering cannot be deleted', { skip: !POSIX }, async (t) => {
  const record = workspaces.create({ label: 'delete-lock' })
  const workspace = record.id
  entities.scaffold({ workspace, name: 'busy-agent', harness: 'pi' })

  const fake = path.join(PROFILE, 'busy-pi')
  fs.writeFileSync(fake, '#!/bin/sh\nsleep 60\n', { mode: 0o755 })
  harnesses.setPath({ id: 'pi', path: fake })

  const thread = await chats.create({ workspace, entity: 'busy-agent', harness: 'pi' })
  const turn = chats.send({ workspace, id: thread.id, text: 'Keep working.' })
  t.after(() => chats.closeAll())

  for (let i = 0; i < 50 && chats.activeCount() === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(chats.activeCount(), 1)
  assert.throws(
    () => chats.remove({ workspace, id: thread.id }),
    /still answering/,
  )
  assert.ok(chats.read({ workspace, id: thread.id }), 'the thread file must survive')

  assert.equal(chats.cancel({ workspace, id: thread.id }).canceled, true)
  await turn
  assert.deepEqual(chats.remove({ workspace, id: thread.id }), { removed: true })
})

/* ── the plan gate ────────────────────────────────────────────────────
   A message that delegates is sent as always; its runs wait for one answer.
   The hold is in memory, so these tests drive it through the same two verbs a
   window uses: `decideHold` and `cancel`. */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('a plan waits before any harness starts, and Cancel starts nothing', { skip: !POSIX }, async (t) => {
  const record = workspaces.create({ label: 'hold' })
  const workspace = record.id
  entities.scaffold({ workspace, name: 'hold-parent', harness: 'pi', dir: PROFILE })
  entities.scaffold({ workspace, name: 'hold-child', harness: 'pi', dir: PROFILE })
  const fake = path.join(PROFILE, 'hold-pi')
  fs.writeFileSync(fake, '#!/bin/sh\nsleep 60\n', { mode: 0o755 })
  harnesses.setPath({ id: 'pi', path: fake })

  const thread = await chats.create({ workspace, entity: 'hold-parent', harness: 'pi' })
  const events = []
  const turn = chats.send({
    workspace,
    id: thread.id,
    text: '@hold-child check the site',
    emit: (event) => events.push(event),
  })
  t.after(() => chats.closeAll())

  for (let i = 0; i < 100 && !chats.heldPlan(thread.id); i += 1) await sleep(20)
  const plan = chats.heldPlan(thread.id)
  assert.ok(plan, 'the turn waits for an answer')
  assert.equal(plan.rows.length, 1)
  assert.equal(plan.rows[0].name, 'hold-child')
  assert.equal(plan.rows[0].harness, 'pi')
  assert.equal(plan.rows[0].shownDir, PROFILE)
  assert.ok(plan.timeoutMs > 0)
  assert.equal(chats.activeCount(), 0, 'no harness exists while the plan waits')

  /* the window is told, once, with the plan the card reads */
  const hold = events.find((event) => event.phase === 'hold')
  assert.ok(hold, 'the hold is painted from an event, not from the reply')
  assert.equal(hold.data.rows.length, 1)

  assert.deepEqual(chats.decideHold({ workspace, id: thread.id, action: 'cancel' }), {
    decided: 'cancel',
    runs: 1,
  })
  const updated = await turn
  const sys = updated.messages.at(-1)
  assert.equal(sys.text, 'Delegation cancelled — nothing was sent to @hold-child.')
  assert.equal(sys.error, true, 'Retry is the app’s existing way back')
  assert.equal(sys.hold.settled, 'cancelled')
  assert.equal(sys.hold.rows.length, 1, 'the settled block names the row that never ran')
  /* the question is still there after a reload — the runs never started, but the
     message was sent */
  const question = updated.messages.at(-2)
  assert.equal(question.who, 'me')
  assert.equal(question.text, '@hold-child check the site')
  assert.equal(chats.activeCount(), 0)
})

test('Run starts the held runs, and a second answer finds nothing to decide', { skip: !POSIX }, async (t) => {
  const record = workspaces.create({ label: 'hold-run' })
  const workspace = record.id
  entities.scaffold({ workspace, name: 'run-parent', harness: 'pi', dir: PROFILE })
  entities.scaffold({ workspace, name: 'run-child', harness: 'pi', dir: PROFILE })
  const fake = path.join(PROFILE, 'run-pi')
  fs.writeFileSync(fake, '#!/bin/sh\nsleep 60\n', { mode: 0o755 })
  harnesses.setPath({ id: 'pi', path: fake })

  const thread = await chats.create({ workspace, entity: 'run-parent', harness: 'pi' })
  const turn = chats.send({ workspace, id: thread.id, text: '@run-child check the site' })
  t.after(() => chats.closeAll())

  for (let i = 0; i < 100 && !chats.heldPlan(thread.id); i += 1) await sleep(20)
  assert.ok(chats.heldPlan(thread.id))
  assert.deepEqual(chats.decideHold({ workspace, id: thread.id, action: 'run' }), {
    decided: 'run',
    runs: 1,
  })
  /* one answer per plan: a double click cannot start it twice */
  assert.deepEqual(chats.decideHold({ workspace, id: thread.id, action: 'run' }), {
    decided: 'none',
  })

  for (let i = 0; i < 100 && chats.activeCount() === 0; i += 1) await sleep(20)
  assert.ok(chats.activeCount() > 0, 'Run is what starts the harness')

  assert.equal(chats.cancel({ workspace, id: thread.id }).canceled, true)
  const stopped = await turn
  assert.equal(stopped.messages.at(-1).text, 'Stopped by you.')
})

test('a run that delegates again never holds: it is headless and cannot ask', { skip: !POSIX }, async (t) => {
  const record = workspaces.create({ label: 'hold-inherited' })
  const workspace = record.id
  for (const name of ['nested-parent', 'nested-child']) {
    entities.scaffold({ workspace, name, harness: 'pi', dir: PROFILE })
  }
  const fake = path.join(PROFILE, 'nested-pi')
  fs.writeFileSync(fake, '#!/bin/sh\nsleep 60\n', { mode: 0o755 })
  harnesses.setPath({ id: 'pi', path: fake })

  const parent = await chats.create({ workspace, entity: 'nested-parent', harness: 'pi' })
  const session = chats.spawnMentionSession(record, parent, {
    kind: 'entity',
    name: 'nested-parent',
    job: 'first pass',
    answer: 'done',
    status: 'ok',
  })
  assert.ok(session.spawnedFrom, 'the fixture is a session, not a conversation')

  const turn = chats.send({
    workspace,
    id: session.id,
    text: '@nested-child check the site',
  })
  t.after(() => chats.closeAll())

  for (let i = 0; i < 100 && chats.activeCount() === 0; i += 1) await sleep(20)
  assert.equal(chats.heldPlan(session.id), null, 'no gate below the top turn')
  assert.ok(chats.activeCount() > 0, 'the nested run started on its own')

  chats.cancel({ workspace, id: session.id })
  await turn
})
