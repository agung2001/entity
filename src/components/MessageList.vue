<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import EntityMark from '@/components/EntityMark.vue'
import ThreadMinimap from '@/components/ThreadMinimap.vue'
import MessageBody from '@/components/MessageBody.vue'
import ChatArtifacts from '@/components/ChatArtifacts.vue'
import TraceDigest from '@/components/TraceDigest.vue'
import { saveTextArtifact } from '@/stores/artifacts'
import { credentials, hub, isSending, toast } from '@/stores/hub'
import { gravatarUrl } from '@/lib/gravatar'

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
})
const emit = defineEmits(['chip', 'retry'])

const box = ref(null)
const saving = ref('')
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

const liveStatus = computed(() =>
  [liveAction.value, liveElapsed.value].filter(Boolean).join(' · '),
)

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

function releasePin() {
  pin = false
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
  pin = !focused
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
  if (gap > 400) pin = false
  else if (gap < 8) pin = true
  if (firstShown.value <= 0 || el.scrollTop >= 800) return
  /* Reading backwards means the newest message no longer owns the viewport. */
  pin = false
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

let pinned = false

function toBottom() {
  /* Three watchers can fire in the same tick; one scroll is enough, and each
     one forces a layout of the whole transcript. */
  if (pinned) return
  pinned = true
  nextTick(() => {
    pinned = false
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
  const boxEl = box.value
  if (!boxEl) return false
  const target = boxEl.querySelector(`[data-thread-anchor="${props.focusIndex}"]`)
  if (!target) return false
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

watch(
  () => [props.messages.length, props.focusIndex, props.threadId],
  async () => {
    const key = `${props.threadId}:${props.focusIndex}`
    if (props.focusIndex < 0 || appliedFocus.value === key) return
    if (await scrollToFocus()) appliedFocus.value = key
  },
  { immediate: true },
)

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through */
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    return copied
  } catch {
    return false
  }
}

async function copyMessage(message) {
  const copied = await copyText(message.text)
  const noun = message.who === 'me' ? 'Message' : 'Response'
  toast(copied ? `${noun} copied` : `The ${noun.toLowerCase()} could not be copied.`)
}

async function shareMessage(message, index) {
  let url = ''
  if (props.shareUrl) {
    try {
      url = new URL(props.shareUrl(index), window.location.href).href
    } catch {
      url = ''
    }
  }
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
  /* A share without a link is only a copy. The deep link is the useful part:
     it opens this thread and scrolls to this exact message. */
  const copied = await copyText(url || message.text)
  toast(
    copied
      ? url
        ? 'Link to this message copied'
        : 'Response copied for sharing'
      : 'The response could not be shared.',
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

function mentionLabel(mention) {
  return mention.token || `@${mention.name || 'entity'}`
}

function mentionMeta(mention) {
  const execution = mention.execution || {}
  return [execution.harness, execution.model, formatDuration(mention.ms || execution.ms)]
    .filter(Boolean)
    .join(' · ')
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
        <div
          :id="`chat-msg-${i}`"
          class="ask-sys"
          :data-error="m.error ? '1' : '0'"
          :data-thread-anchor="i"
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
        :data-avatar="m.who === 'me' && userAvatar ? '1' : '0'"
        :style="m.who === 'me' && userAvatar ? { '--msg-avatar': 'url(' + userAvatar + ')' } : null"
      >
        <div
          v-if="m.who === 'agent' && delegations(m).length"
          class="msg-delegations"
          aria-label="Delegated work"
        >
          <div
            v-for="(mention, j) in delegations(m)"
            :key="mention.token || mention.name || j"
            class="msg-delegation"
            :data-error="mention.status === 'error' ? '1' : '0'"
            :title="mention.job || mention.raw || ''"
          >
            <EntityMark
              :entity="mention.name"
              animate
              class="msg-delegation-mark"
            />
            <div class="msg-delegation-body">
              <div class="msg-delegation-head">
                <span class="msg-delegation-kicker">Delegated to</span>
                <span class="msg-delegation-name">{{ mentionLabel(mention) }}</span>
                <span v-if="mentionMeta(mention)" class="msg-delegation-meta">{{ mentionMeta(mention) }}</span>
              </div>
              <p v-if="mention.job" class="msg-delegation-job">{{ mention.job }}</p>
              <p class="msg-delegation-answer">{{ mention.answer || mention.note || 'No answer recorded.' }}</p>
            </div>
          </div>
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
      </div>
      </template>
    </template>

    <div v-if="live" class="msg msg--live" data-who="agent">
      <div class="msg-body">
        <div v-if="liveText" class="msg-live-text">
          {{ liveText }}<span class="msg-live-caret" aria-hidden="true"></span>
        </div>
        <div v-else class="msg-live-status">
          <span class="msg-live-dot" aria-hidden="true"></span>{{ liveAction }}…
        </div>
      </div>
      <EntityMark mini :entity="entityName" class="msg-avatar" />
    </div>
    <div v-if="live" class="msg-foot msg-foot--live" data-who="agent">
      <span class="msg-replied">{{ liveStatus }}</span>
    </div>

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

    <ThreadMinimap
      :messages="messages"
      :scroll-el="box"
      :entity-name="entityName"
      :reveal="revealThrough"
      :rendered="messages.length - firstShown"
    />
  </div>
</template>
