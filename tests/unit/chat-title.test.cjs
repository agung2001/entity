/**
 * A thread title the person wrote is theirs.
 *
 * The turn holds a copy of the thread read before the harness started. It used
 * to write that copy back — title included — so a rename made while the answer
 * was streaming was replaced by the first message's text. The title also must
 * not be re-derived just because the thread is the same age as its first turn.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-chat-title-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('../../electron/workspace-store.cjs')
const entities = require('../../electron/entity-store.cjs')
const chats = require('../../electron/chat-store.cjs')
const harnesses = require('../../electron/harness-store.cjs')

/* The stand-in is a POSIX shell script, and a run never goes through a shell. */
const POSIX = process.platform !== 'win32'
const slowPi = path.join(PROFILE, 'slow-pi')

function prepare(t, label) {
  const record = workspaces.create({ label })
  entities.scaffold({ workspace: record.id, name: 'writer', harness: 'pi' })
  fs.writeFileSync(slowPi, '#!/bin/sh\nsleep 0.4\nexit 0\n', { mode: 0o755 })
  harnesses.setPath({ id: 'pi', path: slowPi })
  t.after(() => chats.closeAll())
  return record
}

function onDisk(record, id) {
  return JSON.parse(fs.readFileSync(path.join(record.path, 'chats', `${id}.json`), 'utf8'))
}

test('a title set before the first message is never replaced by it', { skip: !POSIX }, async (t) => {
  const record = prepare(t, 'title-keep')
  const thread = await chats.create({ workspace: record.id, entity: 'writer', harness: 'pi' })
  chats.rename({ workspace: record.id, id: thread.id, title: 'Spring launch note' })

  await chats.send({ workspace: record.id, id: thread.id, text: 'Write the launch note for the spring papers.' })

  const saved = onDisk(record, thread.id)
  assert.equal(saved.title, 'Spring launch note')
  assert.equal(saved.titleSource, 'user')
})

test('a rename made while the answer streams survives the turn', { skip: !POSIX }, async (t) => {
  const record = prepare(t, 'title-midturn')
  const thread = await chats.create({ workspace: record.id, entity: 'writer', harness: 'pi' })

  const turn = chats.send({ workspace: record.id, id: thread.id, text: 'Write the launch note for the spring papers.' })
  /* The harness is asleep; this is the person tidying the rail meanwhile. */
  await new Promise((resolve) => setTimeout(resolve, 80))
  chats.rename({ workspace: record.id, id: thread.id, title: 'Launch note' })
  await turn

  const saved = onDisk(record, thread.id)
  assert.equal(saved.title, 'Launch note', 'the turn wrote its older copy back')
  assert.equal(saved.titleSource, 'user')
})

test('an untitled thread still gets the first message as its title', { skip: !POSIX }, async (t) => {
  const record = prepare(t, 'title-auto')
  const thread = await chats.create({ workspace: record.id, entity: 'writer', harness: 'pi' })
  await chats.send({ workspace: record.id, id: thread.id, text: 'Plan the last week before the fair.' })

  const saved = onDisk(record, thread.id)
  assert.equal(saved.title, 'Plan the last week before the fair.')
  assert.equal(saved.titleSource, 'auto')
})

test('clearing a title is a decision, not an empty slot to fill', { skip: !POSIX }, async (t) => {
  const record = prepare(t, 'title-cleared')
  const thread = await chats.create({ workspace: record.id, entity: 'writer', harness: 'pi' })
  chats.rename({ workspace: record.id, id: thread.id, title: 'Temporary' })
  chats.rename({ workspace: record.id, id: thread.id, title: '' })

  await chats.send({ workspace: record.id, id: thread.id, text: 'Something else entirely.' })

  assert.equal(onDisk(record, thread.id).title, '')
})

test('a pin and a tag added mid-turn are not dropped by the answer', { skip: !POSIX }, async (t) => {
  const record = prepare(t, 'title-metadata')
  const thread = await chats.create({ workspace: record.id, entity: 'writer', harness: 'pi' })

  const turn = chats.send({ workspace: record.id, id: thread.id, text: 'Write something.' })
  await new Promise((resolve) => setTimeout(resolve, 80))
  chats.pin({ workspace: record.id, id: thread.id, pinned: true })
  chats.tags({ workspace: record.id, id: thread.id, tags: ['spring', 'launch'] })
  await turn

  const saved = onDisk(record, thread.id)
  assert.equal(saved.pinned, true)
  assert.deepEqual(saved.tags, ['spring', 'launch'])
})
