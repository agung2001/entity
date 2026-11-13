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

const defaults = { enabled: true, volume: 0.65, theme: 'area51', version: 2 }

function stored() {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (!value || typeof value !== 'object') return { ...defaults }
    let volume = Number.isFinite(value.volume)
      ? Math.min(1, Math.max(0, value.volume))
      : defaults.volume
    /* The old default was 34%; move a profile that never chose a volume to the
       new 65% default once, without touching anyone's custom level. */
    if (value.version !== 2 && volume === 0.34) volume = defaults.volume
    return {
      enabled: value.enabled !== false,
      volume,
      theme: SFX_THEMES.some((item) => item.id === value.theme) ? value.theme : defaults.theme,
      version: 2,
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
  nav() {
    tone(520, { dur: 0.032, gain: 0.03, to: 690 })
    tone(690, { at: 0.035, dur: 0.04, gain: 0.022, type: 'triangle' })
  },
  workspace() {
    tone(130, { dur: 0.22, gain: 0.05, type: 'sine', to: 430 })
    tone(430, { at: 0.13, dur: 0.16, gain: 0.034, type: 'triangle', to: 860 })
    staticBurst({ at: 0.1, dur: 0.08, gain: 0.014, high: 1100 })
  },
  'theme-light'() {
    ;[440, 660, 880, 1100].forEach((freq, index) => {
      tone(freq, { at: index * 0.045, dur: 0.1, gain: 0.032, type: 'triangle' })
    })
    staticBurst({ at: 0.02, dur: 0.04, gain: 0.012, high: 1700 })
  },
  'theme-dark'() {
    ;[440, 330, 247, 165].forEach((freq, index) => {
      tone(freq, { at: index * 0.055, dur: 0.12, gain: 0.034, type: 'sine' })
    })
    staticBurst({ at: 0.04, dur: 0.07, gain: 0.014, high: 500 })
  },
  spark() {
    tone(780, { dur: 0.035, gain: 0.035, to: 1040 })
    tone(1180, { at: 0.04, dur: 0.06, gain: 0.028, type: 'triangle', to: 1560 })
    staticBurst({ at: 0.02, dur: 0.035, gain: 0.01, high: 2200 })
  },
  confirm() {
    tone(520, { dur: 0.06, gain: 0.04 })
    tone(780, { at: 0.065, dur: 0.11, gain: 0.04, type: 'triangle' })
  },
  remove() {
    tone(300, { dur: 0.14, gain: 0.05, type: 'sawtooth', to: 90 })
    tone(150, { at: 0.08, dur: 0.13, gain: 0.032, type: 'square', to: 60 })
    staticBurst({ dur: 0.06, gain: 0.016, high: 600 })
  },
  copy() {
    tone(900, { dur: 0.022, gain: 0.03 })
    tone(1160, { at: 0.04, dur: 0.028, gain: 0.028 })
  },
  upload() {
    tone(280, { dur: 0.18, gain: 0.038, type: 'triangle', to: 1020 })
    staticBurst({ at: 0.03, dur: 0.05, gain: 0.012, high: 1300 })
  },
  download() {
    tone(1020, { dur: 0.18, gain: 0.038, type: 'triangle', to: 280 })
    tone(260, { at: 0.17, dur: 0.06, gain: 0.025, type: 'sine' })
  },
  pin() {
    tone(1320, { dur: 0.02, gain: 0.032 })
    tone(760, { at: 0.035, dur: 0.055, gain: 0.03, type: 'triangle' })
  },
  signal() {
    tone(880, { dur: 0.12, gain: 0.03, type: 'sine', to: 1320 })
    tone(1320, { at: 0.11, dur: 0.18, gain: 0.024, type: 'sine', to: 880 })
    staticBurst({ at: 0.02, dur: 0.04, gain: 0.008, high: 1900 })
  },
  stop() {
    tone(360, { dur: 0.16, gain: 0.05, type: 'sawtooth', to: 80 })
    tone(180, { at: 0.09, dur: 0.12, gain: 0.03, type: 'square', to: 55 })
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
  { id: 'nav', name: 'Rail step', desc: 'Moving between sections.' },
  { id: 'workspace', name: 'Workspace door', desc: 'A room opens and the air changes.' },
  { id: 'theme-light', name: 'Daylight', desc: 'Switching to the light theme.' },
  { id: 'theme-dark', name: 'Nightfall', desc: 'Switching to the dark theme.' },
  { id: 'spark', name: 'Spark', desc: 'A new entity, chat or workspace.' },
  { id: 'confirm', name: 'Confirm', desc: 'A setting or file is saved.' },
  { id: 'remove', name: 'Remove', desc: 'Deleting something for good.' },
  { id: 'copy', name: 'Copy', desc: 'A path or link lands on the clipboard.' },
  { id: 'upload', name: 'Upload', desc: 'Something is coming in.' },
  { id: 'download', name: 'Download', desc: 'Something is going out.' },
  { id: 'pin', name: 'Pin', desc: 'A thread is pinned or unpinned.' },
  { id: 'signal', name: 'Signal', desc: 'A notification calls you back.' },
  { id: 'stop', name: 'Stop', desc: 'A running turn is cut short.' },
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

function cueFor(target) {
  const explicit = target.closest('[data-sfx]')?.getAttribute('data-sfx')
  if (explicit) return explicit
  if (target.matches('[role="switch"], input[type="checkbox"], input[type="radio"]')) {
    return 'toggle'
  }
  const label = `${target.getAttribute('aria-label') || ''} ${target.textContent || ''}`
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  if (target.matches('.danger') || /\b(delete|remove|trash)\b/.test(label)) return 'remove'
  if (/\b(save|confirm|apply|publish)\b/.test(label)) return 'confirm'
  if (/\b(create|add|new|duplicate|start blank)\b/.test(label)) return 'spark'
  if (/\bcopy\b/.test(label)) return 'copy'
  if (/\b(upload|import)\b/.test(label)) return 'upload'
  if (/\b(download|export)\b/.test(label)) return 'download'
  if (/\bstop\b/.test(label)) return 'stop'
  if (/\b(close|cancel|dismiss)\b/.test(label)) return 'close'
  if (/\b(open|timeline|workspace)\b/.test(label)) return 'open'
  return 'tap'
}

function onDocumentClick(event) {
  if (!sfxSettings.enabled) return
  const target = event.target instanceof Element
    ? event.target.closest(
        'button, a[href], summary, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], input[type="checkbox"], input[type="radio"]',
      )
    : null
  if (!target) return
  if (target.closest('[data-sfx="off"], [data-sfx-preview]')) return
  if (target.disabled || target.getAttribute('aria-disabled') === 'true') return
  const cue = cueFor(target)
  if (cue && cue !== 'off') playSfx(cue)
}

export function initSfx() {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener('click', onDocumentClick)
}
