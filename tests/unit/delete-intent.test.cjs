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

test('a delegate brief that says never delete is not a delete request', () => {
  /* the real message that opened "delete coder": a fan-out brief whose last
     line forbids deleting the worktree */
  const brief =
    'spawn per @youtrack:ENTITY:relates to: ENTITY-21 #Unresolved @coder ' +
    '/workspace:orca-worktree the repo is Orca\'s entity project. Then commit, push and open ' +
    'ONE pull request. Never merge, tag, release, delete the worktree or the branch. ' +
    'Your row is the only issue you touch.'
  assert.equal(deletionTarget(brief, AGENTS), null)
  /* and the negated forms of a request are not requests either */
  assert.equal(deletionTarget('do not delete @secretary', AGENTS), null)
  assert.equal(deletionTarget('never remove secretary', AGENTS), null)
  /* a negation in the *previous* clause does not swallow the request */
  assert.deepEqual(deletionTarget("no, not that one — delete @researcher", AGENTS), {
    names: ['researcher'],
  })
})

test('the verb has to name an entity, not merely share a sentence with one', () => {
  assert.equal(
    deletionTarget('delete the worktree named entity-23, then report to @researcher', AGENTS),
    null,
  )
  assert.deepEqual(deletionTarget('delete @researcher and then release @secretary', AGENTS), {
    names: ['researcher'],
  })
})
