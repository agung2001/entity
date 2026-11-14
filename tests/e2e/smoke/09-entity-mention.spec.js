import { test, expect, readProfile } from '../fixtures.js'
import { newThread, openChat, readActiveThread, sendMessage, waitForAnswer } from '../helpers/app.js'
import { logsMatching, newestPrompt } from '../helpers/profile.js'

/**
 * UAT E02 — mentioning another entity is a real sub-run, not a label.
 *
 * `@secretary E2E-SECRETARY-READ ...` runs the secretary process in its own
 * working directory (outside the workspace), has it read `brief.md`, then
 * injects the answer into the chief-of-staff turn.
 */
test('@smoke mentions: @secretary reads a file and its answer is injected', async ({ page }) => {
  const profile = readProfile()
  await openChat(page, profile)
  await newThread(page, { entity: 'chief-of-staff' })

  await sendMessage(page, '@secretary E2E-SECRETARY-READ read brief.md and quote the canary')
  await waitForAnswer(page, 'E2E-STUB-OK')

  const delegation = page.locator('.msg-delegation').first()
  await expect(delegation.locator('.msg-delegation-mark')).toBeVisible()
  await expect(delegation).toContainText('@secretary')
  await expect(delegation).toContainText('E2E-SECRETARY-OK-E2E-EXTERNAL-CANARY-42')

  const trace = page.locator('details.msg-trace[data-who="agent"]').last()
  await trace.locator('summary.msg-trace-head').click()
  const mentions = trace.locator('details.trace-mentions')
  await mentions.locator('summary').first().click()
  await expect(mentions.locator('.trace-mention-entry').first()).toContainText('@secretary')
  await expect(mentions.locator('details.trace-delegation-run')).toBeVisible()

  const mainPrompt = newestPrompt(profile)
  expect(mainPrompt).toContain('Resolved mentions')
  expect(mainPrompt).toContain('@secretary')
  expect(mainPrompt).toContain('E2E-SECRETARY-OK-E2E-EXTERNAL-CANARY-42')

  const reads = logsMatching(profile, '.secretary', 'E2E-EXTERNAL-CANARY-42')
  expect(reads.length).toBeGreaterThan(0)

  const meta = logsMatching(profile, '.meta', 'entity: secretary').at(-1)
  expect(meta).toContain(`cwd: ${profile.paths.external}`)

  const thread = await readActiveThread(page, profile)
  const asked = thread.messages.find((message) => message.who === 'me')
  const mention = asked.mentions?.find((entry) => entry.kind === 'entity')
  expect(mention?.name).toBe('secretary')
  expect(mention?.answer).toContain('E2E-SECRETARY-OK-E2E-EXTERNAL-CANARY-42')
  expect(mention?.steps?.length).toBeGreaterThan(0)
  expect(mention?.execution?.harness).toBe('claude')

  await page.reload()
  await expect(page.locator('.msg-delegation')).toContainText('E2E-SECRETARY-OK-E2E-EXTERNAL-CANARY-42')
})
