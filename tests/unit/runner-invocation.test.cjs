/**
 * How an MCP runtime is folded into a harness argv. This is a one-line contract
 * with a real failure mode behind it: handing `withMcp` the whole spec instead
 * of its argv broke every chat turn, and no unit test noticed until an
 * end-to-end run.
 */
const test = require('node:test')
const assert = require('node:assert/strict')

process.env.ENTITY_HOME = '/tmp/entity-invocation-test'

const { chatInvocation, invocation } = require('../../electron/runner-local.cjs')

const claudeMcp = {
  servers: ['youtrack'],
  argv: ['--mcp-config', '/tmp/mcp.json', '--strict-mcp-config'],
  env: {},
  notes: [],
}

test('claude appends the MCP flags after its own', () => {
  const spec = chatInvocation('claude', 'sys', 'prompt', 'sonnet', claudeMcp)
  assert.deepEqual(spec.argv.slice(-3), claudeMcp.argv)
  assert.equal(spec.argv[0], '-p')
  assert.equal(spec.argv.indexOf('--model') >= 0, true)
})

test('codex keeps its -c overrides before the positional prompt', () => {
  const spec = chatInvocation('codex', 'sys', 'prompt', '', { argv: ['-c', 'k=v'] })
  assert.deepEqual(spec.argv.slice(0, 3), ['exec', '-c', 'k=v'])
  assert.equal(spec.argv[3], '-')
})

test('no MCP runtime leaves the argv exactly as it was', () => {
  const spec = chatInvocation('claude', 'sys', 'prompt', '')
  assert.deepEqual(spec.argv, ['-p', '--append-system-prompt', 'sys', '--output-format', 'stream-json', '--verbose'])
  /* and the entity-run shape, which shares the helper */
  const run = invocation('pi', 'sys', 'prompt', '')
  assert.deepEqual(run.argv, ['-p', '--append-system-prompt', 'sys'])
})

test('an empty runtime is not a reason to return the spec instead of argv', () => {
  const empty = { servers: [], argv: [], env: {}, notes: [] }
  const spec = chatInvocation('claude', 'sys', 'prompt', '', empty)
  assert.equal(Array.isArray(spec.argv), true)
  assert.equal(spec.argv.includes('--mcp-config'), false)
})
