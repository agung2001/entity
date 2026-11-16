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

test('a parked MCP server is present, not missing', () => {
  const id = workspaces.create({ label: 'parked' }).id
  entities.scaffold({ workspace: id, name: 'writer', mcp: ['notion'] })
  workspaces.setMcpEnabled({
    id,
    name: 'notion',
    enabled: false,
    definition: { command: 'npx', args: ['-y', 'notion-mcp'] },
  })

  /* The definition is in the workspace, only disabled: the entity resolves. */
  assert.deepEqual(problemsOf(id).writer, [])
})

test('a server with no definition anywhere is still a problem', () => {
  const id = workspaces.create({ label: 'unknown' }).id
  entities.scaffold({ workspace: id, name: 'writer', mcp: ['ghost'] })
  assert.deepEqual(problemsOf(id).writer, ['mcp server "ghost" is not in this workspace'])
})

test('a local workspace still flags a skill it cannot attach', () => {
  const id = workspaces.create({ label: 'local' }).id
  entities.scaffold({ workspace: id, name: 'writer', skills: ['house-style'] })
  assert.deepEqual(problemsOf(id).writer, ['skill "house-style" is missing'])
})

test('a connected remote workspace leaves its missing skills to the panel', () => {
  const id = workspaces.create({ label: 'remote' }).id
  entities.scaffold({ workspace: id, name: 'writer', skills: ['house-style'], mcp: ['notion'] })
  workspaces.setMcpEnabled({
    id,
    name: 'notion',
    enabled: false,
    definition: { command: 'npx', args: ['-y', 'notion-mcp'] },
  })
  const file = path.join(workspaces.open(id).path, 'workspace.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...raw, schema: 1, id, kind: 'remote' }))

  assert.deepEqual(problemsOf(id).writer, [])
})
