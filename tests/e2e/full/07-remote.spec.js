import { execFileSync } from 'node:child_process'
import { test, expect, readProfile } from '../fixtures.js'
import {
  attachFile,
  newThread,
  openChat,
  readActiveThread,
  sendMessage,
  waitForAnyAnswer,
  waitForAnswer,
} from '../helpers/app.js'
import { callRpc } from '../helpers/rpc.js'

const SKILL_ROOTS = {
  claude: '.claude/skills',
  pi: '.pi/agent/skills',
  opencode: '.config/opencode/skills',
  gemini: '.gemini/skills',
}
const HARNESS_ORDER = ['pi', 'opencode', 'gemini', 'claude']
let cleanup = null

/**
 * UAT H01–H09 — opt-in, because a remote turn needs a real ssh host the owner
 * has already scanned. Nothing about the host is stored in this file: set
 * E2E_REMOTE_HOST to an alias from ~/.ssh/config.
 *
 *   E2E_REMOTE_HOST=<alias> E2E_REMOTE_SCAN=1             scan once, then run all
 *   E2E_REMOTE_HOST=<alias> E2E_REMOTE_SKILL=1            also test //workspace:
 *
 * The scan is read-only on the host. The `//` case installs a uniquely named
 * E2E skill, then removes that one directory in `afterAll`; backups and the
 * host's own skills are left alone.
 */
test.describe('remote execution (opt-in)', () => {
  async function remoteContext() {
    const host = String(process.env.E2E_REMOTE_HOST || '').trim()
    test.skip(!host, 'set E2E_REMOTE_HOST to run the remote acceptance cases')

    const profile = readProfile()
    const ssh = await callRpc(profile, 'ssh.hosts', {})
    const known = (ssh?.hosts || []).some((entry) => entry.alias === host)
    test.skip(!known, `${host} is not in ~/.ssh/config`)

    let facts = await callRpc(profile, 'workspace.machineFacts', { id: profile.workspace })
    if (!facts?.hosts?.[host] && process.env.E2E_REMOTE_SCAN === '1') {
      await callRpc(profile, 'workspace.scanMachine', { id: profile.workspace, alias: host })
      facts = await callRpc(profile, 'workspace.machineFacts', { id: profile.workspace })
    }
    const hostFacts = facts?.hosts?.[host]
    test.skip(!hostFacts, `${host} has no capability snapshot; run Test & scan or set E2E_REMOTE_SCAN=1`)

    const harness = HARNESS_ORDER.find((id) =>
      (hostFacts.harnesses || []).some((entry) => entry.id === id),
    )
    test.skip(!harness, `${host} reports none of ${HARNESS_ORDER.join(', ')}`)
    const meta = (hostFacts.harnesses || []).find((entry) => entry.id === harness)
    return {
      host,
      profile,
      harness,
      label: meta?.label || harness,
      skillRoot: SKILL_ROOTS[harness],
    }
  }

  test.afterAll(() => {
    if (!cleanup) return
    try {
      execFileSync(
        'ssh',
        [
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=10',
          cleanup.host,
          `rm -rf "$HOME/${cleanup.root}/e2e-remote-alpha"`,
        ],
        { stdio: 'ignore', timeout: 20_000 },
      )
    } catch {
      /* the host may be gone; the run directory is still cleaned by the app */
    }
  })

  test('a thread pinned to an ssh host runs there and returns', async ({ page }) => {
    test.setTimeout(300_000)
    const { host, profile, label } = await remoteContext()

    await openChat(page, profile)
    await newThread(page, { entity: 'remote-agent', machine: host, harness: label })
    await sendMessage(page, 'Reply with exactly E2E-REMOTE-OK and nothing else. Do not use tools.')
    await waitForAnswer(page, 'E2E-REMOTE-OK', 240_000)

    const thread = await readActiveThread(page, profile)
    const reply = thread.messages.filter((message) => message.who === 'agent').at(-1)
    expect(thread.machine).toBe(host)
    expect(reply.execution.remote).toBe(true)
    expect(reply.execution.machine).toBe(host)
    expect(reply.execution.status).toBe('ok')
  })

  test('a local attachment is uploaded for one remote turn', async ({ page }) => {
    test.setTimeout(300_000)
    const { host, profile, label } = await remoteContext()

    await openChat(page, profile)
    await newThread(page, { entity: 'remote-agent', machine: host, harness: label })
    await attachFile(page, profile.fixtures.brief)
    await sendMessage(page, 'Read the attached file and quote the canary exactly.')
    await waitForAnswer(page, 'E2E-EXTERNAL-CANARY-42', 240_000)

    const thread = await readActiveThread(page, profile)
    const reply = thread.messages.filter((message) => message.who === 'agent').at(-1)
    expect(reply.execution.remote).toBe(true)
    expect(reply.execution.status).toBe('ok')
  })

  test('@@ resolves on this machine before the remote turn runs', async ({ page }) => {
    test.setTimeout(300_000)
    const { host, profile, label } = await remoteContext()

    await openChat(page, profile)
    await newThread(page, { entity: 'remote-agent', machine: host, harness: label })
    await sendMessage(page, 'E2E-REMOTE-MENTION use the resolved note from my colleague @@reviewer summarise the plan')
    await waitForAnyAnswer(page, 240_000)

    const thread = await readActiveThread(page, profile)
    const asked = thread.messages.find((message) => message.who === 'me')
    expect(asked.sent).toContain('Resolved mentions')
    expect(asked.sent).toContain('@reviewer')
    expect(asked.sent).toContain('E2E-STUB-OK')
    expect(asked.mentions?.some((mention) => mention.kind === 'entity')).toBe(true)
  })

  test('//workspace installs the local skill on the host (opt-in)', async ({ page }) => {
    test.setTimeout(300_000)
    test.skip(
      process.env.E2E_REMOTE_SKILL !== '1',
      'set E2E_REMOTE_SKILL=1 to install //workspace:e2e-remote-alpha on the host (persistent)',
    )
    const { host, profile, label, skillRoot } = await remoteContext()
    cleanup = { host, root: skillRoot }

    await openChat(page, profile)
    await newThread(page, { entity: 'remote-agent', machine: host, harness: label })
    await sendMessage(page, '//workspace:e2e-remote-alpha E2E-REMOTE-SKILL use the skill and answer briefly.')
    await waitForAnyAnswer(page, 240_000)

    const thread = await readActiveThread(page, profile)
    const asked = thread.messages.find((message) => message.who === 'me')
    expect(asked.sent).toContain(`/${skillRoot}/e2e-remote-alpha`)
    expect(asked.sent).toContain('E2E-REMOTE-SKILL')
  })
})
