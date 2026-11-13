const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-clone-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('./workspace-store.cjs')
const entities = require('./entity-store.cjs')

test('an entity clones into another workspace without replacing files', () => {
  const source = workspaces.create({ label: 'source' }).id
  const target = workspaces.create({ label: 'target' }).id

  const original = entities.scaffold({
    workspace: source,
    name: 'writer',
    harness: 'claude',
    model: 'claude-sonnet-4-5',
    description: 'Writes clear, sourced content.',
    shape: 'leaf',
    color: 'mint',
    mood: 'happy',
  })

  const copy = entities.cloneTo({ from: source, to: target, name: 'writer' })
  assert.equal(copy.name, 'writer')
  assert.equal(copy.workspace, target)
  assert.equal(copy.harness, original.harness)
  assert.equal(copy.model, original.model)
  assert.equal(copy.instructions, original.instructions)
  assert.deepEqual(copy.mark, original.mark)
  assert.equal(fs.existsSync(entities.locate({ workspace: target, name: 'writer' })), true)

  /* A second clone never overwrites the first. */
  const second = entities.cloneTo({ from: source, to: target, name: 'writer' })
  assert.equal(second.name, 'writer-2')

  /* A different target name is honoured. */
  const renamed = entities.cloneTo({
    from: source,
    to: target,
    name: 'writer',
    nextName: 'editor',
  })
  assert.equal(renamed.name, 'editor')

  /* The source file is untouched. */
  assert.equal(entities.list(source).length, 1)
  assert.equal(entities.list(target).length, 3)
})
