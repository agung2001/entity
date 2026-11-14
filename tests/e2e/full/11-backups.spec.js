import fs from 'node:fs'
import path from 'node:path'
import { test, expect, readProfile, ROOT } from '../fixtures.js'

test.describe('workspace backups', () => {
  test('ZIP backups land in the chosen folder and a snapshot restores', async ({ page }) => {
    const profile = readProfile()
    const target = path.join(ROOT, '.tmp', 'e2e-backup-target')
    fs.rmSync(target, { recursive: true, force: true })

    await page.goto('/account/backups')
    await expect(page.getByRole('heading', { name: 'Workspace backups' })).toBeVisible()

    const panel = page.locator('.backups-page')
    await panel.locator('.bkp-mode').filter({ hasText: 'Smart' }).click()
    await expect(panel.getByRole('radio', { name: /Smart/ })).toBeChecked()

    /* The browser suite cannot open a native folder picker; the path input is
       the same setting the desktop picker writes. */
    const folder = panel.getByLabel('Backup folder')
    await folder.fill(target)
    await panel.getByRole('button', { name: 'Apply' }).click()
    await expect(page.locator('.toast')).toContainText('Backup folder saved')
    await expect(folder).toHaveValue(target)

    await panel.getByRole('button', { name: 'Back up now' }).click()
    await expect(page.locator('.toast')).toContainText('Workspace backed up', { timeout: 30_000 })

    const zips = fs
      .readdirSync(path.join(target, profile.workspace))
      .filter((name) => name.endsWith('.zip'))
    expect(zips.length).toBeGreaterThan(0)

    const manual = panel.locator('.bkp-row').filter({ hasText: 'manual' }).first()
    await expect(manual).toBeVisible()

    await panel.locator('.bkp-mode').filter({ hasText: 'Weekly' }).click()
    await expect(panel.getByRole('radio', { name: /Weekly/ })).toBeChecked()
    await expect(page.locator('.toast')).toContainText('Backup schedule: Weekly')

    await page.reload()
    await expect(page.getByRole('heading', { name: 'Workspace backups' })).toBeVisible()
    await expect(page.locator('.backups-page').getByRole('radio', { name: /Weekly/ })).toBeChecked()
    await expect(page.locator('.backups-page').getByLabel('Backup folder')).toHaveValue(target)

    const beforeRestore = await page.locator('.bkp-select select option').count()
    await page.locator('.backups-page').getByRole('button', { name: 'Restore' }).first().click()
    await expect(page.locator('.toast')).toContainText('restored', { timeout: 30_000 })
    await expect
      .poll(() => page.locator('.bkp-select select option').count())
      .toBeGreaterThan(beforeRestore)

    const row = page
      .locator('.backups-page .bkp-row')
      .filter({ hasText: 'manual' })
      .first()
    const beforeDelete = await page.locator('.backups-page .bkp-row').count()
    await row.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(row.getByRole('button', { name: 'Delete?' })).toBeVisible()
    await row.getByRole('button', { name: 'Delete?' }).click()
    await expect(page.locator('.toast')).toContainText('Backup deleted')
    await expect
      .poll(() => page.locator('.backups-page .bkp-row').count())
      .toBe(beforeDelete - 1)
  })
})
