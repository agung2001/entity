/**
 * Transfer is one file out and one file in. These tests use a throwaway
 * ENTITY_HOME (set before the stores are required) so they never see a real
 * workspace or a real Downloads folder.
 */
process.env.ENTITY_HOME = require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'entity-transfer-'),
)

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const workspaces = require('../../electron/workspace-store.cjs')
const transfer = require('../../electron/transfer-store.cjs')

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-transfer-out-'))
const PASS = 'correct horse battery'

let nextLabel = 0

/** A fresh record with no files beyond what the harness creates, so a diff has
 *  somewhere empty to land. */
function emptyWorkspace() {
  nextLabel += 1
  return workspaces.create({ label: `transfer-test-${nextLabel}`, seed: false })
}

function makeWorkspace() {
  nextLabel += 1
  const record = workspaces.create({ label: `transfer-test-${nextLabel}`, seed: false })
  const file = (rel, value) => {
    const full = path.join(record.path, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, value)
    return full
  }
  file('entities/agent.md', '---\nname: agent\nharness: pi\ndir: /tmp\n---\n\nBe brief.\n')
  file('chats/t1.json', JSON.stringify({ schema: 1, id: 't1', messages: [] }))
  file('artifacts/note.txt', 'a note')
  file('mcp.json', JSON.stringify({ schema: 1, servers: { youtrack: { url: 'https://example.test/mcp', headers: { Authorization: 'Bearer real-token-123' } } } }))
  return { record, file }
}

const bytes = (base) => fs.readFileSync(path.join(OUT, base)).toString('base64')

test('agents preset travels as readable JSON and never claims a secret', async () => {
  const { record } = makeWorkspace()
  const sent = await transfer.send({ workspace: record.id, preset: 'agents', directory: OUT })
  assert.match(sent.filename, /\.entity\.json$/)
  assert.equal(sent.sealed, false)

  const bundle = JSON.parse(fs.readFileSync(path.join(OUT, sent.filename), 'utf8'))
  assert.equal(bundle.schema, 1)
  assert.equal(bundle.kind, 'entity.transfer')
  assert.equal(bundle.secrets, 'none')
  assert.equal(bundle.sealed, false)
  assert.ok(Object.keys(bundle.files).some((rel) => rel.startsWith('entities/')))
  assert.ok(!Object.keys(bundle.files).some((rel) => rel.startsWith('chats/')))
  assert.equal(bundle.mcp, null)
})

test('connections redacts every value and keeps the token home', async () => {
  const { record } = makeWorkspace()
  const sent = await transfer.send({ workspace: record.id, preset: 'connections', directory: OUT })
  const bundle = JSON.parse(fs.readFileSync(path.join(OUT, sent.filename), 'utf8'))
  assert.equal(bundle.secrets, 'none')
  assert.equal(bundle.mcp.servers.youtrack.headers.Authorization, '***')
  assert.equal(transfer.hasRedacted(bundle.mcp.servers.youtrack), true)
  assert.ok(!JSON.stringify(bundle.files).includes('real-token-123'))
})

test('a credential forces a sealed zip and a passphrase of at least 12 characters', async () => {
  const { record } = makeWorkspace()
  await assert.rejects(
    transfer.send({ workspace: record.id, preset: 'connections', includeCredentials: true, directory: OUT }),
    /must be sealed/,
  )
  await assert.rejects(
    transfer.send({
      workspace: record.id,
      preset: 'connections',
      includeCredentials: true,
      passphrase: 'short',
      directory: OUT,
    }),
    /at least 12 characters/,
  )

  const sent = await transfer.send({
    workspace: record.id,
    preset: 'connections',
    includeCredentials: true,
    passphrase: PASS,
    directory: OUT,
  })
  assert.match(sent.filename, /\.entity\.zip$/)
  assert.equal(sent.sealed, true)

  const raw = bytes(sent.filename)
  const sealedOnly = await transfer.read({ filename: sent.filename, data: raw, passphrase: PASS })
  assert.equal(sealedOnly.mcp.servers.youtrack.headers.Authorization, 'Bearer real-token-123')

  const wrong = await transfer
    .read({ filename: sent.filename, data: raw, passphrase: 'wrong passphrase here' })
    .then(() => null)
    .catch((error) => error)
  assert.equal(wrong.code, 'passphrase')
  assert.match(wrong.message, /2 tries left/)
})

test('the reader refuses a file that lies about what it is or what it carries', async () => {
  const plain = Buffer.from(JSON.stringify({ schema: 1, kind: 'entity.transfer', secrets: 'included', files: {} }))
  await assert.rejects(
    transfer.read({ filename: 'x.entity.json', data: plain.toString('base64') }),
    /claims to carry secrets in a readable file\. Nothing was changed\./,
  )

  const sealedName = Buffer.from(JSON.stringify({ schema: 1, kind: 'entity.transfer', sealed: true, secrets: 'none', files: {} }))
  await assert.rejects(
    transfer.read({ filename: 'x.entity.json', data: sealedName.toString('base64') }),
    /named \.json but it is sealed/,
  )

  await assert.rejects(
    transfer.read({ filename: 'x.entity.zip', data: plain.toString('base64') }),
    /named \.zip but it is not sealed/,
  )

  const leaky = Buffer.from(
    JSON.stringify({
      schema: 1,
      kind: 'entity.transfer',
      secrets: 'none',
      files: {},
      mcp: { servers: { youtrack: { url: 'https://example.test/mcp', headers: { Authorization: 'Bearer nope' } } } },
    }),
  )
  await assert.rejects(
    transfer.read({ filename: 'x.entity.json', data: leaky.toString('base64') }),
    /must be sealed/,
  )

  await assert.rejects(
    transfer.read({ filename: 'x.entity.json', data: Buffer.from('{').toString('base64') }),
    /not readable JSON/,
  )
})

test('inspect diffs what is here against what arrived, and add-alongside never overtakes', async () => {
  const source = makeWorkspace()
  const target = emptyWorkspace()
  const sent = await transfer.send({ workspace: source.record.id, preset: 'agents', directory: OUT })

  const args = { workspace: target.id, filename: sent.filename, data: bytes(sent.filename) }
  const first = await transfer.inspect(args)
  const entities = first.groups.find((group) => group.key === 'entities')
  assert.equal(entities.counts.add, 1)
  assert.equal(first.same, false)

  const written = await transfer.apply({ ...args, mode: 'add', snapshot: false })
  assert.equal(written.written, 2)
  assert.equal(written.firstFailure, null)
  assert.equal(
    fs.readFileSync(path.join(target.path, 'entities/agent.md'), 'utf8'),
    fs.readFileSync(path.join(source.record.path, 'entities/agent.md'), 'utf8'),
  )

  const second = await transfer.inspect(args)
  assert.equal(second.same, true)
  assert.ok(second.groups.every((group) => group.same))

  /* A local edit stays: add-alongside keeps the file that is already here. */
  fs.writeFileSync(path.join(target.path, 'entities/agent.md'), 'mine\n')
  await transfer.apply({ ...args, mode: 'add', snapshot: false })
  assert.equal(fs.readFileSync(path.join(target.path, 'entities/agent.md'), 'utf8'), 'mine\n')

  const replaced = await transfer.apply({ ...args, mode: 'replace', snapshot: true })
  assert.equal(replaced.written, 1)
  assert.match(replaced.snapshot, /\.zip$/)
  assert.notEqual(fs.readFileSync(path.join(target.path, 'entities/agent.md'), 'utf8'), 'mine\n')
})

test('placing beside a live workspace makes a second one, and replacing needs its id', async () => {
  const source = makeWorkspace()
  const target = makeWorkspace()
  const sent = await transfer.send({ workspace: source.record.id, preset: 'whole', directory: OUT })
  const args = { workspace: target.record.id, filename: sent.filename, data: bytes(sent.filename) }

  await assert.rejects(
    transfer.place({ ...args, mode: 'replace', confirm: 'nope' }),
    /Nothing was changed\./,
  )

  const beside = await transfer.place({ ...args, mode: 'beside' })
  assert.equal(beside.replaced, false)
  assert.notEqual(beside.id, target.record.id)
  assert.match(beside.id, /-2$/)
  assert.ok(fs.existsSync(path.join(workspaces.open(beside.id).path, 'entities/agent.md')))

  const presetsOnly = await transfer.send({ workspace: source.record.id, preset: 'agents', directory: OUT })
  await assert.rejects(
    transfer.place({
      workspace: target.record.id,
      filename: presetsOnly.filename,
      data: bytes(presetsOnly.filename),
      mode: 'beside',
    }),
    /carries one preset, not a whole workspace/,
  )
})

test('one connector travels without its token, and lands as a definition', async () => {
  const source = makeWorkspace()
  const sent = await transfer.connectorSend({ workspace: source.record.id, id: 'youtrack', directory: OUT })
  assert.match(sent.filename, /\.entity\.json$/)
  /* Flat, the same shape the receiving sheet reads: the two columns are arrays, not
     an object a `v-for` would walk one level too high. */
  assert.ok(Array.isArray(sent.travels) && sent.travels.length)
  assert.ok(Array.isArray(sent.stays) && sent.stays.length)
  assert.equal(sent.token, true)

  const target = emptyWorkspace()
  const args = { workspace: target.id, filename: sent.filename, data: bytes(sent.filename) }
  const seen = await transfer.connectorInspect(args)
  assert.equal(seen.present, false)
  assert.equal(seen.needsSignIn, true)

  const installed = await transfer.connectorInstall({ ...args, mode: 'update' })
  assert.equal(installed.updated, false)
  assert.equal(installed.id, 'youtrack')
  assert.equal(workspaces.mcp(target.id).servers.youtrack.url, 'https://example.test/mcp')

  /* A second visit finds it here and installs beside rather than over it. */
  assert.equal((await transfer.connectorInspect(args)).present, true)
  const again = await transfer.connectorInstall({ ...args, mode: 'beside' })
  assert.equal(again.beside, true)
  assert.equal(again.id, 'youtrack-2')
  /* The first one is still there, untouched. */
  assert.equal(workspaces.mcp(target.id).servers.youtrack.url, 'https://example.test/mcp')
})
