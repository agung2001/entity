/**
 * Voice mode, without a dependency.
 *
 * The app already talks to local CLIs for everything heavy, so voice uses the
 * same shape: a *speaker* that is the platform's own speech synthesis, and a
 * *listener* chosen from an engine ladder rather than assumed.
 *
 *   1. `webspeech` — the browser's SpeechRecognition. Instant interim words and
 *      no setup, but it needs a recognition service: it works in a Chrome/Edge
 *      tab and, in Electron, fails with `network` because the desktop shell has
 *      no key for that service. That failure is remembered for the session.
 *   2. `local` — the microphone is segmented here (energy endpointing), encoded
 *      as 16 kHz mono PCM WAV, and transcribed by a whisper CLI through the
 *      main process. Costs one process per utterance, but works offline.
 *   3. `none` — the dialog still works: the entity speaks, and you type.
 *
 * Everything in this module is browser-global only, never Vue, so the pure
 * half (markdown flattening, sentence chunking, echo detection, WAV encoding,
 * voice picking, threshold math) is unit-tested without a DOM.
 */

/* ── text shaping ─────────────────────────────────────────────────── */

/**
 * What a voice should actually read. Markdown syntax is punctuation to the eye
 * and noise to a synthesizer: fences are dropped whole, links keep their label,
 * emphasis markers, headings, bullets, table pipes and HTML tags go.
 */
export function speechText(markdown) {
  let text = String(markdown || '')
  text = text.replace(/```[\s\S]*?```/g, ' ')
  text = text.replace(/~~~[\s\S]*?~~~/g, ' ')
  text = text.replace(/`([^`]+)`/g, '$1')
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  text = text.replace(/https?:\/\/\S+/g, 'link')
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  text = text.replace(/^\s{0,3}>\s?/gm, '')
  text = text.replace(/^\s*[-*+]\s+/gm, '')
  text = text.replace(/^\s*\d+[.)]\s+/gm, '')
  text = text.replace(/^\s*\|?[\s:-]+\|[\s:|-]*$/gm, ' ')
  text = text.replace(/\|/g, ' ')
  text = text.replace(/[*_~]{1,3}/g, '')
  text = text.replace(/<[^>]+>/g, ' ')
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Split a reply into utterances. One long `speak()` call cannot be interrupted
 * mid-sentence in some engines, and a 2 000-word answer read as one blob makes
 * `stop()` feel unresponsive; sentence-sized chunks give barge-in a seam.
 */
export function splitSpeech(text, { max = 220 } = {}) {
  const source = String(text || '').replace(/\s+/g, ' ').trim()
  if (!source) return []
  const sentences = source.match(/[^.!?…]+[.!?…]+["')\]]*|[^.!?…]+$/g) || [source]
  const chunks = []
  let current = ''
  const flush = () => {
    const trimmed = current.trim()
    if (trimmed) chunks.push(trimmed)
    current = ''
  }
  for (const sentence of sentences) {
    const next = sentence.trim()
    if (!next) continue
    if (next.length > max) {
      flush()
      chunks.push(...splitLong(next, max))
      continue
    }
    if (`${current} ${next}`.trim().length > max) flush()
    current = `${current} ${next}`.trim()
  }
  flush()
  return chunks
}

function splitLong(text, max) {
  const parts = []
  let rest = text
  while (rest.length > max) {
    const window = rest.slice(0, max)
    let cut = Math.max(
      window.lastIndexOf(', '),
      window.lastIndexOf('; '),
      window.lastIndexOf(' — '),
      window.lastIndexOf(' '),
    )
    if (cut < max * 0.4) cut = window.lastIndexOf(' ')
    if (cut <= 0) cut = max
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) parts.push(rest)
  return parts
}

const STOP_PHRASES = new Set([
  'stop',
  'stop it',
  'stop please',
  'stop now',
  'cancel',
  'cancel that',
  'abort',
  'halt',
  'quiet',
  'shut up',
  'never mind',
  'nevermind',
  'forget it',
  'enough',
  "that's enough",
  'thats enough',
  'wait',
  'hold on',
  'hold on a second',
])

/** Was the utterance an instruction to *stop*, not a message for the model? */
export function isStopPhrase(text) {
  const clean = String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return STOP_PHRASES.has(clean)
}

/** Lowercase words with punctuation removed, for similarity only. */
export function words(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Is this transcript just the entity hearing itself?
 *
 * Speech synthesis has no echo cancellation of its own, and a laptop speaker at
 * volume will feed straight back into the microphone. When most of a transcript
 * was already in the sentence being spoken, it is echo — sending it would make
 * the entity answer its own reply forever.
 */
export function echoLikely(transcript, spoken) {
  const heard = words(transcript)
  if (!heard.length) return false
  const said = new Set(words(spoken))
  if (!said.size) return false
  const hits = heard.filter((word) => said.has(word)).length
  return hits / heard.length >= 0.6
}

/* ── engine detection ─────────────────────────────────────────────── */

let webSpeechFailure = ''

export function webSpeechSupported() {
  return Boolean(globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition)
}

/** A session that already answered `network`/`not-allowed` must not be retried. */
export function webSpeechUsable() {
  return webSpeechSupported() && !webSpeechFailure
}

export function noteWebSpeechFailure(reason) {
  webSpeechFailure = String(reason || 'error')
}

export function resetWebSpeechFailure() {
  webSpeechFailure = ''
}

/* ── voice picking ───────────────────────────────────────────────── */

/**
 * Prefer a voice that matches the page language, then an enhanced/natural one,
 * then the platform default. Novelty voices are avoided because a chat reply
 * read by "Bells" is not a chat reply.
 */
export function pickVoice(voices, language = 'en-US') {
  const list = (voices || []).filter((voice) => voice && voice.name)
  if (!list.length) return null
  const base = String(language || 'en').toLowerCase().slice(0, 2)
  const matching = list.filter((voice) => String(voice.lang || '').toLowerCase().startsWith(base))
  const pool = matching.length ? matching : list
  const novelty = /bells|bubbles|trinoids|whisper|zarvox|albert|bad news|good news|jester|organ|superstar|wobble/i
  const real = pool.filter((voice) => !novelty.test(voice.name))
  const candidates = real.length ? real : pool
  const enhanced = candidates.find(
    (voice) => voice.localService !== false && /natural|premium|enhanced/i.test(voice.name),
  )
  return enhanced || candidates.find((voice) => voice.default) || candidates[0]
}

/* ── audio math (tested) ─────────────────────────────────────────── */

export function rms(frame) {
  if (!frame || !frame.length) return 0
  let sum = 0
  for (let index = 0; index < frame.length; index += 1) sum += frame[index] * frame[index]
  return Math.sqrt(sum / frame.length)
}

/**
 * Speech threshold from a measured room floor. Clamped at both ends: an open
 * microphone in a silent room still has a noise floor, and a café must not
 * leave the recorder running forever.
 */
export function vadThreshold(floor = 0) {
  const value = Number(floor) || 0
  return Math.min(0.12, Math.max(0.012, value * 2.5 + 0.008))
}

/** Average-window decimation; whisper wants 16 kHz and the mic gives 44.1/48. */
export function downsample(input, from, to) {
  const source = input || new Float32Array(0)
  if (!source.length) return new Float32Array(0)
  if (!(from > to)) return Float32Array.from(source)
  const ratio = from / to
  const out = new Float32Array(Math.floor(source.length / ratio))
  const width = Math.max(1, Math.round(ratio))
  for (let index = 0; index < out.length; index += 1) {
    const start = Math.floor(index * ratio)
    let sum = 0
    let count = 0
    for (let offset = 0; offset < width && start + offset < source.length; offset += 1) {
      sum += source[start + offset]
      count += 1
    }
    out[index] = sum / (count || 1)
  }
  return out
}

function writeAscii(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index))
  }
}

/** A 16-bit mono PCM WAV. The only audio format the transcriber accepts. */
export function encodeWav(samples, sampleRate = 16_000) {
  const count = samples?.length || 0
  const buffer = new ArrayBuffer(44 + count * 2)
  const view = new DataView(buffer)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + count * 2, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, count * 2, true)
  for (let index = 0; index < count; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]))
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return new Uint8Array(buffer)
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Base64 for an audio blob, without relying on `btoa` being present. */
export function base64FromBytes(bytes) {
  const source = bytes || new Uint8Array(0)
  let out = ''
  for (let index = 0; index < source.length; index += 3) {
    const a = source[index]
    const b = source[index + 1]
    const c = source[index + 2]
    out += B64[a >> 2]
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)]
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]
    out += c === undefined ? '=' : B64[c & 63]
  }
  return out
}

/** Decoded byte count for a base64 string, padding included. */
export const base64Length = (encoded) => {
  const text = String(encoded || '')
  if (!text) return 0
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  return Math.floor((text.length * 3) / 4) - padding
}

/* ── speaker: the platform's own speech synthesis ────────────────── */

export function createSpeaker({
  language = 'en-US',
  rate = 1.02,
  voiceName = '',
  onStart = () => {},
  onEnd = () => {},
  onError = () => {},
  /* called as each sentence starts, with its index, so a surface can show the
     text it is hearing and highlight the line being read */
  onChunk = () => {},
} = {}) {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : null
  const Utterance = typeof window !== 'undefined' ? window.SpeechSynthesisUtterance : null
  const supported = Boolean(synth && Utterance)
  let queue = []
  let speaking = false
  let cancelled = false
  let finished = true
  let total = 0
  let index = 0

  const chooseVoice = () => {
    if (!synth) return null
    const voices = synth.getVoices() || []
    if (voiceName) {
      const named = voices.find((voice) => voice.name === voiceName)
      if (named) return named
    }
    return pickVoice(voices, language)
  }

  function pump() {
    if (!supported || speaking) return
    if (!queue.length) {
      if (!finished) {
        finished = true
        onEnd()
      }
      return
    }
    finished = false
    const text = queue.shift()
    const at = index
    index += 1
    const utterance = new Utterance(text)
    utterance.lang = language
    utterance.rate = rate
    utterance.pitch = 1
    const voice = chooseVoice()
    if (voice) utterance.voice = voice
    speaking = true
    utterance.onend = () => {
      speaking = false
      if (cancelled) return
      pump()
    }
    utterance.onerror = (event) => {
      speaking = false
      const reason = event?.error || 'speech-error'
      if (cancelled || reason === 'interrupted' || reason === 'canceled') return
      finished = true
      onError(reason)
    }
    try {
      onChunk(text, at, total)
      synth.speak(utterance)
      onStart()
    } catch (error) {
      speaking = false
      finished = true
      onError(String(error?.message || error))
    }
  }

  return {
    supported,
    speak(text) {
      const chunks = splitSpeech(speechText(text))
      if (!chunks.length) return false
      cancelled = false
      finished = false
      queue = chunks
      total = chunks.length
      index = 0
      pump()
      return true
    },
    stop() {
      const wasActive = speaking || queue.length > 0
      cancelled = true
      queue = []
      total = 0
      index = 0
      speaking = false
      finished = true
      try {
        synth?.cancel()
      } catch {
        /* a cancelled synthesis is not a failure */
      }
      if (wasActive) onEnd()
    },
    speaking: () => speaking,
    voices: () => (synth?.getVoices?.() || []).map((voice) => ({ name: voice.name, lang: voice.lang })),
  }
}

/* ── listener 1: the browser's SpeechRecognition ─────────────────── */

export function createWebRecognizer({
  language = 'en-US',
  onPartial = () => {},
  onFinal = () => {},
  onSpeechStart = () => {},
  onError = () => {},
  onEnd = () => {},
} = {}) {
  const Recognizer = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition
  if (!Recognizer) {
    return {
      available: false,
      start: () => false,
      stop: () => {},
    }
  }

  let instance = null
  let active = false
  let fatal = ''
  let retry = null

  function build() {
    const recognizer = new Recognizer()
    recognizer.lang = language
    recognizer.continuous = true
    recognizer.interimResults = true
    recognizer.maxAlternatives = 1
    recognizer.onspeechstart = () => onSpeechStart()
    recognizer.onresult = (event) => {
      let interim = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        const text = String(result[0]?.transcript || '')
        if (result.isFinal) {
          const clean = text.trim()
          if (clean) onFinal(clean)
        } else {
          interim += text
        }
      }
      onPartial(interim.trim())
    }
    recognizer.onerror = (event) => {
      const reason = String(event?.error || 'error')
      /* silence and a deliberate abort are not failures */
      if (reason === 'no-speech' || reason === 'aborted') return
      fatal = reason
      active = false
      noteWebSpeechFailure(reason)
      onError(reason)
    }
    recognizer.onend = () => {
      onPartial('')
      if (!active || fatal) {
        onEnd()
        return
      }
      /* Chromium ends a continuous session on its own after a pause. */
      clearTimeout(retry)
      retry = setTimeout(() => {
        try {
          recognizer.start()
        } catch {
          /* the next explicit start() will report the real problem */
        }
      }, 260)
    }
    return recognizer
  }

  return {
    available: true,
    start() {
      if (!webSpeechUsable()) return false
      active = true
      fatal = ''
      instance = instance || build()
      try {
        instance.start()
        return true
      } catch {
        /* already started */
        return true
      }
    },
    stop() {
      active = false
      clearTimeout(retry)
      retry = null
      onPartial('')
      try {
        instance?.abort()
      } catch {
        /* already closed */
      }
      onEnd()
    },
  }
}

/* ── listener 2: microphone → endpointed WAV segments ───────────── */

const FRAME = 2048
const SILENCE_MS = 700
const MIN_SPEECH_MS = 260

/**
 * Open the microphone and hand back one WAV per spoken sentence.
 *
 * There is no streaming model here, so the work is endpointing: measure the
 * room floor for ~350 ms, decide a threshold, then accumulate frames while the
 * level is above it and flush after a short silence. The same analyser drives
 * barge-in — a speech onset while the entity is talking stops the speaker
 * before a single word has been transcribed.
 *
 * The microphone stays open for the dialog's lifetime, and `stop()` releases
 * both the stream and the audio context; a closed dialog with a hot mic is not
 * a state this may ever return to.
 */
export async function startMicrophone({
  onLevel = () => {},
  onSpeechStart = () => {},
  onSegment = () => {},
  onError = () => {},
  maxSeconds = 30,
} = {}) {
  const media = globalThis.navigator?.mediaDevices
  if (!media?.getUserMedia) throw new Error('This build has no microphone access.')
  const Context = globalThis.AudioContext || globalThis.webkitAudioContext
  if (!Context) throw new Error('This build has no audio input support.')

  const stream = await media.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  })

  const context = new Context()
  try {
    await context.resume()
  } catch {
    /* a context that cannot resume still gets started by the first gesture */
  }

  const source = context.createMediaStreamSource(stream)
  const analyser = context.createAnalyser()
  analyser.fftSize = 1024
  analyser.smoothingTimeConstant = 0.35
  source.connect(analyser)

  /* A ScriptProcessor only runs while it is connected to the graph; a zero gain
     node keeps it alive without echoing the microphone into the speakers. */
  const processor = context.createScriptProcessor(FRAME, 1, 1)
  const sink = context.createGain()
  sink.gain.value = 0
  source.connect(processor)
  processor.connect(sink)
  sink.connect(context.destination)

  const frameMs = (FRAME / context.sampleRate) * 1000
  let stopped = false
  let calibrating = true
  let calibration = []
  let floor = 0
  let threshold = vadThreshold(0)
  let speaking = false
  let hot = 0
  let quietMs = 0
  let voicedMs = 0
  let segmentMs = 0
  let segment = []
  let level = 0
  let lastLevelAt = 0

  function flush() {
    speaking = false
    hot = 0
    quietMs = 0
    const frames = segment
    const voiced = voicedMs
    segment = []
    segmentMs = 0
    voicedMs = 0
    if (voiced < MIN_SPEECH_MS || !frames.length) return
    const total = frames.reduce((sum, frame) => sum + frame.length, 0)
    const flat = new Float32Array(total)
    let offset = 0
    for (const frame of frames) {
      flat.set(frame, offset)
      offset += frame.length
    }
    try {
      onSegment(encodeWav(downsample(flat, context.sampleRate, 16_000), 16_000))
    } catch (error) {
      onError(String(error?.message || error))
    }
  }

  function onAudio(event) {
    if (stopped) return
    const input = event.inputBuffer.getChannelData(0)
    const frame = new Float32Array(input.length)
    frame.set(input)
    const energy = rms(frame)
    const now = typeof performance !== 'undefined' ? performance.now() : 0

    if (calibrating) {
      calibration.push(energy)
      if (calibration.length * frameMs >= 350) {
        const sorted = [...calibration].sort((a, b) => a - b)
        floor = sorted[Math.floor(sorted.length / 2)] || 0
        threshold = vadThreshold(floor)
        calibrating = false
        calibration = []
      }
      return
    }

    level = Math.min(1, energy / (threshold * 3))
    if (now - lastLevelAt >= 60) {
      lastLevelAt = now
      onLevel(level)
    }

    if (!speaking) {
      hot = energy >= threshold ? hot + 1 : 0
      if (hot >= 2) {
        speaking = true
        segment = []
        segmentMs = 0
        voicedMs = 0
        quietMs = 0
        onSpeechStart()
      }
      return
    }

    segment.push(frame)
    segmentMs += frameMs
    if (energy >= threshold) {
      voicedMs += frameMs
      quietMs = 0
    } else {
      quietMs += frameMs
    }
    if (segmentMs >= Math.max(1000, maxSeconds * 1000)) flush()
    else if (quietMs >= SILENCE_MS && voicedMs >= MIN_SPEECH_MS) flush()
  }

  processor.onaudioprocess = onAudio

  function release() {
    try {
      processor.onaudioprocess = null
      processor.disconnect()
      sink.disconnect()
      analyser.disconnect()
      source.disconnect()
    } catch {
      /* already torn down */
    }
    for (const track of stream.getTracks()) {
      try {
        track.stop()
      } catch {
        /* the device was removed */
      }
    }
    context.close?.().catch?.(() => {})
  }

  return {
    stop() {
      if (stopped) return
      stopped = true
      /* A take that is still open is discarded, not transcribed: stop() runs
         when the dialog closes or the microphone is paused, and a transcript
         arriving after that would send a message nobody asked for. */
      speaking = false
      segment = []
      segmentMs = 0
      voicedMs = 0
      release()
    },
    level: () => level,
    threshold: () => threshold,
    sampleRate: () => context.sampleRate,
  }
}
