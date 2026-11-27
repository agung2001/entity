/**
 * A message that is nothing but a connector read is answered by the app.
 *
 * The rows a mention resolved ARE the question, so the turn settles with them
 * and no harness is started: a mention-only YouTube Studio summary used to open
 * the thread's entity, and a YouTrack-first agent went looking for a board issue
 * about the video instead of reading the numbers it had just been handed. The
 * stand-in harness writes a marker, so "did anything run?" is answered by the
 * filesystem instead of by a status field.
 *
 * The second test is the guard rail: a sentence under the read is an ordinary
 * turn, and it runs.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-chat-reads-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('../../electron/workspace-store.cjs')
const entities = require('../../electron/entity-store.cjs')
const chats = require('../../electron/chat-store.cjs')
const harnesses = require('../../electron/harness-store.cjs')

/* The stand-ins are POSIX shell scripts (`#!/bin/sh`), and a run is spawned with
   an argv array (never through a shell), so they cannot execute on Windows. */
const POSIX = process.platform !== 'win32'

let seq = 0

/** A workspace with one agent and one artifact to read. */
function workspace(touch) {
  const created = workspaces.create({ label: `reads-${++seq}` })
  entities.scaffold({ workspace: created.id, name: 'desk-agent', harness: 'pi' })
  const record = workspaces.open(created.id)
  fs.mkdirSync(path.join(record.path, 'artifacts'), { recursive: true })
  fs.writeFileSync(path.join(record.path, 'artifacts', 'release-notes.md'), '# notes\n')
  /* A harness that leaves evidence behind the moment it is spawned. */
  const fake = path.join(PROFILE, `pi-${seq}`)
  fs.writeFileSync(fake, `#!/bin/sh\necho ran > "${touch}"\necho "the harness answered"\n`, {
    mode: 0o755,
  })
  harnesses.setPath({ id: 'pi', path: fake })
  return record
}

test('a read-only mention is answered in place, without a harness', { skip: !POSIX }, async () => {
  const marker = path.join(PROFILE, 'never-ran')
  const record = workspace(marker)
  const thread = await chats.create({ workspace: record.id, entity: 'desk-agent', harness: 'pi' })

  const updated = await chats.send({
    workspace: record.id,
    id: thread.id,
    text: '@artifact:release-notes',
  })

  assert.equal(fs.existsSync(marker), false, 'a harness was started for a read')
  const [question, answer] = updated.messages
  assert.equal(question.who, 'me')
  /* the block travels with the question, so a follow-up turn can still read it */
  assert.match(question.sent, /^Resolved mentions/)
  assert.equal(question.mentions.length, 1)
  assert.equal(answer.who, 'agent')
  assert.equal(answer.execution.harness, 'mention')
  assert.match(answer.text, /artifact:\/\/release-notes\.md/)
  /* a read is not a turn: no steps, no trace to open */
  assert.equal(answer.steps, undefined)
  assert.equal(updated.messages.length, 2)
})

test('a read with a sentence under it is an ordinary turn', { skip: !POSIX }, async (t) => {
  const marker = path.join(PROFILE, 'did-run')
  const record = workspace(marker)
  const thread = await chats.create({ workspace: record.id, entity: 'desk-agent', harness: 'pi' })
  t.after(() => chats.closeAll())

  const updated = await chats.send({
    workspace: record.id,
    id: thread.id,
    text: '@artifact:release-notes\nwhat changed in here?',
  })

  assert.equal(fs.existsSync(marker), true, 'the question never reached a harness')
  const answer = updated.messages.at(-1)
  assert.equal(answer.who, 'agent')
  assert.equal(answer.text, 'the harness answered')
})
