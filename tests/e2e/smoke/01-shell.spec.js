import { test, expect } from '../fixtures.js'
import { newThread, openChat } from '../helpers/app.js'

/**
 * UAT K05/K06/B01 — the composer help and the app-wide guide are the two
 * surfaces a person uses to discover the chat language. Both must open, list
 * the documented tokens and close on Escape.
 */
test('@smoke shell: composer help and keyboard guide close on Escape', async ({ page }) => {
  await openChat(page)
  await newThread(page, { entity: 'chief-of-staff' })

  await page.getByRole('button', { name: 'Composer help' }).click()
  const help = page.getByRole('dialog', { name: 'Composer help' })
  await expect(help).toBeVisible()
  await expect(help.getByRole('tab', { name: 'Keys' })).toBeVisible()
  await expect(help.getByRole('tab', { name: 'Mentions' })).toBeVisible()
  await expect(help.getByRole('tab', { name: 'Skills' })).toBeVisible()
  await expect(help.getByRole('tab', { name: 'Attachments' })).toBeVisible()

  await help.getByRole('tab', { name: 'Mentions' }).click()
  await expect(help).toContainText('@artifact:')
  await expect(help).toContainText('@youtrack:')
  await expect(help).toContainText('@@')

  await page.keyboard.press('Escape')
  await expect(help).toHaveAttribute('data-open', '0')

  await page.getByRole('button', { name: 'Keyboard shortcuts' }).click()
  const guide = page.getByRole('dialog', { name: /Keyboard/ })
  await expect(guide).toBeVisible()
  await expect(guide).toContainText('Focus the composer')
  await expect(guide).toContainText('Execution timeline')
  await page.keyboard.press('Escape')
  await expect(guide).toHaveAttribute('data-open', '0')
})
