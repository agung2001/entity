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

function run(args, { workspace = '', input = '' } = {}) {
  const env = { ...process.env, ENTITY_HOME: PROFILE }
  if (workspace) env.ENTITY_WORKSPACE = workspace
  else delete env.ENTITY_WORKSPACE
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
