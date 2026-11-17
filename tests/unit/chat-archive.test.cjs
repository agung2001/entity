/**
 * Archiving is a state of the same record, not a move.
 *
 * These tests pin the three things that make it cheap and reversible: the field
 * mirrors `pinned`, restoring deletes it instead of writing `false` (so a file
 * that came back is byte-identical to one that never left), and the row carries
 * enough for the rail to sort the archive without re-reading the thread.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-archive-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('../../electron/workspace-store.cjs')
const entities = require('../../electron/entity-store.cjs')
const chats = require('../../electron/chat-store.cjs')

let seq = 0

function workspaceWithThread(messages) {
  const workspace = workspaces.create({ label: `archive-${++seq}` })
  entities.scaffold({ workspace: workspace.id, name: 'chief-of-staff', harness: 'pi' })
  const record = workspaces.open(workspace.id)
  const id = `t_archive_${seq}`
  fs.mkdirSync(path.join(record.path, 'chats'), { recursive: true })
  const at = new Date().toISOString()
  fs.writeFileSync(
    path.join(record.path, 'chats', `${id}.json`),
    JSON.stringify(
      {
        schema: 1,
        id,
        entity: 'chief-of-staff',
        machine: 'local',
        harness: 'pi',
        createdAt: at,
        updatedAt: at,
        messages: messages || [
          { who: 'me', text: 'archive me', at },
          { who: 'agent', text: 'Done.', at, execution: { harness: 'pi', endedAt: at, status: 'ok' } },
        ],
      },
      null,
      2,
    ),
  )
  return { record, id, file: path.join(record.path, 'chats', `${id}.json`) }
}

const readFile = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

test('archiving sets the flag and a timestamp, and keeps the thread', () => {
  const { record, id, file } = workspaceWithThread()
  const archived = chats.archive({ workspace: record.id, id, archived: true })

  assert.equal(archived.archived, true)
  assert.ok(archived.archivedAt, 'archivedAt is written with the flag')
  const onDisk = readFile(file)
  assert.equal(onDisk.archived, true)
  assert.equal(onDisk.archivedAt, archived.archivedAt)
  /* everything else is still there: an archive is not a delete */
  assert.equal(onDisk.messages.length, 2)

  const read = chats.read({ workspace: record.id, id })
  assert.equal(read.archived, true)
})

test('restoring deletes both keys instead of writing false', () => {
  const { record, id, file } = workspaceWithThread()
  chats.archive({ workspace: record.id, id, archived: true })
  chats.archive({ workspace: record.id, id, archived: false })

  const onDisk = readFile(file)
  assert.equal('archived' in onDisk, false)
  assert.equal('archivedAt' in onDisk, false)
  /* acceptance 14: a workspace never accumulates `archived: false` */
  assert.equal(fs.readFileSync(file, 'utf8').includes('archived: false'), false)

  const read = chats.read({ workspace: record.id, id })
  assert.equal(read.archived, false)
  assert.equal(read.archivedAt, undefined)
})

test('a thread that was never archived stays byte-identical', () => {
  const { record, id, file } = workspaceWithThread()
  const before = fs.readFileSync(file, 'utf8')
  const read = chats.read({ workspace: record.id, id })
  assert.equal(read.archived, false)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
})

test('a rename or a pin never writes archived: false', () => {
  const { record, id, file } = workspaceWithThread()
  const before = fs.readFileSync(file, 'utf8')
  chats.rename({ workspace: record.id, id, title: 'renamed while active' })
  chats.pin({ workspace: record.id, id, pinned: true })
  const after = fs.readFileSync(file, 'utf8')
  assert.equal(after.includes('"archived"'), false, 'the key is absent, not false')
  assert.equal(before.includes('"archived"'), false)
})

test('the row carries the state, so the rail can split the list without reading', () => {
  const { record, id } = workspaceWithThread()
  chats.archive({ workspace: record.id, id, archived: true })

  const rows = chats.list({ workspace: record.id })
  const row = rows.find((entry) => entry.id === id)
  assert.equal(row.archived, true)
  assert.ok(row.archivedAt)
  /* the row still has what an active row has: nothing was downgraded */
  assert.equal(row.queries, 1)
  assert.equal(row.entity, 'chief-of-staff')
})

test('archiving keeps the pin, and restoring does not touch the age', () => {
  const { record, id, file } = workspaceWithThread()
  chats.pin({ workspace: record.id, id, pinned: true })
  const updatedAt = readFile(file).updatedAt

  chats.archive({ workspace: record.id, id, archived: true })
  assert.equal(readFile(file).pinned, true, 'the pin survives the archive')
  assert.equal(readFile(file).updatedAt, updatedAt, 'the row age is not a place in the archive')

  chats.archive({ workspace: record.id, id, archived: false })
  assert.equal(readFile(file).pinned, true)
  assert.equal(readFile(file).updatedAt, updatedAt)
})

test('an archived thread stays archived, and its file is still readable', () => {
  const { record, id } = workspaceWithThread()
  chats.archive({ workspace: record.id, id, archived: true })
  /* Nothing about archiving removes it from list/read: the rail does the
     hiding, so a deep link and a restore both still resolve. */
  assert.ok(chats.list({ workspace: record.id }).some((row) => row.id === id))
  assert.equal(chats.read({ workspace: record.id, id })?.messages.length, 2)
})

/**
 * The sweep side of the same write.
 *
 * ENTITY-20 turns archive into a rule ("archive a thread 30 days after its last
 * message") and empties the archive later ("delete it 180 days *after it was
 * archived*"). Both depend on this one function behaving like a state setter
 * rather than a button: a pass runs on every boot, and re-stamping `archivedAt`
 * on each tick would reset the clock the delete rule counts.
 */
test('archiving an archived thread is a no-op, not a re-stamp', async () => {
  const { record, id, file } = workspaceWithThread()
  const first = chats.archive({ workspace: record.id, id, archived: true })
  await new Promise((resolve) => setTimeout(resolve, 15))

  const second = chats.archive({ workspace: record.id, id, archived: true })
  assert.equal(second.archivedAt, first.archivedAt, 'the stamp is written once')
  assert.equal(readFile(file).archivedAt, first.archivedAt)
})

test('a pass that changes nothing writes nothing', () => {
  const { record, id, file } = workspaceWithThread()
  chats.archive({ workspace: record.id, id, archived: true })
  const archivedBefore = fs.readFileSync(file, 'utf8')

  chats.archive({ workspace: record.id, id, archived: true })
  assert.equal(fs.readFileSync(file, 'utf8'), archivedBefore, 'no rewrite on an archived thread')

  chats.archive({ workspace: record.id, id, archived: false })
  const restoredBefore = fs.readFileSync(file, 'utf8')
  chats.archive({ workspace: record.id, id, archived: false })
  assert.equal(fs.readFileSync(file, 'utf8'), restoredBefore, 'no rewrite on an active thread')
})

test('the archive date is what a retention pass would count from', () => {
  const { record, id, file } = workspaceWithThread()
  const old = '2020-01-01T00:00:00.000Z'
  const doc = readFile(file)
  doc.archived = true
  doc.archivedAt = old
  fs.writeFileSync(file, JSON.stringify(doc, null, 2))

  /* the pass calls the same function a click does */
  const thread = chats.archive({ workspace: record.id, id, archived: true })
  assert.equal(thread.archivedAt, old, 'a sweep keeps the date the thread went in')
  assert.equal(readFile(file).archivedAt, old)

  /* and the stamp survives every other read-modify-write of the same record */
  chats.rename({ workspace: record.id, id, title: 'renamed while archived' })
  chats.pin({ workspace: record.id, id, pinned: true })
  const after = readFile(file)
  assert.equal(after.archived, true)
  assert.equal(after.archivedAt, old, 'only the archive transition owns the date')
})
