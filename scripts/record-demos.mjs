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
/* `--encode` finishes the job the recorder started: the clip is written, then the
   one encoder in `readme-media.mjs` turns it into the `.webp` + poster pair the
   documents reference. Re-recording one clip is one command. */
const ENCODE = args.includes('--encode')
/* The account and the workspace come from the seeder: one copy, so the recipe in
   `npm run demo` and the clips here cannot describe different profiles. */
const ACCOUNT = { email: DEMO.email, password: DEMO.password }
const WORKSPACE = DEMO.workspace
const VIEW = { width: 1440, height: 1000 }

/* The hub keeps an SSE stream open for the life of the page, so `networkidle` can
   never settle and a `goto` that waits for it hangs forever. Every clip already
   waits explicitly after loading; this makes the load itself bounded, and a
   selector that never appears fails inside the 8 s default instead of stalling
   the whole run. */
const LOAD = { waitUntil: 'domcontentloaded' }

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
      await page.goto(`${BASE}/${WORKSPACE}/overview`, LOAD)
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
      await page.goto(`${BASE}/workspaces`, LOAD)
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
      await page.goto(`${BASE}/${WORKSPACE}/overview`, LOAD)
      await wait(page, 1400)
      /* The year is one heatmap: an SVG whose cells are `<rect>`s. The poster is
         taken halfway through, so the page is scrolled to the `This year` block
         *before* the recording starts settling — otherwise the frame is the hero
         again and the picture teaches nothing. */
      /* `scrollIntoViewIfNeeded` is a no-op when the block is already partly in
         view — and it is, at the bottom of a 1000 px window — so the block is
         centred explicitly and the poster frame is then the heatmap and its four
         tiles, not the hero. */
      await page.evaluate(() => {
        const head = [...document.querySelectorAll('h2')].find((el) => /this year/i.test(el.textContent || ''))
        const target = head?.closest('section') || head
        target?.scrollIntoView({ block: 'center' })
      })
      await wait(page, 1100)
      await soft(page, 'heatmap hover', async () => {
        const box = await page.locator('.hm').boundingBox()
        if (!box) throw new Error('no heatmap')
        await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.5, { steps: 14 })
        await wait(page, 900)
        await page.mouse.move(box.x + box.width * 0.78, box.y + box.height * 0.3, { steps: 14 })
        await wait(page, 900)
      })
      await wait(page, 500)
    },
  },
  {
    name: 'chat',
    async run(page) {
      await page.goto(`${BASE}/${WORKSPACE}/chat`, LOAD)
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
      await page.goto(`${BASE}/${WORKSPACE}/chat`, LOAD)
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
      await page.goto(`${BASE}/${WORKSPACE}/entities/campaign-writer`, LOAD)
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
      await page.goto(`${BASE}/${WORKSPACE}/skills`, LOAD)
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
    /* An MCP server is a connector row now, so `/mcp` redirects into the roster
       and one server's own page is `connectors/:id`. This profile's servers point
       at invented hosts, so none of them can report a tool list — the clip shows
       what the page does say: the transport and binding, the state chip with its
       reason, and the mention the row offers. */
    name: 'mcp',
    async run(page) {
      await page.goto(`${BASE}/${WORKSPACE}/settings?tab=connectors`, LOAD)
      await wait(page, 1500)
      /* Narrowed to the two non-account kinds, so the picture is the workspace's
         MCP servers and CLI rows — a healthy roster — rather than one server whose
         invented token was rejected (`needs a token · error`). The frame teaches
         the set, not a failure state. */
      await soft(page, 'kind filter', async () => {
        const seg = page.locator('.conn-bar button', { hasText: /^\s*mcp\s/i }).first()
        if (await seg.count()) await seg.click()
        else throw new Error('no mcp segment')
        await wait(page, 900)
      })
      await soft(page, 'row hover', () => hover(page, '.ct-row', { nth: 0, settle: 700 }))
      await soft(page, 'row hover 2', () => hover(page, '.ct-row', { nth: 2, settle: 700 }))
      await wait(page, 500)
    },
  },
  {
    name: 'machines',
    async run(page) {
      await page.goto(`${BASE}/${WORKSPACE}/machines`, LOAD)
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
    /* the roster: one row per connector, an MCP row beside a CLI row beside
       three that carry accounts */
    name: 'connectors',
    async run(page) {
      await page.goto(`${BASE}/${WORKSPACE}/settings?tab=connectors`, LOAD)
      await wait(page, 1400)
      await soft(page, 'row hover', () => hover(page, '.ct-row', { nth: 2 }))
      await hover(page, '.ct-row', { nth: 4 })
      await soft(page, 'built-in pane', async () => {
        await page.getByRole('tab', { name: /built-in/i }).click()
        await wait(page, 1200)
      })
      await wait(page, 500)
    },
  },
  {
    /* one account-bearing connector's page: the accounts card, then the tier
       selector, whose three tiers are the answer to "how much access" */
    name: 'connector-accounts',
    async run(page) {
      await page.goto(`${BASE}/${WORKSPACE}/connectors/gmail`, LOAD)
      await wait(page, 1400)
      await soft(page, 'account hover', () => hover(page, '.acct-row', { nth: 1 }))
      await soft(page, 'tier selector', async () => {
        await hover(page, '.acct-tier', { nth: 2, settle: 700 })
        await wait(page, 600)
      })
      await wait(page, 500)
    },
  },
  {
    /* Account → Harnesses: the machine's own CLIs, one switch each. A toggle is
       never photographed as the interaction — the switch writes a real file — so
       the clip hovers the row and the switch beside it.

       The roster is filtered to one letter, and that is not decoration: this page
       prints each CLI's resolved path, and on the machine that served this demo
       two of the eight sat under a home directory (a version-manager install),
       which would publish a username in a README image. The hero meter above the
       list still reports the whole machine (`6 / 8 installed`), so the picture
       states the total and shows only rows whose path is a system prefix. */
    name: 'account-harnesses',
    async run(page) {
      await page.goto(`${BASE}/account/harnesses`, LOAD)
      await wait(page, 1600)
      await soft(page, 'filter', async () => {
        const box = page.locator('.harness-search input').first()
        await box.fill('')
        await box.type('c', { delay: 120 })
        await wait(page, 900)
      })
      await soft(page, 'row hover', () => hover(page, '.harness-row', { nth: 1, settle: 700 }))
      await soft(page, 'switch hover', () => hover(page, '.harness-switch', { nth: 2, settle: 700 }))
      await soft(page, 'path button hover', () => hover(page, '.harness-path-btn', { nth: 1, settle: 600 }))
      await wait(page, 500)
    },
  },
  {
    name: 'activity',
    async run(page) {
      await page.goto(`${BASE}/${WORKSPACE}/settings?tab=activity`, LOAD)
      await wait(page, 1600)
      /* The pulse plot is bars over days; the journal below it is one `.jr` row
         per turn. Hover one of each, then nudge the page so the journal reads. */
      await soft(page, 'pulse hover', () => hover(page, '.act-bar', { nth: 6, settle: 700 }))
      await soft(page, 'row hover', async () => {
        await page.mouse.wheel(0, 240)
        await wait(page, 700)
        await hover(page, '.jr', { nth: 0, settle: 800 })
      })
      await wait(page, 700)
    },
  },
  {
    name: 'artifacts',
    async run(page) {
      await page.goto(`${BASE}/${WORKSPACE}/artifacts/spring-poster.png`, LOAD)
      await wait(page, 1300)
      await soft(page, 'stage hover', () => hover(page, '[class*="stage"] img, img', { settle: 800 }))
      await page.mouse.wheel(0, 120)
      await wait(page, 800)
    },
  },
  {
    name: 'sound',
    async run(page) {
      await page.goto(`${BASE}/account/sound`, LOAD)
      await wait(page, 1200)
      await soft(page, 'cue hover', () => hover(page, '[class*="cue"], button', { nth: 2, settle: 500 }))
      await soft(page, 'cue play', async () => {
        await page.locator('[class*="cue"]').nth(2).click().catch(() => {})
        await wait(page, 900)
      })
      /* The last pointer position before the poster is taken must not be the
         theme toggle in the bar — its tooltip reads `Switch to dark (⌥⇧L)` and
         lands bottom-left over the picture. Park it on the page body instead. */
      await page.mouse.move(900, 760, { steps: 10 })
      await wait(page, 900)
    },
  },
  {
    name: 'command-palette',
    async run(page) {
      await page.goto(`${BASE}/${WORKSPACE}/overview`, LOAD)
      await wait(page, 1200)
      await page.keyboard.press('Meta+k')
      await wait(page, 700)
      await page.keyboard.type('spr', { delay: 120 })
      await wait(page, 900)
      await page.keyboard.press('Escape')
      await wait(page, 600)
    },
  },
  {
    /* `New thread → Start from a folder` pins a project directory, and the
       composer then shows it beside the harness with `/` listing what that
       folder carries. The folder here is the seeded `spring-catalogue`, so the
       thread is the one already started in it. */
    name: 'folder',
    async run(page) {
      await page.goto(`${BASE}/${WORKSPACE}/chat?thread=t_demo_catalogue`, LOAD)
      await wait(page, 2200)
      /* `Scanning skill libraries…` is a loading banner over the composer. Wait for
         it to leave, or the poster is a spinner instead of the folder. */
      await page
        .locator('.ask-cmd-loading')
        .first()
        .waitFor({ state: 'detached', timeout: 15000 })
        .catch(() => {})
      await wait(page, 600)
      await soft(page, 'folder pill hover', () => hover(page, '.cp-dir', { settle: 800 }))
      await soft(page, 'slash menu', async () => {
        await page.locator('.cp-compose textarea, textarea').first().click()
        await page.keyboard.insertText('/')
        await wait(page, 1100)
        await hover(page, '.ask-cmd', { nth: 0, settle: 800 })
      })
      await wait(page, 600)
    },
  },
  {
    /* Learning reads the thread history and proposes a replacement brief. The
       dialog opens on its scope form; the review itself costs a harness run, so
       the clip shows the scope and the dialog's own chrome rather than inventing
       an answer. */
    name: 'learning',
    async run(page) {
      await page.goto(`${BASE}/${WORKSPACE}/entities/campaign-writer`, LOAD)
      await wait(page, 1800)
      await soft(page, 'open learning', async () => {
        await page.getByRole('button', { name: /^\s*Learning\s*$/ }).first().click()
        await wait(page, 1300)
      })
      await soft(page, 'preset hover', () => hover(page, '.learn-presets .btn', { nth: 1, settle: 700 }))
      await soft(page, 'date field hover', () => hover(page, '.learn-field--date input', { nth: 0, settle: 600 }))
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
  /* The login card mounts a fetch after first paint, so `domcontentloaded` plus a
     short settle is the reliable read — the same reason every clip uses `LOAD`. */
  loginPage.setDefaultTimeout(8000)
  await loginPage.goto(`${BASE}/login`, LOAD)
  await wait(loginPage, 1200)
  /* A profile that finished first run holds the account on disk: the screen
     offers one click instead of a form. Fall back to the form on a cold hub. */
  const resume = loginPage.getByRole('button', { name: /continue as owner/i })
  if (await resume.count()) {
    await resume.click()
    await loginPage.waitForURL(/\/overview|\/workspaces|overview|workspaces/, { timeout: 20000 })
  } else {
    await loginPage.fill('input[autocomplete="username"]', ACCOUNT.email)
    await loginPage.fill('input[autocomplete="current-password"]', ACCOUNT.password)
    await Promise.all([
      loginPage.waitForURL(/\/workspaces|workspaces/, { timeout: 20000 }),
      loginPage.click('button[type="submit"]'),
    ])
  }
  await wait(loginPage, 800)
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
    /* A selector that never appears must fail this clip, not the run. */
    page.setDefaultTimeout(8000)
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
    /* One encoder, reused: `readme-hero` lands beside the logo in `assets/`, and
       its middle is still moving, so its poster frame is named rather than picked
       halfway (docs/assets/README.md). */
    if (ENCODE) {
      try {
        if (clip.name === 'readme-hero') {
          encode({ input: target, name: clip.name, hero: true, posterAt: 1.2 })
        } else {
          encode({ input: target, name: clip.name })
        }
      } catch (error) {
        console.log(`  ! encode ${clip.name}: ${error.message.split('\n')[0]}`)
      }
    }
  }
  await browser.close()
  if (!ENCODE) console.log('\nEncode one with: node scripts/readme-media.mjs encode <webm> <name>')
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
