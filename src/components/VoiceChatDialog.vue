<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import EntityMark from '@/components/EntityMark.vue'
import PixelBackdrop from '@/components/PixelBackdrop.vue'
import { call } from '@/composables/localBridge'
import { colorById, markFor, moodGlyph, playReaction } from '@/composables/entityMark'
import { useDialogDismiss } from '@/composables/useDialog'
import { shortcutLabel } from '@/lib/shortcuts'
import {
  base64FromBytes,
  createSpeaker,
  createWebRecognizer,
  echoLikely,
  isStopPhrase,
  resetWebSpeechFailure,
  speechText,
  splitSpeech,
  startMicrophone,
  webSpeechUsable,
} from '@/lib/voice'

/**
 * Voice mode: one full-screen dialog, one turn at a time.
 *
 * Talk and the entity answers out loud. Talking *while* it works or speaks is
 * the point, not an accident: a speech onset stops the voice immediately, and a
 * finished sentence during a turn interrupts that turn (the page cancels it and
 * sends the new words as the next message, so more context is never lost).
 *
 * The engine is chosen, never assumed — the browser's recognition when it can
 * actually run, a local whisper CLI when it cannot, and typing when neither is
 * there. The dialog is honest about which one is in use.
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  entity: { type: String, default: '' },
  workspace: { type: String, default: '' },
  thread: { type: Object, default: null },
  sending: { type: Boolean, default: false },
  stopping: { type: Boolean, default: false },
  live: { type: Object, default: null },
})
const emit = defineEmits(['close', 'send', 'interrupt', 'stop'])

const MUTE_KEY = 'entity.voice.muted'
const escLabel = shortcutLabel('escape')
const voiceShortcut = shortcutLabel('voice')

const mode = ref('idle') /* idle · listening · transcribing · thinking · speaking · blocked */
const engine = ref('') /* webspeech · local · none */
const local = ref(null)
const error = ref('')
const caption = ref('')
const partial = ref('')
const heard = ref('')
const typed = ref('')
const level = ref(0)
const clock = ref(Date.now())
const micOn = ref(false)
const muted = ref(readMuted())
/* The words the entity is saying, split exactly as the speaker splits them, so
   the line being read can be highlighted. A voice with an accent is much easier
   to follow with the text in front of you. */
const replyChunks = ref([])
const activeChunk = ref(-1)
const replyEl = ref(null)

let speaker = null
let recognizer = null
let mic = null
let ticker = null
let turnAt = 0
let spokenText = ''
let speechIdle = 0
let lastSpeechAt = 0
const spoken = new Set()

const mark = computed(() => markFor(props.workspace || '', props.entity || ''))
const color = computed(() => colorById(mark.value.color, mark.value.custom).hex)
const emoji = computed(() => moodGlyph(mark.value.mood) || '💬')

const liveSteps = computed(() => props.live?.steps || [])
const liveAction = computed(() => {
  const steps = liveSteps.value
  const writing = steps.some((step) => step.type === 'text' && step.content)
  const tool = [...steps].reverse().find((step) => step.type === 'tool_use' && !step.endedAt)
  if (writing) return 'Writing'
  if (tool) return `Running ${tool.tool || 'tool'}`
  if (steps.some((step) => step.type === 'thinking' && step.content)) return 'Thinking'
  return 'Working'
})

const elapsed = computed(() => {
  if (mode.value !== 'thinking') return ''
  const started = Date.parse(props.live?.execution?.startedAt || '')
  const from = Number.isFinite(started) ? started : turnAt
  if (!from) return ''
  return duration(Math.max(0, clock.value - from))
})

const status = computed(() => {
  if (mode.value === 'listening') return partial.value || 'Listening…'
  if (mode.value === 'transcribing') return 'Transcribing…'
  if (mode.value === 'thinking') return [liveAction.value, elapsed.value].filter(Boolean).join(' · ')
  if (mode.value === 'speaking') return 'Speaking…'
  if (mode.value === 'blocked') return 'Voice input is unavailable'
  return 'Paused'
})

const hint = computed(() => {
  if (mode.value === 'thinking') {
    return 'Talk again to interrupt — your new words become the next message.'
  }
  if (mode.value === 'speaking') return 'Talk over the entity to take the floor.'
  if (mode.value === 'listening') return `Speak freely. Say “stop” to cancel a turn.`
  if (mode.value === 'transcribing') return 'One moment — turning that into text.'
  if (mode.value === 'blocked') return error.value
  return micOn.value ? 'The microphone is open.' : 'Press the microphone to start again.'
})

const engineLabel = computed(() => {
  if (engine.value === 'webspeech') return 'Browser speech'
  if (engine.value === 'local') {
    const name = local.value?.stt?.model ? String(local.value.stt.model).split('/').pop() : ''
    return name ? `Local · ${name}` : 'Local transcription'
  }
  return 'Typing only'
})

function readMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) === '1'
  } catch {
    return false
  }
}

function writeMuted(value) {
  try {
    localStorage.setItem(MUTE_KEY, value ? '1' : '0')
  } catch {
    /* a blocked storage quota must not break voice */
  }
}

function duration(ms) {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

function messageKey(message) {
  return message?.id || `${message?.at || ''}|${message?.who || ''}|${String(message?.text || '').slice(0, 48)}`
}

/** Everything already in the thread is history; only new replies are read. */
function rememberExisting() {
  spoken.clear()
  for (const message of props.thread?.messages || []) {
    if (message?.who === 'agent') spoken.add(messageKey(message))
  }
}

async function probeLocal() {
  try {
    return await call('voice.status')
  } catch (failure) {
    return {
      stt: { available: false, reason: String(failure?.message || failure) },
    }
  }
}

function speakerError(reason) {
  if (reason === 'not-allowed') return
  /* A failed utterance must not leave the surface stuck on "Speaking…". */
  if (mode.value === 'speaking') mode.value = micOn.value ? 'listening' : 'idle'
  caption.value = 'The system voice could not speak that. The text is in the thread.'
}

function buildSpeaker() {
  speaker = createSpeaker({
    language: typeof navigator !== 'undefined' ? navigator.language || 'en-US' : 'en-US',
    onStart: () => {
      if (!props.open) return
      lastSpeechAt = Date.now()
      mode.value = 'speaking'
    },
    onChunk: (_text, index) => {
      activeChunk.value = index
    },
    onEnd: () => {
      if (!props.open) return
      activeChunk.value = -1
      if (mode.value === 'speaking') mode.value = props.sending ? 'thinking' : 'listening'
    },
    onError: speakerError,
  })
}

function speakReply(message) {
  const text = speechText(message?.text)
  if (!text) return
  spokenText = text
  replyChunks.value = splitSpeech(text)
  activeChunk.value = -1
  if (muted.value || !speaker?.supported) return
  speaker.speak(text)
}

/* Follow the line being read. The block is short and scrolls, so a long answer
   never pushes the controls out of the dialog. */
watch(activeChunk, () => {
  nextTick(() => {
    const at = replyEl.value?.querySelector('[data-on="1"]')
    at?.scrollIntoView({ block: 'nearest' })
  })
})

/* ── listening ───────────────────────────────────────────────────── */

function handleFinal(text, source = 'voice') {
  const clean = String(text || '').trim()
  partial.value = ''
  if (!clean) return
  /* The entity hearing its own speaker is not a message. Only recent speech can
     be an echo: minutes later the same words are a person quoting the answer. */
  if (
    source === 'voice' &&
    Date.now() - lastSpeechAt < 1500 &&
    echoLikely(clean, spokenText)
  ) {
    caption.value = 'That sounded like my own voice — go ahead.'
    return
  }
  /* A typed "stop" is a message; a spoken one is an instruction. */
  if (source === 'voice' && isStopPhrase(clean)) {
    if (props.sending) emit('stop')
    caption.value = 'Stopped.'
    heard.value = ''
    mode.value = props.sending ? 'thinking' : 'listening'
    return
  }
  heard.value = clean
  error.value = ''
  /* a new turn retires the previous answer's text */
  replyChunks.value = []
  activeChunk.value = -1
  if (props.sending) {
    caption.value = 'Interrupting the turn — sending this as new context.'
    emit('interrupt', clean)
  } else {
    caption.value = ''
    emit('send', clean)
  }
  turnAt = clock.value
  mode.value = 'thinking'
}

function onSpeechStart() {
  /* Barge-in: the moment a person starts talking, the entity's voice stops.
     Recognition is left running so the sentence that interrupted still lands. */
  if (mode.value === 'speaking') {
    speaker?.stop()
    mode.value = 'listening'
    caption.value = 'Go ahead.'
  }
}

function webSpeechProblem(reason) {
  if (reason === 'no-speech' || reason === 'aborted') return
  if (reason === 'network' || reason === 'service-not-allowed') {
    /* Electron has the constructor but no recognition service behind it. */
    if (local.value?.stt?.available) {
      engine.value = 'local'
      caption.value = 'The browser speech service is unavailable here — using local transcription.'
      pauseListening()
      listen()
      return
    }
    mode.value = 'blocked'
    error.value =
      'This build has no speech recognition service and no local whisper CLI. Type below, and the entity still speaks its answer.'
    return
  }
  if (reason === 'not-allowed') {
    mode.value = 'blocked'
    error.value =
      'Microphone access is off for Entity. Allow it in System Settings → Privacy & Security → Microphone, then press Retry.'
    return
  }
  caption.value = `Speech recognition stopped (${reason}).`
}

async function listen() {
  if (!props.open || engine.value === 'none') return
  error.value = ''
  if (engine.value === 'webspeech') {
    if (!recognizer) {
      recognizer = createWebRecognizer({
        language: typeof navigator !== 'undefined' ? navigator.language || 'en-US' : 'en-US',
        onPartial: (text) => {
          partial.value = text
          if (text && mode.value !== 'speaking' && mode.value !== 'thinking') mode.value = 'listening'
        },
        onFinal: (text) => handleFinal(text),
        onSpeechStart,
        onError: webSpeechProblem,
      })
    }
    if (recognizer.start()) {
      micOn.value = true
      mode.value = 'listening'
    }
    return
  }

  if (engine.value === 'local') {
    try {
      mic = await startMicrophone({
        onLevel: (value) => {
          level.value = value
        },
        onSpeechStart,
        onSegment: (bytes) => transcribe(bytes),
        onError: (reason) => {
          caption.value = String(reason)
        },
      })
      micOn.value = true
      mode.value = 'listening'
    } catch (failure) {
      mic = null
      micOn.value = false
      mode.value = 'blocked'
      if (failure?.name === 'NotAllowedError' || failure?.name === 'SecurityError') {
        error.value = 'Microphone access is blocked. Allow it for Entity, then press Retry.'
      } else if (failure?.name === 'NotFoundError' || /device not found/i.test(String(failure?.message))) {
        error.value = 'No microphone was found on this machine.'
      } else {
        error.value = String(failure?.message || failure)
      }
    }
  }
}

function pauseListening() {
  recognizer?.stop()
  mic?.stop()
  mic = null
  micOn.value = false
  level.value = 0
  partial.value = ''
  if (mode.value === 'listening' || mode.value === 'transcribing') mode.value = 'idle'
}

function toggleMic() {
  if (micOn.value) {
    pauseListening()
    caption.value = 'Listening paused. Nothing is being recorded.'
    return
  }
  listen()
}

async function transcribe(bytes) {
  if (!props.open) return
  mode.value = 'transcribing'
  try {
    const result = await call('voice.transcribe', {
      audio: base64FromBytes(bytes),
      mime: 'audio/wav',
      language: typeof navigator !== 'undefined' ? navigator.language || 'en-US' : 'en-US',
    })
    if (!props.open) return
    mode.value = micOn.value ? 'listening' : 'idle'
    handleFinal(result?.text || '')
  } catch (failure) {
    if (!props.open) return
    mode.value = micOn.value ? 'listening' : 'idle'
    caption.value = String(failure?.message || failure)
  }
}

function submitTyped() {
  const text = typed.value.trim()
  if (!text) return
  typed.value = ''
  handleFinal(text, 'typed')
}

/* ── session lifecycle ───────────────────────────────────────────── */

async function begin() {
  error.value = ''
  caption.value = ''
  partial.value = ''
  heard.value = ''
  typed.value = ''
  level.value = 0
  mode.value = 'idle'
  clock.value = Date.now()
  rememberExisting()
  playReaction(props.workspace, props.entity, 'happy')
  buildSpeaker()
  local.value = await probeLocal()
  if (!props.open) return
  engine.value = webSpeechUsable() ? 'webspeech' : local.value?.stt?.available ? 'local' : 'none'
  if (engine.value === 'none') {
    mode.value = 'blocked'
    error.value = local.value?.stt?.reason || 'No speech engine is available in this build.'
    return
  }
  await listen()
}

function retry() {
  resetWebSpeechFailure()
  pauseListening()
  local.value = null
  begin()
}

/** The Stop control: silence the voice, or cancel the turn that is running. */
function stopNow() {
  if (mode.value === 'speaking') {
    speaker?.stop()
    mode.value = micOn.value ? 'listening' : 'idle'
    return
  }
  emit('stop')
}

function teardown() {
  pauseListening()
  speaker?.stop()
  speaker = null
  recognizer = null
  clearInterval(ticker)
  ticker = null
  spoken.clear()
  spokenText = ''
  replyChunks.value = []
  activeChunk.value = -1
  partial.value = ''
  level.value = 0
  mode.value = 'idle'
}

function requestClose() {
  teardown()
  emit('close')
}

useDialogDismiss({ active: () => props.open, close: requestClose })

watch(
  () => props.open,
  (open) => {
    clearInterval(ticker)
    ticker = null
    if (!open) {
      teardown()
      return
    }
    ticker = setInterval(() => {
      clock.value = Date.now()
      /* Some platforms accept an utterance and never report the end (no voice
         installed, audio device gone). Three seconds of silence from a speaker
         that is meant to be talking is treated as the end. */
      if (mode.value === 'speaking' && speaker && !speaker.speaking()) {
        speechIdle += 1
        if (speechIdle >= 12) {
          speechIdle = 0
          speaker.stop()
          mode.value = micOn.value ? 'listening' : 'idle'
        }
      } else {
        speechIdle = 0
      }
    }, 250)
    begin()
  },
  { immediate: true },
)

/* a turn that ends puts us back in front of the microphone */
watch(
  () => props.sending,
  (sending) => {
    if (!props.open) return
    if (sending) {
      if (mode.value !== 'speaking') mode.value = 'thinking'
      return
    }
    if (mode.value !== 'thinking') return
    /* an interrupt briefly leaves the thread idle between cancel and re-send */
    setTimeout(() => {
      if (props.open && !props.sending && !props.stopping && mode.value === 'thinking') {
        mode.value = micOn.value ? 'listening' : 'idle'
      }
    }, 700)
  },
)

/* The reply is spoken when it lands. Agent rows are append-only in the store,
   so the newest agent row we have not read yet is the answer to this turn. */
watch(
  () => props.thread?.messages?.length || 0,
  () => {
    if (!props.open) return
    const list = props.thread?.messages || []
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const message = list[index]
      if (message?.who !== 'agent') continue
      const key = messageKey(message)
      if (spoken.has(key)) break
      spoken.add(key)
      speakReply(message)
      break
    }
  },
)

/* A failed turn is a system row; say something rather than going quiet. */
watch(
  () => {
    const list = props.thread?.messages || []
    const last = list[list.length - 1]
    return last?.error ? `${last.at || ''}:${list.length}` : ''
  },
  (flag) => {
    if (!props.open || !flag) return
    mode.value = micOn.value ? 'listening' : 'idle'
    caption.value = 'That turn failed. The thread has the details.'
  },
)

watch(muted, (value) => {
  writeMuted(value)
  if (value) speaker?.stop()
})

onBeforeUnmount(teardown)
</script>

<template>
  <Teleport to="body">
    <div class="scrim" :data-open="open ? '1' : '0'" @click="requestClose"></div>
    <div
      class="modal voice-modal"
      :data-open="open ? '1' : '0'"
      :data-mode="mode"
      role="dialog"
      aria-modal="true"
      aria-label="Voice mode"
    >
      <button class="x mo-x voice-close" type="button" aria-label="Close" @click="requestClose">
        <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M2 2l8 8M10 2l-8 8" />
        </svg>
      </button>

      <div class="voice-room" :style="{ '--vc': color }">
        <PixelBackdrop variant="hero" :color="color" :active="mode === 'listening' || mode === 'thinking'" :count="16" />

        <div class="voice-stage">
          <div class="voice-orb" :data-live="mode === 'speaking' ? '1' : '0'" aria-hidden="true">
            <span class="voice-emoji">{{ emoji }}</span>
          </div>
          <div class="voice-figure">
            <EntityMark :entity="entity" hop :badge="false" />
          </div>
        </div>

        <p class="voice-status" role="status" aria-live="polite">{{ status }}</p>
        <p class="voice-hint">{{ hint }}</p>

        <div
          v-if="replyChunks.length"
          ref="replyEl"
          class="voice-reply"
          :data-live="activeChunk >= 0 ? '1' : '0'"
          aria-label="Entity reply"
        >
          <span class="voice-reply-kicker">{{ entity || 'Entity' }} says</span>
          <span
            v-for="(chunk, index) in replyChunks"
            :key="index"
            class="voice-reply-chunk"
            :data-on="index === activeChunk ? '1' : '0'"
          >{{ chunk }} </span>
        </div>

        <div class="voice-wave" :data-on="mode === 'listening' ? '1' : '0'" aria-hidden="true">
          <i v-for="bar in 7" :key="bar" :style="{ '--lvl': Math.max(0.08, Math.min(1, level + (bar % 3) * 0.16)) }"></i>
        </div>

        <p v-if="heard && mode !== 'thinking'" class="voice-heard">“{{ heard }}”</p>

        <div class="voice-controls">
          <button
            class="voice-btn"
            type="button"
            :data-on="micOn ? '1' : '0'"
            :aria-pressed="micOn ? 'true' : 'false'"
            :title="micOn ? 'Pause the microphone' : 'Start listening'"
            :disabled="engine === 'none'"
            @click="toggleMic"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
              <rect x="6" y="2.4" width="4" height="7.2" rx="2" />
              <path d="M3.6 8a4.4 4.4 0 008.8 0M8 12.4V14" stroke-linecap="round" />
            </svg>
            <span>{{ micOn ? 'Pause' : 'Listen' }}</span>
          </button>
          <button
            v-if="mode === 'speaking' || mode === 'thinking'"
            class="voice-btn"
            type="button"
            title="Stop this turn"
            @click="stopNow"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.2" />
            </svg>
            <span>Stop</span>
          </button>
          <button
            class="voice-btn"
            type="button"
            :data-on="muted ? '0' : '1'"
            :aria-pressed="muted ? 'false' : 'true'"
            :title="muted ? 'Unmute the entity voice' : 'Mute the entity voice'"
            @click="muted = !muted"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">
              <path d="M8.6 2.6L4.9 5.6H2.6v4.8h2.3l3.7 3z" />
              <path v-if="!muted" d="M11.2 5.8a3.1 3.1 0 010 4.4M13 4a5.2 5.2 0 010 8" />
              <path v-else d="M11 6l3 4M14 6l-3 4" />
            </svg>
            <span>{{ muted ? 'Muted' : 'Speak' }}</span>
          </button>
          <button v-if="mode === 'blocked'" class="voice-btn" type="button" @click="retry">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">
              <path d="M13 8a5 5 0 11-1.6-3.7M13 2.6V5.4h-2.8" />
            </svg>
            <span>Retry</span>
          </button>
        </div>

        <form class="voice-type" @submit.prevent="submitTyped">
          <input
            v-model="typed"
            type="text"
            autocomplete="off"
            aria-label="Type instead"
            :placeholder="engine === 'none' ? 'Type instead — no speech engine here' : 'Or type it…'"
          />
          <button class="btn" type="submit" :disabled="!typed.trim()">Send</button>
        </form>

        <p class="voice-meta">
          <span>{{ engineLabel }}</span>
          <span class="voice-meta-sep" aria-hidden="true"></span>
          <span>{{ voiceShortcut }} to toggle</span>
          <span class="voice-meta-sep" aria-hidden="true"></span>
          <span>{{ escLabel }} to close</span>
        </p>
      </div>
    </div>
  </Teleport>
</template>
