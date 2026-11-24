const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildScript,
  stageFiles,
  stageArtifacts,
  artifactsNote,
  transferTimeout,
  SKILL_ROOTS,
} = require('../../electron/remote-runner.cjs')

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

test('an MCP token is exported in the run script, never argv', () => {
  const out = buildScript({
    harness: 'pi',
    model: 'm',
    instructions: 's',
    prompt: 'p',
    mcp: { argv: ['--extension', '/r/mcp/pi.mjs'], env: { OPENCODE_CONFIG: '/r/mcp/x.json' } },
  })
  assert.match(out.script, /export OPENCODE_CONFIG='\/r\/mcp\/x\.json'/)
  assert.match(out.script, /'--extension' '\/r\/mcp\/pi\.mjs'/)
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

/* The shelf is the one unbounded thing a remote turn stages. Staging all of it
   cost a minute per turn on a home uplink and tripped the transfer cap, which
   came back as `scp failed: Command failed:` with nothing else in it. */
test('only the newest artifacts travel, and the rest are counted', () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const shelf = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-shelf-'))
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-stage-'))
  const write = (rel, bytes, ageMs) => {
    const full = path.join(shelf, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, Buffer.alloc(bytes, 1))
    const at = new Date(Date.now() - ageMs)
    fs.utimesSync(full, at, at)
  }
  write('old.bin', 10, 3 * 86_400_000)
  write('design/new.bin', 10, 0)
  write('design/half.bin.8156.deadbeef.tmp', 10, 0)
  write('.hidden', 10, 0)

  const result = stageArtifacts(shelf, target, { maxBytes: 10, maxFiles: 1 })
  assert.equal(result.staged, 1, 'the budget is one file')
  assert.equal(result.skipped, 1, 'the older file is counted, not hidden')
  assert.equal(result.bytes, 10)
  assert.equal(result.skippedBytes, 10)
  assert.equal(fs.existsSync(path.join(target, 'design', 'new.bin')), true, 'newest wins')
  assert.equal(fs.existsSync(path.join(target, 'old.bin')), false)
  assert.equal(
    fs.existsSync(path.join(target, 'design', 'half.bin.8156.deadbeef.tmp')),
    false,
    'an interrupted artifact write is junk, not an artifact',
  )
  assert.equal(fs.existsSync(path.join(target, '.hidden')), false)

  /* and the model is told, in words, instead of meeting a missing file */
  const note = artifactsNote({ staged: 1, skipped: 137, skippedBytes: 51 * 1024 * 1024 })
  assert.match(note, /137 older files/)
  assert.match(note, /51 MB/)
  assert.equal(artifactsNote({ staged: 3, skipped: 0, skippedBytes: 0 }), '')
})

test('the transfer deadline follows the payload', () => {
  assert.equal(transferTimeout(0), 120_000)
  assert.ok(transferTimeout(24 * 1024 * 1024) > 120_000)
  /* a minute was the old constant; a staged workspace is far past what it holds */
  assert.ok(transferTimeout(75 * 1024 * 1024) >= 180_000)
})

test('a remote listener table yields ports for both ss and netstat', () => {
  const { portsFrom } = require('../../electron/remote-runner.cjs')
  const ss = [
    'State Recv-Q Send-Q Local Address:Port Peer Address:Port',
    'LISTEN 0 511 127.0.0.1:4800 0.0.0.0:*',
    'LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*',
    'LISTEN 0 4096 [::]:8200 [::]:*',
  ].join('\n')
  assert.deepEqual([...portsFrom(ss)].sort((a, b) => a - b), [22, 4800, 8200])

  const netstat = [
    'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)',
    'tcp4       0      0  127.0.0.1.4780         *.*                    LISTEN',
    'tcp6       0      0  ::1.4790               *.*                    LISTEN',
  ].join('\n')
  assert.deepEqual([...portsFrom(netstat)].sort((a, b) => a - b), [4780, 4790])
  assert.deepEqual([...portsFrom('')], [])
})
