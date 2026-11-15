import { test, expect } from '../fixtures.js'
import { newThread, openChat } from '../helpers/app.js'

/**
 * Voice mode is a browser surface: the module that reads the microphone, the
 * synthesizer and the engine ladder only exists in a page. These two paths are
 * the ones a static check cannot cover — the dialog opens from the composer
 * (before Composer help), `Esc` closes it like every other surface, and a typed
 * message still reaches the entity when no microphone is present.
 */
test.describe('voice mode', () => {
  test.use({ permissions: ['microphone'] })

  test('opens from the composer as a full dialog and closes on Escape', async ({ page }) => {
    /* opening the surface must not throw: a missing handler in the engine setup
       used to leave the dialog open with no microphone and no message */
    const errors = []
    page.on('pageerror', (error) => errors.push(String(error)))

    await openChat(page)
    await newThread(page, { entity: 'chief-of-staff' })

    const trigger = page.getByRole('button', { name: /^Voice mode/ })
    await expect(trigger).toBeVisible()

    /* the button is the one immediately before Composer help in the dock */
    const order = await page
      .locator('.cp-picks')
      .evaluate((dock) => [...dock.querySelectorAll('button')].map((b) => b.className))
    expect(order.at(-1)).toContain('compose-help')
    expect(order.at(-2)).toContain('compose-voice')

    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'Voice mode' })
    await expect(dialog).toHaveAttribute('data-open', '1')
    await expect(dialog.locator('.voice-emoji')).toBeVisible()
    await expect(dialog.locator('.voice-figure .mark')).toBeVisible()
    await expect(dialog.locator('.voice-meta')).toContainText('to toggle')
    /* the engine is named, not assumed */
    await expect(dialog.locator('.voice-meta')).toContainText(/Browser speech|Local|Typing/)

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveAttribute('data-open', '0')
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(errors).toEqual([])
  })

  test('the catalog shortcut toggles it, and typing still sends a turn', async ({ page }) => {
    await openChat(page)
    await newThread(page, { entity: 'chief-of-staff' })

    const dialog = page.getByRole('dialog', { name: 'Voice mode' })

    /* inside a text field the native combo is paste-as-plain: leave it alone */
    await page.getByRole('textbox', { name: 'Message' }).click()
    await page.keyboard.press('Control+Shift+V')
    await expect(dialog).toHaveAttribute('data-open', '0')

    /* the tab uses the catalog's browser variant */
    await page.keyboard.press('Alt+Shift+V')
    await expect(dialog).toHaveAttribute('data-open', '1')

    const token = 'E2E-VOICE-TOKEN'
    await dialog.getByRole('textbox', { name: 'Type instead' }).fill(`${token} from voice`)
    await dialog.getByRole('button', { name: 'Send' }).click()

    await expect(page.locator('.c-thread')).toContainText(`${token} from voice`)
    await expect(page.locator('.c-thread')).toContainText('E2E-STUB-OK')

    /* the answer is also written in the dialog, so a hard-to-follow voice is
       still readable while it speaks */
    await expect(dialog.locator('.voice-reply')).toContainText('E2E-STUB-OK')

    /* the shortcut closes what it opened, even with focus inside the dialog */
    await page.keyboard.press('Alt+Shift+V')
    await expect(dialog).toHaveAttribute('data-open', '0')

    /* outside a text field the native combo works too, so people who try the
       shortcut on the page do not conclude it is broken */
    await page.locator('.cp-id-meta').click()
    await page.keyboard.press('Control+Shift+V')
    await expect(dialog).toHaveAttribute('data-open', '1')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveAttribute('data-open', '0')
  })

  test('speaking while a turn runs interrupts it and keeps the new context', async ({ page }) => {
    await openChat(page)
    await newThread(page, { entity: 'chief-of-staff' })

    await page.getByRole('button', { name: /^Voice mode/ }).click()
    const dialog = page.getByRole('dialog', { name: 'Voice mode' })
    await expect(dialog).toHaveAttribute('data-open', '1')

    /* E2E-SLOW is the stub that keeps working until it is stopped */
    const field = dialog.getByRole('textbox', { name: 'Type instead' })
    await field.fill('E2E-SLOW start the long turn')
    await dialog.getByRole('button', { name: 'Send' }).click()

    /* the turn is genuinely in flight before the second utterance */
    await expect(page.locator('.msg-live-status')).toBeVisible()
    await expect(dialog.locator('.voice-status')).toContainText('Working')

    const token = 'E2E-INTERRUPT-TOKEN'
    await field.fill(`${token} use the staging branch instead`)
    await dialog.getByRole('button', { name: 'Send' }).click()

    /* the running turn is cancelled, and the new words become the next turn */
    await expect(page.locator('.c-thread')).toContainText('Stopped by you.')
    await expect(page.locator('.c-thread')).toContainText(`${token} use the staging branch instead`)
    await expect(page.locator('.c-thread')).toContainText('E2E-STUB-OK')
  })

  test('a finished answer can be read aloud from the thread', async ({ page }) => {
    await openChat(page)
    await newThread(page, { entity: 'chief-of-staff' })
    await page.getByRole('textbox', { name: 'Message' }).fill('E2E-READ-ALOUD hello')
    await page.keyboard.press('Control+Enter')
    await expect(page.locator('.c-thread')).toContainText('E2E-STUB-OK')

    const readButton = page.getByRole('button', { name: 'Read response aloud' }).last()
    await expect(readButton).toBeVisible()
    /* the action sits with copy, share and save, and toggles its own state */
    await readButton.click()
    const stopButton = page.getByRole('button', { name: 'Stop reading' }).last()
    await expect(stopButton).toBeVisible()
    await expect(stopButton).toHaveAttribute('aria-pressed', 'true')
    await stopButton.click()
    await expect(page.getByRole('button', { name: 'Read response aloud' }).last()).toBeVisible()
  })
})
