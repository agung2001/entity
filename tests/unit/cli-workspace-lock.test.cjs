/**
 * The agent-facing CLI is pinned to `$ENTITY_WORKSPACE` when the app starts a
 * run. A pinned run may READ another workspace — its own shell can read those
 * files anyway, so refusing would be theatre — but never write to one. This is
 * the C07 boundary at the transport layer.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const assert = require('node:assert/strict')

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-cli-lock-'))
process.env.ENTITY_HOME = PROFILE

const workspaces = require('../../electron/workspace-store.cjs')
const entities = require('../../electron/entity-store.cjs')
const CLI = path.join(__dirname, '..', '..', 'electron', 'cli.cjs')

function run(args, { workspace = '', entity = '', input = '' } = {}) {
  const env = { ...process.env, ENTITY_HOME: PROFILE }
  if (workspace) env.ENTITY_WORKSPACE = workspace
  else delete env.ENTITY_WORKSPACE
  if (entity) env.ENTITY_ENTITY = entity
  else delete env.ENTITY_ENTITY
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env,
    input,
    encoding: 'utf8',
    timeout: 20_000,
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: (() => {
      try {
        return JSON.parse(result.stdout)
      } catch {
        return null
      }
    })(),
  }
}

test('a pinned run cannot WRITE to another workspace, even with --workspace', () => {
  const first = workspaces.create({ label: 'first' })
  const second = workspaces.create({ label: 'second' })
  entities.scaffold({ workspace: first.id, name: 'private-agent', harness: 'pi' })
  entities.scaffold({ workspace: second.id, name: 'private-agent', harness: 'pi' })
  const target = entities.locate({ workspace: second.id, name: 'private-agent' })
  const before = fs.readFileSync(target, 'utf8')

  for (const args of [
    ['entity', 'set-instructions', 'private-agent', '--body-stdin'],
    ['entity', 'set-fields', 'private-agent', '--model', 'x'],
    ['entity', 'create', 'intruder'],
    ['mcp', 'add', 'intruder', '--command', 'true'],
    ['workspace', 'set-context', '--context', 'hijacked'],
  ]) {
    const result = run(
      [...args, '--workspace', second.id],
      { workspace: first.id, input: '# escaped\n' },
    )
    assert.equal(result.status, 1, args.join(' '))
    assert.equal(result.json?.ok, false)
    assert.equal(result.json?.code, 'denied')
  }
  assert.equal(fs.readFileSync(target, 'utf8'), before)
  assert.equal(fs.readdirSync(path.join(PROFILE, 'workspaces', second.id, 'entities')).length, 1)

  /* A person at a shell (no ENTITY_WORKSPACE) can still choose a workspace. */
  const human = run(['entity', 'get', 'private-agent', '--output', 'json', '--workspace', second.id])
  assert.equal(human.status, 0)
  assert.equal(human.json?.ok, true)
  assert.equal(human.json?.data?.name, 'private-agent')
})

test('a pinned run can READ another workspace, and says so in its own audit log', () => {
  const first = workspaces.create({ label: 'reader' })
  const second = workspaces.create({ label: 'target' })
  entities.scaffold({ workspace: second.id, name: 'sibling-agent', harness: 'pi' })

  const read = run(['entity', 'get', 'sibling-agent', '--output', 'json', '--workspace', second.id], {
    workspace: first.id,
    entity: 'reader',
  })
  assert.equal(read.status, 0, read.stderr || read.stdout)
  assert.equal(read.json?.ok, true)
  assert.equal(read.json?.data?.name, 'sibling-agent')

  /* the read is recorded where the run that made it can be seen */
  const audit = fs.readFileSync(path.join(PROFILE, 'workspaces', first.id, 'audit.jsonl'), 'utf8')
  assert.match(audit, /cross\.read entity\.get/)
  assert.match(audit, new RegExp(second.id))
  /* and nothing was written where it was read from */
  const otherFile = path.join(PROFILE, 'workspaces', second.id, 'audit.jsonl')
  const other = fs.existsSync(otherFile) ? fs.readFileSync(otherFile, 'utf8') : ''
  assert.doesNotMatch(other, /cross\.read/)
})

test('workspace list names every room without a pinned run', () => {
  const first = workspaces.create({ label: 'listed-one' })
  const second = workspaces.create({ label: 'listed-two' })
  const result = run(['workspace', 'list', '--output', 'json', '--workspace', first.id])
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const ids = (result.json?.data || []).map((row) => row.id)
  assert.ok(ids.includes(first.id) && ids.includes(second.id), ids.join(', '))
  const current = (result.json?.data || []).find((row) => row.id === first.id)
  assert.equal(current?.current, true)
})


test('an agent can create an entity with the CLI and no direct file write', () => {
  const workspace = workspaces.create({ label: 'create-cli' })
  entities.scaffold({ workspace: workspace.id, name: 'lead', harness: 'pi' })

  const result = run(
    [
      'entity',
      'create',
      'researcher',
      '--description',
      'Researches questions on the web.',
      '--body-stdin',
      '--output',
      'json',
    ],
    { workspace: workspace.id, entity: 'lead', input: '# researcher\n\nFind sources.\n' },
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.json?.ok, true)
  assert.equal(result.json?.data?.name, 'researcher')
  assert.equal(result.json?.data?.harness, 'pi')

  const file = entities.locate({ workspace: workspace.id, name: 'researcher' })
  assert.match(fs.readFileSync(file, 'utf8'), /Find sources\./)
  const audit = fs.readFileSync(path.join(PROFILE, 'workspaces', workspace.id, 'audit.jsonl'), 'utf8')
  assert.match(audit, /entity\.create/)

  const duplicate = run(
    ['entity', 'create', 'researcher', '--harness', 'pi', '--output', 'json'],
    { workspace: workspace.id, entity: 'lead' },
  )
  assert.equal(duplicate.status, 1)
  assert.equal(duplicate.json?.code, 'conflict')
})

test('a pinned clone into another workspace parks until a person allows it', () => {
  const first = workspaces.create({ label: 'clone-source' })
  const second = workspaces.create({ label: 'clone-target' })
  entities.scaffold({ workspace: first.id, name: 'clone-agent', harness: 'pi' })

  const pinned = run(['entity', 'clone', 'clone-agent', '--to', second.id], {
    workspace: first.id,
    entity: 'lead',
  })
  assert.equal(pinned.status, 1, pinned.stderr || pinned.stdout)
  assert.equal(pinned.json?.code, 'needs_consent')
  assert.match(String(pinned.json?.data?.command), /entity clone clone-agent/)
  assert.equal(fs.readdirSync(path.join(PROFILE, 'workspaces', second.id, 'entities')).length, 0)

  const pending = JSON.parse(
    fs.readFileSync(path.join(PROFILE, 'workspaces', first.id, 'pending-clone.json'), 'utf8'),
  )
  assert.equal(pending.to, second.id)
  assert.equal(pending.from, first.id)
  assert.equal(pending.requestedBy, 'lead')

  /* Nothing was written where the run is not looking, not even on retry. */
  const retry = run(['entity', 'clone', 'clone-agent', '--to', second.id], {
    workspace: first.id,
  })
  assert.equal(retry.json?.code, 'needs_consent')

  /* The same workspace still duplicates without asking. */
  const local = run(['entity', 'clone', 'clone-agent', '--name', 'clone-copy'], {
    workspace: first.id,
  })
  assert.equal(local.status, 0, local.stderr || local.stdout)
  assert.equal(local.json?.data?.name, 'clone-copy')

  /* Naming the target with --workspace must not turn it into the caller's own
     workspace and slip past the gate. */
  const disguised = run(
    ['entity', 'clone', 'clone-agent', '--workspace', second.id, '--to', second.id],
    { workspace: first.id },
  )
  assert.equal(disguised.json?.code, 'needs_consent')
  assert.equal(fs.readdirSync(path.join(PROFILE, 'workspaces', second.id, 'entities')).length, 0)

  /* A person at a shell is not pinned: the same copy performs. */
  const human = run([
    'entity',
    'clone',
    'clone-agent',
    '--workspace',
    first.id,
    '--to',
    second.id,
  ])
  assert.equal(human.status, 0, human.stderr || human.stdout)
  assert.equal(
    fs.existsSync(path.join(PROFILE, 'workspaces', second.id, 'entities', 'clone-agent.md')),
    true,
  )
})
