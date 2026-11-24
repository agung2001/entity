#!/usr/bin/env node
/**
 * One command for a README recording or a screenshot: seed the invented demo
 * profile, serve it, print where it is.
 *
 * Nothing here touches the real profile — the seeder writes `.tmp/demo/` and the
 * server is pointed at it with `ENTITY_HOME` **and** a scratch `HOME` (the ssh
 * reader resolves `~` against that one), so no real host, account or path can
 * reach a frame. No caller sets an environment variable.
 *
 *   npm run demo                              # serve, stay in the foreground
 *   npm run demo -- --port 5299               # another port
 *   npm run demo -- --screenshot machines     # one settled still, then exit
 *   npm run demo -- --no-serve                # seed and print, no server
 *   npm run demo -- --keep                    # reuse what is already seeded
 *
 * Then, in another terminal, the README clips:
 *
 *   npm run media:record
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DEMO, seedDemo } from './demo-profile.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name, fallback = '') => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : fallback
}

const PORT = Number(argOf('--port', 5183))
const SHOT = argOf('--screenshot')
const SHOTS = path.join(ROOT, '.tmp', 'demo-shots')
const VIEW = { width: 1440, height: 1000 }
const wait = (page, ms) => page.waitForTimeout(ms)

/* The stills worth taking on the seeded profile: a route per name, so a typo is
   answered with the list instead of a picture of a 404. */
const ROUTES = {
  overview: (workspace) => `/${workspace}/overview`,
  workspaces: () => '/workspaces',
  chat: (workspace) => `/${workspace}/chat`,
  entity: (workspace) => `/${workspace}/entities/campaign-writer`,
  skills: (workspace) => `/${workspace}/skills`,
  mcp: (workspace) => `/${workspace}/mcp`,
  connectors: (workspace) => `/${workspace}/settings?tab=connectors`,
  'connector-accounts': (workspace) => `/${workspace}/connectors/gmail`,
  machines: (workspace) => `/${workspace}/settings?tab=machines`,
  activity: (workspace) => `/${workspace}/settings?tab=activity`,
  artifacts: (workspace) => `/${workspace}/artifacts/spring-poster.png`,
  sound: () => '/account/sound',
}

if (SHOT && !ROUTES[SHOT]) {
  console.error(`[demo] no route for --screenshot ${SHOT}. Seeded: ${Object.keys(ROUTES).join(', ')}`)
  process.exit(1)
}

/* ── the profile ───────────────────────────────────────────────────── */
if (args.includes('--keep')) {
  console.log('[demo] kept')
} else {
  await seedDemo({ force: true })
}

const url = `http://localhost:${PORT}/${DEMO.workspace}/settings?tab=machines`
console.log(`[demo] profile ${DEMO.profile}`)
console.log(`[demo] home ${DEMO.scratch}`)
console.log(`[demo] url ${url}`)
console.log(`[demo] email ${DEMO.email}`)
console.log(`[demo] password ${DEMO.password}`)
if (SHOT) console.log(`[demo] shot .tmp/demo-shots/${SHOT}.png`)

if (args.includes('--no-serve')) process.exit(0)

/* ── the server ────────────────────────────────────────────────────── */
const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
if (!fs.existsSync(vite)) {
  console.error('[demo] vite is not installed. Run npm install first.')
  process.exit(1)
}

const child = spawn(
  process.execPath,
  [vite, '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      /* both are needed: ENTITY_HOME is the app's profile, HOME is what the ssh
         reader resolves `~` against */
      ENTITY_HOME: DEMO.profile,
      HOME: DEMO.scratch,
      /* the machine names itself in the hero's Local row and in the rail; a
         recording must not publish the machine it was taken on */
      ENTITY_HOSTNAME: DEMO.hostname,
      VITE_DEV_PORT: String(PORT),
    },
    stdio: 'inherit',
  },
)

const stop = (signal) => {
  try {
    child.kill(signal)
  } catch {
    /* already gone */
  }
}
process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))
process.on('exit', () => stop('SIGTERM'))

child.on('error', (error) => {
  console.error(`[demo] vite could not start: ${error.message}`)
  process.exit(1)
})

/* `--strictPort` makes a taken port an error instead of a silent move to the
   next free one, so the URL that was printed is the URL that is served. Vite's
   own message stays on screen; the hint is the part it does not say. */
child.on('exit', (code) => {
  if (code && code !== 0) {
    console.error(`[demo] vite exited with ${code} — if the port is taken, pass --port <n>`)
    process.exit(code)
  }
  if (!SHOT) process.exit(0)
})

if (SHOT) {
  const shot = await takeStill()
  stop('SIGTERM')
  process.exit(shot ? 0 : 1)
}

/**
 * One settled still, on the same profile the server is serving.
 *
 * `// ponytail:` the ceiling is `networkidle` plus a fixed settle — not a
 * readiness poll on the page's own first paint. If this starts catching a
 * half-drawn chart, the upgrade is a poll loop against the page's signal, not a
 * longer timeout.
 */
async function takeStill() {
  /* `127.0.0.1`, not the printed `localhost`: the child binds the IPv4 address,
     and on a machine where something else already owns `localhost` on the other
     address family the wheel would photograph that other thing — the real
     profile. The printed URL stays the friendly one. */
  const base = `http://127.0.0.1:${PORT}`
  /* The child is mid-boot when this runs, and a refused connection fails fast
     rather than waiting, so the first request is retried for a few seconds. */
  await listening(base)

  const { chromium } = await import('playwright')
  let browser
  try {
    browser = await chromium.launch()
  } catch (error) {
    const cache = process.env.PLAYWRIGHT_BROWSERS_PATH
    console.error(`[demo] no Chromium for the screenshot: ${error.message.split('\n')[0]}`)
    console.error('[demo] run: npx playwright install chromium')
    if (cache) console.error(`[demo] PLAYWRIGHT_BROWSERS_PATH is set to ${cache}`)
    /* the profile stays: it is the expensive part, and it is still correct */
    return false
  }

  try {
    const page = await browser.newPage({ viewport: VIEW })
    /* Sign in once: a profile that finished first run holds the account on disk
       and offers one click; a cold one asks for the form. */
    await page.goto(`${base}/login`, { waitUntil: 'networkidle' })
    const resume = page.getByRole('button', { name: /continue as owner/i })
    if (await resume.count()) {
      await resume.click()
      await page.waitForURL(/\/overview|\/workspaces/, { timeout: 20000 })
    } else {
      await page.fill('input[autocomplete="username"]', DEMO.email)
      await page.fill('input[autocomplete="current-password"]', DEMO.password)
      await Promise.all([
        page.waitForURL(/\/workspaces/, { timeout: 20000 }),
        page.click('button[type="submit"]'),
      ])
    }
    await page.goto(`${base}${ROUTES[SHOT](DEMO.workspace)}`, { waitUntil: 'networkidle' })
    await wait(page, 1200)

    fs.mkdirSync(SHOTS, { recursive: true })
    const file = path.join(SHOTS, `${SHOT}.png`)
    await page.screenshot({ path: file })
    return true
  } finally {
    await browser.close()
  }
}

/** Resolve once the dev server answers, or give up after ~15 s. */
async function listening(base) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await fetch(base)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw new Error(`the dev server never answered on ${base}`)
}
