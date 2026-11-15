const test = require('node:test')
const assert = require('node:assert/strict')

const { deletionTarget } = require('../../src/lib/delete-intent.js')

const AGENTS = [{ name: 'secretary' }, { name: 'chief-of-staff' }, { name: 'researcher' }]

test('a delete request that names an entity is intercepted', () => {
  assert.deepEqual(deletionTarget('I want to delete the @secretary', AGENTS), {
    names: ['secretary'],
  })
  assert.deepEqual(deletionTarget('remove chief-of-staff please', AGENTS), {
    names: ['chief-of-staff'],
  })
})

test('a sentence about something else is not a delete request', () => {
  assert.equal(deletionTarget('How do I keep the @secretary on topic?', AGENTS), null)
  assert.equal(deletionTarget('delete the old notes', AGENTS), null)
})

test('an unknown mention is not a target', () => {
  assert.equal(deletionTarget('delete @nobody', AGENTS), null)
})

test('a workspace with no entities cannot match', () => {
  assert.equal(deletionTarget('delete secretary', []), null)
})
