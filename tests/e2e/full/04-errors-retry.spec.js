import fs from 'node:fs'
import path from 'node:path'
import { test, expect, readProfile } from '../fixtures.js'
import { newThread, openChat, sendMessage, waitForAnswer } from '../helpers/app.js'
import { pinHarness } from '../helpers/rpc.js'

/**
 * UAT J01–J03/I05 — failures are real harness outcomes: the transcript says
 * what happened, Retry re-runs the same question, and a recovery is not a new
 * conversation.
 */
test.describe('harness failures and retry', () => {
  test.afterEach(async () => {
    const profile = readProfile()
    await pinHarness('claude', profile.paths.stub)
  })

  test('a signed-out harness is reported and Retry recovers', async ({ page }) => {
    const profile = readProfile()
    await pinHarness('claude', profile.paths.failStub)
    await openChat(page, profile)
    await newThread(page, { entity: 'chief-of-staff' })

    await sendMessage(page, 'E2E-AUTH please answer')
    const error = page.locator('.ask-sys').filter({ hasText: 'is not signed in' })
    await expect(error).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.ask-retry')).toBeVisible()

    await pinHarness('claude', profile.paths.stub)
    await page.locator('.ask-retry').click()
    await waitForAnswer(page, 'E2E-STUB-OK')

    await expect(page.locator('.ask-sys').filter({ hasText: 'is not signed in' })).toHaveCount(0)
    await expect(page.locator('.msg[data-who="me"]')).toHaveCount(1)
  })

  test('a missing harness binary is stated, not simulated', async ({ page }) => {
    const profile = readProfile()
    await openChat(page, profile)
    await newThread(page, { entity: 'chief-of-staff' })

    /* Create the thread while claude is still the known-good stub, then make
       the pinned binary disappear. Pinning a missing path from the start would
       make the New-thread dialog settle on another installed harness. */
    const vanishing = path.join(profile.paths.stubLog, 'vanishing-harness')
    fs.writeFileSync(vanishing, fs.readFileSync(profile.paths.stub, 'utf8'), { mode: 0o755 })
    fs.chmodSync(vanishing, 0o755)
    await pinHarness('claude', vanishing)
    fs.rmSync(vanishing, { force: true })

    await sendMessage(page, 'E2E-MISSING answer?')
    await expect(page.locator('.ask-sys').filter({ hasText: 'not installed' })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.locator('.msg[data-who="agent"]')).toHaveCount(0)

    await pinHarness('claude', profile.paths.stub)
  })

  test('a transient failure can be retried without duplicating the question', async ({ page }) => {
    const profile = readProfile()
    const countFile = path.join(profile.paths.stubLog, 'flaky-count')
    fs.rmSync(countFile, { force: true })
    await pinHarness('claude', profile.paths.flakyStub)
    await openChat(page, profile)
    await newThread(page, { entity: 'chief-of-staff' })

    await sendMessage(page, 'E2E-FLAKY-RETRY please answer')
    await expect(page.locator('.ask-sys').filter({ hasText: 'E2E-FLAKY' })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.locator('.msg[data-who="me"]')).toHaveCount(1)

    await page.locator('.ask-retry').click()
    await waitForAnswer(page, 'E2E-FLAKY-RETRY-OK')
    await expect(page.locator('.msg[data-who="me"]')).toHaveCount(1)

    await pinHarness('claude', profile.paths.stub)
  })
})
