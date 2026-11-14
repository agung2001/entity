import { test, expect } from '../fixtures.js'
import { newThread, openChat, readActiveThread, sendMessage, waitForAnswer } from '../helpers/app.js'

/**
 * A turn is visible while it is still running: partial assistant text paints in
 * the live bubble, and the final message replaces it when the stream closes.
 */
test('a turn streams partial answer text before it finishes', async ({ page }) => {
  await openChat(page)
  await newThread(page, { entity: 'chief-of-staff' })

  await sendMessage(page, 'E2E-STREAM show the live answer')
  const live = page.locator('.msg--live')
  await expect(live).toBeVisible({ timeout: 10_000 })
  await expect(live).toContainText('E2E-STREAM-ONE', { timeout: 10_000 })
  await expect(live.locator('.msg-live-caret')).toBeVisible()

  await waitForAnswer(page, 'E2E-STREAM-TWO')
  await expect(page.locator('.msg--live')).toHaveCount(0)

  const stored = await readActiveThread(page)
  const reply = stored.messages.filter((message) => message.who === 'agent').at(-1)
  expect(reply.execution.status).toBe('ok')
  expect(Number.isFinite(reply.execution.ttfbMs)).toBe(true)
  expect(Number.isFinite(reply.execution.firstTextMs)).toBe(true)
})
