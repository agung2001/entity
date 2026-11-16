/**
 * A machine-bound MCP definition is stored, never silently enabled.
 *
 * `maka` at `http://127.0.0.1:4780/mcp` is a real server on the laptop that
 * wrote it. Synced into a container on another host, `127.0.0.1` is the
 * container, where nothing listens — so the pool shows it parked with a reason
 * instead of offering a server that cannot answer. A command inside
 * `/Users/<someone>/…` is the same class of bug.
 *
 * The definition still travels (a teammate may run the same service), and a
 * healthy remote URL is untouched.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/* `workspace-store` resolves ROOT at require time. */
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-machine-bound-'))
process.env.ENTITY_HOME = PROFILE

const manifest = require('../../electron/remote-manifest.cjs')
const workspaces = require('../../electron/workspace-store.cjs')
const serverSync = require('../../server/sync.cjs')
const remoteSync = require('../../electron/remote-sync.cjs')

const LAPTOP_SKILL = '/Users/someone/.entity/workspaces/team/skills/opendesign/bin/opendesign-mcp.sh'

function pool(servers, disabled = {}) {
  return { schema: 1, servers, disabled }
}

test('a loopback URL, and only that, is machine-bound', () => {
  assert.equal(manifest.machineBoundReason({ url: 'http://127.0.0.1:4780/mcp' }), 'loopback')
  assert.equal(manifest.machineBoundReason({ url: 'http://localhost:4790/mcp' }), 'loopback')
  assert.equal(manifest.machineBoundReason({ url: 'http://[::1]:4800/mcp' }), 'loopback')
  assert.equal(manifest.machineBoundReason({ url: 'http://host.docker.internal:4800/mcp' }), 'loopback')
  assert.equal(manifest.machineBoundReason({ url: 'https://mcp.notion.com/mcp' }), '')
  assert.equal(manifest.machineBoundReason({ url: 'https://youtrack.example.test/mcp' }), '')
})

test('a command inside a home directory is machine-bound; a normal one is not', () => {
  assert.equal(manifest.machineBoundReason({ command: LAPTOP_SKILL }), 'home-path')
  assert.equal(manifest.machineBoundReason({ command: '~/bin/mcp.sh' }), 'home-path')
  assert.equal(manifest.machineBoundReason({ command: '/home/ubuntu/run.sh' }), 'home-path')
  assert.equal(manifest.machineBoundReason({ command: 'npx', args: ['-y', 'search-mcp'] }), '')
  assert.equal(manifest.machineBoundReason({ command: '/usr/local/bin/gemini' }), '')
  assert.equal(
    manifest.machineBoundReason({ command: 'node', args: ['--root', '/srv/mcp/index.js'] }),
    '',
  )
})

test('the shared copy carries the marker and still redacts secrets', () => {
  const shared = manifest.sanitizeMcp(
    pool({
      maka: { url: 'http://127.0.0.1:4780/mcp', headers: { Authorization: 'Bearer secret' } },
      notion: { url: 'https://mcp.notion.com/mcp', headers: { Authorization: 'Bearer secret' } },
    }),
  )
  assert.equal(shared.servers.maka.machineLocal, 'loopback')
  assert.equal(shared.servers.maka.headers.Authorization, manifest.REDACTED)
  assert.equal(shared.servers.notion.machineLocal, undefined)
  assert.equal(JSON.stringify(shared).includes('Bearer secret'), false)
})

test('a pulled machine-bound server is parked, its portable neighbours are enabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-machine-bound-pull-'))
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify(pool({})))
  const record = { id: 'clone', label: 'clone', path: dir }

  const applied = remoteSync.applyRemoteMcp(
    record,
    pool({
      maka: { url: 'http://127.0.0.1:4780/mcp', machineLocal: 'loopback' },
      youtrack: { url: 'https://youtrack.example.test/mcp' },
    }),
  )

  const after = JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8'))
  assert.deepEqual(after.servers.youtrack, { url: 'https://youtrack.example.test/mcp' })
  assert.equal(after.servers.maka, undefined)
  assert.match(after.disabled.maka.__unavailable, /loopback/)
  assert.equal(after.disabled.maka.__remote, true)
  /* the marker belongs to the machine that shared it, never to this pool */
  assert.equal(after.disabled.maka.machineLocal, undefined)
  assert.deepEqual(applied.quarantined, ['maka'])
})

test('a machine-bound definition the machine already runs stays enabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-machine-bound-author-'))
  const own = { url: 'http://127.0.0.1:4780/mcp', headers: { Authorization: 'Bearer mine' } }
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify(pool({ maka: own })))
  const record = { id: 'author', label: 'author', path: dir }

  remoteSync.applyRemoteMcp(
    record,
    pool({ maka: { ...own, headers: { Authorization: '***' }, machineLocal: 'loopback' } }),
  )

  const after = JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8'))
  assert.ok(after.servers.maka, 'the author keeps the server it wrote')
  assert.equal(after.disabled.maka, undefined)
  /* the local secret survives the round trip through the redacted copy */
  assert.equal(after.servers.maka.headers.Authorization, 'Bearer mine')
})

test('the server parks a pushed machine-bound server instead of enabling it', () => {
  const record = workspaces.create({ label: 'machine-bound-server', skills: [] })
  const file = path.join(record.path, 'mcp.json')

  serverSync.applyMcp(
    record,
    pool({
      maka: { url: 'http://127.0.0.1:4780/mcp', headers: { Authorization: '***' }, machineLocal: 'loopback' },
      one: { url: 'http://127.0.0.1:4790/mcp' },
      opendesign: { command: LAPTOP_SKILL },
      youtrack: { url: 'https://youtrack.example.test/mcp', headers: { Authorization: '***' } },
    }),
  )

  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(Object.keys(after.servers).sort(), ['youtrack'])
  for (const name of ['maka', 'one', 'opendesign']) {
    assert.equal(after.disabled[name].__remote, true, `${name} is parked, not enabled`)
    assert.match(after.disabled[name].__unavailable, /machine that (set it up|shared it)/)
    assert.equal(after.disabled[name].machineLocal, undefined)
  }
})

test('an entry a person enabled on the server is pinned, and a push leaves it alone', () => {
  const record = workspaces.create({ label: 'machine-bound-pinned', skills: [] })
  const file = path.join(record.path, 'mcp.json')
  const definition = { url: 'http://127.0.0.1:4800/mcp' }

  serverSync.applyMcp(record, pool({ hyperframes: definition }))
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).servers.hyperframes, undefined)

  /* A person on that machine says "the service is here" — the enable is a pin. */
  const enabled = workspaces.setMcpEnabled({
    id: record.id,
    name: 'hyperframes',
    enabled: true,
  })
  assert.equal(enabled.servers.hyperframes.__pinned, true)
  assert.equal(enabled.disabled.hyperframes, undefined)

  serverSync.applyMcp(record, pool({ hyperframes: definition }))
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.ok(after.servers.hyperframes, 'a pinned server survives the next push')
})

test('the server repair pass parks what an older build enabled, and is idempotent', () => {
  const record = workspaces.create({ label: 'machine-bound-repair', skills: [] })
  const file = path.join(record.path, 'mcp.json')
  /* What the previous build wrote: enabled, no markers, nothing listening. */
  fs.writeFileSync(
    file,
    JSON.stringify(
      pool({
        maka: { url: 'http://127.0.0.1:4780/mcp' },
        opendesign: { command: LAPTOP_SKILL },
        youtrack: { url: 'https://youtrack.example.test/mcp' },
      }),
    ),
  )

  assert.deepEqual(serverSync.parkMachineBound(record), ['maka', 'opendesign'])
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(Object.keys(after.servers), ['youtrack'])
  assert.match(after.disabled.opendesign.__unavailable, /home directory/)

  assert.deepEqual(serverSync.parkMachineBound(record), [])
})
