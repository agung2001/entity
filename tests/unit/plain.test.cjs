const assert = require('node:assert/strict')
const test = require('node:test')

test('a reactive-shaped argument becomes plain data for IPC', async () => {
  const { toPlain } = await import('../../src/lib/plain.js')
  const mark = new Proxy({ shape: 'blob', color: 'sun' }, {})
  const entity = new Proxy(
    {
      name: 'chief-of-staff',
      harness: 'pi',
      skills: ['planning'],
      mark,
      workspace: 'studio',
    },
    {},
  )
  const plain = toPlain({ entity })
  assert.deepEqual(plain, {
    entity: {
      name: 'chief-of-staff',
      harness: 'pi',
      skills: ['planning'],
      mark: { shape: 'blob', color: 'sun' },
      workspace: 'studio',
    },
  })
  /* The clone must own its nested values, not share the proxy. */
  assert.notEqual(plain.entity.mark, mark)
  assert.deepEqual(toPlain(undefined), {})
})
