<script setup>
import { nextTick, ref, watch } from 'vue'
import MessageBody from '@/components/MessageBody.vue'
import TraceTimeline from '@/components/TraceTimeline.vue'
import { saveTextArtifact } from '@/stores/artifacts'
import { toast } from '@/stores/hub'

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
})
const emit = defineEmits(['chip'])

const box = ref(null)
const saving = ref('')

function toBottom() {
  nextTick(() => {
    if (box.value) box.value.scrollTop = box.value.scrollHeight
  })
}

watch(() => props.messages.length, toBottom, { immediate: true })
watch(() => props.live?.steps?.length || 0, toBottom)

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
  toast(copied ? 'Response copied' : 'The response could not be copied.')
}

async function shareMessage(message) {
  if (navigator.share) {
    try {
      await navigator.share({ title: `Chat with ${props.entityName}`, text: message.text })
      return
    } catch (error) {
      if (error?.name === 'AbortError') return
    }
  }
  const copied = await copyText(message.text)
  toast(copied ? 'Response copied for sharing' : 'The response could not be shared.')
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
  <div
    ref="box"
    :class="listClass"
    role="log"
    aria-live="polite"
    aria-label="Conversation with entity"
  >
    <template v-for="(m, i) in messages" :key="m.id || i">
      <div v-if="m.who === 'sys'" class="ask-sys">{{ m.text }}</div>
      <div v-else class="msg" :data-who="m.who">
        <MessageBody :text="m.text" />
      </div>
      <div v-if="hasTrace(m)" class="msg-trace" :data-who="m.who">
        <div class="msg-trace-head">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
            <path d="M2.5 3.5h11M2.5 8h7M2.5 12.5h9" />
          </svg>
          <span>{{ traceSummary(m) }}</span>
        </div>
        <TraceTimeline :steps="m.steps" :execution="m.execution" compact />
      </div>
      <div v-if="m.who === 'agent'" class="msg-foot" :data-who="m.who">
        <span v-if="elapsed(m)" class="msg-replied">Replied in {{ elapsed(m) }}</span>
        <button class="msg-act" type="button" title="Copy response" aria-label="Copy response" @click="copyMessage(m)">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
            <rect x="5.2" y="5.2" width="8" height="8" rx="1.5" />
            <path d="M10.8 5.2V3.8a1.5 1.5 0 00-1.5-1.5H3.8a1.5 1.5 0 00-1.5 1.5v5.5a1.5 1.5 0 001.5 1.5h1.4" />
          </svg>
        </button>
        <button class="msg-act" type="button" title="Share response" aria-label="Share response" @click="shareMessage(m)">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
            <circle cx="12" cy="3.4" r="1.8" />
            <circle cx="4" cy="8" r="1.8" />
            <circle cx="12" cy="12.6" r="1.8" />
            <path d="M5.6 7.1l4.8-2.8M5.6 8.9l4.8 2.8" />
          </svg>
        </button>
        <button
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

    <div v-if="hasTrace(live)" class="msg-trace msg-trace--live">
      <div class="msg-trace-head">
        <span class="tr-live">Working…</span>
        <span>{{ live.steps.filter((step) => step.type === 'tool_use').length }} tool calls</span>
      </div>
      <TraceTimeline :steps="live.steps" :execution="live.execution" compact />
    </div>

    <div v-if="chips.length && !messages.some((m) => m.who === 'me')" class="chips">
      <button v-for="q in chips" :key="q" class="pick" type="button" @click="emit('chip', q)">
        {{ q }}
      </button>
    </div>
  </div>
</template>
