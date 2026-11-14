import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test as base, expect } from '@playwright/test'

/**
 * The one fixture every E2E test starts from.
 *
 * The dev server seeds a throwaway profile (see tests/support/e2e-server.mjs).
 * Instead of driving the sign-in form in every test, the context starts with
 * exactly the session the app persists after a real sign-in — no password, no
 * token, nothing to leak in the repository. `restoreSession()` still validates
 * the identity against the seeded auth.json before the router trusts it.
 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export function readProfile() {
  const file = path.join(ROOT, '.tmp', 'e2e', 'profile.json')
  if (!fs.existsSync(file)) {
    throw new Error(`E2E profile is missing at ${file}. Start the suite through Playwright (npm run test:smoke).`)
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export const test = base.extend({
  context: async ({ browser }, use) => {
    const p = readProfile()
    const origin = new URL(p.baseURL).origin
    const session = {
      user: p.user.username,
      email: p.user.email,
      role: 'owner',
      at: new Date().toISOString(),
    }
    const context = await browser.newContext({
      baseURL: p.baseURL,
      locale: 'en-US',
      viewport: { width: 1440, height: 900 },
      storageState: {
        cookies: [],
        origins: [
          {
            origin,
            localStorage: [
              { name: 'entity.session', value: JSON.stringify(session) },
              { name: 'entity.workspace', value: p.workspace },
              { name: 'entity.theme', value: 'light' },
              {
                name: 'entity.notifications',
                value: JSON.stringify({
                  enabled: false,
                  replies: false,
                  errors: false,
                  backgroundOnly: true,
                }),
              },
            ],
          },
        ],
      },
    })
    await use(context)
    await context.close()
  },
})

export { expect }
