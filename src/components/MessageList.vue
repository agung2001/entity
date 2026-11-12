<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import EntityMark from '@/components/EntityMark.vue'
import ThreadMinimap from '@/components/ThreadMinimap.vue'
import MessageBody from '@/components/MessageBody.vue'
import ChatArtifacts from '@/components/ChatArtifacts.vue'
import TraceTimeline from '@/components/TraceTimeline.vue'
import { saveTextArtifact } from '@/stores/artifacts'
import { credentials, hub, toast } from '@/stores/hub'
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

/* The bubble belongs to the signed-in account; the entity owns the reply. */
const accountEmail = computed(() => hub.session?.email || credentials().email || '')
const userAvatar = computed(() => gravatarUrl(accountEmail.value, 96))

function toBottom() {
  nextTick(() => {
    if (box.value) box.value.scrollTop = box.value.scrollHeight
  })
}

watch(() => props.messages.length, toBottom, { immediate: true })
watch(() => props.live?.steps?.length || 0, toBottom)

async function scrollToFocus() {
  if (props.focusIndex < 0) return false
  await nextTick()
  const boxEl = box.value
  if (!boxEl) return false
  const target = boxEl.querySelector(`[data-thread-anchor="${props.focusIndex}"]`)
  if (!target) return false
  const top =
    target.getBoundingClientRect().top - boxEl.getBoundingClientRect().top + boxEl.scrollTop - 16
  boxEl.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
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

function elapsed(message) {
  const ms = message.execution?.ms
  if (!Number.isFinite(ms)) return ''
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
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
  const ms = message.execution?.ms
  const duration = Number.isFinite(ms)
    ? ms < 1000
      ? `${Math.max(1, Math.round(ms))}ms`
      : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
    : ''
  return [duration, `${thoughts} thinking`, `${tools} tool${tools === 1 ? '' : 's'}`]
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
      <div
        v-if="m.who === 'sys'"
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
          :disabled="hub.chat.sending"
          @click="emit('retry', m)"
        >
          {{ hub.chat.sending ? 'Retrying…' : 'Retry' }}
        </button>
      </div>
      <div
        v-else
        :id="`chat-msg-${i}`"
        class="msg"
        :data-who="m.who"
        :data-thread-anchor="i"
        :data-avatar="m.who === 'me' && userAvatar ? '1' : '0'"
        :style="m.who === 'me' && userAvatar ? { '--msg-avatar': 'url(' + userAvatar + ')' } : null"
      >
        <MessageBody :text="m.text" />
        <ChatArtifacts v-if="m.artifacts?.length" :items="m.artifacts" />
        <EntityMark v-if="m.who === 'agent'" mini :entity="entityName" class="msg-avatar" />
      </div>
      <details v-if="hasTrace(m)" class="msg-trace" :data-who="m.who">
        <summary class="msg-trace-head">
          <svg class="trace-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <path d="M6 3.5L10.5 8 6 12.5" />
          </svg>
          <span>{{ traceSummary(m) }}</span>
        </summary>
        <div class="msg-trace-body">
          <TraceTimeline :steps="m.steps" :execution="m.execution" compact />
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

    <details v-if="hasTrace(live)" class="msg-trace msg-trace--live" open>
      <summary class="msg-trace-head">
        <svg class="trace-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <path d="M6 3.5L10.5 8 6 12.5" />
        </svg>
        <span class="tr-live">Working…</span>
        <span>{{ live.steps.filter((step) => step.type === 'tool_use').length }} tool calls</span>
      </summary>
      <div class="msg-trace-body">
        <TraceTimeline :steps="live.steps" :execution="live.execution" compact />
      </div>
    </details>

      <div v-if="chips.length && !messages.some((m) => m.who === 'me')" class="chips">
        <button v-for="q in chips" :key="q" class="pick" type="button" @click="emit('chip', q)">
          {{ q }}
        </button>
      </div>
    </div>

    <ThreadMinimap :messages="messages" :scroll-el="box" :entity-name="entityName" />
  </div>
</template>
