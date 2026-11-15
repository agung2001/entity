/**
 * A thread's optional base directory: the folder its skills and `@file:` paths
 * are read from. These pin the contract — validation, persistence, the
 * `/project:` reference and the file listing — without starting a harness.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-basedir-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('../../electron/workspace-store.cjs')
const entities = require('../../electron/entity-store.cjs')
const chats = require('../../electron/chat-store.cjs')
const localData = require('../../electron/local-data.cjs')
const skillRef = require('../../electron/skill-ref.cjs')
const mention = require('../../electron/mention-ref.cjs')

let seq = 0

function workspace() {
  const created = workspaces.create({ label: `base-dir-${++seq}` })
  entities.scaffold({ workspace: created.id, name: 'chief-of-staff', harness: 'claude' })
  return workspaces.open(created.id)
}

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-project-'))
  const skill = path.join(dir, '.claude', 'skills', 'review')
  fs.mkdirSync(skill, { recursive: true })
  fs.writeFileSync(
    path.join(skill, 'SKILL.md'),
    ['---', 'name: review', 'description: Review the diff', '---', '', '# review', ''].join('\n'),
  )
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const app = 1\n')
  fs.writeFileSync(path.join(dir, 'README.md'), '# project\n')
  return dir
}

test('project skills are scanned from the base directory', () => {
  const dir = project()
  const found = localData.scanProjectSkills({ dir })
  assert.equal(found.dir, dir)
  assert.equal(found.count, 1)
  assert.equal(found.items[0].name, 'review')
  assert.equal(found.items[0].harness, 'claude')
  assert.equal(found.items[0].scope, 'project')
})

test('a base directory is validated, persisted and refuses another machine', () => {
  const record = workspace()
  const dir = project()

  const thread = chats.create({
    workspace: record.id,
    entity: 'chief-of-staff',
    harness: 'claude',
    dir,
  })
  assert.equal(thread.dir, path.resolve(dir))
  assert.equal(chats.read({ workspace: record.id, id: thread.id }).dir, path.resolve(dir))
  /* The history row carries it too: reopening a thread restores the scope
     without a second read. */
  const row = chats.list({ workspace: record.id }).find((entry) => entry.id === thread.id)
  assert.equal(row.dir, path.resolve(dir))

  assert.throws(
    () =>
      chats.create({
        workspace: record.id,
        entity: 'chief-of-staff',
        harness: 'claude',
        dir: 'relative/path',
      }),
    /absolute path/,
  )
  assert.throws(
    () =>
      chats.create({
        workspace: record.id,
        entity: 'chief-of-staff',
        harness: 'claude',
        dir: path.join(dir, 'missing'),
      }),
    /does not exist/,
  )
  assert.throws(
    () =>
      chats.create({
        workspace: record.id,
        entity: 'chief-of-staff',
        harness: 'claude',
        machine: 'somewhere-else',
        dir,
      }),
    /only available on this machine|capability snapshot/i,
  )
})

test('/project: and a bare name resolve from the base directory', () => {
  const record = workspace()
  const dir = project()

  const qualified = skillRef.rewrite(record, '/project:review look at the diff', { dir })
  assert.match(qualified.text, /^use this skill .*review/)
  assert.match(qualified.text, /look at the diff/)

  const bare = skillRef.rewrite(record, '/review look at the diff', { dir })
  assert.match(bare.text, /^use this skill .*review/)

  assert.throws(() => skillRef.rewrite(record, '/project:review nope', {}), /base directory/i)
})

test('the @file: menu lists files under the base directory', async () => {
  const record = workspace()
  const dir = project()

  const page = await mention.search({
    record,
    kind: 'file',
    fields: ['app'],
    dir,
    limit: 10,
    offset: 0,
  })
  assert.equal(page.items.length, 1)
  assert.equal(page.items[0].insert, '@file:src/app.ts')
  assert.match(page.items[0].detail, /src\/app\.ts$/)

  const none = await mention.search({ record, kind: 'file', fields: ['app'], limit: 10, offset: 0 })
  assert.deepEqual(none.items, [], 'without a base directory the menu stays empty')
})

test('@file: resolves from the base directory when the turn is sent', async (t) => {
  const harnesses = require('../../electron/harness-store.cjs')
  const record = workspace()
  const dir = project()
  const fake = path.join(PROFILE, 'fake-pi')
  fs.writeFileSync(fake, '#!/bin/sh\ncat >/dev/null 2>&1\nexit 0\n', { mode: 0o755 })
  harnesses.setPath({ id: 'pi', path: fake })

  const thread = chats.create({
    workspace: record.id,
    entity: 'chief-of-staff',
    harness: 'pi',
    dir,
  })
  t.after(() => chats.closeAll())
  const updated = await chats.send({
    workspace: record.id,
    id: thread.id,
    text: '@file:README.md summarise this',
    attachmentsEnabled: true,
  })
  const asked = updated.messages.find((message) => message.who === 'me')
  assert.equal(asked.attachments.length, 1)
  assert.equal(asked.attachments[0].path, path.join(dir, 'README.md'))
})

test('a file written during a turn is attached in the returned thread', async (t) => {
  const harnesses = require('../../electron/harness-store.cjs')
  const record = workspace()
  const fake = path.join(PROFILE, 'fake-pi-artifact')
  fs.writeFileSync(
    fake,
    [
      '#!/bin/sh',
      'cat >/dev/null 2>&1',
      `mkdir -p ${JSON.stringify(path.join(record.path, 'artifacts'))}`,
      `printf "png bytes" > ${JSON.stringify(path.join(record.path, 'artifacts', 'shot.png'))}`,
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  harnesses.setPath({ id: 'pi', path: fake })

  const thread = chats.create({
    workspace: record.id,
    entity: 'chief-of-staff',
    harness: 'pi',
  })
  t.after(() => chats.closeAll())
  const updated = await chats.send({
    workspace: record.id,
    id: thread.id,
    text: 'Take a screenshot and show me.',
  })
  const reply = updated.messages.find((message) => message.who === 'agent')
  assert.ok(Array.isArray(reply.artifacts), 'the reply carries the files the turn wrote')
  assert.equal(reply.artifacts[0].id, 'shot.png')
})
