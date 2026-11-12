const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

/* The server resolves its config file at require time. */
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-mcp-server-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('./workspace-store.cjs')
const server = require('./mcp-server.cjs')

function freePort() {
  return new Promise((resolve) => {
    const socket = net.createServer()
    socket.listen(0, '127.0.0.1', () => {
      const port = socket.address().port
      socket.close(() => resolve(port))
    })
  })
}

test('the MCP server authenticates and serves workspace tools', async (t) => {
  const workspace = workspaces.create({ label: 'mcp-server' })
  const port = await freePort()
  const started = await server.save({ enabled: true, port, allowWrite: false })
  t.after(() => server.stop())

  assert.equal(started.running, true)
  assert.equal(started.port, port)
  assert.equal(fs.statSync(server.CONFIG_FILE).mode & 0o777, 0o600)

  const headers = {
    authorization: `Bearer ${started.token}`,
    'content-type': 'application/json',
    accept: 'application/json',
  }
  const call = async (method, params = {}) => {
    const response = await fetch(started.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    return { status: response.status, body: await response.json() }
  }

  const blocked = await fetch(started.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  assert.equal(blocked.status, 401)

  const init = await call('initialize', {})
  assert.equal(init.body.result.serverInfo.name, 'entity')

  const listed = await call('tools/list')
  const names = listed.body.result.tools.map((tool) => tool.name)
  assert.ok(names.includes('list_workspaces'))
  assert.ok(names.includes('list_chats'))
  assert.ok(names.includes('create_entity'))

  const spaces = await call('tools/call', { name: 'list_workspaces', arguments: {} })
  assert.equal(spaces.body.result.isError, false)
  assert.equal(JSON.parse(spaces.body.result.content[0].text)[0].id, workspace.id)

  const denied = await call('tools/call', {
    name: 'create_entity',
    arguments: { workspace: workspace.id, name: 'from-mcp', description: 'Reads the repo.' },
  })
  assert.equal(denied.body.result.isError, true)

  await server.save({ allowWrite: true })
  const created = await call('tools/call', {
    name: 'create_entity',
    arguments: {
      workspace: workspace.id,
      name: 'from-mcp',
      description: 'Reads the repo.',
      instructions: '# from-mcp\n\nReads the repo.',
    },
  })
  assert.equal(created.body.result.isError, false)
  assert.equal(JSON.parse(created.body.result.content[0].text).name, 'from-mcp')
  assert.equal(fs.existsSync(path.join(workspace.path, 'entities', 'from-mcp.md')), true)
})
