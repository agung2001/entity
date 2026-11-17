import { test, expect } from '../fixtures.js'
import { newThread, openChat, sendMessage, threadIdFromUrl, waitForAnswer } from '../helpers/app.js'
import { readProfile } from '../helpers/profile.js'
import fs from 'node:fs'
import path from 'node:path'

/**
 * ENTITY-18 — archive is the reversible middle between keeping a thread forever
 * and destroying it: one click, one undo, a collapsed group at the foot of the
 * same list, and no confirm dialog (the guard stays on Delete, which has none).
 */
const working = (page) => page.locator('.rchat-section[data-group="working"] .rchat-row')
const archived = (page) => page.locator('.rchat-section[data-group="archived"] .rchat-row')
const groupHead = (page) => page.locator('.rchat-section[data-group="archived"] .rchat-section-head')

/* Rows accumulate across tests in one workspace, so nothing here hardcodes a
   total: counts are read before the action and compared after it. */
async function openGroup(page) {
  if ((await groupHead(page).getAttribute('aria-expanded')) === 'false') await groupHead(page).click()
  await expect(groupHead(page)).toHaveAttribute('aria-expanded', 'true')
}

async function archiveRow(page, index = 0) {
  await working(page).nth(index).locator('.rchat-dots').click()
  await page.getByRole('menuitem', { name: 'Archive thread' }).click()
  await expect(page.locator('.toast')).toHaveAttribute('data-open', '1')
}

test.describe('archive a thread', () => {
  test('the row leaves the working list, with one click and an Undo', async ({ page }) => {
    const profile = readProfile()
    await openChat(page, profile)
    await newThread(page, { entity: 'chief-of-staff' })
    const id = threadIdFromUrl(page)
    await sendMessage(page, 'E2E-ARCHIVE-TOKEN me')
    await waitForAnswer(page, 'E2E-STUB-OK')

    const before = await working(page).count()
    const archivedBefore = await archived(page).count()
    /* Five items now: Archive sits directly above Delete. */
    const row = working(page).filter({ hasText: 'E2E-ARCHIVE-TOKEN' }).first()
    await row.locator('.rchat-dots').click()
    /* Archive is a first-class item directly above Delete. The list is checked by
       position, not by copying another feature's labels into this spec. */
    const items = (await page.locator('.rchat-menu-item').allInnerTexts()).map((text) =>
      text.trim(),
    )
    expect(items).toHaveLength(5)
    expect(items[0]).toBe('Pin thread')
    expect(items[3]).toBe('Archive thread')
    expect(items[4]).toBe('Delete thread')

    await page.getByRole('menuitem', { name: 'Archive thread' }).click()
    await expect(working(page)).toHaveCount(before - 1)
    await expect(working(page).filter({ hasText: 'E2E-ARCHIVE-TOKEN' })).toHaveCount(0)
    await expect(archived(page)).toHaveCount(archivedBefore + 1)

    /* the header counts the rows above the divider, nothing else */
    await expect(page.locator('.rail-t2-count')).toHaveText(String(before - 1))
    await expect(page.locator('.rchat-section-count')).toHaveText(String(archivedBefore + 1))

    /* the file says archived, and never says `false` */
    const file = path.join(profile.workspacePath, 'chats', `${id}.json`)
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(stored.archived).toBe(true)
    expect(typeof stored.archivedAt).toBe('string')

    /* Undo is the confirmation, and it is exercisable for five seconds */
    await expect(page.locator('.toast')).toContainText('Thread archived')
    await expect(page.locator('.toast-action')).toHaveText('Undo')
    await page.locator('.toast-action').click()
    await expect(working(page).filter({ hasText: 'E2E-ARCHIVE-TOKEN' })).toHaveCount(1)
    await expect(archived(page)).toHaveCount(archivedBefore)
    await expect(page.locator('.rail-t2-count')).toHaveText(String(before))
    expect('archived' in JSON.parse(fs.readFileSync(file, 'utf8'))).toBe(false)
  })

  test('the group expands, restores from the row, and keeps its state', async ({ page }) => {
    await openChat(page, readProfile())
    await newThread(page, { entity: 'chief-of-staff' })
    await sendMessage(page, 'E2E-ARCHIVE-GROUP me')
    await waitForAnswer(page, 'E2E-STUB-OK')

    await archiveRow(page)
    /* collapsed by default: the header is the only thing that says the row is
       below, and nothing else on screen reports it */
    await expect(groupHead(page)).toHaveAttribute('aria-expanded', 'false')
    const mine = page.locator('.rchat-section[data-group="archived"] .rchat-row').first()
    await expect(mine).toBeHidden()
    await openGroup(page)
    await expect(mine).toBeVisible()

    /* the archived row offers Restore where the pin used to be */
    await mine.hover()
    await expect(mine.locator('.rchat-restore')).toBeVisible()
    await mine.locator('.rchat-restore').click()
    await expect(mine).toHaveCount(0)

    /* an archived row's menu has no pin item and offers Restore instead */
    await archiveRow(page)
    await openGroup(page)
    await page.locator('.rchat-section[data-group="archived"] .rchat-dots').first().click()
    const items = (await page.locator('.rchat-menu-item').allInnerTexts()).map((text) =>
      text.trim(),
    )
    /* Restore takes the pin's place: a pin has no effect inside the archive */
    expect(items).toHaveLength(4)
    expect(items[0]).toBe('Restore thread')
    expect(items[3]).toBe('Delete thread')
  })

  test('a query opens the group and counts matches', async ({ page }) => {
    await openChat(page, readProfile())
    await newThread(page, { entity: 'chief-of-staff' })
    await sendMessage(page, 'E2E-ARCHIVE-QUERY me')
    await waitForAnswer(page, 'E2E-STUB-OK')
    await archiveRow(page)
    const archivedRows = await archived(page).count()

    const search = page.getByRole('searchbox', { name: 'Search threads' })
    await search.fill('E2E-ARCHIVE-QUERY')
    /* an empty result while an archived thread matches would be a lie */
    await expect(groupHead(page)).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('.rchat-section-count')).toHaveText('1 match')
    await expect(page.locator('.rchat-empty')).toHaveCount(0)

    await search.fill('')
    await expect(groupHead(page)).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('.rchat-section-count')).toHaveText(String(archivedRows))
  })

  test('Escape closes the menu and hands focus back', async ({ page }) => {
    await openChat(page, readProfile())
    const dots = working(page).first().locator('.rchat-dots')
    await dots.click()
    await expect(page.locator('.rchat-menu-pop')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.locator('.rchat-menu-pop')).toHaveCount(0)
    /* focus returns to the control that opened it, not to the page */
    await expect(dots).toBeFocused()
  })

  test('an archived row keeps its pin but does not advertise one', async ({ page }) => {
    await openChat(page, readProfile())
    await newThread(page, { entity: 'chief-of-staff' })
    await sendMessage(page, 'E2E-ARCHIVE-PIN me')
    await waitForAnswer(page, 'E2E-STUB-OK')

    const row = working(page).filter({ hasText: 'E2E-ARCHIVE-PIN' }).first()
    await row.locator('.rchat-dots').click()
    await page.getByRole('menuitem', { name: 'Pin thread' }).click()
    await expect(row).toHaveAttribute('data-pinned', '1')
    await expect(row.locator('.rchat-pin')).toHaveCount(1)

    await row.locator('.rchat-dots').click()
    await page.getByRole('menuitem', { name: 'Archive thread' }).click()
    await openGroup(page)
    const archivedRow = archived(page).filter({ hasText: 'E2E-ARCHIVE-PIN' }).first()
    /* the archive ignores the pin, so the glyph would claim an order the list
       is not in — the field itself survives for the trip back */
    await expect(archivedRow).toHaveAttribute('data-pinned', '1')
    await expect(archivedRow.locator('.rchat-pin')).toHaveCount(0)

    await archivedRow.locator('.rchat-dots').click()
    await page.getByRole('menuitem', { name: 'Restore thread' }).click()
    await expect(working(page).filter({ hasText: 'E2E-ARCHIVE-PIN' }).locator('.rchat-pin')).toHaveCount(1)
  })

  test('Archive is disabled while the turn is running, and looks it', async ({ page }) => {
    await openChat(page, readProfile())
    await newThread(page, { entity: 'chief-of-staff' })
    await sendMessage(page, 'E2E-SLOW archive cannot interrupt')
    await expect(page.locator('.msg-trace--live')).toBeVisible({ timeout: 20_000 })

    await working(page).first().locator('.rchat-dots').click()
    const archive = page.getByRole('menuitem', { name: 'Archive thread' })
    await expect(archive).toBeDisabled()
    /* F6: a disabled menu item used to be pixel-identical to an enabled one */
    const dimmed = await archive.evaluate((el) => Number(getComputedStyle(el).opacity))
    const enabled = await page
      .getByRole('menuitem', { name: 'Rename thread' })
      .evaluate((el) => Number(getComputedStyle(el).opacity))
    expect(dimmed).toBeLessThan(enabled)
    expect(await archive.evaluate((el) => getComputedStyle(el).cursor)).toBe('not-allowed')

    await page.getByRole('button', { name: 'Stop agent' }).click()
    await expect(page.locator('.ask-sys').filter({ hasText: 'Stopped by you.' })).toBeVisible({
      timeout: 20_000,
    })
  })
})
