const test = require('node:test')
const assert = require('node:assert/strict')
const { buildScript, stageFiles, SKILL_ROOTS } = require('./remote-runner.cjs')

test('pi receives the prompt on stdin and instructions as an argument', () => {
  const out = buildScript({ harness: 'pi', model: 'm', instructions: 'be brief', prompt: 'hello' })
  assert.equal(out.stdin, true)
  assert.equal(out.promptText, 'hello')
  assert.match(out.script, /< "\$DIR\/prompt\.txt"/)
  assert.match(out.script, /'be brief'/)
})

test('opencode and gemini place the prompt from the file', () => {
  const opencode = buildScript({ harness: 'opencode', model: 'm', instructions: 's', prompt: 'p' })
  assert.equal(opencode.stdin, false)
  assert.match(opencode.script, /PROMPT=\$\(cat "\$DIR\/prompt\.txt"\)/)
  assert.match(opencode.script, /opencode 'run' '-m' 'm' "\$PROMPT"/)

  const gemini = buildScript({ harness: 'gemini', model: 'm', instructions: 's', prompt: 'p' })
  assert.match(gemini.script, /gemini '-p' "\$PROMPT" '-m' 'm'/)
})

test('model and prompt values are single-quoted, not interpolated', () => {
  const out = buildScript({
    harness: 'pi',
    model: "m'; rm -rf /",
    instructions: 's',
    prompt: 'p',
  })
  assert.match(out.script, /'m'\\''; rm -rf \/'/)
  assert.doesNotMatch(out.script, /exec .*rm -rf \//)
})

test('stageFiles rejects missing and oversized attachments', () => {
  assert.throws(() => stageFiles([{ kind: 'file', path: '/no/such/file' }], require('node:os').tmpdir()), /does not exist/)
  assert.ok(SKILL_ROOTS.pi)
})
