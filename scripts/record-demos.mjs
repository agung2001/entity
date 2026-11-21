#!/usr/bin/env node
/**
 * Record the README demos against the demo profile.
 *
 * Nothing here touches the real profile: the dev server it talks to is started
 * by `npm run demo`, which seeds the invented profile and points the app at it
 * (see docs/assets/README.md).
 *
 *   npm run demo                          # seeds + serves .tmp/demo/
 *   npm run media:record                  # records against it
 *
 * Each clip is a real interaction (hover, open, fold), recorded as WebM and then
 * encoded to the animated WebP + poster pair the documents reference. An
 * interaction that fails only logs: a clip of the page settling is still honest,
 * a crashed run is not.
 */
import { chromium } from 'playwright'
import { mkdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { encode } from './readme-media.mjs'
import { DEMO } from './demo-profile.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name, fallback = '') => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : fallback
}

/* The demo server binds 127.0.0.1; the recorder default matches it rather than
   `localhost`, which can answer from the other address family on a machine where
   another dev server already owns the port. The clips it records are the demo
   profile's own — `npm run demo` seeds and serves that. */
const BASE = argOf('--url', 'http://127.0.0.1:5183')
const OUT = path.resolve(ROOT, argOf('--out', '.tmp/demo-clips'))
const ONLY = argOf('--only') ? new Set(argOf('--only').split(',').map((s) => s.trim())) : null
/* The account and the workspace come from the seeder: one copy, so the recipe in
   `npm run demo` and the clips here cannot describe different profiles. */
const ACCOUNT = { email: DEMO.email, password: DEMO.password }
const WORKSPACE = DEMO.workspace
const VIEW = { width: 1440, height: 1000 }

const wait = (page, ms) => page.waitForTimeout(ms)

/** Move the pointer to an element's centre, so hover states read on camera. */
async function hover(page, selector, { nth = 0, settle = 550 } = {}) {
  const box = await page.locator(selector).nth(nth).boundingBox({ timeout: 3000 })
  if (!box) throw new Error(`no box for ${selector}`)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 14 })
  await wait(page, settle)
}

async function soft(page, label, fn) {
  try {
    await fn()
  } catch (error) {
    console.log(`  · ${label} skipped: ${error.message.split('\n')[0]}`)
  }
}

const clips = [
  {
    /* the README opening shot: the year, scrolling past */
    name: 'readme-hero',
    async run(page) {
      await page.goto(`${BASE}/${WORKSPACE}/overview`, { waitUntil: 'networkidle' })
      await wait(page, 1500)
      await page.mouse.move(700, 330)
      await page.mouse.wheel(0, 300)
      await wait(page, 1300)
      await page.mouse.wheel(0, 300)
      await wait(page, 1400)
    },
  },
  {
    name: 'workspaces',
    async run(page) {
      await page.goto(`${BASE}/workspaces`, { waitUntil: 'networkidle' })
      await wait(page, 900)
      await hover(page, '.wsl-card', { nth: 0 })
      await hover(page, '.wsl-card', { nth: 2 })
      await page.locator('.wsl-card').nth(2).click()
      await page.waitForURL(/overview|northwind-studio/, { timeout: 15000 })
      await wait(page, 1600)
    },
  },
  {
    name: 'usage',
    async run(page) {
      await page.goto(`${BASE}/${WORKSPACE}/overview`, { waitUntil: 'networkidle' })
      await wait(page, 1400)
      await soft(page, 'spend hover', () => hover(page, 'canvas', { settle: 900 }))
      await soft(page, 'heatmap hover', async () => {
        await page.mouse.wheel(0, 430)
        await wait(page, 700)
        await hover(page, 'canvas', { nth: 1, settle: 900 })
      })
      await wait(page, 700)
    },
  },
  {
    name: 'chat',
    async run(page) {
      await page.goto(`${BASE}/${WORKSPACE}/chat`, { waitUntil: 'networkidle' })
      await wait(page, 1500)
      await soft(page, 'fold', async () => {
        const fold = page.getByText(/1 reasoning|reasoning ·/i).first()
        await fold.click()
        await wait(page, 900)
      })
      await soft(page, 'thread hover', () => hover(page, '.rchat-row', { nth: 1 }))
      await page.mouse.wheel(0, -260)
      await wait(page, 900)
    },
  },
  {
    name: 'timeline',
    async run(page) {
      await page.goto(`${BASE}/${WORKSPACE}/chat`, { waitUntil: 'networkidle' })
      await wait(page, 1400)
      await soft(page, 'open timeline', async () => {
        await page.getByRole('button', { name: /timeline/i }).first().click()
        await wait(page, 1200)
      })
      await soft(page, 'step open', async () => {
        await hover(page, '.td-orow', { nth: 1, settle: 500 })
        await page.locator('.td-orow').nth(1).click()
        await wait(page, 1100)
      })
      await wait(page, 700)
    },
  },
  {
    name: 'entity',
    async run(page) {
      await page.goto(`${BASE}/${WORKSPACE}/entities/campaign-writer`, { waitUntil: 'networkidle' })
      await wait(page, 1300)
      await page.mouse.wheel(0, 300)
      await wait(page, 800)
      await page.mouse.wheel(0, 300)
      await wait(page, 1200)
    },
  },
  {
    name: 'skills',
    async run(page) {
      await page.goto(`${BASE}/${WORKSPACE}/skills`, { waitUntil: 'networkidle' })
      await wait(page, 1200)
      await hover(page, '.rail-t2-row', { nth: 1 })
      await page.mouse.wheel(0, 200)
      await wait(page, 600)
      await soft(page, 'open skill', async () => {
        await page.locator('.rail-t2-row').nth(0).click()
        await wait(page, 1400)
      })
    },
  },
  {
    name: 'mcp',
    async run(page) {
      await page.goto(`${BASE}/${WORKSPACE}/mcp`, { waitUntil: 'networkidle' })
      await wait(page, 1200)
      await hover(page, '.mcp-inv-row', { nth: 0 })
      await hover(page, '.mcp-inv-row', { nth: 3 })
      await soft(page, 'open server', async () => {
        await page.locator('.mcp-inv-row').nth(0).click()
        await wait(page, 1400)
      })
    },
  },
  {
    name: 'machines',
    async run(page) {
      await page.goto(`${BASE}/${WORKSPACE}/machines`, { waitUntil: 'networkidle' })
      await wait(page, 1200)
      await hover(page, '.rail-t2-row', { nth: 1 })
      await hover(page, '.rail-t2-row', { nth: 2 })
      await soft(page, 'open host', async () => {
        await page.locator('.rail-t2-row').nth(1).click()
        await wait(page, 1400)
      })
    },
  },
  {
    name: 'activity',
    async run(page) {
      await page.goto(`${BASE}/${WORKSPACE}/settings?tab=activity`, { waitUntil: 'networkidle' })
      await wait(page, 1400)
      await soft(page, 'row hover', () => hover(page, 'tbody tr', { nth: 1, settle: 800 }))
      await page.mouse.wheel(0, 240)
      await wait(page, 900)
    },
  },
  {
    name: 'artifacts',
    async run(page) {
      await page.goto(`${BASE}/${WORKSPACE}/artifacts/spring-poster.png`, { waitUntil: 'networkidle' })
      await wait(page, 1300)
      await soft(page, 'stage hover', () => hover(page, '[class*="stage"] img, img', { settle: 800 }))
      await page.mouse.wheel(0, 120)
      await wait(page, 800)
    },
  },
  {
    name: 'sound',
    async run(page) {
      await page.goto(`${BASE}/account/sound`, { waitUntil: 'networkidle' })
      await wait(page, 1200)
      await soft(page, 'cue hover', () => hover(page, '[class*="cue"], button', { nth: 2, settle: 500 }))
      await soft(page, 'cue play', async () => {
        await page.locator('[class*="cue"]').nth(2).click().catch(() => {})
        await wait(page, 900)
      })
    },
  },
  {
    name: 'command-palette',
    async run(page) {
      await page.goto(`${BASE}/${WORKSPACE}/overview`, { waitUntil: 'networkidle' })
      await wait(page, 1200)
      await page.keyboard.press('Meta+k')
      await wait(page, 700)
      await page.keyboard.type('spr', { delay: 120 })
      await wait(page, 900)
      await page.keyboard.press('Escape')
      await wait(page, 600)
    },
  },
]

async function main() {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

  const browser = await chromium.launch()
  /* Sign in once, then reuse the session for every clip. */
  const loginContext = await browser.newContext({ viewport: VIEW })
  const loginPage = await loginContext.newPage()
  await loginPage.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  /* A profile that finished first run holds the account on disk: the screen
     offers one click instead of a form. Fall back to the form on a cold hub. */
  const resume = loginPage.getByRole('button', { name: /continue as owner/i })
  if (await resume.count()) {
    await resume.click()
    await loginPage.waitForURL(/\/overview|\/workspaces/, { timeout: 20000 })
  } else {
    await loginPage.fill('input[autocomplete="username"]', ACCOUNT.email)
    await loginPage.fill('input[autocomplete="current-password"]', ACCOUNT.password)
    await Promise.all([
      loginPage.waitForURL(/\/workspaces/, { timeout: 20000 }),
      loginPage.click('button[type="submit"]'),
    ])
  }
  const storage = await loginContext.storageState()
  await loginContext.close()

  const wanted = ONLY ? clips.filter((clip) => ONLY.has(clip.name)) : clips
  for (const clip of wanted) {
    const context = await browser.newContext({
      viewport: VIEW,
      storageState: storage,
      recordVideo: { dir: path.join(OUT, '.raw'), size: VIEW },
    })
    const page = await context.newPage()
    const started = Date.now()
    try {
      await clip.run(page)
    } catch (error) {
      console.log(`  ! ${clip.name}: ${error.message.split('\n')[0]}`)
    }
    const video = page.video()
    await context.close()
    const raw = await video.path()
    const target = path.join(OUT, `${clip.name}.webm`)
    await video.saveAs(target)
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    const size = (statSync(target).size / 1024 / 1024).toFixed(1)
    console.log(`${clip.name.padEnd(16)} ${seconds}s  ${size} MB  → ${path.relative(ROOT, target)}`)
  }
  await browser.close()
  console.log('\nEncode one with: node scripts/readme-media.mjs encode <webm> <name>')
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
