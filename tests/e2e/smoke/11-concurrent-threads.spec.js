import { test, expect } from '../fixtures.js'
import { newThread, openChat, sendMessage, waitForAnswer } from '../helpers/app.js'

/**
 * UAT A06 — a thread's turn is not the workspace's turn.
 *
 * A slow turn stays alive in thread A while thread B sends and answers. The
 * delete action is locked while A is working, and switching back to A still
 * shows its live trace so it can be stopped.
 */
test('@smoke threads: two conversations answer at once and a working thread cannot be deleted', async ({ page }) => {
  await openChat(page)
  await newThread(page, { entity: 'chief-of-staff' })
  await sendMessage(page, 'E2E-A-PRIME first question')
  await waitForAnswer(page, 'E2E-STUB-OK')

  /* A second, slow turn in the same thread: its rail row already exists. */
  await sendMessage(page, 'E2E-SLOW-CONCURRENT keep working in the background')
  await expect(page.locator('.msg-trace--live')).toBeVisible({ timeout: 20_000 })

  const slowRow = page.locator('.rchat-row').filter({ hasText: 'E2E-A-PRIME' }).first()
  await slowRow.locator('.rchat-dots').click()
  await expect(page.getByRole('menuitem', { name: /Delete thread/ })).toBeDisabled()

  /* B is created and allowed to send while A is still running. */
  await newThread(page, { entity: 'chief-of-staff' })
  await sendMessage(page, 'E2E-B-CONCURRENT answer now')
  await waitForAnswer(page, 'E2E-STUB-OK')

  await expect(slowRow).toHaveAttribute('data-working', '1')

  /* Switching back does not lose A's live trace. */
  await slowRow.locator('.rchat-open').click()
  await expect(page.locator('.msg-trace--live')).toBeVisible()
  await page.getByRole('button', { name: 'Stop agent' }).click()
  await expect(page.locator('.ask-sys').filter({ hasText: 'Stopped by you.' })).toBeVisible({
    timeout: 20_000,
  })

  await slowRow.locator('.rchat-dots').click()
  await expect(page.getByRole('menuitem', { name: /Delete thread/ })).toBeEnabled()
})
