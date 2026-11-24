/**
 * A shipped MCP connector is built in even before anybody adopts it.
 *
 * `maka` was a real server in `mcp.json` and a real entry in the catalog, but the
 * roster only knew how to call an integration row or a catalog-installed index
 * row. So a workspace whose `mcp.json` already held Maka saw it as an unmanaged
 * pool server: a generic initial instead of the app's mark, no `built in` origin,
 * and an `Adopt` verb for a definition the app already ships.
 *
 * The catalog entry also carries the service's own site, which the connector page
 * shows beside the transport. It is data, not a second list in the renderer.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-builtin-maka-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('../../electron/workspace-store.cjs')
const connectorStore = require('../../electron/connector-store.cjs')
const catalog = require('../../electron/connector-catalog.cjs')

test('the catalog ships Maka with its own site and mark id', () => {
  const entry = catalog.entryOf('maka')
  assert.equal(entry.label, 'Maka')
  assert.equal(entry.kind, 'mcp')
  assert.equal(entry.website, 'https://maka.agungsundoro.com')
  assert.equal(catalog.websiteOf('maka'), 'https://maka.agungsundoro.com')
  assert.equal(catalog.websiteOf('youtrack'), '')

  const listed = catalog.entries().find((row) => row.id === 'maka')
  assert.equal(listed.website, 'https://maka.agungsundoro.com')
  assert.equal(catalog.workOf('maka').website, 'https://maka.agungsundoro.com')
})

test('a pool server the catalog ships reads as built in, not unmanaged', () => {
  const record = workspaces.create({ label: 'builtin-maka', skills: [] })
  fs.writeFileSync(
    path.join(record.path, 'mcp.json'),
    JSON.stringify({
      schema: 1,
      servers: { maka: { url: 'http://127.0.0.1:4780/mcp' } },
      disabled: {},
    }),
  )

  const row = connectorStore.list({ workspace: record.id }).rows.find((entry) => entry.id === 'maka')
  assert.ok(row, 'maka is in the roster')
  assert.equal(row.label, 'Maka')
  assert.equal(row.builtIn, 'maka', 'the shipped mark is what the roster and page draw')
  assert.equal(row.website, 'https://maka.agungsundoro.com')
  assert.equal(row.managed, true)
  assert.equal(row.unmanaged, false, 'a shipped connector is not something to adopt')
  assert.equal(row.mention, '@maka:')
  assert.equal(row.work.resolver, 'maka')
})

test('a pool server nobody ships stays unmanaged and has no site', () => {
  const record = workspaces.create({ label: 'builtin-private', skills: [] })
  fs.writeFileSync(
    path.join(record.path, 'mcp.json'),
    JSON.stringify({
      schema: 1,
      servers: { 'my-private-server': { url: 'https://mcp.example.test/mcp' } },
      disabled: {},
    }),
  )

  const row = connectorStore
    .list({ workspace: record.id })
    .rows.find((entry) => entry.id === 'my-private-server')
  assert.equal(row.builtIn, '')
  assert.equal(row.website, '')
  assert.equal(row.unmanaged, true)
})

test('a built-in with no index row can still be uninstalled', () => {
  const record = workspaces.create({ label: 'builtin-uninstall', skills: [] })
  fs.writeFileSync(
    path.join(record.path, 'mcp.json'),
    JSON.stringify({
      schema: 1,
      servers: { maka: { url: 'http://127.0.0.1:4780/mcp' } },
      disabled: {},
    }),
  )

  const after = connectorStore.uninstall({ workspace: record.id, id: 'maka' })
  assert.equal(after.rows.some((row) => row.id === 'maka'), false)
  const pool = JSON.parse(fs.readFileSync(path.join(record.path, 'mcp.json'), 'utf8'))
  assert.equal(pool.servers.maka, undefined)
  /* the catalog gets it back as an installable card */
  assert.ok(after.available.some((row) => row.id === 'maka'))
})
