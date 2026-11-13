const test = require('node:test')
const assert = require('node:assert/strict')
const { extract } = require('./attachment-ref.cjs')

test('extracts file and MCP attachments out of the prompt', () => {
  const out = extract('read @file:docs/brief.md then use @mcp:youtrack please')
  assert.equal(out.text, 'read then use please')
  assert.deepEqual(out.attachments, [
    { kind: 'file', value: 'docs/brief.md' },
    { kind: 'mcp', value: 'youtrack' },
  ])
})

test('quoted file paths survive spaces, duplicate tokens collapse', () => {
  const out = extract('@file:"docs/my brief.md" @file:"docs/my brief.md" @mcp:one @mcp:one')
  assert.deepEqual(out.attachments, [
    { kind: 'file', value: 'docs/my brief.md' },
    { kind: 'mcp', value: 'one' },
  ])
  assert.equal(out.text, '')
})

test('ordinary @mentions and prose are left alone', () => {
  const out = extract('@chief-of-staff summarize @artifact:shot and @maka:plan')
  assert.equal(out.text, '@chief-of-staff summarize @artifact:shot and @maka:plan')
  assert.deepEqual(out.attachments, [])
})
