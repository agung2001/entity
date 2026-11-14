import { test, expect, readProfile } from '../fixtures.js'
import { newThread, openChat, readActiveThread, sendMessage, waitForAnswer } from '../helpers/app.js'

/**
 * UAT A01/H03 — a real OpenCode turn on this machine. This is the harness the
 * owner uses day to day; the deterministic stub proves plumbing, this proves
 * the real CLI is wired correctly.
 *
 * The test is skipped (not failed) when OpenCode is not installed, so the
 * suite also runs on a clean machine. No credential is read by the test: the
 * CLI uses whatever auth its own profile already has.
 */
test('@smoke harness: opencode answers a real turn', async ({ page }) => {
  test.setTimeout(240_000)
  const profile = readProfile()
  const installed = profile.harnesses.find((item) => item.id === 'opencode')?.installed
  test.skip(!installed, 'opencode is not installed on this machine')

  await openChat(page, profile)
  await newThread(page, { entity: 'opencode-agent' })

  await sendMessage(page, 'Reply with exactly E2E-OPENCODE-OK and nothing else. Do not use tools.')
  await waitForAnswer(page, 'E2E-OPENCODE-OK', 210_000)

  const thread = await readActiveThread(page, profile)
  const reply = thread.messages.filter((message) => message.who === 'agent').at(-1)
  expect(reply.execution.harness).toBe('opencode')
  expect(reply.execution.status).toBe('ok')
  expect(thread.harness).toBe('opencode')
})
