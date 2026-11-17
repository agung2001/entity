import { test, expect, readProfile } from '../fixtures.js'
import { newThread, openChat, sendMessage, waitForAnswer } from '../helpers/app.js'

/**
 * A chat card lists the design that turn drew, not everything that happened to
 * land on the shelf while it ran. The stub writes two designs in one turn — the
 * one the answer links, and a second folder written in the same minutes — which
 * is exactly the shape of the real leak: a background render for a different
 * design showing up inside an unrelated conversation.
 */
const cardIds = async (page) =>
  page
    .locator('.msg-artifacts--turn .msg-attach')
    .evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()))

test('a card shows only the design the turn worked on', async ({ page }) => {
  const profile = readProfile()
  await openChat(page, profile)
  await newThread(page, { entity: 'chief-of-staff' })

  await sendMessage(page, 'E2E-DESIGN draw the page')
  await waitForAnswer(page, 'Design drawn')

  const card = page.locator('.msg-artifacts--turn').first()
  await expect(card).toBeVisible({ timeout: 20_000 })
  await expect(card).toContainText('index.html')
  await expect(card).toContainText('spec.md')
  /* the other design, written in the same turn window, is not on the card —
     neither while the turn settles nor after the read-time rebuild */
  await expect(card).not.toContainText('board.png')
  await expect(card).not.toContainText('shots.png')

  await page.reload()
  await expect(page.locator('.msg-artifacts--turn').first()).toBeVisible({ timeout: 20_000 })
  const after = page.locator('.msg-artifacts--turn').first()
  /* the named file is in the answer as well, so the rebuilt card lists all three */
  await expect(after).toContainText('index.png')
  await expect(after).toContainText('index.html')
  await expect(after).toContainText('spec.md')
  await expect(after).not.toContainText('board.png')
  await expect(after).not.toContainText('shots.png')
  expect((await cardIds(page)).length).toBeGreaterThanOrEqual(3)
})
