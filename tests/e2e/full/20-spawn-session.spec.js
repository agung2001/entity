import { test, expect } from '../fixtures.js'
import { newThread, openChat, sendMessage, threadIdFromUrl, waitForAnswer } from '../helpers/app.js'
import { listThreads, readProfile, readThread } from '../helpers/profile.js'

/**
 * ENTITY-24, second reading — spawning is a **mention**.
 *
 * There is no Spawn button and no block of child cards: `@entity <job>` runs the
 * job and leaves a session behind, the transcript's delegation card continues
 * into it, and the parent's rail row carries the count and opens a tree. Two
 * surfaces were rejected exactly because they were extra furniture next to the
 * thing the composer already does.
 */
const railRows = (page) => page.locator('.rchat-row')
const railRow = (page, text) => railRows(page).filter({ hasText: text })
const tree = (page) => page.getByRole('dialog', { name: 'Spawned sessions' })

async function openParent(page) {
  const profile = readProfile()
  await openChat(page, profile)
  const parentId = await newThread(page, { entity: 'chief-of-staff' })
  return { profile, parentId }
}

const sessionOf = (profile, parentId) =>
  listThreads(profile).find((thread) => thread.spawnedFrom?.id === parentId) || null

test.describe('a mention is a session', () => {
  test('delegating leaves a card with Continue, and Continue opens the session', async ({
    page,
  }) => {
    const { profile, parentId } = await openParent(page)

    await sendMessage(page, '@secretary E2E-STUB-TOKEN check the site')
    await waitForAnswer(page, 'E2E-STUB-OK')

    const card = page.locator('.msg-delegation').first()
    await expect(card).toBeVisible()
    await expect(card.locator('.msg-delegation-kicker')).toHaveText('Delegated to')
    await expect(card.locator('.msg-delegation-name')).toHaveText('@secretary')
    await expect(card.locator('.msg-delegation-job')).toContainText('check the site')
    await expect(card.locator('.msg-delegation-answer')).toContainText('E2E-STUB-OK')

    const session = sessionOf(profile, parentId)
    expect(session, 'the delegation wrote a session').not.toBeNull()
    expect(session.spawnedFrom).toEqual({ workspace: profile.workspace, id: parentId })
    expect(session.entity).toBe('secretary')
    expect(session.messages[0].who).toBe('me')
    expect(session.messages[0].text).toContain('check the site')
    expect(session.messages[1].who).toBe('agent')
    expect(session.messages[1].text).toContain('E2E-STUB-OK')
    /* the parent keeps its own reply; the session is a separate conversation */
    expect(readThread(profile, parentId).messages).toHaveLength(2)

    /* Continue is the way into that conversation, from the answer that caused it */
    await card.locator('.msg-delegation-open').click()
    await expect.poll(() => threadIdFromUrl(page)).toBe(session.id)
    await expect(page.locator('.cp-from')).toContainText('from #')
    await expect(page.locator('.msg[data-who="me"]')).toContainText('check the site')
    await expect(page.locator('.msg[data-who="agent"]')).toContainText('E2E-STUB-OK')

    /* and back, the way the session points */
    await page.locator('.cp-from').click()
    await expect.poll(() => threadIdFromUrl(page)).toBe(parentId)
  })

  test('the session is in the tree behind the count, not a row in the rail', async ({ page }) => {
    const { profile, parentId } = await openParent(page)
    await sendMessage(page, '@secretary E2E-STUB-TOKEN second job')
    await waitForAnswer(page, 'E2E-STUB-OK')
    const session = sessionOf(profile, parentId)

    /* A delegated session would drown the list, so it is not a row. The parent's
       title is the whole message and the session's is only the job, so an exact
       compare against every row title proves the session itself is not painted —
       and the workspace is shared with the other specs, so nothing here counts
       rows. */
    const titles = await page.locator('.rchat-row .rchat-title b').allInnerTexts()
    expect(titles).not.toContain(session.title)

    const count = railRow(page, 'second job').first().locator('.rchat-kids')
    await expect(count).toBeVisible()
    await count.click()

    const dialog = tree(page)
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Spawned sessions')
    const rows = dialog.locator('.spawn-tree-row')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText(session.title)
    await expect(rows.first()).toContainText('secretary')

    /* one click goes to the conversation */
    await rows.first().locator('.spawn-tree-open').click()
    await expect(dialog).toHaveAttribute('data-open', '0')
    await expect.poll(() => threadIdFromUrl(page)).toBe(session.id)

    /* while a session is open the rail marks the conversation it belongs to */
    await expect(railRow(page, 'second job').first()).toHaveAttribute('data-on', '1')
  })

  test('Escape closes the tree without leaving the conversation', async ({ page }) => {
    const { parentId } = await openParent(page)
    await sendMessage(page, '@secretary E2E-STUB-TOKEN third job')
    await waitForAnswer(page, 'E2E-STUB-OK')

    await railRow(page, 'third job').first().locator('.rchat-kids').click()
    await expect(tree(page)).toHaveAttribute('data-open', '1')
    await page.keyboard.press('Escape')
    await expect(tree(page)).toHaveAttribute('data-open', '0')
    expect(threadIdFromUrl(page)).toBe(parentId)
  })
})
