#!/usr/bin/env node
/**
 * The animated Entity mark, as one looping WebP.
 *
 * The README opens with the character, and a still of a character that blinks
 * and hops reads as a sticker. This script draws the same 9 × 9 voxel mark as
 * `docs/assets/icon.svg` (the squircle in the app's `entityMark.js`), wraps it
 * in the brand motion — breathing, a hard two-step blink, a squash-and-stretch
 * hop — and steps the timeline frame by frame, so the result is deterministic
 * rather than whatever the recorder caught.
 *
 *   npm run media:logo                 # → docs/assets/entity-logo.webp + poster
 *
 * Chrome renders the frames (Playwright) and `img2webp` packs them. The mark
 * itself is still `icon.svg`; that stays the favicon and the static fallback.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS = path.join(ROOT, 'docs', 'assets')
const TMP = path.join(ROOT, '.tmp', 'logo-frames')

/* 12 fps matches the README demos; 6 s gives the hop and two blinks room. */
const FPS = 12
const SECONDS = 6
const SIZE = 336
const QUALITY = 82

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  if (result.error) throw new Error(`${cmd} could not start: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${cmd} failed:\n${result.stderr || result.stdout}`)
  return result.stdout
}

/* The squircle face, one cell = 4 units, plus the cream tile from icon.svg.
   `hop` owns the jump, `body` the breath, each `ey` its lid. */
const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="-22 -22 52 52" shape-rendering="crispEdges" role="img" aria-label="entity">
  <style>
    .fc{fill:#f0b52e}.hi{fill:#f8d77e}.sh{fill:#c48a20}.dx1{fill:#a1711d}.dx2{fill:#644311}.eye{fill:#151006}.glint{fill:#f0b52e}.lid{fill:#f0b52e}
  </style>
  <rect x="-22" y="-22" width="52" height="52" rx="11" fill="#fffaf0"/>
  <g class="fit"><g class="hop"><g class="body">
    <g>
      <rect class="dx2" x="-6" y="-10" width="28" height="4"/><rect class="dx2" x="-10" y="-6" width="36" height="4"/><rect class="dx2" x="-10" y="-2" width="36" height="4"/><rect class="dx2" x="-10" y="2" width="36" height="4"/><rect class="dx2" x="-10" y="6" width="36" height="4"/><rect class="dx2" x="-10" y="10" width="36" height="4"/><rect class="dx2" x="-10" y="14" width="36" height="4"/><rect class="dx2" x="-10" y="18" width="36" height="4"/><rect class="dx2" x="-6" y="22" width="28" height="4"/>
      <rect class="dx1" x="-10" y="-14" width="28" height="4"/><rect class="dx1" x="-14" y="-10" width="36" height="4"/><rect class="dx1" x="-14" y="-6" width="36" height="4"/><rect class="dx1" x="-14" y="-2" width="36" height="4"/><rect class="dx1" x="-14" y="2" width="36" height="4"/><rect class="dx1" x="-14" y="6" width="36" height="4"/><rect class="dx1" x="-14" y="10" width="36" height="4"/><rect class="dx1" x="-14" y="14" width="36" height="4"/><rect class="dx1" x="-10" y="18" width="28" height="4"/>
      <rect class="hi" x="-14" y="-18" width="28" height="4"/><rect class="hi" x="-18" y="-14" width="4" height="4"/><rect class="fc" x="-14" y="-14" width="28" height="4"/><rect class="hi" x="14" y="-14" width="4" height="4"/><rect class="hi" x="-18" y="-10" width="4" height="4"/><rect class="fc" x="-14" y="-10" width="28" height="4"/><rect class="sh" x="14" y="-10" width="4" height="4"/><rect class="hi" x="-18" y="-6" width="4" height="4"/><rect class="fc" x="-14" y="-6" width="28" height="4"/><rect class="sh" x="14" y="-6" width="4" height="4"/><rect class="hi" x="-18" y="-2" width="4" height="4"/><rect class="fc" x="-14" y="-2" width="28" height="4"/><rect class="sh" x="14" y="-2" width="4" height="4"/><rect class="hi" x="-18" y="2" width="4" height="4"/><rect class="fc" x="-14" y="2" width="28" height="4"/><rect class="sh" x="14" y="2" width="4" height="4"/><rect class="hi" x="-18" y="6" width="4" height="4"/><rect class="fc" x="-14" y="6" width="28" height="4"/><rect class="sh" x="14" y="6" width="4" height="4"/><rect class="sh" x="-18" y="10" width="4" height="4"/><rect class="fc" x="-14" y="10" width="28" height="4"/><rect class="sh" x="14" y="10" width="4" height="4"/><rect class="sh" x="-14" y="14" width="28" height="4"/>
      <g class="ey"><rect class="eye" x="-10" y="-6" width="8" height="8"/><rect class="glint" x="-10" y="-6" width="4" height="4"/><rect class="lid" x="-11" y="-7" width="10" height="10"/></g>
      <g class="ey"><rect class="eye" x="2" y="-6" width="8" height="8"/><rect class="glint" x="2" y="-6" width="4" height="4"/><rect class="lid" x="1" y="-7" width="10" height="10"/></g>
    </g>
  </g></g></g>
</svg>`

const HTML = `<!doctype html>
<html><head><meta charset="utf-8" />
<style>
  html, body { margin: 0; background: transparent; }
  .mark { width: ${SIZE}px; height: ${SIZE}px; transform-origin: 50% 100%; }
  .mark svg { display: block; width: 100%; height: 100%; }
  .fit, .hop, .body, .ey, .lid { transform-box: fill-box; }
  .fit { transform-origin: 50% 100%; transform: scale(0.9); }
  .hop { transform-origin: 50% 100%; animation: hop ${SECONDS}s linear infinite; }
  .body { transform-origin: 50% 100%; animation: breathe ${SECONDS}s ease-in-out infinite; }
  .ey { transform-origin: 50% 100%; }
  .lid { transform-origin: 50% 0; animation: blink ${SECONDS}s step-end infinite; }
  .ey.wink .lid { animation-name: wink; }

  /* the hop curve from entityMark.js: squash, lift, hang, land, settle */
  @keyframes hop {
    0%, 19.9% { transform: translateY(0) scale(1, 1); }
    20%       { transform: translateY(0) scale(1, 1); }
    22%       { transform: translateY(0) scale(0.90, 1.08); }
    24.8%     { transform: translateY(-17%) scale(1.05, 0.97); }
    27.7%     { transform: translateY(-18%) scale(1.02, 0.99); }
    29.7%     { transform: translateY(0) scale(0.90, 1.07); }
    31.7%     { transform: translateY(-4%) scale(1.04, 0.96); }
    34.2%, 100% { transform: translateY(0) scale(1, 1); }
  }
  @keyframes breathe {
    0%, 100% { transform: scale(1.008, 0.992); }
    50%      { transform: scale(0.99, 1.016); }
  }
  /* two hard pixel steps, twice a loop; the second blink is a wink */
  @keyframes blink {
    0%, 49%   { transform: scaleY(0); }
    50%       { transform: scaleY(0.5); }
    51%       { transform: scaleY(1); }
    52.5%     { transform: scaleY(1); }
    53.5%     { transform: scaleY(0.5); }
    54.5%, 100% { transform: scaleY(0); }
  }
  @keyframes wink {
    0%, 71%   { transform: scaleY(0); }
    72%       { transform: scaleY(0.5); }
    73%       { transform: scaleY(1); }
    74.5%     { transform: scaleY(1); }
    75.5%     { transform: scaleY(0.5); }
    76.5%, 100% { transform: scaleY(0); }
  }
</style></head>
<body><span class="mark">${SVG.replace('<g class="ey"><rect class="eye" x="2"', '<g class="ey wink"><rect class="eye" x="2"')}</span></body>
</html>`

async function main() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  mkdirSync(ASSETS, { recursive: true })

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 })
  await page.setContent(HTML, { waitUntil: 'load' })
  /* Pause every CSS animation, then set the clock by hand: one screenshot per
     frame, no dependence on how fast the machine is. */
  const frames = FPS * SECONDS
  await page.evaluate(() => document.getAnimations().forEach((a) => a.pause()))
  for (let i = 0; i < frames; i += 1) {
    const at = (i / FPS) * 1000
    await page.evaluate((ms) => {
      for (const animation of document.getAnimations()) animation.currentTime = ms
    }, at)
    await page.locator('.mark').screenshot({
      path: path.join(TMP, `frame-${String(i).padStart(3, '0')}.png`),
      omitBackground: true,
    })
  }
  await browser.close()

  const files = readdirSync(TMP).filter((n) => n.endsWith('.png')).sort()
  const target = path.join(ASSETS, 'entity-logo.webp')
  const poster = path.join(ASSETS, 'entity-logo.poster.jpg')

  run('img2webp', [
    '-loop', '0',
    '-d', String(Math.round(1000 / FPS)),
    '-lossy',
    '-q', String(QUALITY),
    '-m', '6',
    ...files.map((name) => path.join(TMP, name)),
    '-o', target,
  ])

  /* The poster is the settled first frame on the tile's own cream, so the
     rounded corners do not turn black in a JPEG. */
  run('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=#fffaf0:s=${SIZE}x${SIZE}`,
    '-i', path.join(TMP, files[0]),
    '-filter_complex', '[0:v][1:v]overlay=format=auto',
    '-frames:v', '1', '-q:v', '4',
    poster,
  ])

  const kb = (file) => `${(statSync(file).size / 1024).toFixed(0)} KB`
  console.log(`${path.relative(ROOT, target)}  ${kb(target)}  ${frames} frames @ ${FPS} fps`)
  console.log(`${path.relative(ROOT, poster)}  ${kb(poster)}`)
  console.log(`\nUse it with:\n\n<picture>\n  <source srcset="docs/assets/entity-logo.webp" type="image/webp" />\n  <img src="docs/assets/entity-logo.poster.jpg" alt="Entity" width="64" />\n</picture>`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
