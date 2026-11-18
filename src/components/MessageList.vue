<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import EntityMark from '@/components/EntityMark.vue'
import ThreadMinimap from '@/components/ThreadMinimap.vue'
import MessageBody from '@/components/MessageBody.vue'
import DelegationCard from '@/components/DelegationCard.vue'
import DelegationHold from '@/components/DelegationHold.vue'
import ChatArtifacts from '@/components/ChatArtifacts.vue'
import TraceDigest from '@/components/TraceDigest.vue'
import { saveTextArtifact } from '@/stores/artifacts'
import { credentials, hub, isSending, toast } from '@/stores/hub'
import { copyText } from '@/lib/clipboard'
import { gravatarUrl } from '@/lib/gravatar'
import { createSpeaker } from '@/lib/voice'

/**
 * The thread surface. It scrolls itself to the newest message whenever the
 * conversation grows; chips are offered only before the first question.
 */
const props = defineProps({
  messages: { type: Array, default: () => [] },
  chips: { type: Array, default: () => [] },
  listClass: { type: String, default: 'ask-thread' },
  live: { type: Object, default: null },
  entityName: { type: String, default: 'entity' },
  threadId: { type: String, default: '' },
  focusIndex: { type: Number, default: -1 },
  shareUrl: { type: Function, default: null },
  followups: { type: Array, default: () => [] },
  followupsBusy: { type: Boolean, default: false },
  /* The thread search lives in the chat header; the list only paints the hits
     and scrolls to the one that is active. */
  searchHits: { type: Array, default: () => [] },
  searchActive: { type: Number, default: -1 },
})
const emit = defineEmits(['chip', 'retry', 'followup', 'suggest', 'open-thread', 'delegate'])

/* Follow-ups belong to the newest completed reply, not to an empty thread and
   not while a turn is streaming. */
const showFollowups = computed(() => {
  if (props.live) return false
  const last = props.messages[props.messages.length - 1]
  return Boolean(last && last.who === 'agent' && !last.error)
})

const box = ref(null)
const saving = ref('')
/* Which message is being read aloud, by key. One speaker per thread: starting a
   second read stops the first instead of queueing behind it. */
const reading = ref('')
let reader = null
const appliedFocus = ref('')
/* A collapsed trace is a label, not a mounted DOM tree. Long tool transcripts
   were being rendered for every message even while their folds were shut. */
const openTraces = ref(new Set())

/* The live bubble reads the same steps the trace does. It is deliberately
   plain text: parsing Markdown on every token would make the answer more
   expensive than the model that produced it. The final message renders prose. */
const clock = ref(Date.now())
let clockTimer = null
watch(
  () => props.live?.messageId,
  (id) => {
    if (clockTimer) clearInterval(clockTimer)
    clockTimer = null
    if (!id) return
    clock.value = Date.now()
    clockTimer = setInterval(() => {
      clock.value = Date.now()
    }, 1000)
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  if (clockTimer) clearInterval(clockTimer)
  clockTimer = null
  reader?.stop()
  reader = null
})

const liveSteps = computed(() => props.live?.steps || [])

const liveText = computed(() => {
  const steps = liveSteps.value
  let afterTool = -1
  steps.forEach((step, index) => {
    if (step.type === 'tool_use' || step.type === 'tool_result') afterTool = index
  })
  const tail = afterTool >= 0 ? steps.slice(afterTool + 1) : steps
  return tail
    .filter((step) => step.type === 'text' && step.content)
    .map((step) => step.content)
    .join('\n\n')
    .trim()
})

/* Rows the fan-out has announced, with answers as they land. The card grammar is
   the one the finished answer uses, so nothing changes shape mid-turn. A held
   plan paints its own rows; the queued event that preceded it must not double
   them. */
const liveDelegations = computed(() => {
  if (props.live?.hold) return []
  return (props.live?.delegations || []).map((row) => ({
    kind: 'entity',
    name: row.name,
    row: row.row,
    job: row.job,
    share: row.share,
    status: row.status,
    answer: row.answer,
    note: row.note,
    ms: row.ms,
    live: true,
  }))
})

const liveProgress = computed(() => {
  const rows = props.live?.delegations || []
  if (!rows.length) return ''
  const done = rows.filter((row) => row.status === 'ok' || row.status === 'error').length
  return `${done} of ${rows.length} done`
})

const liveTool = computed(() => {
  const tools = liveSteps.value.filter((step) => step.type === 'tool_use')
  const last = tools[tools.length - 1]
  return last && !last.endedAt ? last.tool || 'tool' : ''
})

const liveThinking = computed(() =>
  liveSteps.value.some((step) => step.type === 'thinking' && step.content),
)

const liveElapsed = computed(() => {
  const start = Date.parse(props.live?.execution?.startedAt || '')
  return Number.isFinite(start) ? formatDuration(Math.max(0, clock.value - start)) : ''
})

const liveAction = computed(() => {
  if (liveText.value) return 'Writing'
  if (liveTool.value) return `Running ${liveTool.value}`
  if (liveThinking.value) return 'Thinking'
  return 'Starting'
})

/* While rows are delegated the cards are the status — each one says Working or
   keeps its answer — so the foot carries the count and the clock, not another
   sentence about the same thing. A held plan has no progress yet: the block says
   what is waiting, so the foot keeps only the clock. */
const liveStatus = computed(() => {
  const plan = props.live?.hold
  /* A held plan has not started: the foot says what is waiting, not what is
     happening. */
  if (plan) {
    const n = Array.isArray(plan.rows) ? plan.rows.length : 0
    return `held · ${n} ${n === 1 ? 'run' : 'runs'} · 0 started`
  }
  return [liveProgress.value ? liveProgress.value : liveAction.value, liveElapsed.value]
    .filter(Boolean)
    .join(' · ')
})

/* The bubble belongs to the signed-in account; the entity owns the reply. */
const accountEmail = computed(() => hub.session?.email || credentials().email || '')
const userAvatar = computed(() => gravatarUrl(accountEmail.value, 96))

/* A long transcript is mounted newest-first: the rows a person actually lands
   on are painted now, a screenful of history follows on the next frames, and
   anything older is mounted when someone scrolls back into it. */
const INITIAL_ROWS = 24
const ROWS_PER_STEP = 24
/* Everything past this is mounted only when someone scrolls back into it.
   Filling a four-hundred-message thread in the background was a second of
   main-thread work nobody had asked to see. */
const PREFILL_ROWS = 96
const firstShown = ref(0)
let growing = 0
/* While older rows are being filled in, keep the newest message pinned to the
   bottom — a switch is not a reason to scroll someone into the middle of a
   transcript. A wheel, touch or key hands control back. */
let pin = true
/* The template needs the same fact: a reader who left the bottom is offered a
   way back. `setPin` is the only writer, so the two can never disagree. */
const following = ref(true)

function setPin(value) {
  pin = value
  following.value = value
}

function releasePin() {
  setPin(false)
}

let settleToken = 0

/** Late layout (a screenshot decode, an artifact list, the dock settling) can
    move the bottom after the switch. While the newest message is still pinned,
    confirm it a couple of times instead of chasing every mutation. */
function settleLater() {
  const token = ++settleToken
  for (const delay of [60, 240, 700]) {
    setTimeout(() => {
      if (token !== settleToken || !pin || !box.value) return
      box.value.scrollTop = box.value.scrollHeight
    }, delay)
  }
}

function resetWindow() {
  const total = props.messages.length
  const focused = props.focusIndex >= 0
  firstShown.value = focused ? 0 : Math.max(0, total - INITIAL_ROWS)
  /* A link to one message owns the scroll position; nothing may snap away. */
  setPin(!focused)
  grow()
  if (pin) settleLater()
}

/* One step per frame. `requestIdleCallback` is not used: the entity mark runs
   its own animation loop, so an idle window can be a long time coming and a
   thread would finish filling in half a second later. */
function grow(force = false) {
  if (firstShown.value <= 0 || growing) return
  const rendered = props.messages.length - firstShown.value
  if (!force && rendered >= PREFILL_ROWS) return
  growing = requestAnimationFrame(() => {
    growing = 0
    firstShown.value = Math.max(0, firstShown.value - ROWS_PER_STEP)
    /* Scroll anchoring keeps the reader where they are while rows are inserted
       above them; the last prefill step confirms the newest message is still
       under the eye. Growth the reader asked for never moves them. */
    const renderedNow = props.messages.length - firstShown.value
    const settled = firstShown.value === 0 || (!force && renderedNow >= PREFILL_ROWS)
    if (pin && settled) {
      nextTick(() => {
        if (pin && box.value) box.value.scrollTop = box.value.scrollHeight
      })
    }
    /* Keep going while the reader is still near the top: reaching the oldest
       mounted message should reveal the next batch, not stop at a dead end. */
    if (firstShown.value > 0 && box.value && box.value.scrollTop < 800) grow(true)
    else grow()
  })
}

/* Someone is reading backwards: continue a step at a time for as long as the
   top is near. */
function onScroll() {
  const el = box.value
  if (!el) return
  /* Clearly away from the end: stop following resizes (a growing composer
     should not pull a reader down). Small gaps are just rows settling. */
  const gap = el.scrollHeight - el.scrollTop - el.clientHeight
  if (gap > 400) setPin(false)
  else if (gap < 8) setPin(true)
  if (firstShown.value <= 0 || el.scrollTop >= 800) return
  /* Reading backwards means the newest message no longer owns the viewport. */
  setPin(false)
  grow(true)
}

/** Mount the rows down to `index`, so the minimap can jump to any message. */
function revealThrough(index) {
  if (typeof index !== 'number' || index < 0) return
  if (firstShown.value <= index) return
  firstShown.value = Math.max(0, index - 2)
}

/* A live turn replaces the message array with the same conversation in it; only
   a different conversation (or a deep link to an old message) resets the
   window, or every reply would re-mount the transcript around it. */
let shownFor = ''
watch(
  () => [props.threadId, props.messages[0]?.id || '', props.focusIndex],
  ([threadId, firstId, focus]) => {
    const key = `${threadId}:${firstId}:${focus >= 0 ? focus : ''}`
    if (key === shownFor) return
    shownFor = key
    if (growing) {
      cancelAnimationFrame(growing)
      growing = 0
    }
    resetWindow()
  },
  { immediate: true },
)

let scrolling = false

/**
 * Follow the newest row — but only while the reader is still following. A
 * streamed chunk must never pull someone back down: that is the whole point of
 * the follow flag, and these watchers fire many times a second during a turn.
 */
function toBottom() {
  if (!pin) return
  /* Three watchers can fire in the same tick; one scroll is enough, and each
     one forces a layout of the whole transcript. */
  if (scrolling) return
  scrolling = true
  nextTick(() => {
    scrolling = false
    if (!pin) return
    if (box.value) box.value.scrollTop = box.value.scrollHeight
  })
}

/** One click puts the reader back on the live turn and follows it again. */
function toNewest() {
  setPin(true)
  nextTick(() => {
    if (box.value) box.value.scrollTop = box.value.scrollHeight
  })
}

watch(() => props.messages.length, toBottom, { immediate: true })
watch(() => props.threadId, toBottom)

let resizes = null

onMounted(() => {
  const el = box.value
  if (!el) return
  /* The composer dock can settle a frame later and take height from the
     transcript. While the newest message is pinned, follow that resize. */
  resizes = new ResizeObserver(() => {
    if (pin) el.scrollTop = el.scrollHeight
  })
  resizes.observe(el)
  el.addEventListener('wheel', releasePin, { passive: true })
  el.addEventListener('scroll', onScroll, { passive: true })
  el.addEventListener('touchmove', releasePin, { passive: true })
  el.addEventListener('keydown', releasePin)
})

onBeforeUnmount(() => {
  resizes?.disconnect()
  resizes = null
  const el = box.value
  if (el) {
    el.removeEventListener('wheel', releasePin)
    el.removeEventListener('scroll', onScroll)
    el.removeEventListener('touchmove', releasePin)
    el.removeEventListener('keydown', releasePin)
  }
  if (growing) {
    cancelAnimationFrame(growing)
    growing = 0
  }
})
watch(() => props.live?.steps?.length || 0, toBottom)
watch(() => liveText.value.length, toBottom)

async function scrollToFocus() {
  if (props.focusIndex < 0) return false
  await nextTick()
  return scrollToAnchor(props.focusIndex)
}

/** Scroll one anchor into view, mounting older rows first when needed. */
async function scrollToAnchor(index, attempt = 0) {
  const boxEl = box.value
  if (!boxEl) return false
  const target = boxEl.querySelector(`[data-thread-anchor="${index}"]`)
  if (!target) {
    if (attempt >= 2) return false
    await nextTick()
    return scrollToAnchor(index, attempt + 1)
  }
  const top =
    target.getBoundingClientRect().top - boxEl.getBoundingClientRect().top + boxEl.scrollTop - 16
  const distance = Math.abs(top - boxEl.scrollTop)
  /* A smooth scroll over a long transcript reads as a slow load; only animate
     when the destination is close enough to see the movement. */
  boxEl.scrollTo({
    top: Math.max(0, top),
    behavior: distance > boxEl.clientHeight * 2 ? 'auto' : 'smooth',
  })
  return true
}

/** Mount down to a message and put it on screen; used by the header search. */
async function jumpTo(index) {
  if (typeof index !== 'number' || index < 0) return
  setPin(false)
  revealThrough(index)
  await nextTick()
  await scrollToAnchor(index)
}

defineExpose({ jumpTo })

watch(
  () => [props.messages.length, props.focusIndex, props.threadId],
  async () => {
    const key = `${props.threadId}:${props.focusIndex}`
    if (props.focusIndex < 0 || appliedFocus.value === key) return
    if (await scrollToFocus()) appliedFocus.value = key
  },
  { immediate: true },
)

async function copyMessage(message) {
  const copied = await copyText(message.text)
  const noun = message.who === 'me' ? 'Message' : 'Response'
  toast(copied ? `${noun} copied` : `The ${noun.toLowerCase()} could not be copied.`)
}

/** The message's own address: a web URL in a tab, `entity://` in the app. */
function linkFor(message, index) {
  const raw = props.shareUrl ? props.shareUrl(index, message) : ''
  if (!raw) return ''
  try {
    return new URL(raw, window.location.href).href
  } catch {
    return ''
  }
}

/**
 * Share means "hand this to someone else", and the two environments can do
 * different things:
 *
 *  - a browser tab has the Web Share API, so the OS sheet takes the text and the
 *    link;
 *  - the packaged app does not — Electron implements neither `navigator.share`
 *    nor a share sheet — so the honest outcome is **the link on the clipboard**,
 *    not a quoted reference nobody asked for. Deep links (`entity://open/…`)
 *    travel between installs; a workspace with a remote server shares its URL.
 */
async function shareMessage(message, index) {
  const url = linkFor(message, index)
  if (navigator.share) {
    try {
      await navigator.share({
        title: `Chat with ${props.entityName}`,
        text: message.text,
        ...(url ? { url } : {}),
      })
      return
    } catch (error) {
      if (error?.name === 'AbortError') return
    }
  }
  const copied = await copyText(url || message.text)
  toast(
    copied
      ? url
        ? 'Link copied'
        : 'Response copied'
      : 'The link could not be copied.',
  )
}

async function saveMessage(message) {
  const id = message.id || message.at || 'reply'
  if (saving.value) return
  saving.value = id
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const name = `chat-${props.entityName}-${stamp}.md`
    await saveTextArtifact(name, `# Chat with ${props.entityName}\n\n${message.text}\n`)
    toast('Saved to artifacts')
  } catch (error) {
    toast(error?.message || 'The response could not be saved to artifacts.')
  } finally {
    saving.value = ''
  }
}

function readKey(message) {
  return message.id || message.at || 'reply'
}

function readerFor() {
  if (!reader) {
    reader = createSpeaker({
      language: typeof navigator !== 'undefined' ? navigator.language || 'en-US' : 'en-US',
      onEnd: () => {
        reading.value = ''
      },
      onError: () => {
        reading.value = ''
        toast('The system voice could not read that response.')
      },
    })
  }
  return reader
}

/**
 * Read one answer aloud. The same voice mode uses, without opening the dialog:
 * a long reply is often easier to follow while reading something else, and it
 * is the fastest way to hear how an answer actually sounds.
 */
function readMessage(message) {
  const key = readKey(message)
  if (reading.value === key) {
    reader?.stop()
    reading.value = ''
    return
  }
  const speaker = readerFor()
  if (!speaker.supported) {
    toast('This build has no speech synthesis.')
    return
  }
  /* an answer being read stops before a different one starts */
  if (reading.value) speaker.stop()
  reading.value = key
  if (!speaker.speak(message.text)) reading.value = ''
}

watch(
  () => props.threadId,
  () => {
    reader?.stop()
    reading.value = ''
  },
)

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return ''
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

function elapsed(message) {
  return formatDuration(message.execution?.ms)
}

/** Entity mentions are one-shot sub-runs; their answers belong above the outer reply. */
function delegations(message) {
  const rows = message?.execution?.mentions || message?.mentions || []
  return rows.filter((mention) => mention?.kind === 'entity')
}

function traceKey(message, index) {
  return message.id || `msg-${message.at || index}`
}

function traceOpen(message, index) {
  return openTraces.value.has(traceKey(message, index))
}

function onTraceToggle(message, index, event) {
  const key = traceKey(message, index)
  const next = new Set(openTraces.value)
  if (event.target.open) next.add(key)
  else next.delete(key)
  openTraces.value = next
}

function hasTrace(message) {
  return Boolean(
    message?.steps?.some((step) =>
      ['thinking', 'tool_use', 'tool_result', 'error'].includes(step.type),
    ),
  )
}

function traceSummary(message) {
  const steps = message.steps || []
  const tools = steps.filter((step) => step.type === 'tool_use').length
  const thoughts = steps.filter((step) => step.type === 'thinking').length
  const duration = formatDuration(message.execution?.ms)
  return [duration, `${thoughts} reasoning`, `${tools} tool${tools === 1 ? '' : 's'}`]
    .filter(Boolean)
    .join(' · ')
}
</script>

<template>
  <div class="thread-shell">
    <div
      ref="box"
      :class="listClass"
      role="log"
      aria-live="polite"
      aria-label="Conversation with entity"
    >
    <template v-for="(m, i) in messages" :key="m.id || i">
      <template v-if="i >= firstShown">
      <template v-if="m.who === 'sys'">
        <DelegationHold
          v-if="m.hold"
          class="hold--settled"
          :settled="m.hold"
        />
        <div
          :id="`chat-msg-${i}`"
          class="ask-sys"
          :data-error="m.error ? '1' : '0'"
          :data-thread-anchor="i"
          :data-search-hit="searchHits.includes(i) ? '1' : '0'"
          :data-search-active="searchActive === i ? '1' : '0'"
        >
          <span>{{ m.text }}</span>
          <button
            v-if="m.error"
            class="ask-retry"
            type="button"
            :disabled="isSending(threadId)"
            @click="emit('retry', m)"
          >
            {{ isSending(threadId) ? 'Retrying…' : 'Retry' }}
          </button>
        </div>
        <ChatArtifacts
          v-if="m.artifacts?.length"
          class="msg-artifacts--sys"
          :items="m.artifacts"
        />
      </template>
      <div
        v-else
        :id="`chat-msg-${i}`"
        class="msg"
        :data-who="m.who"
        :data-thread-anchor="i"
        :data-search-hit="searchHits.includes(i) ? '1' : '0'"
        :data-search-active="searchActive === i ? '1' : '0'"
        :data-avatar="m.who === 'me' && userAvatar ? '1' : '0'"
        :style="m.who === 'me' && userAvatar ? { '--msg-avatar': 'url(' + userAvatar + ')' } : null"
      >
        <div
          v-if="m.who === 'agent' && delegations(m).length"
          class="msg-delegations"
          aria-label="Delegated work"
        >
          <DelegationCard
            v-for="(mention, j) in delegations(m)"
            :key="`${mention.token || mention.name || 'mention'}-${mention.share || j}`"
            :mention="mention"
            @open-thread="emit('open-thread', $event)"
          />
        </div>
        <MessageBody :text="m.text" />
        <EntityMark v-if="m.who === 'agent'" mini :entity="entityName" class="msg-avatar" />
      </div>
      <ChatArtifacts
        v-if="m.who !== 'sys' && m.artifacts?.length"
        class="msg-artifacts--turn"
        :data-who="m.who"
        :items="m.artifacts"
      />
      <details
        v-if="hasTrace(m)"
        class="msg-trace"
        :data-who="m.who"
        @toggle="onTraceToggle(m, i, $event)"
      >
        <summary class="msg-trace-head">
          <svg class="trace-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <path d="M6 3.5L10.5 8 6 12.5" />
          </svg>
          <span>{{ traceSummary(m) }}</span>
        </summary>
        <div v-if="traceOpen(m, i)" class="msg-trace-body">
          <TraceDigest :steps="m.steps" :execution="m.execution" />
        </div>
      </details>
      <div v-if="m.who !== 'sys'" class="msg-foot" :data-who="m.who">
        <span v-if="m.who === 'agent' && elapsed(m)" class="msg-replied">Replied in {{ elapsed(m) }}</span>
        <button
          class="msg-act"
          type="button"
          :title="m.who === 'me' ? 'Copy message' : 'Copy response'"
          :aria-label="m.who === 'me' ? 'Copy message' : 'Copy response'"
          @click="copyMessage(m)"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
            <rect x="5.2" y="5.2" width="8" height="8" rx="1.5" />
            <path d="M10.8 5.2V3.8a1.5 1.5 0 00-1.5-1.5H3.8a1.5 1.5 0 00-1.5 1.5v5.5a1.5 1.5 0 001.5 1.5h1.4" />
          </svg>
        </button>
        <button
          class="msg-act"
          type="button"
          :title="m.who === 'me' ? 'Share link to this message' : 'Share response'"
          :aria-label="m.who === 'me' ? 'Share link to this message' : 'Share response'"
          @click="shareMessage(m, i)"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
            <circle cx="12" cy="3.4" r="1.8" />
            <circle cx="4" cy="8" r="1.8" />
            <circle cx="12" cy="12.6" r="1.8" />
            <path d="M5.6 7.1l4.8-2.8M5.6 8.9l4.8 2.8" />
          </svg>
        </button>
        <button
          v-if="m.who === 'agent'"
          class="msg-act"
          type="button"
          title="Save response as an artifact"
          aria-label="Save response as an artifact"
          :disabled="saving === (m.id || m.at || 'reply')"
          @click="saveMessage(m)"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
            <path d="M3 2.4h6l4 4v7.2H3z" />
            <path d="M9 2.4v4h4M5.4 9.4h5.2M5.4 11.6h3.4" />
          </svg>
        </button>
        <button
          v-if="m.who === 'agent'"
          class="msg-act"
          type="button"
          :data-on="reading === readKey(m) ? '1' : '0'"
          :aria-pressed="reading === readKey(m) ? 'true' : 'false'"
          :title="reading === readKey(m) ? 'Stop reading' : 'Read response aloud'"
          :aria-label="reading === readKey(m) ? 'Stop reading' : 'Read response aloud'"
          @click="readMessage(m)"
        >
          <svg v-if="reading === readKey(m)" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.2" />
          </svg>
          <svg v-else viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true">
            <path d="M8.6 2.6L4.9 5.6H2.6v4.8h2.3l3.7 3z" />
            <path d="M11.2 5.8a3.1 3.1 0 010 4.4M13 4a5.2 5.2 0 010 8" />
          </svg>
        </button>
      </div>
      </template>
    </template>

    <div
      v-if="live"
      class="msg msg--live"
      data-who="agent"
      :data-delegating="liveDelegations.length || live.hold ? '1' : '0'"
    >
      <!-- A held plan: the runs are ready, nothing has started, and Run is the
           one action. Same bubble, same rows — only the state word changes. -->
      <DelegationHold
        v-if="live.hold"
        :plan="live.hold"
        @run="emit('delegate', 'run')"
        @cancel="emit('delegate', 'cancel')"
      />
      <!-- A fan-out is the turn: its rows are painted here, queued then
           running then answered, so minutes of work never read as a hang. -->
      <div v-if="liveDelegations.length" class="msg-delegations" aria-label="Delegated work in progress">
        <DelegationCard
          v-for="(mention, j) in liveDelegations"
          :key="`${mention.row || mention.name || 'run'}-${mention.index ?? j}`"
          :mention="mention"
        />
      </div>
      <div class="msg-body">
        <div v-if="liveText" class="msg-live-text">
          {{ liveText }}<span class="msg-live-caret" aria-hidden="true"></span>
        </div>
        <div v-else-if="!liveDelegations.length && !live.hold" class="msg-live-status">
          <span class="msg-live-dot" aria-hidden="true"></span>{{ liveAction }}…
        </div>
      </div>
      <EntityMark mini :entity="entityName" class="msg-avatar" />
    </div>
    <div v-if="live" class="msg-foot msg-foot--live" data-who="agent">
      <span class="msg-replied">{{ liveStatus }}</span>
    </div>

    <section v-if="showFollowups" class="quick-actions" aria-label="Suggested follow-ups">
      <header>
        <span>Follow-ups</span>
        <button
          v-if="followups.length"
          class="qa-refresh"
          type="button"
          :disabled="followupsBusy"
          title="Regenerate suggestions"
          aria-label="Regenerate suggestions"
          @click="emit('suggest', true)"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <path d="M13.2 7A5.2 5.2 0 1 0 12 11" />
            <path d="M13.4 3.2v4h-4" />
          </svg>
        </button>
      </header>
      <div v-if="followups.length" class="qa-row">
        <button
          v-for="action in followups"
          :key="action.label"
          class="qa-btn"
          type="button"
          :data-primary="action.primary ? '1' : '0'"
          :title="action.prompt"
          @click="emit('followup', action)"
        >
          {{ action.label }}
          <svg v-if="action.primary" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <path d="M4.4 11.6L11.6 4.4M6 4.4h5.6V10" />
          </svg>
        </button>
      </div>
      <div v-else-if="followupsBusy" class="qa-note">
        <span class="qa-dot" aria-hidden="true"></span>
        Reading the conversation for a next step…
      </div>
      <button v-else class="qa-btn qa-btn--ghost" type="button" @click="emit('suggest', false)">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <path d="M8 1.8l1.5 3.9 3.9 1.5-3.9 1.5L8 12.6 6.5 8.7 2.6 7.2l3.9-1.5z" />
        </svg>
        Suggest follow-ups
      </button>
    </section>

    <details v-if="hasTrace(live)" class="msg-trace msg-trace--live" open>
      <summary class="msg-trace-head">
        <svg class="trace-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <path d="M6 3.5L10.5 8 6 12.5" />
        </svg>
        <span class="tr-live">Working…</span>
        <span>{{ live.steps.filter((step) => step.type === 'tool_use').length }} tool calls</span>
      </summary>
      <div class="msg-trace-body">
        <TraceDigest :steps="live.steps" :execution="live.execution" />
      </div>
    </details>

      <div v-if="chips.length && !messages.some((m) => m.who === 'me')" class="chips">
        <button v-for="q in chips" :key="q" class="pick" type="button" @click="emit('chip', q)">
          {{ q }}
        </button>
      </div>
    </div>

    <Transition name="jump-live">
      <button
        v-if="!following && messages.length"
        class="jump-live"
        type="button"
        title="Jump to the newest message"
        @click="toNewest"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <path d="M8 2.6v10.8" />
          <path d="M3.6 9.2L8 13.6l4.4-4.4" />
        </svg>
        <span>{{ live ? 'Newest activity' : 'Newest message' }}</span>
      </button>
    </Transition>

    <ThreadMinimap
      :messages="messages"
      :scroll-el="box"
      :entity-name="entityName"
      :reveal="revealThrough"
      :rendered="messages.length - firstShown"
    />
  </div>
</template>
