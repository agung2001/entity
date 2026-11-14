import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT } from '../fixtures.js'
import { readProfile } from './profile.js'

/**
 * Drive the agent-facing CLI exactly as a harness would.
 *
 * The environment is the disposable profile, never the developer's. No token,
 * password or host is involved: the CLI only writes inside the workspace.
 */
export function runCli(args, { p = readProfile(), input = '', workspace = p.workspace } = {}) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'electron', 'cli.cjs'), ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      ENTITY_HOME: p.profile,
      ENTITY_WORKSPACE: workspace,
    },
    input,
    encoding: 'utf8',
    timeout: 30_000,
  })
  let json = null
  try {
    json = JSON.parse(result.stdout)
  } catch {
    /* table output, or a crash before the envelope */
  }
  return {
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    json,
  }
}

export function cliEntityGet(name, options = {}) {
  return runCli(['entity', 'get', name, '--output', 'json'], options)
}

export function cliSetInstructions(name, body, extra = [], options = {}) {
  return runCli(
    ['entity', 'set-instructions', name, '--body-stdin', ...extra],
    { ...options, input: body },
  )
}

export function cliAudit(limit = 20, options = {}) {
  return runCli(['entity', 'audit', '--limit', String(limit), '--output', 'json'], options)
}
