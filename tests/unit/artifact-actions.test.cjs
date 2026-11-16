/**
 * The action row on an artifact is decided by the file, not by the card.
 *
 * One list on the server (`capabilitiesFor`) says what a file supports; the RPC
 * refuses a verb the file does not have, so a button that cannot work is a
 * message and never a launch. Reveal applies to everything, an editor to text,
 * a browser to a page.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-artifact-actions-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('../../electron/workspace-store.cjs')
const entities = require('../../electron/entity-store.cjs')
const artifacts = require('../../electron/artifact-store.cjs')
const chats = require('../../electron/chat-store.cjs')
const { createRpc } = require('../../electron/rpc.cjs')

function shelfWith(files) {
  const record = workspaces.create({ label: `actions-${Math.random().toString(36).slice(2, 7)}` })
  const dir = path.join(record.path, 'artifacts')
  fs.mkdirSync(dir, { recursive: true })
  for (const name of files) {
    const file = path.join(dir, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'bytes')
  }
  return record
}

test('the extension decides what a file can do', () => {
  assert.deepEqual(artifacts.capabilitiesFor('note.md'), ['reveal', 'editor'])
  assert.deepEqual(artifacts.capabilitiesFor('data.csv'), ['reveal', 'editor'])
  assert.deepEqual(artifacts.capabilitiesFor('app.ts'), ['reveal', 'editor'])
  assert.deepEqual(artifacts.capabilitiesFor('page.html'), ['reveal', 'editor', 'browser'])
  assert.deepEqual(artifacts.capabilitiesFor('manual.pdf'), ['reveal', 'browser'])
  assert.deepEqual(artifacts.capabilitiesFor('shot.png'), ['reveal'])
  assert.deepEqual(artifacts.capabilitiesFor('clip.mp4'), ['reveal'])
  assert.deepEqual(artifacts.capabilitiesFor('bundle.zip'), ['reveal'])
  assert.deepEqual(artifacts.capabilitiesFor('archive.unknown'), ['reveal'])
})

test('the listed metadata carries the capabilities the card renders', () => {
  const record = shelfWith(['note.md', 'page.html', 'shot.png'])
  const rows = artifacts.list({ workspace: record.id }).items
  const byName = Object.fromEntries(rows.map((row) => [row.name, row.capabilities]))
  assert.deepEqual(byName['note.md'], ['reveal', 'editor'])
  assert.deepEqual(byName['page.html'], ['reveal', 'editor', 'browser'])
  assert.deepEqual(byName['shot.png'], ['reveal'])
})

function rpcWith(calls, { editor = true, opener = true } = {}) {
  const rpc = createRpc({
    emit: () => {},
    reveal: (file) => calls.push(['reveal', file]),
    ...(opener ? { openPath: async (file) => calls.push(['browser', file]) } : {}),
    ...(editor ? { openInEditor: async (file) => calls.push(['editor', file]) } : {}),
  })
  return rpc
}

test('each verb opens the file the way it says, and nothing else', async (t) => {
  const record = shelfWith(['note.md', 'page.html', 'manual.pdf', 'shot.png'])
  const calls = []
  const rpc = rpcWith(calls)
  t.after(() => rpc.closeAll())

  const open = (id, how) => rpc.call('artifact.open', { workspace: record.id, id, how })

  assert.equal((await open('note.md', 'editor')).ok, true)
  assert.equal((await open('page.html', 'browser')).ok, true)
  assert.equal((await open('manual.pdf', 'browser')).ok, true)
  assert.equal((await open('shot.png', 'reveal')).ok, true)

  assert.deepEqual(
    calls.map(([how, file]) => [how, path.basename(file)]),
    [
      ['editor', 'note.md'],
      ['browser', 'page.html'],
      ['browser', 'manual.pdf'],
      ['reveal', 'shot.png'],
    ],
  )
})

test('a verb the file does not have is refused with a sentence a person can read', async (t) => {
  const record = shelfWith(['note.md', 'shot.png', 'bundle.zip'])
  const calls = []
  const rpc = rpcWith(calls)
  t.after(() => rpc.closeAll())
  const open = (id, how) => rpc.call('artifact.open', { workspace: record.id, id, how })

  const image = await open('shot.png', 'editor')
  assert.equal(image.ok, false)
  assert.match(image.error, /not text/i)

  const markdown = await open('note.md', 'browser')
  assert.equal(markdown.ok, false)
  assert.match(markdown.error, /no rendered page/i)

  const binary = await open('bundle.zip', 'browser')
  assert.equal(binary.ok, false)

  const nonsense = await open('note.md', 'shell')
  assert.equal(nonsense.ok, false)

  assert.deepEqual(calls, [], 'nothing was launched')
})

test('a build without the capability says so instead of doing nothing', async (t) => {
  const record = shelfWith(['note.md', 'page.html'])
  const calls = []
  const rpc = rpcWith(calls, { editor: false, opener: false })
  t.after(() => rpc.closeAll())

  const editor = await rpc.call('artifact.open', { workspace: record.id, id: 'note.md', how: 'editor' })
  assert.equal(editor.ok, false)
  assert.match(editor.error, /not available in this build/i)

  const browser = await rpc.call('artifact.open', {
    workspace: record.id,
    id: 'page.html',
    how: 'browser',
  })
  assert.equal(browser.ok, false)
  assert.match(browser.error, /not available in this build/i)
})

test('an id outside the shelf is refused before anything resolves', async (t) => {
  const record = shelfWith(['note.md'])
  const rpc = rpcWith([])
  t.after(() => rpc.closeAll())
  const escape = await rpc.call('artifact.open', {
    workspace: record.id,
    id: '../../package.json',
    how: 'reveal',
  })
  assert.equal(escape.ok, false)
})

test('a chat card arrives with the capabilities it needs to draw its row', () => {
  const record = shelfWith(['note.md'])
  entities.scaffold({ workspace: record.id, name: 'writer', harness: 'pi' })
  const askedAt = new Date(Date.now() - 90_000)
  const savedAt = new Date(Date.now() - 60_000)
  const answeredAt = new Date(Date.now() - 30_000)
  const file = path.join(record.path, 'artifacts', 'note.md')
  fs.utimesSync(file, savedAt, savedAt)
  fs.mkdirSync(path.join(record.path, 'chats'), { recursive: true })
  fs.writeFileSync(
    path.join(record.path, 'chats', 't_caps.json'),
    JSON.stringify({
      schema: 1,
      id: 't_caps',
      entity: 'writer',
      machine: 'local',
      harness: 'pi',
      createdAt: askedAt.toISOString(),
      updatedAt: answeredAt.toISOString(),
      messages: [
        { who: 'me', text: 'Write the note.', at: askedAt.toISOString() },
        {
          who: 'agent',
          text: 'Saved as artifact://note.md',
          at: answeredAt.toISOString(),
          execution: { harness: 'pi', endedAt: answeredAt.toISOString(), status: 'ok' },
        },
      ],
    }),
  )

  const thread = chats.read({ workspace: record.id, id: 't_caps' })
  const chip = thread.messages[1].artifacts?.[0]
  assert.equal(chip?.name, 'note.md')
  assert.deepEqual(chip?.capabilities, ['reveal', 'editor'])
})
