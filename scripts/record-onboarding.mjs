#!/usr/bin/env node
/**
 * The four onboarding stills, from the wizard a new install actually shows.
 *
 * These were the last hand-made pictures in `docs/assets/onboarding/`, and they
 * went stale the moment the first-run card changed. So they are taken the same
 * way the demos are: a throwaway profile, a real browser, a settled frame — and
 * then the server is stopped.
 *
 *   npm run media:onboarding
 *
 * **Its own profile and its own port, on purpose.** The demo server this
 * repository may also be running holds a profile that has *finished* first run,
 * so it can only ever show the return launch. This script writes
 * `.tmp/onboarding/` (a `HOME` and an `ENTITY_HOME` under it, with no
 * `workspaces/` directory — that absence is what makes the guard open `/welcome`)
 * and serves it on 5299. Nothing here reads or writes `~/.entity`.
 *
 * A still ships as the `.webp` alone — no poster, no `<picture>` — because a
 * screenshot has nothing to fall back from (`docs/assets/README.md`).
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'docs', 'assets', 'onboarding')
const HOME = path.join(ROOT, '.tmp', 'onboarding')
const PORT = 5299
/* 1440 × 1000 is the demos' own viewport, so a still and a clip read at the same
   scale. The card is 404 px wide, so the shot is the card and its stage. */
/* Step 2 prints the path each CLI was found at, so a version-manager install
   under the real home would put this machine's username in the picture. Drop
   every PATH entry beneath it: what is left is the system's own prefix
   (`/opt/homebrew/bin` here), which is a path a person can read without learning
   whose laptop took the shot. The probe then honestly reports the CLIs it finds
   and marks the rest not installed. */
const REAL_HOME = os.homedir()
const PATH_SAFE = String(process.env.PATH || '')
  .split(path.delimiter)
  .filter(Boolean)
  .filter((entry) => entry !== REAL_HOME && !entry.startsWith(`${REAL_HOME}${path.sep}`))
  .join(path.delimiter)

const VIEW = { width: 1440, height: 1000 }

/* The invented room the wizard is walked with. */
const ROOM = 'spring-catalogue'

/* Which CLI takes the hello turn. Step 3's picture is only worth publishing when
   the reply in it is a real answer, and a CLI that is installed but signed out
   comes back as an error turn. `--agent <id>` names the one this machine can
   actually answer with; without it the wizard's own preselection stands. */
const at = process.argv.indexOf('--agent')
const AGENT = at >= 0 ? String(process.argv[at + 1] || '') : ''

/** Send the demo question on step 3, then wait for the turn to stop running.
 *  `true` when the answer landed, `false` when the CLI refused. */
async function askOnce(page) {
  const chip = page.locator('.chips button').first()
  if (!(await chip.count())) return false
  await chip.click()
  /* The reply is a real CLI process. Wait for the typing row to go, not for a
     fixed number of seconds — pi took ~40 s on this machine and 12 s only ever
     photographed "Thinking…". */
  await page
    .locator('.turn .hint', { hasText: /Thinking/ })
    .first()
    .waitFor({ state: 'detached', timeout: 180000 })
    .catch(() => {})
  await page.waitForTimeout(1500)
  const errors = await page.locator('.turn .hint').filter({ hasText: /harness error/i }).count()
  return errors === 0
}

/** One settled screenshot, and no half-drawn card. */
async function still(page, name) {
  await page.waitForTimeout(900)
  const file = path.join(OUT, `${name}.webp`)
  await page.screenshot({ path: file })
  /* Chromium writes a PNG; the contract is `.webp`. `encode`'s ffmpeg is already
     a dependency of this repository, so it does the one conversion. */
  const { spawnSync } = await import('node:child_process')
  const png = `${file}.png`
  const { renameSync } = await import('node:fs')
  renameSync(file, png)
  const result = spawnSync('ffmpeg', [
    '-v', 'error', '-y', '-i', png, '-c:v', 'libwebp', '-lossless', '0',
    '-q:v', '82', '-an', '-f', 'webp', file,
  ], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`ffmpeg: ${result.stderr || 'failed'}`)
  rmSync(png, { force: true })
  console.log(`  ${path.relative(ROOT, file)}`)
}

async function main() {
  /* A profile with no workspace on disk: that absence, not a flag, is what the
     router reads before it opens `/welcome`. */
  rmSync(HOME, { recursive: true, force: true })
  mkdirSync(path.join(HOME, 'home', '.entity'), { recursive: true })
  mkdirSync(OUT, { recursive: true })

  const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
  if (!existsSync(vite)) throw new Error('vite is not installed. Run npm install first.')

  const child = spawn(
    process.execPath,
    [vite, '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        /* `ENTITY_HOME` is the whole profile, so the wizard is walked on a scratch
           one. `HOME` stays the real one on purpose: the CLIs on the next step
           read their sign-in from `~/.claude`, `~/.pi` and the rest, and a drawn
           picture of an error turn is not what this page documents. What the
           profile owns still lives under `.tmp/`, and `PATH_SAFE` keeps a
           version-manager install from putting a username in step 2. */
        ENTITY_HOME: path.join(HOME, 'home', '.entity'),
        ENTITY_HOSTNAME: 'studio-workstation',
        PATH: PATH_SAFE,
        VITE_DEV_PORT: String(PORT),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )
  const stop = () => {
    try {
      child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
  process.on('exit', stop)

  const base = `http://127.0.0.1:${PORT}`
  await listening(base)

  const { chromium } = await import('playwright')
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ viewport: VIEW })
    const page = await context.newPage()
    page.setDefaultTimeout(8000)

    /* The first screen is the wizard, not a form: this profile has no room. */
    await page.goto(`${base}/welcome`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)

    /* Step 1 — the room's name, with the folder preview under it. Typed, so the
       preview is the derivation and not the default. */
    const field = page.locator('.welc input').first()
    await field.fill('')
    await field.type(ROOM, { delay: 40 })
    await still(page, 'step-1-name')

    /* Step 2 — the probe's real answer for this machine. */
    await page.locator('.wiz-foot button[type="submit"]').click()
    await page.waitForTimeout(2200)
    await still(page, 'step-2-agent')

    if (AGENT) {
      const row = page.locator('.hrow').filter({ hasText: AGENT }).first()
      if (await row.count()) {
        await row.click()
        await page.waitForTimeout(500)
      }
    }

    /* Step 3 — the transcript. The turn is a real CLI process, so it is given
       time. The CLI named with `--agent` is chosen here, before the question, so
       the reply in the picture is a real answer rather than a sign-in error. */
    const primary = page.locator('.wiz-foot button[type="submit"]')
    if (await primary.isEnabled()) {
      await primary.click()
      await page.waitForTimeout(1200)
      await askOnce(page)
    }
    await still(page, 'step-3-reply')

    /* The return launch needs the one combination the guard answers with
       `/login`: a room on disk and **no session**. The wizard just signed one in,
       so the session key is cleared and the page reloaded — the card is then the
       real second-launch screen, and the room is untouched. */
    await page.evaluate(() => {
      localStorage.removeItem('entity.session')
      localStorage.removeItem('entity.credentials')
    })
    await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1600)
    await still(page, 'return-launch')

    await context.close()
  } finally {
    await browser.close()
    stop()
  }
}

/** Resolve once the dev server answers, or give up after ~20 s. */
async function listening(base) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await fetch(base)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw new Error(`the dev server never answered on ${base}`)
}

main()
  .then(() => {
    console.log('\nStills are in docs/assets/onboarding/')
    process.exit(0)
  })
  .catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
