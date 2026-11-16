/**
 * Two kinds of editable metadata, pinned without a browser:
 *
 * - thread tags are written by the tag dialog as comma-separated text, so the
 *   store must normalise what a person types before it reaches the rail;
 * - an artifact edit writes back to the same file, never a second copy.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-tags-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('../../electron/workspace-store.cjs')
const entities = require('../../electron/entity-store.cjs')
const chats = require('../../electron/chat-store.cjs')
const artifacts = require('../../electron/artifact-store.cjs')

let seq = 0

function workspace() {
  const created = workspaces.create({ label: `tags-${++seq}` })
  entities.scaffold({ workspace: created.id, name: 'chief-of-staff', harness: 'claude' })
  return workspaces.open(created.id)
}

function thread(record) {
  return chats.create({
    workspace: record.id,
    entity: 'chief-of-staff',
    harness: 'claude',
  })
}

test('a new thread starts with no tags', () => {
  const record = workspace()
  const created = thread(record)
  assert.deepEqual(created.tags, [])
  assert.deepEqual(chats.read({ workspace: record.id, id: created.id }).tags, [])
})

test('tags trim, collapse duplicates and survive the history row', () => {
  const record = workspace()
  const created = thread(record)
  const updated = chats.tags({
    workspace: record.id,
    id: created.id,
    tags: ['  design ', 'Review', 'design', '', '  '],
  })
  assert.deepEqual(updated.tags, ['design', 'Review'])

  const row = chats.list({ workspace: record.id }).find((entry) => entry.id === created.id)
  assert.deepEqual(row.tags, ['design', 'Review'], 'the rail row carries the tags')
  assert.deepEqual(chats.read({ workspace: record.id, id: created.id }).tags, ['design', 'Review'])
})

test('tags are capped so a pasted paragraph cannot become a wall of chips', () => {
  const record = workspace()
  const created = thread(record)
  const many = Array.from({ length: 30 }, (_, index) => `tag-${index}`)
  const updated = chats.tags({ workspace: record.id, id: created.id, tags: many })
  assert.equal(updated.tags.length, 12)
  const long = chats.tags({
    workspace: record.id,
    id: created.id,
    tags: ['x'.repeat(200)],
  })
  assert.equal(long.tags[0].length, 32)
})

test('an artifact edit overwrites the file it came from', () => {
  const record = workspace()
  const saved = artifacts.saveText({
    workspace: record.id,
    name: 'influencer.md',
    text: '# Influencer\n\nFirst draft.\n',
  })
  const next = artifacts.writeText({
    workspace: record.id,
    id: saved.id,
    text: '# Influencer\n\nSecond draft.\n',
  })
  assert.equal(next.id, saved.id, 'an edit is not a new copy')
  assert.equal(next.name, 'influencer.md')
  const read = artifacts.read({ workspace: record.id, id: saved.id })
  assert.match(read.text, /Second draft/)
  assert.equal(artifacts.list({ workspace: record.id }).count, 1, 'one file, not two')
  fs.rmSync(path.join(PROFILE, 'workspaces', record.id), { recursive: true, force: true })
})

test('a binary artifact is not writable as text', () => {
  const record = workspace()
  const saved = artifacts.upload({
    workspace: record.id,
    name: 'shot.png',
    dataUrl: `data:image/png;base64,${Buffer.from('png bytes').toString('base64')}`,
  })
  assert.throws(
    () => artifacts.writeText({ workspace: record.id, id: saved.id, text: 'not a png' }),
    /Only text artifacts/,
  )
})
