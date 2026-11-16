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

/* ── a shared shelf belongs to the workspace, not to one conversation ──
 *
 * The bug this pins: a turn claimed every file modified while it ran, so four
 * conversations that ran in the same nine minutes all listed the same files.
 * A file is a turn's only when that turn is the only one that could have
 * written it; otherwise the transcript has to name it.
 */

const SHELF_BASE = Date.parse('2026-11-16T15:00:00.000Z')
const at = (seconds) => new Date(SHELF_BASE + seconds * 1000).toISOString()

function workspaceWithShelf() {
  const workspace = workspaces.create({ label: `attribution-${++seq}` })
  entities.scaffold({ workspace: workspace.id, name: 'designer', harness: 'pi' })
  const record = workspaces.open(workspace.id)
  fs.mkdirSync(path.join(record.path, 'artifacts'), { recursive: true })
  return record
}

function writeShelfFile(record, id, seconds) {
  const file = path.join(record.path, 'artifacts', id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `bytes of ${id}`)
  const when = new Date(SHELF_BASE + seconds * 1000)
  fs.utimesSync(file, when, when)
}

function writeThread(record, { id, entity = 'designer', machine = 'local', messages }) {
  const file = path.join(record.path, 'chats', `${id}.json`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        schema: 1,
        id,
        entity,
        machine,
        harness: 'pi',
        title: id,
        createdAt: messages[0].at,
        updatedAt: messages[messages.length - 1].at,
        messages,
      },
      null,
      2,
    ),
  )
  return id
}

test('a file two overlapping turns could have written is attached to neither', () => {
  const record = workspaceWithShelf()
  /* One file in the overlap, one only inside the first turn. */
  writeShelfFile(record, 'shared.png', 300)
  writeShelfFile(record, 'mine.png', 120)

  writeThread(record, {
    id: 't_overlap_a',
    messages: [
      { who: 'me', text: 'Design the page.', at: at(100) },
      {
        who: 'agent',
        text: 'Done — the board is on the shelf.',
        at: at(400),
        execution: { harness: 'pi', endedAt: at(400), status: 'ok' },
      },
    ],
  })
  writeThread(record, {
    id: 't_overlap_b',
    messages: [
      { who: 'me', text: 'Write the spec.', at: at(250) },
      {
        who: 'agent',
        text: 'Spec written.',
        at: at(500),
        execution: { harness: 'pi', endedAt: at(500), status: 'ok' },
      },
    ],
  })

  const a = chats.read({ workspace: record.id, id: 't_overlap_a' })
  const b = chats.read({ workspace: record.id, id: 't_overlap_b' })
  const ids = (thread) => (thread.messages[1].artifacts || []).map((entry) => entry.id)

  assert.deepEqual(ids(a), ['mine.png'], 'the turn keeps the file only it could have written')
  assert.deepEqual(ids(b), [], 'the overlap is ambiguous, so nothing is invented')
})

test('the overlapping file goes to the turn whose transcript names it', () => {
  const record = workspaceWithShelf()
  writeShelfFile(record, 'shared.png', 300)

  writeThread(record, {
    id: 't_names_a',
    messages: [
      { who: 'me', text: 'Design the page.', at: at(100) },
      {
        who: 'agent',
        text: 'I left it in artifacts/design/ for you.',
        at: at(400),
        execution: { harness: 'pi', endedAt: at(400), status: 'ok' },
      },
    ],
  })
  writeThread(record, {
    id: 't_names_b',
    messages: [
      { who: 'me', text: 'Write the spec.', at: at(250) },
      {
        who: 'agent',
        text: 'Saved as artifact://shared.png',
        at: at(500),
        execution: { harness: 'pi', endedAt: at(500), status: 'ok' },
      },
    ],
  })

  const a = chats.read({ workspace: record.id, id: 't_names_a' })
  const b = chats.read({ workspace: record.id, id: 't_names_b' })
  assert.deepEqual((a.messages[1].artifacts || []).map((entry) => entry.id), [])
  assert.deepEqual((b.messages[1].artifacts || []).map((entry) => entry.id), ['shared.png'])
})

test('a step that writes the path counts as naming it', () => {
  const record = workspaceWithShelf()
  writeShelfFile(record, 'board.png', 300)

  writeThread(record, {
    id: 't_step_a',
    messages: [
      { who: 'me', text: 'Render the board.', at: at(100) },
      {
        who: 'agent',
        text: 'Rendered.',
        at: at(400),
        execution: { harness: 'pi', endedAt: at(400), status: 'ok' },
        steps: [
          {
            seq: 1,
            type: 'tool_use',
            tool: 'bash',
            at: at(200),
            input: { command: 'node render.mjs > artifacts/board.png' },
          },
        ],
      },
    ],
  })
  writeThread(record, {
    id: 't_step_b',
    messages: [
      { who: 'me', text: 'Unrelated question.', at: at(250) },
      { who: 'agent', text: 'Answer.', at: at(500), execution: { harness: 'pi', endedAt: at(500), status: 'ok' } },
    ],
  })

  const a = chats.read({ workspace: record.id, id: 't_step_a' })
  assert.deepEqual((a.messages[1].artifacts || []).map((entry) => entry.id), ['board.png'])
})

test('a chip an older time-based read attached is dropped, not kept', () => {
  const record = workspaceWithShelf()
  writeShelfFile(record, 'not-mine.png', 300)
  writeThread(record, {
    id: 't_stale',
    messages: [
      { who: 'me', text: 'Something else entirely.', at: at(400) },
      {
        who: 'agent',
        text: 'Answered.',
        at: at(500),
        execution: { harness: 'pi', endedAt: at(500), status: 'ok' },
        /* what the previous build stored: a guess from the window */
        artifacts: [{ id: 'not-mine.png', name: 'not-mine.png', kind: 'image', mime: 'image/png' }],
      },
    ],
  })

  const thread = chats.read({ workspace: record.id, id: 't_stale' })
  assert.deepEqual(thread.messages[1].artifacts || [], [])
})

test('a sole writer still owns everything it saved', () => {
  const record = workspaceWithShelf()
  for (let i = 0; i < 3; i += 1) writeShelfFile(record, `shot-${i}.png`, 120 + i * 10)
  writeThread(record, {
    id: 't_sole',
    messages: [
      { who: 'me', text: 'Take three shots.', at: at(100) },
      {
        who: 'agent',
        text: 'Three shots on the shelf.',
        at: at(400),
        execution: { harness: 'pi', endedAt: at(400), status: 'ok' },
      },
    ],
  })
  const thread = chats.read({ workspace: record.id, id: 't_sole' })
  assert.deepEqual(
    (thread.messages[1].artifacts || []).map((entry) => entry.id).sort(),
    ['shot-0.png', 'shot-1.png', 'shot-2.png'],
  )
})
