/**
 * The entity mark — a voxel character, not a letterform.
 *
 * A 9 × 9 field of square cells standing on two shaded depth layers, so the
 * block reads solid from the front. It is built once from a face map and then
 * driven channel by channel — breathing on a sine, eyes tracking on a spring,
 * blinks in two hard pixel steps, and (only where the mark is the whole
 * statement) a squash-and-stretch hop. One requestAnimationFrame loop drives
 * every instance on screen.
 *
 * Mood and colour are user settings rather than motion: the same animation runs
 * under every mood, and the glyph pinned to the extruded corner is what
 * distinguishes them.
 */
import { reactive } from 'vue'

const U = 4
const N = 9
const O = -18

const FACE = [
  '011111110',
  '111111111',
  '111111111',
  '111111111',
  '111111111',
  '111111111',
  '111111111',
  '111111111',
  '011111110',
]
const EYES = [
  [2, 3],
  [5, 3],
]

/* One cadence for every mark. How far the gaze travels, how often it re-aims,
   how often the lids close, how greedy a wink is and how slow the breath is. */
const BASE = { gaze: 3.2, gazeEvery: [2100, 2800], blinkEvery: [2400, 3400], wink: 0.28, breathe: 520, lid: 0 }

export const MOODS = [
  { id: 'none', name: 'Default', glyph: '' },
  { id: 'happy', name: 'Happy', glyph: '😄' },
  { id: 'cool', name: 'Cool', glyph: '😎' },
  { id: 'focus', name: 'Focused', glyph: '🧠' },
  { id: 'sleepy', name: 'Sleepy', glyph: '😴' },
  { id: 'hype', name: 'Excited', glyph: '🤩' },
]

export const COLORS = [
  { id: 'sun', name: 'Sun', v: 'var(--accent)', h: 78 },
  { id: 'ember', name: 'Ember', v: 'oklch(72% 0.16 42)', h: 42 },
  { id: 'lime', name: 'Lime', v: 'oklch(85% 0.17 128)', h: 128 },
  { id: 'mint', name: 'Mint', v: 'oklch(84% 0.13 175)', h: 175 },
  { id: 'sky', name: 'Sky', v: 'oklch(80% 0.13 240)', h: 240 },
  { id: 'orchid', name: 'Orchid', v: 'oklch(78% 0.15 310)', h: 310 },
]

const STORE_KEY = 'entity.mark'

export const markSettings = reactive({ mood: 'none', color: 'sun' })

try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null')
  if (saved?.mood) markSettings.mood = saved.mood
  if (saved?.color) markSettings.color = saved.color
} catch {
  /* a bad stored value just means the defaults */
}

export const moodById = (id) => MOODS.find((m) => m.id === id) || MOODS[0]
export const colorById = (id) => COLORS.find((c) => c.id === id) || COLORS[0]

function applyColor() {
  const c = colorById(markSettings.color)
  const root = document.documentElement
  root.style.setProperty('--mk', c.v)
  root.style.setProperty('--mk-h', String(c.h))
}
applyColor()

const on = (r, c) => r >= 0 && r < N && c >= 0 && c < N && FACE[r].charAt(c) === '1'

/* Light falls from the top-left: the top row and left column are the lit
   faces, the bottom row and right column fall into the extrusion shadow. */
function cell(r, c) {
  const up = !on(r - 1, c)
  const left = !on(r, c - 1)
  const down = !on(r + 1, c)
  const right = !on(r, c + 1)
  if (up) return 'hi'
  if (left && !down) return 'hi'
  if (down || right || left) return 'sh'
  return 'fc'
}

/* Merge cells into runs so the surface has no seams and the DOM stays small. */
function runs(d, fixed) {
  let s = ''
  for (let r = 0; r < N; r++) {
    let c = 0
    while (c < N) {
      if (!on(r, c)) {
        c++
        continue
      }
      const k = fixed || cell(r, c)
      let e = c
      while (e + 1 < N && on(r, e + 1) && (fixed || cell(r, e + 1) === k)) e++
      const x = O + c * U + d
      const y = O + r * U + d
      const w = (e - c + 1) * U
      s += `<rect class="${k}" x="${x}" y="${y}" width="${w}" height="${U}"/>`
      c = e + 1
    }
  }
  return s
}

const eyes = EYES.map((p, i) => {
  const x = O + p[0] * U
  const y = O + p[1] * U
  const w = U * 2
  return (
    '<g class="ey">' +
    `<rect class="eye" x="${x}" y="${y}" width="${w}" height="${w}"/>` +
    `<rect class="glint" x="${x}" y="${y}" width="${U}" height="${U}"/>` +
    `<rect class="lid${i ? ' b' : ''}" x="${x}" y="${y}" width="${w}" height="${w}"/>` +
    '</g>'
  )
}).join('')

const SVG =
  '<svg viewBox="-21 -21 50 50" shape-rendering="crispEdges" aria-hidden="true" focusable="false">' +
  '<g class="hd"><g class="bd">' +
  runs(U * 2, 'dx2') +
  runs(U, 'dx1') +
  runs(0) +
  eyes +
  '</g></g></svg>'

const reduced =
  typeof window !== 'undefined' &&
  window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

const marks = []
let seq = 0
let seed = 20241111
let raf = 0

const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296
}

function syncBadge(el) {
  const badge = el.querySelector('.mood')
  if (badge) badge.textContent = moodById(markSettings.mood).glyph
}

/** Paint every live badge after a mood change — a text write, no re-render. */
export function syncMarkBadges() {
  document.querySelectorAll('.mark[data-avatar]').forEach(syncBadge)
}

export function setMark({ mood, color } = {}) {
  if (mood) markSettings.mood = mood
  if (color) markSettings.color = color
  applyColor()
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(markSettings))
  } catch {
    /* private mode — the setting still holds for this session */
  }
  syncMarkBadges()
}

function hopCurve(u) {
  const K = [
    [0.0, 0.0, 1.0, 1.0],
    [0.12, 0.0, 0.9, 1.08],
    [0.34, -0.34, 1.05, 0.97],
    [0.54, -0.36, 1.02, 0.99],
    [0.68, 0.0, 0.9, 1.07],
    [0.82, -0.05, 1.04, 0.96],
    [1.0, 0.0, 1.0, 1.0],
  ]
  for (let j = 1; j < K.length; j++) {
    if (u <= K[j][0]) {
      const a = K[j - 1]
      const b = K[j]
      let f = (u - a[0]) / (b[0] - a[0])
      f = f * f * (3 - 2 * f)
      return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f]
    }
  }
  return [0, 1, 1]
}

function tick(now) {
  for (let q = marks.length - 1; q >= 0; q--) {
    if (marks[q].el.isConnected === false) {
      marks.splice(q, 1)
      continue
    }
    const p = marks[q]
    const el = p.el
    const dtms = p.prev ? Math.min(48, now - p.prev) : 16.7
    p.prev = now
    const t = now + p.phase
    const dt = dtms / 16.667
    const k = 0.11 * dt
    const dmp = Math.pow(0.85, dt)
    const pn = BASE
    const base = pn.lid

    /* where to look next — the xs tier holds the gaze dead centre */
    if (t > p.lookAt) {
      p.lookAt = t + pn.gazeEvery[0] + rnd() * pn.gazeEvery[1]
      if (p.mini) {
        p.tx = 0
        p.ty = 0
        p.tt = 0
      } else {
        p.tx = (rnd() * 2 - 1) * pn.gaze
        p.ty = (rnd() * 2 - 1) * (pn.gaze * 0.47)
        p.tt = p.tx * 0.55
      }
    }
    p.ex.v = (p.ex.v + (p.tx - p.ex.x) * k) * dmp
    p.ex.x += p.ex.v
    p.ey.v = (p.ey.v + (p.ty - p.ey.x) * k) * dmp
    p.ey.x += p.ey.v
    p.tilt.v = (p.tilt.v + (p.tt - p.tilt.x) * k) * dmp
    p.tilt.x += p.tilt.v

    /* blink: 0.26s, closes in two hard steps, sometimes one eye only */
    if (p.blinkNow < 0 && t > p.blinkAt) {
      p.blinkNow = 0
      p.wink = rnd() < pn.wink
      p.blinkAt = t + pn.blinkEvery[0] + rnd() * pn.blinkEvery[1]
    }
    if (p.blinkNow >= 0) {
      p.blinkNow += dtms / 1000
      const bu = p.blinkNow / 0.26
      if (bu >= 1) {
        p.blinkNow = -1
        p.lida = base
        p.lidb = base
      } else {
        let bv = bu < 0.44 ? bu / 0.44 : bu < 0.56 ? 1 : 1 - (bu - 0.56) / 0.44
        bv = Math.min(1, Math.round(bv * 2) / 2)
        /* a resting lid sits under the blink, so the eye never opens wider
           than the preset allows */
        p.lidb = Math.max(base, bv)
        p.lida = p.wink ? base : Math.max(base, bv)
      }
    } else {
      p.lida = base
      p.lidb = base
    }

    /* hop — only where the mark is the whole statement */
    if (p.hop) {
      if (p.hopNow < 0 && t > p.hopAt) {
        p.hopNow = 0
        p.hopAt = t + 3800 + rnd() * 3000
      }
      if (p.hopNow >= 0) {
        p.hopNow += dtms / 1000
        const hu = p.hopNow
        if (hu >= 1) {
          p.hopNow = -1
          p.lift = 0
          p.syf = 1
          p.sxf = 1
        } else {
          const hc = hopCurve(hu)
          p.lift = hc[0]
          p.syf = hc[1]
          p.sxf = hc[2]
        }
      }
    }

    const br = Math.sin(t / pn.breathe)

    el.style.setProperty('--ex', p.ex.x.toFixed(2) + 'px')
    el.style.setProperty('--ey', p.ey.x.toFixed(2) + 'px')
    el.style.setProperty('--tilt', p.tilt.x.toFixed(2) + 'deg')
    el.style.setProperty('--lida', p.lida)
    el.style.setProperty('--lidb', p.lidb)
    el.style.setProperty('--sy', (1 + 0.022 * br).toFixed(4))
    el.style.setProperty('--sx', (1 - 0.015 * br).toFixed(4))
    if (p.hop) {
      el.style.setProperty('--lift', (p.lift * 100).toFixed(2) + '%')
      el.style.setProperty('--syf', p.syf.toFixed(3))
      el.style.setProperty('--sxf', p.sxf.toFixed(3))
    }
  }

  /* nothing on screen: stop the loop and let the next mount restart it */
  if (!marks.length) {
    raf = 0
    return
  }
  raf = requestAnimationFrame(tick)
}

function start() {
  if (raf || reduced) return
  raf = requestAnimationFrame(tick)
}

/** Mount a mark into an element. Safe to call twice on the same element. */
export function hydrateMark(el, { mini = false, hop = false } = {}) {
  if (!el || el.dataset.ready === '1') return
  el.dataset.ready = '1'
  el.innerHTML = SVG
  const badge = document.createElement('span')
  badge.className = 'mood'
  badge.setAttribute('aria-hidden', 'true')
  el.appendChild(badge)
  syncBadge(el)

  const idx = seq++
  marks.push({
    el,
    mini,
    hop,
    phase: idx * 431,
    prev: 0,
    ex: { x: 0, v: 0 },
    tx: 0,
    ey: { x: 0, v: 0 },
    ty: 0,
    tilt: { x: 0, v: 0 },
    tt: 0,
    lookAt: 700 + rnd() * 1900,
    blinkAt: 700 + rnd() * 2600,
    blinkNow: -1,
    wink: false,
    lida: 0,
    lidb: 0,
    hopAt: 2200 + rnd() * 3200,
    hopNow: -1,
    lift: 0,
    syf: 1,
    sxf: 1,
  })
  start()
}

export function releaseMark(el) {
  const i = marks.findIndex((p) => p.el === el)
  if (i > -1) marks.splice(i, 1)
}
