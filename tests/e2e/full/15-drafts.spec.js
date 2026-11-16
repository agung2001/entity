import { test, expect } from '../fixtures.js'
import { newThread, openChat, sendMessage, threadIdFromUrl, waitForAnswer } from '../helpers/app.js'

/**
 * The composer is one box for every conversation, so unsent text used to live
 * exactly as long as that conversation stayed open. A draft belongs to the
 * thread it was typed in — and it has to survive a reload, which is when a long
 * prompt is most likely to be lost.
 */
test('each thread keeps its own draft, across switches and a reload', async ({ page }) => {
  await openChat(page)

  /* Two threads, each with a name of its own so the rail is unambiguous. */
  await newThread(page, { entity: 'chief-of-staff' })
  const first = threadIdFromUrl(page)
  await sendMessage(page, 'E2E-RAIL-ALPHA first thread')
  await waitForAnswer(page, 'E2E-STUB-OK')

  const box = page.getByRole('textbox', { name: 'Message' })
  await box.fill('alpha draft, not sent')
  await expect(box).toHaveValue('alpha draft, not sent')

  await newThread(page, { entity: 'chief-of-staff' })
  const second = threadIdFromUrl(page)
  expect(second).not.toBe(first)
  /* A different thread starts with a different box. */
  await expect(box).toHaveValue('')
  await box.fill('bravo draft, not sent')

  /* Back to the first: the words come back with the thread. */
  await page.locator('.rchat-row').filter({ hasText: 'E2E-RAIL-ALPHA' }).first().click()
  await expect.poll(() => threadIdFromUrl(page)).toBe(first)
  await expect(box).toHaveValue('alpha draft, not sent')

  /* And forward to the second, which kept its own. */
  await page.locator('.rchat-row').filter({ hasText: 'New thread' }).first().click()
  await expect.poll(() => threadIdFromUrl(page)).toBe(second)
  await expect(box).toHaveValue('bravo draft, not sent')

  /* A reload is the case that used to lose everything. */
  await page.reload()
  await expect(box).toHaveValue('bravo draft, not sent', { timeout: 20_000 })

  /* Sending empties only the thread it was sent from. */
  await sendMessage(page, 'bravo draft, now sent')
  await expect(box).toHaveValue('')
  await page.locator('.rchat-row').filter({ hasText: 'E2E-RAIL-ALPHA' }).first().click()
  await expect(box).toHaveValue('alpha draft, not sent')
})
