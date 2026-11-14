/**
 * The evaluator's parser is the boundary between "a model said something" and
 * "a finding we can act on". These pin the cases that matter: JSON in fences,
 * the plain-text safe answer, malformed output (an error, never safe), and
 * redaction of anything that looks like a credential.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const review = require('../../electron/harness-review.cjs')

test('a JSON answer becomes findings', () => {
  const findings = review.parseAnswer(
    '{"findings":[{"path":"entities/a.md","severity":"high","reason":"asks for the ssh key"}]}',
  )
  assert.deepEqual(findings, [
    { path: 'entities/a.md', severity: 'high', reason: 'asks for the ssh key' },
  ])
})

test('JSON inside a fence is still read', () => {
  const findings = review.parseAnswer(
    'Here you go:\n```json\n{"findings":[{"path":"artifacts/x","severity":"medium","reason":"webhook"}]}\n```',
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].severity, 'medium')
})

test('a plain safe answer is an empty result', () => {
  assert.deepEqual(review.parseAnswer('SAFE'), [])
  assert.deepEqual(review.parseAnswer('{"findings":[]}'), [])
  assert.deepEqual(review.parseAnswer('{"safe":true}'), [])
})

test('malformed or empty output is an error, not a pass', () => {
  assert.throws(() => review.parseAnswer(''), /no output/)
  assert.throws(() => review.parseAnswer('looks fine to me'), /JSON/)
  assert.throws(() => review.parseAnswer('{"findings": "none"}'), /findings array/)
  assert.throws(() => review.parseAnswer('{"findings": ['), /JSON/)
})

test('unknown severities become medium and long tokens are redacted', () => {
  const findings = review.parseAnswer(
    JSON.stringify({
      findings: [
        {
          path: 'entities/a.md',
          severity: 'critical',
          reason: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 should not be stored',
        },
      ],
    }),
  )
  assert.equal(findings[0].severity, 'medium')
  assert.match(findings[0].reason, /\[redacted\]/)
  assert.equal(findings[0].reason.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), false)
})

test('the prompt keeps paths and skips binary files', () => {
  const text = review.buildPrompt([
    { path: 'entities/a.md', buffer: Buffer.from('hello') },
    { path: 'artifacts/logo.png', buffer: Buffer.from([0x89, 0x50, 0x00, 0x01]) },
  ])
  assert.match(text, /### entities\/a\.md/)
  assert.match(text, /hello/)
  assert.equal(text.includes('artifacts/logo.png'), false)
})
