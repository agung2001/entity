import { expect } from '@playwright/test'
import { readProfile, readThread } from './profile.js'

/** Everything a spec needs to drive the chat surface without guessing selectors. */

export async function openChat(page, p = readProfile()) {
  await page.goto(`/${p.workspace}/chat`)
  await expect(page.getByRole('button', { name: 'New chat' })).toBeVisible()
}

export async function openNewThreadDialog(page) {
  await page.getByRole('button', { name: 'New chat' }).click()
  const dialog = page.getByRole('dialog', { name: 'New thread' })
  await expect(dialog).toBeVisible()
  return dialog
}

/**
 * Create a thread through the real dialog: entity, harness, model, Start.
 * The harness picker is only touched when the caller asks for an override.
 */
export async function newThread(page, { entity, harness, machine } = {}) {
  const dialog = await openNewThreadDialog(page)

  await dialog.getByRole('button', { name: /^Entity:/ }).click()
  await dialog.getByRole('option').filter({ hasText: entity }).first().click()

  /* Always choose the machine explicitly. Without this, a test that runs after
     a remote thread inherits that host as its default and silently runs on the
     wrong machine. */
  await dialog.getByRole('button', { name: /^Machine:/ }).click()
  await dialog.locator(`.pickopt[data-val="${machine || 'local'}"]`).click()

  if (harness) {
    await dialog.getByRole('button', { name: /^Harness:/ }).click()
    await dialog.getByRole('option').filter({ hasText: harness }).first().click()
  }

  await dialog.getByRole('button', { name: 'Start thread' }).click()
  await expect(dialog).toHaveAttribute('data-open', '0')
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeEnabled()
  await expect.poll(() => threadIdFromUrl(page), { message: 'thread id in the URL' }).not.toBe('')
  return threadIdFromUrl(page)
}

export function threadIdFromUrl(page) {
  return new URL(page.url()).searchParams.get('thread') || ''
}

export async function readActiveThread(page, p = readProfile()) {
  const id = threadIdFromUrl(page)
  if (!id) throw new Error('No thread id in the URL.')
  await expect
    .poll(() => Boolean(readThread(p, id)), { message: `thread ${id} on disk` })
    .toBe(true)
  return readThread(p, id)
}

export async function sendMessage(page, text) {
  const box = page.getByRole('textbox', { name: 'Message' })
  await expect(box).toBeEnabled()
  await box.fill(text)
  await page.getByRole('button', { name: 'Send message' }).click()
}

/** Wait for an agent row containing `token`; on failure, surface the sys row. */
export async function waitForAnswer(page, token, timeout = 90_000) {
  const answer = page.locator('.msg[data-who="agent"]').filter({ hasText: token })
  try {
    await expect(answer.last()).toBeVisible({ timeout })
  } catch (error) {
    const sys = await page.locator('.ask-sys').allInnerTexts().catch(() => [])
    const replies = await page.locator('.msg[data-who="agent"]').allInnerTexts().catch(() => [])
    throw new Error(
      `No agent answer containing "${token}".\nSystem rows: ${sys.join(' | ') || '(none)'}\n` +
        `Agent rows: ${replies.join(' | ') || '(none)'}\n${error.message}`,
    )
  }
  const sys = page.locator('.ask-sys').filter({ hasText: 'Harness error' })
  await expect(sys).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible()
  return answer.last()
}

export async function waitForAnyAnswer(page, timeout = 180_000) {
  await expect(page.locator('.msg[data-who="agent"]').last()).toBeVisible({ timeout })
  await expect(page.locator('.ask-sys').filter({ hasText: 'Harness error' })).toHaveCount(0)
}

export async function attachFile(page, file) {
  await page.locator('.attach-file-input').first().setInputFiles(file)
}

export async function expectToast(page, text, timeout = 10_000) {
  const toast = page.locator('.toast')
  await expect(toast).toHaveAttribute('data-open', '1', { timeout })
  await expect(toast).toContainText(text, { timeout })
}

export function userMessages(page) {
  return page.locator('.msg[data-who="me"]')
}

export function systemMessages(page) {
  return page.locator('.ask-sys')
}

export function agentMessages(page) {
  return page.locator('.msg[data-who="agent"]')
}
