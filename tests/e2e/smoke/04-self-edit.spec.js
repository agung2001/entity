import { test, expect, readProfile } from '../fixtures.js'
import { newThread, openChat, sendMessage, waitForAnswer } from '../helpers/app.js'
import { auditRows, entityText } from '../helpers/profile.js'

/**
 * UAT C01/C02 — the headline claim: an entity rewrites its own main
 * instruction through the real CLI, the change is audited, and the file on
 * disk (and the Entity page) shows it.
 */
test('@smoke self-edit: the entity rewrites its own instructions', async ({ page }) => {
  await openChat(page)
  await newThread(page, { entity: 'self-editor' })

  await sendMessage(page, 'E2E-SELF-EDIT append the E2E canary to your own instructions')
  await waitForAnswer(page, 'E2E-SELF-EDIT-DONE')

  const profile = readProfile()
  await expect.poll(() => entityText(profile, 'self-editor')).toContain('E2E-CANARY-EDIT-APPLIED')

  const text = entityText(profile, 'self-editor')
  expect(text).toContain('name: self-editor')
  expect(text).toContain('harness: claude')
  expect(text).toContain('E2E-CANARY-EDIT-APPLIED')

  await expect
    .poll(() => auditRows(profile).some((row) => row.verb === 'entity.setInstructions'))
    .toBe(true)

  await page.goto(`/${profile.workspace}/entities/self-editor`)
  await expect(page.locator('textarea').first()).toHaveValue(/E2E-CANARY-EDIT-APPLIED/)
})
