import { test, expect, readProfile } from '../fixtures.js'
import { newThread, openChat, sendMessage, waitForAnswer } from '../helpers/app.js'
import { newestPrompt } from '../helpers/profile.js'

/**
 * UAT E01/E05/F02/F09 — the composer's two languages resolve before the
 * harness sees them, and a name that does not exist is an error.
 */
test('@smoke skills: /workspace resolves to an absolute path', async ({ page }) => {
  const profile = readProfile()
  await openChat(page, profile)
  await newThread(page, { entity: 'chief-of-staff' })

  await sendMessage(page, '/workspace:uat-alpha E2E-SKILL-PROBE apply the skill')
  await waitForAnswer(page, 'E2E-STUB-OK')

  const prompt = newestPrompt(profile)
  expect(prompt).toContain(`use this skill ${profile.skill.path}`)
  expect(prompt).toContain('E2E-SKILL-PROBE')
  expect(prompt).not.toContain('/workspace:uat-alpha')
})

test('@smoke mentions: @artifact resolves and the menu opens', async ({ page }) => {
  const profile = readProfile()
  await openChat(page, profile)
  await newThread(page, { entity: 'chief-of-staff' })

  await sendMessage(page, 'E2E-MENTION-PROBE summarise @artifact:e2e-note')
  await waitForAnswer(page, 'E2E-STUB-OK')

  const prompt = newestPrompt(profile)
  expect(prompt).toContain('Resolved mentions')
  expect(prompt).toContain('artifact://notes/e2e-note.md')
  expect(prompt).toContain('E2E-MENTION-PROBE')

  const box = page.getByRole('textbox', { name: 'Message' })
  await box.fill('')
  await box.click()
  await box.pressSequentially('@')
  const menuItem = page.locator('.ask-cmdbox .ask-cmd').filter({ hasText: '@artifact:' })
  await expect(menuItem).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menuItem).toHaveCount(0)
  await box.fill('')
})
