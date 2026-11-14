import fs from 'node:fs'
import path from 'node:path'
import { test, expect, readProfile } from '../fixtures.js'
import { newThread, openChat, sendMessage, waitForAnswer } from '../helpers/app.js'
import { newestPrompt } from '../helpers/profile.js'
import { runCli } from '../helpers/cli.js'

/**
 * UAT F02 + the requested "ask the entity to create a skill" flow.
 *
 * The app has no `skill create` CLI verb; a harness can create the directory the
 * workspace scans. This proves the app accepts and resolves such a skill.
 */
test('@smoke skill creation: an entity writes a workspace skill the app can use', async ({ page }) => {
  const profile = readProfile()
  const skillFile = path.join(profile.workspacePath, 'skills', 'writing-skill', 'SKILL.md')
  fs.rmSync(path.dirname(skillFile), { recursive: true, force: true })

  await openChat(page, profile)
  await newThread(page, { entity: 'chief-of-staff' })
  await sendMessage(page, 'E2E-CREATE-SKILL create a workspace skill called writing-skill')
  await waitForAnswer(page, 'E2E-CREATE-SKILL-DONE')

  await expect.poll(() => fs.existsSync(skillFile)).toBe(true)
  const doc = fs.readFileSync(skillFile, 'utf8')
  expect(doc).toContain('name: writing-skill')
  expect(doc).toContain('description: Created from a chat turn')
  expect(doc).toContain('E2E-WRITING-SKILL-LOADED')

  const listed = runCli(['skill', 'list', '--output', 'json'], { p: profile })
  expect(listed.status).toBe(0)
  expect(listed.json.data.attached).toContain('writing-skill')

  /* The resolver reads the workspace on send, so a typed reference works
     immediately even though the slash menu was built before the skill existed. */
  await newThread(page, { entity: 'chief-of-staff' })
  await sendMessage(page, '/workspace:writing-skill E2E-NEW-SKILL apply it')
  await waitForAnswer(page, 'E2E-STUB-OK')
  expect(newestPrompt(profile)).toContain(
    `use this skill ${path.join(profile.workspacePath, 'skills', 'writing-skill')}`,
  )

  /* The workspace watcher refreshes the slash menu without a reload. */
  await newThread(page, { entity: 'chief-of-staff' })
  const box = page.getByRole('textbox', { name: 'Message' })
  await box.fill('')
  await box.click()
  await box.pressSequentially('/writing')
  await expect(
    page.locator('.ask-cmdbox .ask-cmd').filter({ hasText: '/workspace:writing-skill' }),
  ).toBeVisible()
})
