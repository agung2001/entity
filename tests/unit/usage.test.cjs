const test = require('node:test')
const assert = require('node:assert/strict')
const usage = require('../../electron/usage.cjs')

test('cost prefers the explicit usd field, then the usage cost table', () => {
  assert.equal(usage.costOf({ costUsd: 0.42 }), 0.42)
  assert.equal(usage.costOf({ usage: { cost: { total: 0.17 } } }), 0.17)
  assert.equal(usage.costOf({ usage: { input: 10 } }), 0)
  assert.equal(usage.costOf(null), 0)
})

test('tokens read the three shapes harnesses use', () => {
  assert.deepEqual(usage.usageOf({ usage: { input: 10, output: 4 } }), { input: 10, output: 4 })
  assert.deepEqual(usage.usageOf({ usage: { input_tokens: 7, output_tokens: 3 } }), {
    input: 7,
    output: 3,
  })
  assert.deepEqual(usage.usageOf({ usage: { prompt_tokens: 5, completion_tokens: 2 } }), {
    input: 5,
    output: 2,
  })
  assert.deepEqual(usage.usageOf({}), { input: 0, output: 0 })
})

test('a day is bucketed in local time', () => {
  const at = new Date(2026, 4, 9, 23, 30, 0)
  assert.equal(usage.localDay(at), '2026-05-09')
  assert.equal(usage.localDay(''), '')
})
