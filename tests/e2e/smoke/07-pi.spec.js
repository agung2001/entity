import { test, expect, readProfile } from '../fixtures.js'
import { newThread, openChat, readActiveThread, sendMessage, waitForAnswer } from '../helpers/app.js'

/**
 * UAT A01/H03 — the same acceptance for pi, the second harness the owner uses.
 * Skipped when pi is not installed; otherwise a real process, not a stub.
 */
test('@smoke harness: pi answers a real turn', async ({ page }) => {
  test.setTimeout(240_000)
  const profile = readProfile()
  const installed = profile.harnesses.find((item) => item.id === 'pi')?.installed
  test.skip(!installed, 'pi is not installed on this machine')

  await openChat(page, profile)
  await newThread(page, { entity: 'pi-agent' })

  await sendMessage(page, 'Reply with exactly E2E-PI-OK and nothing else. Do not use tools.')
  await waitForAnswer(page, 'E2E-PI-OK', 210_000)

  const thread = await readActiveThread(page, profile)
  const reply = thread.messages.filter((message) => message.who === 'agent').at(-1)
  expect(reply.execution.harness).toBe('pi')
  expect(reply.execution.status).toBe('ok')
  expect(thread.harness).toBe('pi')
})
