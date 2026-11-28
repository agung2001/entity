import { test, expect } from '../fixtures.js'
import { newThread, openChat, sendMessage, waitForAnswer } from '../helpers/app.js'

/**
 * ENTITY-3 — a streamed chunk never drags a reader back to the bottom. The
 * follow flag exists for exactly this case, and the watchers on the live text
 * fire many times a second while an answer arrives.
 */
const gap = (el) => el.scrollHeight - el.scrollTop - el.clientHeight
const tall = (el) => el.scrollHeight - el.clientHeight

test('reading backwards during a turn holds the place, and one click returns', async ({ page }) => {
  await openChat(page)
  await newThread(page, { entity: 'chief-of-staff' })

  await sendMessage(page, 'E2E-FLOOD stream a long answer')
  const box = page.locator('.c-thread')
  const live = page.locator('.msg-live-text')
  await expect(live).toBeVisible({ timeout: 20_000 })

  /* The stub streams for ~27s; wait for enough height that a wheel up cannot
     reach the top of the transcript. */
  await expect.poll(() => box.evaluate(tall), { timeout: 30_000 }).toBeGreaterThan(1200)

  /* Following is the default: the stream keeps its newest text in view. */
  await expect.poll(() => box.evaluate(gap)).toBeLessThan(8)

  await page.mouse.move(720, 480)
  await page.mouse.wheel(0, -700)
  await expect(page.locator('.jump-live')).toBeVisible()

  const held = await box.evaluate((el) => el.scrollTop)
  const seen = (await live.innerText()).length
  expect(held).toBeGreaterThan(0)

  /* More of the answer arrives; the reader must not move a pixel. */
  await page.waitForTimeout(2500)
  expect(await box.evaluate((el) => el.scrollTop)).toBe(held)
  expect((await live.innerText()).length).toBeGreaterThan(seen)

  /* One click returns to the live turn, and following carries on by itself. */
  await page.locator('.jump-live').click()
  await expect(page.locator('.jump-live')).toHaveCount(0)
  await expect.poll(() => box.evaluate(gap)).toBeLessThan(8)

  /* Scrolling by hand resumes following as well, once the end is reached. */
  await page.mouse.wheel(0, -700)
  await expect(page.locator('.jump-live')).toBeVisible()
  for (let step = 0; step < 20; step += 1) {
    if ((await box.evaluate(gap)) < 8) break
    await page.mouse.wheel(0, 900)
    await page.waitForTimeout(60)
  }
  await expect(page.locator('.jump-live')).toHaveCount(0)
  await expect.poll(() => box.evaluate(gap)).toBeLessThan(8)

  await waitForAnswer(page, 'E2E-FLOOD-DONE', 60_000)
})

/**
 * A thread swap replaces the section the floating bar and the composer live in,
 * and a `ResizeObserver` bound to a removed node delivers `0 × 0` once and then
 * goes quiet. The reserve then collapsed to 14px under the bar and 28px behind
 * the composer — the first and last message unreadable, and no later resize
 * corrected it. The observers follow the elements, so they re-attach.
 */
test('a switch through the opening skeleton keeps the bar and the composer off the thread', async ({
  page,
}) => {
  await openChat(page)
  await newThread(page, { entity: 'chief-of-staff' })
  await sendMessage(page, 'E2E-RESERVE alpha')
  await waitForAnswer(page, 'E2E-STUB-OK')

  await newThread(page, { entity: 'chief-of-staff' })
  await sendMessage(page, 'E2E-RESERVE beta')
  await waitForAnswer(page, 'E2E-STUB-OK')

  /* A thread already in memory paints from memory and never opens; a reload
     empties it, so the rail row below is a real disk read. */
  await page.reload()
  await expect(page.getByRole('button', { name: 'New chat' })).toBeVisible()
  await expect(page.locator('.c-thread')).toBeVisible()

  /* Hold that read open, so the skeleton — a different section, without this
     thread's bar — is what a swap paints. */
  await page.route('**/__entity/call', async (route) => {
    if ((route.request().postData() || '').includes('"chat.read"')) {
      await new Promise((resolve) => setTimeout(resolve, 600))
    }
    await route.continue()
  })
  await page
    .locator('.rchat-row')
    .filter({ hasText: 'E2E-RESERVE alpha' })
    .locator('.rchat-open')
    .click()
  await expect(page.locator('.cpanel-opening')).toBeVisible()
  await expect(page.locator('.cpanel-opening')).toHaveCount(0, { timeout: 20_000 })

  /* The transcript pays for the bar it scrolls under and the composer it stops
     above, measured against where those boxes actually are — not a constant. */
  const clearances = await page.evaluate(() => {
    const list = document.querySelector('.c-thread')
    const head = document.querySelector('.cp-head')
    const dock = document.querySelector('.cpanel .cp-dock')
    const style = getComputedStyle(list)
    const above = head.getBoundingClientRect().bottom - list.getBoundingClientRect().top
    const behind = list.getBoundingClientRect().bottom - dock.getBoundingClientRect().top
    return {
      top: parseFloat(style.paddingTop) - above,
      bottom: parseFloat(style.paddingBottom) - behind,
    }
  })
  expect(clearances.top).toBeGreaterThanOrEqual(8)
  expect(clearances.bottom).toBeGreaterThanOrEqual(8)
})
