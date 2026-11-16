/**
 * MCP is a per-run config, not a global setting, so these are the things that
 * must stay true:
 *
 *   1. The workspace owns the pool; every turn gets all of it. An entity file
 *      cannot narrow it or opt out — a leftover `mcp:` line is inert.
 *   2. `env` on disk is a list of names; the value only exists in the written
 *      file, which is 0600 and deleted when the process ends.
 *   3. A server that cannot be built is reported, never half-written.
 *   4. A harness without a per-run config says so instead of pretending.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

/* `workspace-store` resolves ROOT at require time, so this has to come first. */
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-mcp-'))
process.env.ENTITY_HOME = PROFILE
process.env.ENTITY_TEST_TOKEN = 'sekret-value'

const workspaces = require('../../electron/workspace-store.cjs')
const entities = require('../../electron/entity-store.cjs')
const runtime = require('../../electron/mcp-runtime.cjs')

let seq = 0

function scaffold(servers) {
  const created = workspaces.create({ label: `mcp-${++seq}` })
  workspaces.writeMcp({ id: created.id, servers, disabled: {} })
  entities.scaffold({ workspace: created.id, name: 'py-agent', harness: 'claude' })
  return { record: workspaces.open(created.id), entity: entities.read(created.id, 'py-agent') }
}

const pool = {
  github: {
    command: 'npx',
    args: ['-y', 'server-github', '--token', '${ENTITY_TEST_TOKEN}'],
    env: ['ENTITY_TEST_TOKEN'],
  },
}

test('every turn gets the whole workspace pool', () => {
  const { record } = scaffold(pool)
  const out = runtime.materialise({ record, harness: 'claude' })
  try {
    assert.deepEqual(out.servers, ['github'])
    assert.equal(out.files.length, 1)
  } finally {
    out.cleanup()
  }
})

test('a leftover mcp: line in an entity file cannot narrow the pool', () => {
  const two = {
    ...pool,
    linear: { command: 'npx', args: ['-y', 'mcp-linear'] },
  }
  const { record } = scaffold(two)
  const nocase = { record, harness: 'claude' }
  const out = runtime.materialise(nocase)
  try {
    /* both servers, even though an older file in this workspace said `linear`
       or `none`: the pool is the workspace's, and the entity is not consulted */
    assert.deepEqual(out.servers, ['github', 'linear'])
    const doc = JSON.parse(fs.readFileSync(out.files[0], 'utf8'))
    assert.deepEqual(Object.keys(doc.mcpServers).sort(), ['github', 'linear'])
  } finally {
    out.cleanup()
  }
})

test('`only` is the one narrow path, and it is never entity-driven', () => {
  const two = { ...pool, linear: { command: 'npx', args: ['-y', 'mcp-linear'] } }
  const { record } = scaffold(two)
  const out = runtime.materialise({ record, harness: 'claude', only: 'linear' })
  try {
    assert.deepEqual(out.servers, ['linear'])
  } finally {
    out.cleanup()
  }
})

test('an inline definition is copied, not looked up in the environment', () => {
  const inline = {
    youtrack: {
      url: 'https://yt.example/mcp',
      headers: { Authorization: 'Bearer pasted-value' },
      env: { YT_MODE: 'inline' },
    },
  }
  const { record } = scaffold(inline)
  const out = runtime.materialise({ record, harness: 'claude' })
  try {
    const doc = JSON.parse(fs.readFileSync(out.files[0], 'utf8'))
    assert.equal(doc.mcpServers.youtrack.headers.Authorization, 'Bearer pasted-value')
    assert.deepEqual(doc.mcpServers.youtrack.env, { YT_MODE: 'inline' })
  } finally {
    out.cleanup()
  }
})

test('a named server becomes a strict, secret-bearing config file', () => {
  const { record } = scaffold(pool, ['github'])
  const out = runtime.materialise({ record, harness: 'claude' })
  try {
    assert.deepEqual(out.servers, ['github'])
    assert.equal(out.argv[0], '--mcp-config')
    assert.ok(out.argv.includes('--strict-mcp-config'))
    assert.equal(out.files.length, 1)

    const file = out.files[0]
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.deepEqual(Object.keys(doc.mcpServers), ['github'])
    /* the name became a value, and the placeholder was expanded */
    assert.equal(doc.mcpServers.github.env.ENTITY_TEST_TOKEN, 'sekret-value')
    assert.equal(doc.mcpServers.github.args[3], 'sekret-value')
    /* 0600 is a POSIX permission bit; Windows has no equivalent. */
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    }
  } finally {
    const file = out.files[0]
    out.cleanup()
    assert.equal(fs.existsSync(file), false)
  }
})

test('a server that is not in the pool is reported, not invented', () => {
  /* `only` names one server explicitly — an `@mcp:` attachment in a prompt —
     and a name the workspace does not have is said out loud. */
  const { record } = scaffold(pool)
  const out = runtime.materialise({ record, harness: 'claude', only: 'ghost' })
  try {
    assert.deepEqual(out.servers, [])
    assert.match(out.notes.join(' '), /ghost.*not in this workspace's MCP pool/)
  } finally {
    out.cleanup()
  }
})

test('a server whose secret is missing is skipped with a reason', () => {
  const broken = {
    linear: { command: 'npx', args: ['-y', 'mcp-linear'], env: ['ENTITY_MISSING_TOKEN'] },
  }
  const { record } = scaffold(broken, ['linear'])
  const out = runtime.materialise({ record, harness: 'claude' })
  assert.deepEqual(out.files, [])
  assert.deepEqual(out.argv, [])
  assert.match(out.notes.join(' '), /linear needs ENTITY_MISSING_TOKEN/)
})

test('opencode gets its own shape through the environment, not argv', () => {
  const { record } = scaffold(pool, ['github'])
  const out = runtime.materialise({ record, harness: 'opencode' })
  try {
    assert.deepEqual(out.argv, [])
    assert.equal(out.env.OPENCODE_CONFIG, out.files[0])
    const doc = JSON.parse(fs.readFileSync(out.files[0], 'utf8'))
    assert.equal(doc.mcp.github.type, 'local')
    assert.deepEqual(doc.mcp.github.command.slice(0, 2), ['npx', '-y'])
    assert.equal(doc.mcp.github.enabled, true)
    assert.equal(doc.mcp.github.environment.ENTITY_TEST_TOKEN, 'sekret-value')
  } finally {
    out.cleanup()
  }
})

test('an unknown harness is reported instead of guessed at', () => {
  const { record } = scaffold(pool, ['github'])
  const out = runtime.materialise({ record, harness: 'vim' })
  assert.deepEqual(out.files, [])
  assert.deepEqual(out.servers, [])
  assert.match(out.notes.join(' '), /vim has no known MCP configuration surface/)
})

test('codex gets -c overrides, with the bearer handed over as an env var', () => {
  const servers = {
    github: { command: 'npx', args: ['-y', 'server-github'] },
    yt: { url: 'https://yt.example/mcp', headers: { Authorization: 'Bearer tok-1' } },
  }
  const { record } = scaffold(servers)
  const out = runtime.materialise({ record, harness: 'codex' })
  assert.deepEqual(out.servers, ['github', 'yt'])
  assert.deepEqual(out.files, [])
  assert.ok(out.argv.includes('mcp_servers.github.command="npx"'))
  assert.ok(out.argv.includes('mcp_servers.github.args=["-y","server-github"]'))
  assert.ok(out.argv.includes('mcp_servers.yt.url="https://yt.example/mcp"'))
  assert.ok(out.argv.includes('mcp_servers.yt.bearer_token_env_var="ENTITY_MCP_YT_TOKEN"'))
  /* the token travels in the environment, never in the process list */
  assert.equal(out.env.ENTITY_MCP_YT_TOKEN, 'tok-1')
  assert.equal(out.argv.join(' ').includes('tok-1'), false)
})

test('pi >= 0.99 gets a generated extension and keeps its agent dir untouched', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-home-'))
  const agent = path.join(home, '.pi', 'agent')
  fs.mkdirSync(agent, { recursive: true })
  fs.writeFileSync(path.join(agent, 'mcp.json'), '{"mcpServers":{}}', 'utf8')

  const { record } = scaffold(pool)
  const out = runtime.materialise({ record, harness: 'pi', home, piVersion: '1.3.0' })
  try {
    assert.deepEqual(out.servers, ['github'])
    /* an extension, not a config dir */
    assert.equal(out.env.PI_CODING_AGENT_DIR, undefined)
    assert.equal(out.argv[0], '--extension')
    const file = out.argv[1]
    assert.match(file, /\.mjs$/)
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    }
    const script = fs.readFileSync(file, 'utf8')
    assert.match(script, /registerMcpServer/)
    assert.match(script, /server-github/)
    /* the payload is a JSON string literal, so a token cannot break the file */
    assert.match(script, /JSON\.parse\("/)
  } finally {
    out.cleanup()
    assert.equal(fs.existsSync(out.argv[1]), false)
  }
})

test('pi before 0.99 falls back to a mirrored agent dir with a merged mcp.json', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-home-'))
  const agent = path.join(home, '.pi', 'agent')
  fs.mkdirSync(agent, { recursive: true })
  fs.writeFileSync(path.join(agent, 'auth.json'), '{"token":"x"}', 'utf8')
  fs.writeFileSync(
    path.join(agent, 'mcp.json'),
    JSON.stringify({ mcpServers: { mine: { command: 'echo', args: ['mine'] } } }),
    'utf8',
  )

  const { record } = scaffold(pool)
  const out = runtime.materialise({ record, harness: 'pi', home, piVersion: '0.98.0' })
  try {
    assert.deepEqual(out.servers, ['github'])
    assert.deepEqual(out.argv, [])
    const dir = out.env.PI_CODING_AGENT_DIR
    assert.ok(dir, 'PI_CODING_AGENT_DIR is set')
    /* the user's own server stays, the pool is merged in */
    const merged = JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8'))
    assert.deepEqual(Object.keys(merged.mcpServers).sort(), ['github', 'mine'])
    /* auth is symlinked through, not copied. Creating a symlink needs a
       privilege Windows does not grant by default, so the mirror falls back to
       leaving it out (see `mirror`). */
    if (process.platform !== 'win32') {
      assert.equal(fs.lstatSync(path.join(dir, 'auth.json')).isSymbolicLink(), true)
    }
  } finally {
    out.cleanup()
    assert.equal(fs.existsSync(out.env.PI_CODING_AGENT_DIR || '/nonexistent'), false)
  }
})

test('gemini runs from a mirrored home and is told to trust the folder', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-home-'))
  const conf = path.join(home, '.gemini')
  fs.mkdirSync(conf, { recursive: true })
  fs.writeFileSync(
    path.join(conf, 'settings.json'),
    JSON.stringify({ theme: 'dark', mcpServers: { mine: { command: 'echo' } } }),
    'utf8',
  )

  const { record } = scaffold(pool)
  const out = runtime.materialise({ record, harness: 'gemini', home })
  try {
    assert.deepEqual(out.servers, ['github'])
    assert.ok(out.argv.includes('--skip-trust'))
    const dir = out.env.GEMINI_CLI_HOME
    const settings = JSON.parse(fs.readFileSync(path.join(dir, '.gemini', 'settings.json'), 'utf8'))
    assert.equal(settings.theme, 'dark') /* unrelated keys survive */
    assert.deepEqual(Object.keys(settings.mcpServers).sort(), ['github', 'mine'])
  } finally {
    out.cleanup()
  }
})

test('a config file left by a killed turn is pruned', () => {
  const { record } = scaffold(pool, ['github'])
  const runs = path.join(record.path, 'runs')
  fs.mkdirSync(runs, { recursive: true })
  const stale = path.join(runs, '.mcp-stale.json')
  fs.writeFileSync(stale, '{}', 'utf8')
  const old = (Date.now() - 48 * 60 * 60 * 1000) / 1000
  fs.utimesSync(stale, old, old)

  const out = runtime.materialise({ record, harness: 'claude' })
  try {
    assert.equal(fs.existsSync(stale), false)
  } finally {
    out.cleanup()
  }
})
