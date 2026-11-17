#!/usr/bin/env node
/**
 * README media: recordings in, animated WebP + poster out, and a check that
 * every asset a document references is present and affordable.
 *
 * A README demo is one animated `.webp` plus one `.poster.jpg` beside it. The
 * poster is the first frame as a still: a client that cannot play the animation
 * (or has slow media fetching) shows it instead of an empty box. The markup is
 * `<picture><source type="image/webp"><img src="…poster.jpg"></picture>`, so the
 * poster is what a plain `<img>` would show anyway.
 *
 *   npm run media:encode -- recording.mov workspaces
 *   npm run media:posters                 # (re)build posters from the webp files
 *   npm run media:check                   # every referenced asset exists + budget
 *
 * ffmpeg is required, with the `libwebp_anim` encoder (Homebrew's build has it).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS = path.join(ROOT, 'docs', 'assets')
const FEATURES = path.join(ASSETS, 'readme-features')

/* A loop is a reading aid, not a film: 12 fps is enough for UI motion and keeps
   the file small. GitHub renders these inline on a page with a dozen of them. */
const FPS = 12
/* Twelve seconds is a demo. A clip that recorded a stall is trimmed here. */
const MAX_SECONDS = 12
const MAX_WIDTH = 1440
const WEBP_QUALITY = 72
const POSTER_QUALITY = 5
/* Budgets, in bytes. Over budget is a warning, not a build failure: a long
   interaction is sometimes worth 3 MB. */
const WEBP_BUDGET = 2 * 1024 * 1024
const POSTER_BUDGET = 220 * 1024
/* Documents whose assets we police. */
const DOCS = ['README.md', ...readdirSync(path.join(ROOT, 'docs'))
  .filter((name) => name.endsWith('.md'))
  .map((name) => path.join('docs', name))]

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  if (result.error) throw new Error(`${cmd} could not start: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`${cmd} failed:\n${result.stderr || result.stdout}`)
  }
  return result.stdout
}

const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`

function isAnimated(file) {
  try {
    return readFileSync(file).includes(Buffer.from('ANIM'))
  } catch {
    return false
  }
}

function posterFor(name) {
  const source = existsSync(path.join(FEATURES, `${name}.webp`))
    ? path.join(FEATURES, `${name}.webp`)
    : path.join(ASSETS, `${name}.webp`)
  if (!existsSync(source)) throw new Error(`no webp called ${name}`)
  const target = source.replace(/\.webp$/, '.poster.jpg')
  run('ffmpeg', ['-v', 'error', '-y', '-i', source, '-frames:v', '1', '-q:v', String(POSTER_QUALITY), target])
  return { target, source }
}

/** `media:posters` — every webp gets a poster, rebuilt only when asked. */
function posters({ force = false } = {}) {
  const files = [
    ...readdirSync(FEATURES).filter((name) => name.endsWith('.webp')).map((name) => path.join(FEATURES, name)),
    ...readdirSync(ASSETS).filter((name) => name.endsWith('.webp')).map((name) => path.join(ASSETS, name)),
  ]
  let built = 0
  for (const file of files) {
    /* A still ships as the webp alone, so it has no poster to put beside it. */
    if (!isAnimated(file)) continue
    const poster = file.replace(/\.webp$/, '.poster.jpg')
    if (existsSync(poster) && !force) continue
    run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-frames:v', '1', '-q:v', String(POSTER_QUALITY), poster])
    built += 1
    const animated = isAnimated(file) ? 'animated' : 'still'
    console.log(`  ${path.relative(ROOT, file)}  ${animated}  →  ${path.basename(poster)} (${kb(statSync(poster).size)})`)
  }
  console.log(built ? `built ${built} poster${built === 1 ? '' : 's'}` : 'every poster is already there')
}

/** `media:encode` — one recording becomes the pair a document expects. */
function encode({ input, name, width = MAX_WIDTH, hero = false }) {
  if (!existsSync(input)) throw new Error(`no recording at ${input}`)
  const base = hero ? ASSETS : FEATURES
  const target = path.join(base, `${name}.webp`)
  const poster = path.join(base, `${name}.poster.jpg`)
  const scale = `scale='min(${width},iw)':-2:flags=lanczos`

  run('ffmpeg', [
    '-v', 'error', '-y', '-i', input, '-t', String(MAX_SECONDS),
    '-vf', `fps=${FPS},${scale}`,
    '-c:v', 'libwebp_anim',
    '-lossless', '0',
    '-q:v', String(WEBP_QUALITY),
    '-loop', '0',
    '-an',
    '-f', 'webp',
    target,
  ])
  /* A beat in, so the poster is not a fade-in from black. */
  run('ffmpeg', [
    '-v', 'error', '-y', '-ss', '0.3', '-i', input,
    '-frames:v', '1', '-q:v', String(POSTER_QUALITY),
    poster,
  ])

  const size = statSync(target).size
  console.log(`${path.relative(ROOT, target)}  ${kb(size)}${size > WEBP_BUDGET ? '  ⚠ over budget' : ''}`)
  console.log(`${path.relative(ROOT, poster)}  ${kb(statSync(poster).size)}`)
  console.log('\nUse it with:\n')
  console.log(pictureSnippet(name, 'docs'))
}

function pictureSnippet(name, from = 'docs') {
  const base = from === 'docs' ? 'docs/assets/readme-features' : 'assets/readme-features'
  return [
    `<picture>`,
    `  <source srcset="${base}/${name}.webp" type="image/webp" />`,
    `  <img src="${base}/${name}.poster.jpg" alt="…" width="820" />`,
    `</picture>`,
  ].join('\n')
}

/** Every asset a document points at, resolved from that document's folder. */
function referencedAssets() {
  const found = new Map()
  for (const doc of DOCS) {
    const file = path.join(ROOT, doc)
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    const patterns = [
      /(?:src|srcset|href)="([^"]*\/(?:readme-features\/)?[^"/]+\.(?:webp|jpg|jpeg|png|svg|gif))"/g,
      /!\[[^\]]*\]\(([^)]+\.(?:webp|jpg|jpeg|png|svg|gif))\)/g,
    ]
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const rel = match[1]
        if (/^https?:\/\//.test(rel)) continue
        const resolved = path.resolve(path.dirname(file), rel)
        found.set(resolved, doc)
      }
    }
  }
  return found
}

/** `media:check` — the contract, enforced: present, paired, and affordable. */
function check() {
  let problems = 0
  let stills = 0
  const assets = referencedAssets()
  for (const [file, doc] of assets) {
    const rel = path.relative(ROOT, file)
    if (!existsSync(file)) {
      console.log(`  ✖ ${rel}  (referenced by ${doc}) does not exist`)
      problems += 1
      continue
    }
    const size = statSync(file).size
    if (file.endsWith('.webp')) {
      const animated = isAnimated(file)
      /* The poster is the fallback for an animation. A still has nothing to fall
         back from, so it ships as the webp alone and needs no twin. */
      const poster = file.replace(/\.webp$/, '.poster.jpg')
      if (animated && !existsSync(poster)) {
        console.log(`  ✖ ${rel}  has no ${path.basename(poster)} fallback`)
        problems += 1
      }
      if (size > WEBP_BUDGET) {
        console.log(`  ⚠ ${rel}  ${kb(size)} is over ${kb(WEBP_BUDGET)}`)
      }
      if (!animated) {
        console.log(`  · ${rel}  is a still — record it for a demo`)
        stills += 1
      }
    }
    if (file.endsWith('.poster.jpg') && size > POSTER_BUDGET) {
      console.log(`  ⚠ ${rel}  ${kb(size)} is over ${kb(POSTER_BUDGET)}`)
    }
  }
  console.log(
    `\n${assets.size} referenced asset${assets.size === 1 ? '' : 's'}, ${stills} still, ${problems} problem${problems === 1 ? '' : 's'}`,
  )
  return problems === 0
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
const [command, ...rest] = process.argv.slice(2)

try {
  if (command === 'posters') {
    posters({ force: rest.includes('--force') })
  } else if (command === 'encode') {
    const input = rest[0]
    const name = rest[1]
    if (!input || !name) throw new Error('usage: media:encode -- <recording.mov> <feature-name> [--hero]')
    encode({ input, name, hero: rest.includes('--hero') })
  } else if (command === 'check') {
    process.exit(check() ? 0 : 1)
  } else {
    console.log('usage: readme-media.mjs <posters [--force] | encode <video> <name> | check>')
    process.exit(command ? 1 : 0)
  }
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
}

export { encode, posterFor, posters, check }
