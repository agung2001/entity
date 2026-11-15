const test = require('node:test')
const assert = require('node:assert/strict')
const { cleanActions } = require('../../electron/suggest.cjs')

test('suggestions keep three, drop blanks and duplicates', () => {
  const actions = cleanActions([
    { label: 'Ship it', prompt: 'Ship the change.', primary: false },
    { label: 'Ship it', prompt: 'Ship the change.', primary: true },
    { label: '  ', prompt: 'nothing' },
    { label: 'Add tests', prompt: 'Add tests for this.' },
    { label: 'Explain', prompt: 'Explain that.' },
    { label: 'Extra', prompt: 'One too many.' },
  ])
  assert.equal(actions.length, 3)
  assert.equal(actions.filter((action) => action.primary).length, 1)
  assert.equal(actions[0].label, 'Ship it')
  assert.equal(actions[0].primary, true)
})

test('labels and prompts are trimmed and bounded', () => {
  const [action] = cleanActions([{ label: 'x'.repeat(200), prompt: 'y'.repeat(900), primary: true }])
  assert.ok(action.label.length <= 60)
  assert.ok(action.prompt.length <= 500)
})
