import { test, expect, readProfile } from '../fixtures.js'
import { expectToast, newThread, openChat, sendMessage, waitForAnswer } from '../helpers/app.js'
import { artifactFile, listArtifacts } from '../helpers/profile.js'
import fs from 'node:fs'

test.describe('artifacts', () => {
  test('a file written during the turn reaches the chat and its own page', async ({ page }) => {
    const profile = readProfile()
    await openChat(page, profile)
    await newThread(page, { entity: 'chief-of-staff' })

    await sendMessage(page, 'E2E-ARTIFACT save a note for me')
    await waitForAnswer(page, 'E2E-ARTIFACT-DONE')

    await expect(
      page.locator('.msg-artifacts--turn').filter({ hasText: 'e2e-turn-note.md' }).first(),
    ).toBeVisible()
    expect(fs.existsSync(artifactFile(profile, 'e2e-turn-note.md'))).toBe(true)

    await page.goto(`/${profile.workspace}/artifacts/e2e-turn-note.md`)
    await expect(page.getByRole('heading', { name: 'e2e-turn-note.md' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Download/ }).first()).toBeVisible()
    await expect(page.getByText('E2E-ARTIFACT-CANARY')).toBeVisible()
  })

  test('a reply can be saved back to the artifact shelf', async ({ page }) => {
    const profile = readProfile()
    await openChat(page, profile)
    await newThread(page, { entity: 'chief-of-staff' })

    await sendMessage(page, 'E2E-SAVE save this answer')
    await waitForAnswer(page, 'E2E-STUB-OK')

    const before = listArtifacts(profile)
    await page.getByRole('button', { name: 'Save response as an artifact' }).last().click()
    await expectToast(page, 'Saved to artifacts')

    await expect
      .poll(() => listArtifacts(profile).filter((id) => id.startsWith('chat-')).length)
      .toBeGreaterThan(0)
    expect(listArtifacts(profile).length).toBeGreaterThan(before.length)
  })
})
