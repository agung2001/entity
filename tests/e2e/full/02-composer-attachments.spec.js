import { test, expect, readProfile } from '../fixtures.js'
import {
  attachFile,
  expectToast,
  newThread,
  openChat,
  sendMessage,
  userMessages,
  waitForAnswer,
} from '../helpers/app.js'
import { newestAttachment, newestPrompt } from '../helpers/profile.js'

test.describe('composer and attachments', () => {
  test('empty and whitespace-only sends are blocked', async ({ page }) => {
    await openChat(page)
    await newThread(page, { entity: 'chief-of-staff' })

    const send = page.getByRole('button', { name: 'Send message' })
    await expect(send).toBeDisabled()

    await page.getByRole('textbox', { name: 'Message' }).fill('    ')
    await expect(send).toBeDisabled()
  })

  test('typed @file: becomes a chip, can be removed, and travels once', async ({ page }) => {
    const profile = readProfile()
    await openChat(page, profile)
    await newThread(page, { entity: 'chief-of-staff' })

    const box = page.getByRole('textbox', { name: 'Message' })
    const chip = page.locator('.attach-chip').filter({ hasText: 'quarterly report.txt' })

    await box.fill(`E2E-ATTACH read @file:"${profile.fixtures.spaced}" `)
    await expect(chip).toBeVisible()
    await expect(box).toHaveValue('E2E-ATTACH read')

    await chip.getByRole('button').click()
    await expect(chip).toHaveCount(0)

    await box.fill(`E2E-ATTACH read @file:"${profile.fixtures.spaced}" `)
    await page.getByRole('button', { name: 'Send message' }).click()
    await waitForAnswer(page, 'E2E-ATTACH-OK')

    const prompt = newestPrompt(profile)
    expect(prompt).toContain('Attached files')
    expect(prompt).toContain('quarterly report.txt')
    expect(newestAttachment(profile)).toContain('E2E-SPACE-CANARY-7')
  })

  test('the same file is only attached once; an oversized file is skipped', async ({ page }) => {
    const profile = readProfile()
    await openChat(page, profile)
    await newThread(page, { entity: 'chief-of-staff' })

    await attachFile(page, profile.fixtures.brief)
    await attachFile(page, profile.fixtures.brief)
    await expect(page.locator('.attach-chip').filter({ hasText: 'brief.md' })).toHaveCount(1)

    await attachFile(page, profile.fixtures.huge)
    /* The picker currently skips a file over 25 MB without a visible message.
       Recorded as a UX gap in chat.md (B06); the invariant here is that it is
       never added and the composer stays usable. */
    await expect(page.locator('.attach-chip')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible()
  })

  test('an attachment-only send becomes a readable question', async ({ page }) => {
    const profile = readProfile()
    await openChat(page, profile)
    await newThread(page, { entity: 'chief-of-staff' })
    await attachFile(page, profile.fixtures.brief)
    await page.getByRole('button', { name: 'Send message' }).click()
    await waitForAnswer(page, 'E2E-STUB-OK')
    await expect(userMessages(page).last()).toContainText('Use the attached resources.')
  })

  test('a refused send leaves no half-turn in the transcript', async ({ page }) => {
    await openChat(page)
    await newThread(page, { entity: 'chief-of-staff' })

    await sendMessage(page, '@ghost E2E-MISS do something')
    await expectToast(page, 'not an entity')
    await expect(userMessages(page)).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeEnabled()
  })
})
