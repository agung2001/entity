import { test, expect, readProfile } from '../fixtures.js'
import { attachFile, newThread, openChat, readActiveThread, sendMessage, waitForAnswer } from '../helpers/app.js'
import { newestAttachment, newestPrompt } from '../helpers/profile.js'

/**
 * UAT A01/A07/I01/I03 — one real turn on the deterministic stub: the composer
 * sends, the answer renders, the process fold explains it, the timeline opens,
 * and a reload keeps the transcript.
 */
test('@smoke thread: send, trace, timeline and reload', async ({ page }) => {
  await openChat(page)
  const threadId = await newThread(page, { entity: 'chief-of-staff' })
  expect(threadId).toBeTruthy()

  await sendMessage(page, 'E2E-BASIC give me the stub answer')
  await waitForAnswer(page, 'E2E-STUB-OK')

  const user = page.locator('.msg[data-who="me"]').last()
  await expect(user).toContainText('E2E-BASIC')

  const answer = page.locator('.msg[data-who="agent"]').last()
  const fold = page.locator('details.msg-trace[data-who="agent"]').last()
  await expect(fold).toBeVisible()
  await fold.locator('summary').click()
  await expect(fold).toContainText('e2e thinking step')

  await page.getByRole('button', { name: /View execution timeline/ }).click()
  const timeline = page.getByRole('dialog', { name: 'Execution timeline' })
  await expect(timeline).toBeVisible()
  await expect(timeline).toContainText('e2e-stub')
  await page.keyboard.press('Escape')
  await expect(timeline).toHaveAttribute('data-open', '0')

  const stored = await readActiveThread(page)
  const reply = stored.messages.filter((message) => message.who === 'agent').at(-1)
  expect(reply.text).toContain('E2E-STUB-OK')
  expect(reply.execution.harness).toBe('claude')
  expect(reply.execution.status).toBe('ok')
  expect(reply.steps.some((step) => step.type === 'thinking')).toBe(true)

  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible()
  await expect(page.locator('.msg[data-who="agent"]').filter({ hasText: 'E2E-STUB-OK' })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`thread=${threadId}`))
})

/**
 * UAT B04/B08 — a picked attachment becomes a chip, travels in the prompt and
 * is removed from the tray after the turn.
 */
test('@smoke attachments: a local file reaches the harness prompt', async ({ page }) => {
  const profile = readProfile()
  await openChat(page, profile)
  await newThread(page, { entity: 'chief-of-staff' })

  await attachFile(page, profile.fixtures.brief)
  await expect(page.locator('.attach-chip').filter({ hasText: 'brief.md' })).toBeVisible()

  await sendMessage(page, 'E2E-ATTACH read the attached file')
  await waitForAnswer(page, 'E2E-ATTACH-OK')

  const prompt = newestPrompt(profile)
  expect(prompt).toContain('Attached files')
  expect(prompt).toMatch(/runs\/\.attach-[^/]+\/0-brief\.md/)
  expect(newestAttachment(profile)).toContain('E2E-EXTERNAL-CANARY-42')
  await expect(page.locator('.attach-chip')).toHaveCount(0)
})
