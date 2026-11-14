/**
 * The agent-facing CLI is pinned to `$ENTITY_WORKSPACE` when the app starts a
 * run. An explicit `--workspace` is a human shell convenience, not an agent
 * escape hatch. This is the C07 boundary at the transport layer.
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

test('an agent run cannot reach another workspace, even with --workspace', () => {
  const first = workspaces.create({ label: 'first' })
  const second = workspaces.create({ label: 'second' })
  entities.scaffold({ workspace: first.id, name: 'private-agent', harness: 'pi' })
  entities.scaffold({ workspace: second.id, name: 'private-agent', harness: 'pi' })
  const target = entities.locate({ workspace: second.id, name: 'private-agent' })
  const before = fs.readFileSync(target, 'utf8')

  for (const args of [
    ['entity', 'get', 'private-agent', '--output', 'json'],
    ['entity', 'set-instructions', 'private-agent', '--body-stdin'],
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

  /* A person at a shell (no ENTITY_WORKSPACE) can still choose a workspace. */
  const human = run(['entity', 'get', 'private-agent', '--output', 'json', '--workspace', second.id])
  assert.equal(human.status, 0)
  assert.equal(human.json?.ok, true)
  assert.equal(human.json?.data?.name, 'private-agent')
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
