import { test, expect, readProfile } from '../fixtures.js'
import {
  newThread,
  openChat,
  readActiveThread,
  sendMessage,
  waitForAnswer,
} from '../helpers/app.js'

const token = 'E2E-TITLE-TOKEN'

test.describe('thread lifecycle', () => {
  test('title is automatic, renameable and reversible', async ({ page }) => {
    await openChat(page)
    await newThread(page, { entity: 'chief-of-staff' })
    await sendMessage(page, `${token} give me a title`)
    await waitForAnswer(page, 'E2E-STUB-OK')

    const title = page.locator('.cp-title')
    await expect(title).toContainText(token)

    await title.click()
    const input = page.locator('.cp-title-input')
    await input.fill('UAT renamed thread')
    await input.press('Enter')
    await expect(page.locator('.cp-title')).toHaveText('UAT renamed thread')

    await page.locator('.cp-title').click()
    await page.locator('.cp-title-input').fill('')
    await page.locator('.cp-title-input').press('Enter')
    await expect(page.locator('.cp-title')).toContainText(token)
  })

  test('pin and delete a thread from the rail', async ({ page }) => {
    const pinToken = 'E2E-PIN-TOKEN'
    await openChat(page)
    await newThread(page, { entity: 'chief-of-staff' })
    await sendMessage(page, `${pinToken} pin me`)
    await waitForAnswer(page, 'E2E-STUB-OK')

    const row = page.locator('.rchat-row').filter({ hasText: pinToken }).first()
    await expect(row).toBeVisible()

    await row.locator('.rchat-dots').click()
    await page.getByRole('menuitem', { name: 'Pin thread' }).click()
    await expect(row).toHaveAttribute('data-pinned', '1')
    await expect(row.locator('[aria-label="Pinned"]')).toBeVisible()

    await row.locator('.rchat-dots').click()
    await page.getByRole('menuitem', { name: 'Unpin thread' }).click()
    await expect(row).toHaveAttribute('data-pinned', '0')

    await row.locator('.rchat-dots').click()
    await page.getByRole('menuitem', { name: 'Delete thread' }).click()
    await page.getByRole('menuitem', { name: 'Click again to delete' }).click()
    await expect(page.locator('.rchat-row').filter({ hasText: pinToken })).toHaveCount(0)
  })

  test('rail search narrows by title and shows an honest empty state', async ({ page }) => {
    const searchToken = 'E2E-RAIL-TOKEN'
    await openChat(page)
    await newThread(page, { entity: 'chief-of-staff' })
    await sendMessage(page, `${searchToken} find me in the rail`)
    await waitForAnswer(page, 'E2E-STUB-OK')

    const search = page.getByRole('searchbox', { name: 'Search threads' })
    await search.fill(searchToken)
    await expect(page.locator('.rchat-row').filter({ hasText: searchToken })).toBeVisible()
    await expect(page.locator('.rchat-row')).toHaveCount(1)

    await search.fill('zzzz-no-such-thread-zzzz')
    /* the shipped sentence names all three filters: search, tag and time */
    await expect(page.locator('.rchat-empty')).toContainText('match this search, tag and time filter')
    await page.getByRole('button', { name: 'Clear search' }).click()
  })

  test('the rail says what copy means here, and copies exactly that', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await openChat(page)
    await newThread(page, { entity: 'chief-of-staff' })
    await sendMessage(page, 'E2E-RAIL-COPY me')
    await waitForAnswer(page, 'E2E-STUB-OK')

    const row = page.locator('.rchat-row').filter({ hasText: 'E2E-RAIL-COPY' }).first()
    const id = new URL(page.url()).searchParams.get('thread')
    await row.locator('.rchat-dots').click()
    /* a browser tab can share a URL, and the label says so */
    const item = page.getByRole('menuitem', { name: 'Copy link' })
    await expect(item).toBeVisible()
    await item.click()

    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toContain('/chat?thread=')
    expect(copied).toContain(id)
    /* the old behaviour pasted a quoted reference block instead */
    expect(copied.startsWith('>')).toBe(false)
  })

  test('the new-thread dialog opens on the first picker and starts with the combo', async ({ page }) => {
    await openChat(page)
    await page.keyboard.press('Meta+KeyN')
    await expect(page.locator('.newthread-modal')).toHaveAttribute('data-open', '1')
    /* focus is on the entity picker, not lost on the page behind it */
    await expect(page.locator('.newthread-modal .pickbtn').first()).toBeFocused()

    const before = await page.locator('.rchat-row').count()
    await page.keyboard.press('Meta+Enter')
    await expect(page.locator('.newthread-modal')).toHaveAttribute('data-open', '0')
    await expect(page.locator('.rchat-row')).toHaveCount(before + 1)
  })

  test('a deep link opens the named message; a dead link falls back', async ({ page }) => {
    const deepToken = 'E2E-DEEP-TOKEN'
    const profile = readProfile()
    await openChat(page, profile)
    const id = await newThread(page, { entity: 'chief-of-staff' })
    await sendMessage(page, `${deepToken} deep link target`)
    await waitForAnswer(page, 'E2E-STUB-OK')

    await page.goto(`/${profile.workspace}/chat?thread=${id}&msg=0`)
    await expect(page.locator('.msg[data-who="me"]').first()).toContainText(deepToken)
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible()

    await page.goto(`/${profile.workspace}/chat?thread=t_dead_uat_link`)
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible()
    await expect(page).not.toHaveURL(/t_dead_uat_link/)
    const stored = await readActiveThread(page, profile)
    expect(stored.messages.length).toBeGreaterThan(0)
  })
})
