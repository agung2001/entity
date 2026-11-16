const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-problems-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('../../electron/workspace-store.cjs')
const entities = require('../../electron/entity-store.cjs')

function problemsOf(id) {
  const list = entities.list(id)
  return Object.fromEntries(list.map((entity) => [entity.name, entity.problems]))
}

/* Skills and MCP servers belong to the workspace, so no entity can be wrong
   about them: there is no list to be missing from and no subset to miss. The
   problems an entity can have are about itself — its harness and its dir. */

test('a parked MCP server is not an entity problem', () => {
  const id = workspaces.create({ label: 'parked' }).id
  entities.scaffold({ workspace: id, name: 'writer' })
  workspaces.setMcpEnabled({
    id,
    name: 'notion',
    enabled: false,
    definition: { command: 'npx', args: ['-y', 'notion-mcp'] },
  })

  assert.deepEqual(problemsOf(id).writer, [])
})

test('a skill this machine cannot see is not an entity problem', () => {
  const id = workspaces.create({ label: 'local' }).id
  entities.scaffold({ workspace: id, name: 'writer' })
  /* Nothing in the workspace skills directory, and the entity is still fine:
     the skills page is where a missing body is reported, once. */
  assert.deepEqual(problemsOf(id).writer, [])
})

test('a stale skills:/mcp: line in an old file changes nothing', () => {
  const id = workspaces.create({ label: 'legacy' }).id
  const dir = path.join(workspaces.open(id).path, 'entities')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'old.md')
  fs.writeFileSync(
    file,
    [
      '---',
      'name: old',
      'harness: claude',
      'dir: ~',
      'skills: house-style',
      'mcp: ghost',
      '---',
      '',
      '# Old',
      '',
    ].join('\n'),
  )

  const read = entities.read(id, 'old')
  assert.deepEqual(read.problems, [])
  assert.equal(read.skills, undefined, 'the reader stops inventing an access list')
  assert.equal(read.mcp, undefined)

  /* And the next write drops the keys: nothing reads them, so keeping them
     would only look like configuration. */
  entities.write({ ...read, model: 'opus' })
  const saved = fs.readFileSync(file, 'utf8')
  assert.doesNotMatch(saved, /^(skills|mcp):/m)
  assert.match(saved, /^model: opus$/m)
  /* everything else the file carried survives */
  assert.match(saved, /^name: old$/m)
})

test('the problems an entity can have are its own', () => {
  const id = workspaces.create({ label: 'own' }).id
  const dir = path.join(workspaces.open(id).path, 'entities')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'broken.md'),
    '---\nname: broken\nharness: not-a-harness\ndir: /no/such/dir\n---\n\n# Broken\n',
  )

  assert.deepEqual(problemsOf(id).broken, [
    'harness "not-a-harness" is unknown',
    `dir ${'/no/such/dir'} does not exist`,
  ])
})
