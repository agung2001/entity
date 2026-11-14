import { test, expect } from '../fixtures.js'
import { newThread, openChat, sendMessage } from '../helpers/app.js'

/**
 * UAT B03/J03 — stopping is a first-class outcome: a system row, no Retry, and
 * the composer comes back. The rehearsal stub sleeps for 30 seconds so the
 * click lands while a real child is alive.
 */
test('@smoke stop: a live turn stops and reports itself', async ({ page }) => {
  await openChat(page)
  await newThread(page, { entity: 'chief-of-staff' })

  await sendMessage(page, 'E2E-SLOW please take your time')
  await expect(page.locator('.msg-trace--live')).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Stop agent' }).click()

  const stopped = page.locator('.ask-sys').filter({ hasText: 'Stopped by you.' })
  await expect(stopped).toBeVisible({ timeout: 20_000 })
  await expect(stopped.locator('.ask-retry')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeEnabled()
})
