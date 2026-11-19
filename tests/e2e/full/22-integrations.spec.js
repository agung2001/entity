import { test, expect } from '../fixtures.js'

/**
 * Account → Integrations (ENTITY-35).
 *
 * The seeded profile has no `integrations.json`, so every service is off and
 * nothing is spawned — which is also the state the row copy has to be honest
 * about. Only what a browser can actually check lives here.
 */
const TOKENS = ['@orca:', '@youtrack:', '@github:']

async function open(page, width) {
  if (width) await page.setViewportSize({ width, height: 900 })
  await page.goto('/account/integrations')
  await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible()
  await expect(page.locator('li.int-row')).toHaveCount(3)
}

test.describe('account → integrations', () => {
  test('the row is mark · copy · switch, the switch is 44 × 44, the copy is honest', async ({
    page,
  }) => {
    await open(page)
    /* a real space before `on`: a flex badge trims a plain one (finding F1) */
    const badge = (await page.locator('.int-badge').evaluate((el) => el.textContent)).replace(
      /\u00a0/g,
      ' ',
    )
    expect(badge).toMatch(/^\d+ of 3 on$/)
    for (const row of await page.locator('li.int-row').all()) {
      expect(await row.evaluate((el) => el.children.length)).toBe(3)
      const disclosures = row.locator('.int-cfg-btn')
      expect(await disclosures.count()).toBeLessThanOrEqual(1)
      if (await disclosures.count()) {
        expect(await disclosures.first().evaluate((el) => !!el.closest('.int-name'))).toBe(true)
      }
      const box = await row.locator('.int-switch').boundingBox()
      expect([Math.round(box.width), Math.round(box.height)]).toEqual([44, 44])
      /* every state line carries its own @ token, and says unavailable while off */
      const state = await row.locator('.int-state').innerText()
      expect(TOKENS.some((token) => state.includes(token))).toBe(true)
      expect(state).toContain('unavailable')
    }
    await expect(page.locator('li.int-panel')).toHaveCount(0)
  })

  test('YouTrack without a token never flips: it opens its panel and takes focus', async ({
    page,
  }) => {
    await open(page)
    const row = page.locator('li.int-row').filter({ hasText: '@youtrack:' })
    const toggle = row.locator('.int-switch')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    const panel = page.locator('li.int-panel')
    await expect(panel).toHaveCount(1)
    expect(await panel.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    /* Esc closes it and hands focus back to the disclosure that opened it */
    const disclosure = row.locator('.int-cfg-btn')
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Escape')
    await expect(page.locator('li.int-panel')).toHaveCount(0)
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(await disclosure.evaluate((el) => el === document.activeElement)).toBe(true)
  })

  test('the skeleton repeats the row grid, so nothing moves when rows land', async ({ page }) => {
    let release
    const gate = new Promise((done) => (release = done))
    /* hold the one read that decides whether the rows are real */
    await page.route('**/__entity/call', async (route) => {
      if (String(route.request().postData() || '').includes('integrations.list')) await gate
      await route.continue()
    })
    await page.goto('/account/integrations')
    const skeleton = page.locator('li.skel-row').first()
    await expect(skeleton).toBeVisible()
    const grid = (locator) => locator.evaluate((el) => getComputedStyle(el).gridTemplateColumns)
    const whileLoading = await grid(skeleton)
    release()
    const row = page.locator('li.int-row').first()
    await expect(row).toBeVisible()
    expect(await grid(row)).toBe(whileLoading)
  })

  test('no horizontal overflow at 1280, 768 or 360 px', async ({ page }) => {
    for (const width of [1280, 768]) {
      await open(page, width)
      const seen = await page.evaluate(() => [
        document.documentElement.scrollWidth,
        document.documentElement.clientWidth,
      ])
      expect(seen[0], `overflow at ${width}`).toBe(seen[1])
    }
    await open(page, 360)
    const seen = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
      past: [...document.querySelectorAll('body *')]
        .filter((el) => el.getBoundingClientRect().right > 360.5)
        .map((el) => String(el.className || el.tagName)),
    }))
    expect(seen.scroll).toBe(360)
    expect(seen.scroll).toBe(seen.client)
    expect(seen.past).toEqual([])
  })
})
