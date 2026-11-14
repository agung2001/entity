import { test, expect, readProfile } from '../fixtures.js'
import {
  expectToast,
  newThread,
  openChat,
  sendMessage,
  userMessages,
  waitForAnswer,
} from '../helpers/app.js'
import { newestPrompt } from '../helpers/profile.js'

test.describe('mentions and skills', () => {
  test('two entity mentions run; a third is skipped with a note', async ({ page }) => {
    const profile = readProfile()
    await openChat(page, profile)
    await newThread(page, { entity: 'chief-of-staff' })

    await sendMessage(page, '@mention-a one @mention-b two @mention-c three')
    await waitForAnswer(page, 'E2E-STUB-OK')

    const prompt = newestPrompt(profile)
    expect(prompt).toContain('Resolved mentions')
    expect(prompt).toContain('@mention-a')
    expect(prompt).toContain('@mention-b')
    expect(prompt).toContain('skipped: at most 2 entity mentions per message')
  })

  test('an artifact search with no hits is a note, not a stop', async ({ page }) => {
    const profile = readProfile()
    await openChat(page, profile)
    await newThread(page, { entity: 'chief-of-staff' })

    await sendMessage(page, 'E2E-NOTE-MISS note @artifact:no-such-file')
    await waitForAnswer(page, 'E2E-STUB-OK')

    const prompt = newestPrompt(profile)
    expect(prompt).toContain('matched no file in this workspace')
  })

  test('an email address is prose, not a mention', async ({ page }) => {
    const profile = readProfile()
    await openChat(page, profile)
    await newThread(page, { entity: 'chief-of-staff' })

    await sendMessage(page, 'E2E-EMAIL write to me@example.com and answer briefly')
    await waitForAnswer(page, 'E2E-STUB-OK')

    const prompt = newestPrompt(profile)
    expect(prompt).toContain('me@example.com')
    expect(prompt).not.toContain('Resolved mentions')
  })

  test('@@ is a local mention and resolves like @ on a local thread', async ({ page }) => {
    const profile = readProfile()
    await openChat(page, profile)
    await newThread(page, { entity: 'chief-of-staff' })

    await sendMessage(page, 'E2E-AT-LOCAL use @@artifact:e2e-note')
    await waitForAnswer(page, 'E2E-STUB-OK')

    const prompt = newestPrompt(profile)
    expect(prompt).toContain('Resolved mentions')
    expect(prompt).toContain('artifact://notes/e2e-note.md')
  })

  test('a bare slash name this app does not own is forwarded untouched', async ({ page }) => {
    const profile = readProfile()
    await openChat(page, profile)
    await newThread(page, { entity: 'chief-of-staff' })

    await sendMessage(page, '/review E2E-BARE')
    await waitForAnswer(page, 'E2E-STUB-OK')

    expect(newestPrompt(profile).trim()).toBe('/review E2E-BARE')
  })

  test('an owned skill reference that does not resolve stops the turn', async ({ page }) => {
    await openChat(page)
    await newThread(page, { entity: 'chief-of-staff' })

    await sendMessage(page, '/workspace:ghost E2E-SKILL-MISS go')
    await expectToast(page, 'not a skill this workspace can reach')
    await expect(userMessages(page)).toHaveCount(0)
  })

  test('@mcp with a server outside the pool is refused', async ({ page }) => {
    await openChat(page)
    await newThread(page, { entity: 'chief-of-staff' })

    await sendMessage(page, '@mcp:no-such-server E2E-MCP go')
    await expectToast(page, 'not an enabled server')
    await expect(userMessages(page)).toHaveCount(0)
  })
})
