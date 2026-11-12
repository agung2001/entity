/**
 * The control plane is the only place an agent's request meets the filesystem,
 * so these are the four things that must stay true:
 *
 *   1. A body write changes the instructions and nothing else — the frontmatter,
 *      including keys this app never edits, survives.
 *   2. A name cannot escape the workspace.
 *   3. A write that raced a person in `$EDITOR` is refused, not applied.
 *   4. A secret never comes back out. `env` is a list of names.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

/* `workspace-store` resolves ROOT at require time, so this has to come first. */
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-platform-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('./workspace-store.cjs')
const entities = require('./entity-store.cjs')
const core = require('./platform-core.cjs')
const brief = require('./platform-brief.cjs')

function freshWorkspace(label) {
  const record = workspaces.create({ label })
  return record.id
}

test('instructions write keeps the frontmatter and unknown keys', () => {
  const workspace = freshWorkspace('write')
  entities.scaffold({ workspace, name: 'py-agent', harness: 'claude' })

  const file = entities.locate({ workspace, name: 'py-agent' })
  fs.writeFileSync(
    file,
    fs.readFileSync(file, 'utf8').replace('harness: claude', 'harness: claude\nnote: keep me'),
    'utf8',
  )

  const before = core.call('entity.get', { workspace, name: 'py-agent' })
  assert.equal(before.ok, true)
  assert.equal(before.data.harness, 'claude')

  const written = core.call('entity.setInstructions', {
    workspace,
    name: 'py-agent',
    body: '# py-agent\n\nYou are py-agent.\n\n## Rules\n- Run the tests.\n',
  })
  assert.equal(written.ok, true, written.error)
  assert.equal(written.data.previousBytes > 0, true)

  const after = core.call('entity.get', { workspace, name: 'py-agent' })
  assert.match(after.data.instructions, /You are py-agent/)
  assert.equal(after.data.harness, 'claude', 'frontmatter must survive a body write')
  assert.deepEqual(after.data.rules, ['Run the tests.'])

  /* the key this app never edits is still there, verbatim */
  assert.match(fs.readFileSync(file, 'utf8'), /note: keep me/)

  /* and the write is accountable */
  const audited = fs.readFileSync(path.join(PROFILE, 'workspaces', workspace, 'audit.jsonl'), 'utf8')
  assert.match(audited, /entity\.setInstructions/)
})

test('a name cannot escape the workspace', () => {
  const workspace = freshWorkspace('escape')
  entities.scaffold({ workspace, name: 'safe' })

  for (const name of ['../evil', 'a/b', '..', '']) {
    const result = core.call('entity.get', { workspace, name })
    assert.equal(result.ok, false, `${name} should be refused`)
    assert.equal(result.code, 'invalid')
  }

  const record = workspaces.open(workspace)
  assert.throws(
    () => core.within(record, path.join(os.tmpdir(), 'elsewhere.md')),
    /outside this workspace/,
  )
})

test('a write that raced an external edit is refused', () => {
  const workspace = freshWorkspace('conflict')
  entities.scaffold({ workspace, name: 'runner' })
  const file = entities.locate({ workspace, name: 'runner' })

  const read = core.call('entity.get', { workspace, name: 'runner' })
  assert.equal(read.ok, true)

  /* a person saves the file between the agent's read and its write */
  fs.appendFileSync(file, '\n## Added by a human\n- do not lose this\n', 'utf8')

  const result = core.call('entity.setInstructions', {
    workspace,
    name: 'runner',
    body: '# runner\n\nclobbered\n',
    expect: read.data.stamp,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'conflict')
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /clobbered/)
})

test('an mcp entry never carries a secret value out', () => {
  const workspace = freshWorkspace('mcp')

  const added = core.call('mcp.add', {
    workspace,
    name: 'github',
    spec: { command: 'npx', args: ['-y', 'server-github'], env: ['GITHUB_TOKEN'] },
  })
  assert.equal(added.ok, true, added.error)

  const listed = core.call('mcp.list', { workspace })
  assert.deepEqual(listed.data.names, ['github'])
  assert.deepEqual(listed.data.servers.github.envKeys, ['GITHUB_TOKEN'])
  assert.equal(JSON.stringify(listed.data).includes('ghp_'), false)

  /* a value pasted where a name belongs is rejected, not stored and hidden */
  const smuggled = core.call('mcp.add', {
    workspace,
    name: 'leaky',
    spec: { command: 'npx', env: { GITHUB_TOKEN: 'ghp_notarealtoken' } },
  })
  assert.equal(smuggled.ok, false)

  const duplicate = core.call('mcp.add', { workspace, name: 'github', spec: { command: 'npx' } })
  assert.equal(duplicate.code, 'conflict')
})

test('workspace context is prepended to the entity body', () => {
  const text = brief.compose({
    record: { context: 'House rule: never push to main.' },
    entity: { instructions: 'You are py-agent.' },
    extra: 'Artifacts live in ~/x.',
  })
  assert.ok(text.indexOf('House rule') < text.indexOf('You are py-agent'))
  assert.ok(text.indexOf('You are py-agent') < text.indexOf('Artifacts live'))
  /* the CLI brief is always there, or the agent never learns the CLI exists */
  assert.match(text, /ENTITY_CLI_PATH/)
})

test('set-fields refuses an mcp server that is not in the pool', () => {
  const workspace = freshWorkspace('fields')
  entities.scaffold({ workspace, name: 'a' })

  const missing = core.call('entity.setFields', {
    workspace,
    name: 'a',
    patch: { mcp: 'not-there' },
  })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'invalid')

  core.call('mcp.add', { workspace, name: 'github', spec: { url: 'https://example.com/mcp' } })
  const ok = core.call('entity.setFields', { workspace, name: 'a', patch: { mcp: 'github' } })
  assert.equal(ok.ok, true, ok.error)
  assert.deepEqual(ok.data.changed, ['mcp'])
})
