import { test, expect } from '../fixtures.js'
import { newThread, openChat, sendMessage, waitForAnswer } from '../helpers/app.js'

test.describe('UI contract', () => {
  test('the thread context locks after the first question', async ({ page }) => {
    await openChat(page)
    await newThread(page, { entity: 'chief-of-staff' })

    const machine = page.locator('.cp-picks').getByRole('button', { name: /^Machine:/ })
    await expect(machine).toBeEnabled()

    await sendMessage(page, 'E2E-LOCK ask once')
    await waitForAnswer(page, 'E2E-STUB-OK')

    const locked = page.locator('.cp-picks').getByRole('button', { name: /^Machine:/ })
    await expect(locked).toBeDisabled()
    await expect(locked).toHaveAttribute('title', /context is locked/)
  })

  test('composer help documents every token the composer understands', async ({ page }) => {
    await openChat(page)
    await newThread(page, { entity: 'chief-of-staff' })
    await page.getByRole('button', { name: 'Composer help' }).click()
    const help = page.getByRole('dialog', { name: 'Composer help' })

    await help.getByRole('tab', { name: 'Keys' }).click()
    await expect(help).toContainText('Focus message')
    await expect(help).toContainText('Send')

    await help.getByRole('tab', { name: 'Mentions' }).click()
    for (const token of ['@artifact:', '@maka:', '@youtrack:', '@orca:', '@@']) {
      await expect(help).toContainText(token)
    }

    await help.getByRole('tab', { name: 'Skills' }).click()
    for (const token of ['/workspace:', '//workspace:', '/<harness>:']) {
      await expect(help).toContainText(token)
    }

    await help.getByRole('tab', { name: 'Attachments' }).click()
    for (const token of ['@file:', '@mcp:', '@artifact:']) {
      await expect(help).toContainText(token)
    }
  })

  test('typing ? in the composer does not open the app guide', async ({ page }) => {
    await openChat(page)
    await newThread(page, { entity: 'chief-of-staff' })

    const box = page.getByRole('textbox', { name: 'Message' })
    await box.click()
    await box.press('?')

    await expect(box).toHaveValue('?')
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveAttribute(
      'data-open',
      '0',
    )
  })
})
