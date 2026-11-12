import { reactive } from 'vue'

/**
 * Pixel Area 51 — procedural interface sounds, no audio files.
 *
 * Every cue is a short oscillator/noise phrase synthesized on demand. The
 * master volume lives in localStorage beside the theme, so the choice survives
 * reloads and applies to every window in this profile. Audio is created on the
 * first gesture because browsers require one.
 */
const KEY = 'entity.sfx'

export const SFX_THEMES = [
  {
    id: 'area51',
    name: 'Pixel Area 51',
    desc: 'Square-wave terminals, low alien pulses, and a little tape static.',
  },
]

const defaults = { enabled: true, volume: 0.34, theme: 'area51' }

function stored() {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (!value || typeof value !== 'object') return { ...defaults }
    return {
      enabled: value.enabled !== false,
      volume: Number.isFinite(value.volume) ? Math.min(1, Math.max(0, value.volume)) : defaults.volume,
      theme: SFX_THEMES.some((item) => item.id === value.theme) ? value.theme : defaults.theme,
    }
  } catch {
    return { ...defaults }
  }
}

export const sfxSettings = reactive(stored())

let audio = null
let master = null
let installed = false

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(sfxSettings))
  } catch {
    /* private mode — the sound still works for this window */
  }
}

function ensureAudio() {
  if (typeof window === 'undefined') return null
  if (!audio) {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return null
    audio = new Ctx()
    master = audio.createGain()
    master.gain.value = sfxSettings.volume
    master.connect(audio.destination)
  }
  if (audio.state === 'suspended') audio.resume().catch(() => {})
  return audio
}

function tone(freq, { at = 0, dur = 0.07, type = 'square', gain = 0.06, to = null, detune = 0 } = {}) {
  if (!audio || !master) return
  const when = audio.currentTime + 0.008 + at
  const osc = audio.createOscillator()
  const env = audio.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(Math.max(20, freq), when)
  if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), when + dur)
  if (detune) osc.detune.setValueAtTime(detune, when)
  env.gain.setValueAtTime(0.0001, when)
  env.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), when + 0.006)
  env.gain.exponentialRampToValueAtTime(0.0001, when + dur)
  osc.connect(env)
  env.connect(master)
  osc.start(when)
  osc.stop(when + dur + 0.02)
}

function staticBurst({ at = 0, dur = 0.06, gain = 0.025, high = 900 } = {}) {
  if (!audio || !master) return
  const when = audio.currentTime + 0.008 + at
  const frames = Math.max(1, Math.ceil(audio.sampleRate * dur))
  const buffer = audio.createBuffer(1, frames, audio.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1
  const source = audio.createBufferSource()
  source.buffer = buffer
  const filter = audio.createBiquadFilter()
  filter.type = 'highpass'
  filter.frequency.value = high
  const env = audio.createGain()
  env.gain.setValueAtTime(Math.max(0.0001, gain), when)
  env.gain.exponentialRampToValueAtTime(0.0001, when + dur)
  source.connect(filter)
  filter.connect(env)
  env.connect(master)
  source.start(when)
  source.stop(when + dur + 0.01)
}

const cues = {
  tap() {
    tone(660, { dur: 0.032, gain: 0.035, to: 520 })
    staticBurst({ dur: 0.02, gain: 0.012, high: 1600 })
  },
  toggle() {
    tone(820, { dur: 0.028, gain: 0.035, to: 1040 })
  },
  open() {
    tone(240, { dur: 0.11, gain: 0.05, type: 'triangle', to: 720 })
    tone(520, { at: 0.05, dur: 0.09, gain: 0.025, type: 'sine', to: 980 })
  },
  close() {
    tone(720, { dur: 0.1, gain: 0.045, type: 'triangle', to: 240 })
  },
  send() {
    tone(430, { dur: 0.05, gain: 0.045 })
    tone(700, { at: 0.055, dur: 0.07, gain: 0.04 })
    staticBurst({ at: 0.02, dur: 0.045, gain: 0.018 })
  },
  receive() {
    ;[392, 523, 659, 784].forEach((freq, index) => {
      tone(freq, { at: index * 0.06, dur: 0.11, gain: 0.04, type: 'triangle' })
    })
    staticBurst({ at: 0.04, dur: 0.09, gain: 0.02 })
  },
  success() {
    ;[523, 659, 784, 1046].forEach((freq, index) => {
      tone(freq, { at: index * 0.07, dur: 0.14, gain: 0.04 })
    })
  },
  error() {
    tone(220, { dur: 0.16, gain: 0.055, type: 'sawtooth', to: 90 })
    tone(160, { at: 0.12, dur: 0.18, gain: 0.035, to: 70 })
    staticBurst({ dur: 0.08, gain: 0.018, high: 500 })
  },
  scan() {
    tone(180, { dur: 0.24, gain: 0.035, type: 'sawtooth', to: 1200 })
    staticBurst({ dur: 0.12, gain: 0.016, high: 700 })
  },
}

export const SFX_CUES = [
  { id: 'tap', name: 'Interface tap', desc: 'Buttons, links and menu rows.' },
  { id: 'send', name: 'Send', desc: 'A message leaves the composer.' },
  { id: 'receive', name: 'Reply', desc: 'The entity finishes a turn.' },
  { id: 'open', name: 'Open', desc: 'Dialogs and the timeline.' },
  { id: 'success', name: 'Success', desc: 'A file, entity or workspace is ready.' },
  { id: 'error', name: 'Error', desc: 'A harness or file operation fails.' },
  { id: 'scan', name: 'Scan', desc: 'The Area 51 sweep.' },
]

export function setSfx(patch = {}) {
  if (typeof patch.enabled === 'boolean') sfxSettings.enabled = patch.enabled
  if (Number.isFinite(patch.volume)) {
    sfxSettings.volume = Math.min(1, Math.max(0, patch.volume))
    if (master) master.gain.setTargetAtTime(sfxSettings.volume, audio.currentTime, 0.015)
  }
  if (SFX_THEMES.some((item) => item.id === patch.theme)) sfxSettings.theme = patch.theme
  persist()
}

export function playSfx(name, { force = false } = {}) {
  if (typeof window === 'undefined') return
  if (!force && !sfxSettings.enabled) return
  if (sfxSettings.volume <= 0) return
  if (!ensureAudio()) return
  const cue = cues[name] || cues.tap
  try {
    cue()
  } catch {
    /* audio is a garnish; never break the action it accompanies */
  }
}

function onDocumentClick(event) {
  if (!sfxSettings.enabled) return
  const target = event.target instanceof Element
    ? event.target.closest(
        'button, a[href], [role="menuitem"], [role="option"], [role="tab"], input[type="checkbox"], input[type="radio"]',
      )
    : null
  if (!target) return
  if (target.closest('[data-sfx="off"], [data-sfx-preview]')) return
  if (target.disabled || target.getAttribute('aria-disabled') === 'true') return
  playSfx('tap')
}

export function initSfx() {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener('click', onDocumentClick)
}
