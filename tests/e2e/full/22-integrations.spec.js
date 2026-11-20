import { test, expect } from '../fixtures.js'

/**
 * Account → Integrations (ENTITY-35).
 *
 * The seeded profile has no `integrations.json`, so every service is off and
 * nothing is spawned — which is also the state the row copy has to be honest
 * about. Only what a browser can actually check lives here.
 *
 * The page reads twice: `integrations.list` paints the rows (the switches), and
 * `integrations.probe` fills the status line afterwards and is cached. The tests
 * hold the second read so the loading state and the settled state can both be
 * observed without racing the machine.
 */
const TOKENS = ['@orca:', '@youtrack:', '@github:']

async function open(page, width) {
  if (width) await page.setViewportSize({ width, height: 900 })
  await page.goto('/account/integrations')
  await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible()
  await expect(page.locator('.int-t .row.int-row')).toHaveCount(3)
}

test.describe('account → integrations', () => {
  test('the roster is a table: mark · status · token · on, and the copy is honest', async ({
    page,
  }) => {
    await open(page)
    /* a real space before `on`: a flex badge trims a plain one (finding F1) */
    const badge = (await page.locator('.int-badge').evaluate((el) => el.textContent)).replace(
      /\u00a0/g,
      ' ',
    )
    expect(badge).toMatch(/^\d+ of 3 on$/)

    /* one separator system: no head border, a top border on every data row */
    expect(await page.locator('.int-t .row.head').evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe(
      '0px',
    )

    for (const row of await page.locator('.int-t .row.int-row').all()) {
      /* four cells: the service, its status line, its @ token, its controls */
      expect(await row.evaluate((el) => el.children.length)).toBe(4)
      const box = await row.locator('.int-switch').boundingBox()
      expect([Math.round(box.width), Math.round(box.height)]).toEqual([44, 44])
      /* every status line is a measurement, never a blank cell */
      expect((await row.locator('.int-state').innerText()).length).toBeGreaterThan(0)
      /* the `@` token is stated once, in the column that owns it */
      const token = await row.locator('.int-token code').innerText()
      expect(TOKENS.some((kind) => kind === token.trim())).toBe(true)
    }
    await expect(page.locator('.int-panel')).toHaveCount(0)
  })

  test('the search narrows the table and can be cleared', async ({ page }) => {
    await open(page)
    const field = page.locator('.int-search input')
    await field.fill('youtrack')
    await expect(page.locator('.int-t .row.int-row')).toHaveCount(1)
    await expect(page.locator('.int-t .row.int-row')).toContainText('YouTrack')
    await field.fill('nothing-here')
    await expect(page.locator('.int-t .row.int-row')).toHaveCount(0)
    await expect(page.locator('.int-noresults')).toContainText('nothing-here')
    await page.locator('.int-noresults .btn').click()
    await expect(page.locator('.int-t .row.int-row')).toHaveCount(3)
  })

  test('the switch is one click, offers an Undo, and the row follows both', async ({ page }) => {
    await open(page)
    const row = page.locator('.int-t .row.int-row').filter({ hasText: '@orca:' })
    const toggle = row.locator('.int-switch')
    const before = await toggle.getAttribute('aria-checked')
    await toggle.click()
    await expect(toggle).not.toHaveAttribute('aria-checked', before)
    const undo = page.locator('.undo-strip')
    await expect(undo).toBeVisible()
    await undo.locator('.undo-btn').click()
    await expect(toggle).toHaveAttribute('aria-checked', before)
  })

  test('YouTrack without a token never flips: it opens its panel and takes focus', async ({
    page,
  }) => {
    await open(page)
    const row = page.locator('.int-t .row.int-row').filter({ hasText: '@youtrack:' })
    const toggle = row.locator('.int-switch')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    const panel = page.locator('.int-panel')
    await expect(panel).toHaveCount(1)
    expect(await panel.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    /* Esc closes it and hands focus back to the disclosure that opened it */
    const disclosure = row.locator('.int-cfg-btn')
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Escape')
    await expect(page.locator('.int-panel')).toHaveCount(0)
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(await disclosure.evaluate((el) => el === document.activeElement)).toBe(true)
  })

  test('the rows paint before the probe answers, and Refresh asks again', async ({ page }) => {
    let release
    const gate = new Promise((done) => (release = done))
    /* hold the status read only: the switches must land without it */
    await page.route('**/__entity/call', async (route) => {
      if (String(route.request().postData() || '').includes('integrations.probe')) await gate
      await route.continue()
    })
    await page.goto('/account/integrations')
    const rows = page.locator('.int-t .row.int-row')
    await expect(rows).toHaveCount(3)
    /* the row says it has not been asked yet instead of inventing a status */
    await expect(page.locator('.int-where')).toContainText('asking')
    /* the gate resolves once, so leaving the route installed is fine: every later
       call continues immediately */
    release()
    await expect(page.locator('.int-where')).toContainText(/just now|cached|ago/)
    const refresh = page.locator('.int-refresh')
    await expect(refresh).toBeEnabled()
    await refresh.click()
    await expect(refresh).toContainText('Refresh')
  })

  test('no horizontal overflow at 1440, 1100, 768 or 360 px', async ({ page }) => {
    for (const width of [1440, 1100, 768]) {
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
