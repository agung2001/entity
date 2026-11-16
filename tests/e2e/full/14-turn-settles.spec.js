import { test, expect } from '../fixtures.js'
import { newThread, openChat, sendMessage, threadIdFromUrl } from '../helpers/app.js'
import { readProfile, readThread } from '../helpers/profile.js'

/**
 * A turn settles whenever the harness finishes, which has nothing to do with
 * where the reader is. Finishing one used to move `active` — so asking a long
 * question and reading another conversation meant being yanked back mid-answer.
 */
test('a turn that finishes elsewhere does not move the reader', async ({ page }) => {
  const profile = readProfile()
  await openChat(page)
  await newThread(page, { entity: 'chief-of-staff' })
  const asked = threadIdFromUrl(page)

  await sendMessage(page, 'E2E-STREAM answer where nobody is looking')
  await expect(page.locator('.msg--live')).toBeVisible({ timeout: 20_000 })

  /* Walk away to a second conversation while the first is still answering. */
  await newThread(page, { entity: 'chief-of-staff' })
  const reading = threadIdFromUrl(page)
  expect(reading).not.toBe(asked)

  /* The first turn lands on disk while the second thread owns the screen. */
  await expect
    .poll(() => readThread(profile, asked)?.messages?.at(-1)?.execution?.status, {
      timeout: 30_000,
      message: 'the first turn to finish',
    })
    .toBe('ok')

  /* Give the settled turn a beat to (wrongly) claim the view, then look. */
  await page.waitForTimeout(1200)
  expect(threadIdFromUrl(page)).toBe(reading)
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('')
  /* The second thread is empty: nothing from the first answer leaked onto it. */
  await expect(page.locator('.c-thread .msg[data-who="agent"]')).toHaveCount(0)

  /* And the finished thread is still one click away, with its answer in it. */
  await page.getByRole('button', { name: /answer where nobody is looking/i }).first().click()
  await expect.poll(() => threadIdFromUrl(page)).toBe(asked)
  await expect(page.locator('.c-thread')).toContainText('E2E-STREAM-TWO', { timeout: 20_000 })
})
