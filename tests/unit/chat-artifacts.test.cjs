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
const artifacts = require('../../electron/artifact-store.cjs')
const manifest = require('../../electron/remote-manifest.cjs')

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

/* ── one conversation, one design ─────────────────────────────────────
 *
 * The leak this pins, seen in a real workspace: while a turn about
 * `design/mcp-inventory/` was running, a render for a *different* design
 * (`design/chat-rail-archive/`) wrote fifteen PNGs into the shelf. Nothing else
 * ran in the app at that moment, so the turn was the only window covering those
 * files — and the old rule read "only one turn could have written it" as
 * "therefore it did". The chat showed another design's screenshots.
 *
 * Time is now a filter, never a reason: a turn owns what it names, what it
 * wrote, and the folder it demonstrably produced into. A design that is not in
 * the answer does not appear on the card.
 */

function designFile(record, id, seconds) {
  writeShelfFile(record, id, seconds)
  return id
}

test('a stray render for another design stays off the card', () => {
  const record = workspaceWithShelf()
  /* the turn's own deliverable, and the page it edited */
  writeShelfFile(record, 'design/mcp-inventory/b-navigation.html', 110)
  writeShelfFile(record, 'design/mcp-inventory/b-navigation.png', 120)
  /* a background render for a different design, inside the same minutes */
  for (const name of ['06-empty', '07-search-empty', '08-long-content']) {
    writeShelfFile(record, `design/chat-rail-archive/shots/${name}.png`, 150)
  }

  writeThread(record, {
    id: 't_one_design',
    messages: [
      { who: 'me', text: 'Add the harness marks to b-navigation.', at: at(100) },
      {
        who: 'agent',
        text: 'Marks are in — artifact://design/mcp-inventory/b-navigation.png',
        at: at(400),
        execution: { harness: 'pi', endedAt: at(400), status: 'ok' },
        steps: [
          {
            seq: 1,
            type: 'tool_use',
            tool: 'edit',
            at: at(110),
            input: { path: '/ws/artifacts/design/mcp-inventory/b-navigation.html' },
          },
        ],
      },
    ],
  })

  const thread = chats.read({ workspace: record.id, id: 't_one_design' })
  assert.deepEqual(
    (thread.messages[1].artifacts || []).map((entry) => entry.id).sort(),
    ['design/mcp-inventory/b-navigation.html', 'design/mcp-inventory/b-navigation.png'],
  )
})

test('a render batch follows the folder the turn wrote into', () => {
  const record = workspaceWithShelf()
  writeShelfFile(record, 'design/board/index.html', 110)
  /* the PNG and the shot beside it are never linked in the answer */
  writeShelfFile(record, 'design/board/board.png', 130)
  writeShelfFile(record, 'design/board/shots/dark.png', 140)
  /* …and a sibling folder that only shares a prefix must stay out */
  writeShelfFile(record, 'design/boarder/other.png', 150)

  writeThread(record, {
    id: 't_batch',
    messages: [
      { who: 'me', text: 'Draw the board.', at: at(100) },
      {
        who: 'agent',
        text: 'Drawn.',
        at: at(400),
        execution: { harness: 'pi', endedAt: at(400), status: 'ok' },
        steps: [
          {
            seq: 1,
            type: 'tool_use',
            tool: 'write',
            at: at(110),
            input: { path: 'artifacts/design/board/index.html' },
          },
        ],
      },
    ],
  })

  const thread = chats.read({ workspace: record.id, id: 't_batch' })
  assert.deepEqual(
    (thread.messages[1].artifacts || []).map((entry) => entry.id).sort(),
    ['design/board/board.png', 'design/board/index.html', 'design/board/shots/dark.png'],
  )
})

test('no evidence means no card, even when the turn is the only window', () => {
  const record = workspaceWithShelf()
  writeShelfFile(record, 'design/someone-else/shot.png', 120)

  writeThread(record, {
    id: 't_blind',
    messages: [
      { who: 'me', text: 'Answer a question about the weather.', at: at(100) },
      {
        who: 'agent',
        text: 'It is raining.',
        at: at(400),
        execution: { harness: 'pi', endedAt: at(400), status: 'ok' },
      },
    ],
  })

  const thread = chats.read({ workspace: record.id, id: 't_blind' })
  assert.deepEqual(thread.messages[1].artifacts || [], [])
})

test('two turns writing into one folder do not both list the same fresh file', () => {
  const record = workspaceWithShelf()
  writeShelfFile(record, 'design/shared/index.html', 120)
  writeShelfFile(record, 'design/shared/fresh.png', 300)

  for (const [id, start, end] of [
    ['t_folder_a', 100, 400],
    ['t_folder_b', 250, 500],
  ]) {
    writeThread(record, {
      id,
      messages: [
        { who: 'me', text: 'Edit the shared page.', at: at(start) },
        {
          who: 'agent',
          text: 'Edited.',
          at: at(end),
          execution: { harness: 'pi', endedAt: at(end), status: 'ok' },
          steps: [
            {
              seq: 1,
              type: 'tool_use',
              tool: 'edit',
              at: at(start + 10),
              input: { path: 'artifacts/design/shared/index.html' },
            },
          ],
        },
      ],
    })
  }

  const ids = (id) =>
    (chats.read({ workspace: record.id, id }).messages[1].artifacts || []).map((entry) => entry.id)
  /* `fresh.png` was written inside both windows: nobody gets to guess.
     `index.html` is named by both turns, so both keep it. */
  assert.deepEqual(ids('t_folder_a').sort(), ['design/shared/index.html'])
  assert.deepEqual(ids('t_folder_b').sort(), ['design/shared/index.html'])
})

test('a turn that revises a file another turn created still shows it', () => {
  const record = workspaceWithShelf()
  /* one file, written twice: the shelf keeps the last bytes only */
  writeShelfFile(record, 'design/page/index.html', 350)
  writeShelfFile(record, 'design/page/spec.md', 360)

  writeThread(record, {
    id: 't_revise',
    messages: [
      { who: 'me', text: 'Draw it.', at: at(100) },
      {
        who: 'agent',
        text: 'Drawn — artifact://design/page/index.html',
        at: at(200),
        execution: { harness: 'pi', endedAt: at(200), status: 'ok' },
      },
      { who: 'me', text: 'Now the icons.', at: at(300) },
      {
        who: 'agent',
        text: 'Icons in — artifact://design/page/index.html',
        at: at(400),
        execution: { harness: 'pi', endedAt: at(400), status: 'ok' },
        steps: [
          {
            seq: 1,
            type: 'tool_use',
            tool: 'bash',
            at: at(310),
            input: { command: 'cd artifacts/design/page && cat >> spec.md' },
          },
        ],
      },
    ],
  })

  const thread = chats.read({ workspace: record.id, id: 't_revise' })
  const ids = (index) => (thread.messages[index].artifacts || []).map((entry) => entry.id).sort()
  /* the first turn names the page, the second names it and wrote the spec */
  assert.deepEqual(ids(1), ['design/page/index.html'])
  assert.deepEqual(ids(3), ['design/page/index.html', 'design/page/spec.md'])
})

/**
 * A remote turn stages the shelf and may read all of it. Reading is not writing:
 * a `find` or an `ls` prints filenames, and the old rule — "the filename appears
 * somewhere in the turn" — turned that listing into sixteen chips for files the
 * turn never touched (a real thread: a maintenance question on a remote host,
 * answered with 16 conflict copies attached to it).
 */
function remoteThreadWithShelf(files) {
  const workspace = workspaces.create({ label: `artifacts-shelf-${++seq}` })
  entities.scaffold({ workspace: workspace.id, name: 'chief-of-staff', harness: 'pi' })
  const record = workspaces.open(workspace.id)
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(record.path, 'artifacts', rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, body || 'bytes')
  }
  const created = chats.create({ workspace: record.id, entity: 'chief-of-staff', harness: 'pi' })
  const file = path.join(record.path, 'chats', `${created.id}.json`)
  const thread = JSON.parse(fs.readFileSync(file, 'utf8'))
  thread.machine = 'root-ubuntu'
  thread.messages = [
    { who: 'me', text: 'What is in this shelf?', at: new Date().toISOString() },
    { who: 'agent', text: 'Let me look.', at: new Date().toISOString(), steps: [] },
  ]
  fs.writeFileSync(file, JSON.stringify(thread, null, 2))
  return { record, id: created.id, file }
}

const rewrite = (file, mutate) => {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  mutate(raw)
  fs.writeFileSync(file, JSON.stringify(raw, null, 2))
}

test('a listing in a remote turn is not evidence of ownership', () => {
  const { record, id, file } = remoteThreadWithShelf({
    'design/a/board.png': 'png',
    'design/b/board.png': 'png',
  })
  rewrite(file, (raw) => {
    raw.messages[1].steps = [
      {
        seq: 1,
        type: 'tool_use',
        tool: 'bash',
        input: { command: 'find workspace/artifacts -name "*.png"' },
        output: 'workspace/artifacts/design/a/board.png\nworkspace/artifacts/design/b/board.png\n',
      },
    ]
  })
  const read = chats.read({ workspace: record.id, id })
  assert.equal(read.messages[1].artifacts, undefined, 'reading a file is not writing it')
})

test('a remote turn still owns what it wrote, and what it names', () => {
  const { record, id, file } = remoteThreadWithShelf({
    'design/a/board.png': 'png',
    'design/b/board.png': 'png',
  })
  rewrite(file, (raw) => {
    raw.messages[1].text = 'The render is artifact://design/b/board.png'
    raw.messages[1].steps = [
      {
        seq: 1,
        type: 'tool_use',
        tool: 'write',
        input: { path: '/root/.entity/remote-runs/x/r1/workspace/artifacts/design/a/board.png' },
      },
      /* a `cp` beside a path is a write; a bare listing is not */
      { seq: 2, type: 'tool_use', tool: 'bash', input: { command: 'cp a b' }, output: 'done' },
    ]
  })
  const read = chats.read({ workspace: record.id, id })
  assert.deepEqual(
    (read.messages[1].artifacts || []).map((item) => item.id).sort(),
    ['design/a/board.png', 'design/b/board.png'],
  )
})

test('a sync conflict copy is never an artifact, even when it is named', () => {
  const { record, id, file } = remoteThreadWithShelf({
    'design/a/board.png': 'png',
    'conflicts/artifacts/design/a/board.20260101T000000000Z.local.png': 'png',
  })
  rewrite(file, (raw) => {
    raw.messages[1].text = [
      'Two files disagreed.',
      'artifact://conflicts/artifacts/design/a/board.20260101T000000000Z.local.png',
    ].join('\n')
  })
  const read = chats.read({ workspace: record.id, id })
  assert.equal(
    read.messages[1].artifacts,
    undefined,
    'the sync engine writes there, not a turn',
  )
})

/* ── a session's deliverable is locked to that session ────────────────
 *
 * The leak this pins, again: two conversations ran in the same folder inside
 * one workspace, and the card under one of them listed the other's render.
 * Folder inference is a *guess* with a single-owner condition, and the
 * condition is satisfied whenever the two turns' windows happen not to
 * overlap — the second design is still not this turn's.
 *
 * The store can be made to know: when a turn ends it records the files it
 * produced, and that record outranks the clock, the folder and the shelf root.
 * It is a lock, not a hint: what one session produced never appears under
 * another, and it does not need a second turn to be running to be wrong.
 */

function stampedFile(record, id, seconds) {
  writeShelfFile(record, id, seconds)
  return id
}

test('a file another session stamped never appears under this one', () => {
  const record = workspaceWithShelf()
  /* One folder, one deliverable, and the two turns do not overlap at all —
     which is exactly the case folder inference had no defence against. */
  writeShelfFile(record, 'design/rail/index.html', 110)
  writeShelfFile(record, 'design/rail/rail.png', 120)

  writeThread(record, {
    id: 't_owner',
    messages: [
      { who: 'me', text: 'Draw the rail.', at: at(100) },
      {
        who: 'agent',
        text: 'Drawn.',
        at: at(200),
        execution: { harness: 'pi', endedAt: at(200), status: 'ok' },
        steps: [{ seq: 1, type: 'tool_use', tool: 'write', at: at(110), input: { path: 'artifacts/design/rail/index.html' } }],
      },
    ],
  })
  /* A different conversation, later, in the same folder, naming nothing. */
  writeThread(record, {
    id: 't_other',
    messages: [
      { who: 'me', text: 'How many rows fit?', at: at(600) },
      { who: 'agent', text: 'Twelve.', at: at(700), execution: { harness: 'pi', endedAt: at(700), status: 'ok' } },
    ],
  })

  const owner = chats.read({ workspace: record.id, id: 't_owner' })
  const produced = (owner.messages[1].artifacts || []).map((entry) => entry.id).sort()
  assert.deepEqual(produced, ['design/rail/index.html', 'design/rail/rail.png'])
  const other = chats.read({ workspace: record.id, id: 't_other' })
  assert.deepEqual(other.messages[1].artifacts || [], [])
})

test('a stamp keeps a file in its session after the turn ages out of the window', () => {
  const record = workspaceWithShelf()
  /* Stamped by a turn whose question is older than the retention window the
     read rebuilds from: evidence in the transcript has aged out, but the file
     still belongs to the conversation that made it. */
  writeShelfFile(record, 'design/board/shot.png', 120)
  writeThread(record, {
    id: 't_aged',
    messages: [
      { who: 'me', text: 'Take a shot of the board.', at: at(100) },
      { who: 'agent', text: 'Done.', at: at(200), execution: { harness: 'pi', endedAt: at(200), status: 'ok' } },
    ],
  })

  /* what the store wrote when that turn ended */
  const chatsFile = path.join(record.path, 'artifacts', '.origin.json')
  fs.writeFileSync(
    chatsFile,
    JSON.stringify({ schema: 1, threads: { 'design/board/shot.png': 't_aged' } }, null, 2),
  )

  const thread = chats.read({ workspace: record.id, id: 't_aged' })
  assert.deepEqual((thread.messages[1].artifacts || []).map((entry) => entry.id), ['design/board/shot.png'])

  /* and no other conversation reads it as its own */
  writeThread(record, {
    id: 't_bystander',
    messages: [
      { who: 'me', text: 'Anything new?', at: at(600) },
      { who: 'agent', text: 'No.', at: at(700), execution: { harness: 'pi', endedAt: at(700), status: 'ok' } },
    ],
  })
  const bystander = chats.read({ workspace: record.id, id: 't_bystander' })
  assert.deepEqual(bystander.messages[1].artifacts || [], [])
})

test('a revision by another session still shows beside the answer that names it', () => {
  const record = workspaceWithShelf()
  writeShelfFile(record, 'design/page/index.html', 350)
  writeThread(record, {
    id: 't_author',
    messages: [
      { who: 'me', text: 'Draw it.', at: at(100) },
      { who: 'agent', text: 'Drawn.', at: at(200), execution: { harness: 'pi', endedAt: at(200), status: 'ok' } },
    ],
  })
  fs.writeFileSync(
    path.join(record.path, 'artifacts', '.origin.json'),
    JSON.stringify({ schema: 1, threads: { 'design/page/index.html': 't_author' } }, null, 2),
  )
  /* The second turn edits the page and says so. Authorship does not move, but a
     card under the answer that talks about the file is what a person expects. */
  writeThread(record, {
    id: 't_editor',
    messages: [
      { who: 'me', text: 'Now the icons.', at: at(300) },
      {
        who: 'agent',
        text: 'Icons in — artifact://design/page/index.html',
        at: at(400),
        execution: { harness: 'pi', endedAt: at(400), status: 'ok' },
      },
    ],
  })

  const editor = chats.read({ workspace: record.id, id: 't_editor' })
  assert.deepEqual((editor.messages[1].artifacts || []).map((entry) => entry.id), ['design/page/index.html'])
})

test('the origin index is a dot file, so neither the shelf nor the wire carries it', () => {
  const record = workspaceWithShelf()
  writeShelfFile(record, 'notes.md', 100)
  fs.writeFileSync(
    path.join(record.path, 'artifacts', '.origin.json'),
    JSON.stringify({ schema: 1, threads: { 'notes.md': 't_notes' } }, null, 2),
  )
  const listed = artifacts.list({ workspace: record.id })
  assert.equal(listed.items.some((item) => item.id === '.origin.json'), false)
  assert.equal(listed.count, listed.items.length)
  /* a thread id means nothing on a clone, so the manifest never ships it */
  assert.equal(manifest.safeRel('artifacts/.origin.json'), null)
})
