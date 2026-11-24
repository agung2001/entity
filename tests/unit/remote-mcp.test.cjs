/**
 * The workspace MCP set on a turn that runs elsewhere.
 *
 * A loopback server cannot be reached by name on the far side, so the turn opens
 * an ssh reverse tunnel and hands the harness the tunnel's port. A stdio server is
 * a program on this machine and cannot travel at all — it is named, never silently
 * dropped.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-remote-mcp-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('../../electron/workspace-store.cjs')
const remoteMcp = require('../../electron/remote-mcp.cjs')

let n = 0
function workspace(servers) {
  const record = workspaces.create({ label: `remote-mcp-${++n}`, skills: [] })
  fs.writeFileSync(
    path.join(record.path, 'mcp.json'),
    JSON.stringify({ schema: 1, servers, disabled: {} }),
  )
  return record
}

function stageDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'entity-remote-stage-'))
}

test('a loopback server gets a forward and a URL on the tunnel port', () => {
  const record = workspace({
    maka: {
      url: 'http://127.0.0.1:4780/mcp',
      headers: { Authorization: 'Bearer local-secret' },
    },
  })
  const stage = stageDir()
  const plan = remoteMcp.plan({ record, harness: 'pi', stage, remoteDir: '/remote/run' })

  assert.deepEqual(plan.servers, ['maka'])
  assert.equal(plan.forwards.length, 1)
  const forward = plan.forwards[0]
  assert.equal(forward.localPort, 4780)
  /* the port is not rewritten: the server's Host check is 127.0.0.1:4780 */
  assert.equal(forward.remotePort, 4780)
  assert.equal(forward.spec, '127.0.0.1:4780:127.0.0.1:4780')

  const extension = fs.readFileSync(path.join(stage, 'mcp', 'pi.mjs'), 'utf8')
  assert.match(extension, /127\.0\.0\.1:4780/)
  assert.match(extension, /local-secret/)
  /* the token stays on this machine: it goes to the harness config, never to the
     ssh command line where `ps` would show it */
  assert.equal(plan.argv.join(' ').includes('local-secret'), false)
})

test('a real host passes through unchanged, and a stdio server is named', () => {
  const record = workspace({
    notion: { url: 'https://mcp.example.test/mcp' },
    opendesign: { command: '/Users/someone/opendesign-mcp.sh' },
  })
  const plan = remoteMcp.plan({ record, harness: 'claude', stage: stageDir(), remoteDir: '/r' })

  assert.deepEqual(plan.servers, ['notion'])
  assert.equal(plan.forwards.length, 0)
  assert.match(plan.notes.join(' '), /opendesign.*local program/)
  const config = JSON.parse(fs.readFileSync(path.join(plan.files[0]), 'utf8'))
  assert.equal(config.mcpServers.notion.url, 'https://mcp.example.test/mcp')
})

test('opencode takes the config by env and codex by argv; neither prints the token', () => {
  const record = workspace({
    maka: { url: 'http://localhost:4780/mcp', headers: { Authorization: 'Bearer s3cret' } },
  })

  const opencode = remoteMcp.plan({ record, harness: 'opencode', stage: stageDir(), remoteDir: '/r' })
  assert.equal(opencode.env.OPENCODE_CONFIG, '/r/mcp/opencode.json')
  assert.equal(JSON.stringify(opencode).includes('s3cret'), false)

  const codex = remoteMcp.plan({ record, harness: 'codex', stage: stageDir(), remoteDir: '/r' })
  assert.ok(codex.argv.includes('-c'))
  assert.match(codex.env.ENTITY_MCP_MAKA_TOKEN, /^s3cret$/)
  assert.equal(codex.argv.join(' ').includes('s3cret'), false)
})

test('a remote port already in use means that server stays behind', () => {
  const record = workspace({ maka: { url: 'http://127.0.0.1:4780/mcp' } })
  const plan = remoteMcp.plan({
    record,
    harness: 'pi',
    stage: stageDir(),
    remoteDir: '/r',
    alias: 'box',
    busyPorts: new Set([4780]),
  })
  assert.deepEqual(plan.servers, [])
  assert.equal(plan.forwards.length, 0)
  assert.match(plan.notes.join(' '), /box already listens on port 4780/)
})

test('a harness with no writable surface gets a note, not a silent promise', () => {
  const record = workspace({ maka: { url: 'http://127.0.0.1:4780/mcp' } })
  const plan = remoteMcp.plan({ record, harness: 'gemini', stage: stageDir(), remoteDir: '/r' })
  assert.deepEqual(plan.servers, [])
  assert.match(plan.notes.join(' '), /gemini has no MCP configuration surface/)
})

test('no pool means nothing to send', () => {
  const record = workspaces.create({ label: 'remote-mcp-empty', skills: [] })
  const plan = remoteMcp.plan({ record, harness: 'pi', stage: stageDir(), remoteDir: '/r' })
  assert.deepEqual(plan.servers, [])
  assert.equal(plan.forwards.length, 0)
})
