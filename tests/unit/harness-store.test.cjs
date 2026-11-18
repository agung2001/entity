/**
 * pi resolves a model across every provider it has authenticated, so a bare
 * `deepseek/deepseek-v4.1-flash` can match three of them and refuse to run.
 * These pin the pure resolution `resolvePiModel` does with an explicit listing:
 * prefix only when the answer is actually known, never twice, never by guess.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const store = require('../../electron/harness-store.cjs')

const MODELS = [
  'commandcode/deepseek/deepseek-v4.1-flash',
  'openrouter/deepseek/deepseek-v4.1-flash',
  'commandcode/only-here',
]

test('a bare id on several providers takes the configured provider', () => {
  assert.deepEqual(
    store.resolvePiModel('deepseek/deepseek-v4.1-flash', {
      models: MODELS,
      provider: 'commandcode',
    }),
    {
      model: 'commandcode/deepseek/deepseek-v4.1-flash',
      providers: ['commandcode', 'openrouter'],
      status: 'resolved',
    },
  )
})

test('a bare id only one provider lists is resolved without a provider hint', () => {
  const result = store.resolvePiModel('only-here', { models: MODELS })
  assert.equal(result.status, 'resolved')
  assert.equal(result.model, 'commandcode/only-here')
})

test('a bare id on several providers with no hint is ambiguous and names them', () => {
  const result = store.resolvePiModel('deepseek/deepseek-v4.1-flash', { models: MODELS })
  assert.deepEqual(result, {
    model: 'deepseek/deepseek-v4.1-flash',
    providers: ['commandcode', 'openrouter'],
    status: 'ambiguous',
  })
})

test('an already provider-qualified name is left exactly as typed', () => {
  assert.deepEqual(
    store.resolvePiModel('commandcode/deepseek/deepseek-v4.1-flash', {
      models: MODELS,
      provider: 'openrouter',
    }),
    {
      model: 'commandcode/deepseek/deepseek-v4.1-flash',
      providers: ['commandcode'],
      status: 'qualified',
    },
  )
})

test('a provider the listing omits is kept, not re-prefixed', () => {
  assert.deepEqual(
    store.resolvePiModel('vercel-ai-gateway/deepseek/deepseek-v4.1-flash', {
      models: MODELS,
      provider: 'commandcode',
    }),
    {
      model: 'vercel-ai-gateway/deepseek/deepseek-v4.1-flash',
      providers: [],
      status: 'unknown',
    },
  )
})

test('an empty model is empty, not resolved', () => {
  assert.deepEqual(store.resolvePiModel('  ', { models: MODELS, provider: 'commandcode' }), {
    model: '',
    providers: [],
    status: 'empty',
  })
})
