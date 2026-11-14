import { test, expect, readProfile } from '../fixtures.js'
import { newThread, openChat, sendMessage, waitForAnswer } from '../helpers/app.js'
import { logsMatching, newestMeta } from '../helpers/profile.js'

/**
 * UAT D01/D02/D04 — the headline "the entity can reach files outside its
 * workspace": the harness runs with cwd = the entity's dir, which is outside
 * the workspace, and can read relative and spaced paths from there.
 *
 * The stub records what it read, so this does not depend on a model quoting the
 * canary correctly. A real model's file tools are a separate (manual) check.
 */
test('@smoke external files: the harness cwd and reads are outside the workspace', async ({ page }) => {
  const profile = readProfile()
  await openChat(page, profile)
  await newThread(page, { entity: 'chief-of-staff' })

  await sendMessage(page, 'E2E-READ-EXTERNAL read the brief in your working directory')
  await waitForAnswer(page, 'E2E-EXTERNAL-OK')

  const meta = newestMeta(profile)
  expect(meta).toContain(`cwd: ${profile.paths.external}`)
  expect(meta).not.toContain(`cwd: ${profile.workspacePath}`)

  const reads = logsMatching(profile, '.external', 'E2E-EXTERNAL-CANARY-42')
  expect(reads.length).toBeGreaterThan(0)
  expect(reads.at(-1)).toContain('E2E-NESTED-CANARY-9')
  expect(reads.at(-1)).toContain('E2E-SPACE-CANARY-7')
})
