import { test, expect, readProfile } from '../fixtures.js'

/**
 * Workspace → Settings → Artifacts is one page and two shelves.
 *
 * The shared shelf has a rule: ①/② on one histogram, a cadence, the protections
 * and the one machine that runs the pass. Your personal shelf has no rule at all
 * — it is one account's files under `.personal/`, nothing sweeps it and nothing
 * syncs it. They used to share one column, so a personal count sat beside a
 * workspace-wide threshold and the erase section offered three buttons for two
 * different jobs.
 *
 * The address stays `?tab=artifacts`; the shelf is a second axis (`&shelf=`), so
 * a link, a reload and Back all land where the person was.
 */
async function openTab(page, { shelf } = {}) {
  const profile = readProfile()
  const query = shelf ? `?tab=artifacts&shelf=${shelf}` : '?tab=artifacts'
  await page.goto(`/${profile.workspace}/settings${query}`)
  await expect(page.getByRole('heading', { name: 'Artifacts' })).toBeVisible()
  await expect(page.locator('.art-shelves [role="tab"]')).toHaveCount(2)
  return profile
}

const selected = (page) =>
  page.locator('.art-shelves [aria-selected="true"]').evaluate((el) => el.textContent.trim())

test.describe('workspace settings → artifacts', () => {
  test('the card answers one shelf at a time, and the shared one is the default', async ({
    page,
  }) => {
    await openTab(page)
    expect(await selected(page)).toContain('Shared shelf')
    /* the rule belongs to this shelf */
    await expect(page.getByText('The rule ②')).toBeVisible()
    await expect(page.locator('.ages')).toBeVisible()

    await page.locator('.art-shelves [role="tab"]').nth(1).click()
    expect(await selected(page)).toContain('Personal shelf')
    /* and the rule must not follow it: no chart, no thresholds, no cadence */
    await expect(page.getByText('The rule ②')).toHaveCount(0)
    await expect(page.locator('.ages')).toHaveCount(0)
    await expect(page.getByText('When it runs')).toHaveCount(0)
    /* the personal shelf's own sentence, and no promise of a sweep */
    await expect(page.locator('.ret-intro')).toContainText('.personal/')
  })

  test('the second axis lives in the URL, so a reload and a fresh visit keep the shelf', async ({
    page,
  }) => {
    const profile = await openTab(page)
    await page.locator('.art-shelves [role="tab"]').nth(1).click()
    await expect(page).toHaveURL(/shelf=personal/)
    /* still the artifacts tab — the switch must not navigate away from it */
    await expect(page).toHaveURL(/tab=artifacts/)

    /* the switch is a `replace`, not a push: a tab is a place, and Back should
       leave the page rather than walk through every shelf someone tried. */
    await page.reload()
    expect(await selected(page)).toContain('Personal shelf')

    /* a link can name either shelf, and the default still drops the parameter */
    await page.goto(`/${profile.workspace}/settings?tab=artifacts&shelf=shared`)
    await expect(page.locator('.art-shelves [role="tab"]')).toHaveCount(2)
    expect(await selected(page)).toContain('Shared shelf')

    await page.goto(`/${profile.workspace}/settings?tab=artifacts&shelf=nonsense`)
    expect(await selected(page)).toContain('Shared shelf')

    await page.locator('.art-shelves [role="tab"]').nth(1).click()
    await page.locator('.art-shelves [role="tab"]').first().click()
    await expect(page).toHaveURL(/tab=artifacts$/)
  })

  test('the erase section follows the shelf it is about', async ({ page }) => {
    await openTab(page)
    /* shared: its own button, and never the personal one */
    await expect(page.getByRole('button', { name: 'Erase shared' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Erase personal' })).toHaveCount(0)

    await page.locator('.art-shelves [role="tab"]').nth(1).click()
    await expect(page.getByRole('button', { name: 'Erase personal' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Erase shared' })).toHaveCount(0)
    /* "both populations" stays available from either shelf */
    await expect(page.getByRole('button', { name: 'Erase all' })).toBeVisible()
  })

  test('no horizontal overflow on either shelf at 1280, 768 or 360 px', async ({ page }) => {
    for (const width of [1280, 768, 360]) {
      for (const shelf of ['shared', 'personal']) {
        await page.setViewportSize({ width, height: 900 })
        await openTab(page, { shelf })
        const seen = await page.evaluate(() => [
          document.documentElement.scrollWidth,
          document.documentElement.clientWidth,
        ])
        expect(seen[0], `overflow at ${width}px on the ${shelf} shelf`).toBe(seen[1])
      }
    }
  })
})
