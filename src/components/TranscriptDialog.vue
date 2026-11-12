<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import TraceTimeline from '@/components/TraceTimeline.vue'

/**
 * The full execution record for one chat turn. The header answers "what ran,
 * how long did it take, on which model"; the list below is the harness stream:
 * thinking, tool calls, their output, and the answer.
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  thread: { type: Object, default: null },
  live: { type: Object, default: null },
})
const emit = defineEmits(['close'])

const selectedKey = ref('')

const entries = computed(() => {
  const rows = []
  let query = ''
  for (const message of props.thread?.messages || []) {
    if (message.who === 'me') query = message.text
    if (!message.execution && !message.steps?.length) continue
    rows.push({
      key: message.id || `message-${rows.length}`,
      message,
      execution: message.execution || {},
      steps: message.steps || [],
      query,
      live: false,
    })
  }
  if (props.live) {
    rows.push({
      key: 'live',
      message: null,
      execution: props.live.execution || {},
      steps: props.live.steps || [],
      query,
      live: true,
    })
  }
  return rows
})

const selected = computed(
  () => entries.value.find((entry) => entry.key === selectedKey.value) || entries.value.at(-1) || null,
)

const status = computed(() => {
  if (!selected.value) return ''
  if (selected.value.live) return 'running'
  return selected.value.execution.status || 'done'
})

const hasText = computed(() => selected.value?.steps?.some((step) => step.type === 'text'))
const answerLabel = computed(() => (selected.value?.message?.who === 'sys' ? 'Error' : 'Answer'))

const usageText = computed(() => {
  const usage = selected.value?.execution?.usage
  if (!usage || typeof usage !== 'object') return ''
  const input = usage.input ?? usage.input_tokens ?? usage.prompt_tokens
  const output = usage.output ?? usage.output_tokens ?? usage.completion_tokens
  const total = usage.total ?? usage.total_tokens ?? usage.totalTokens
  const parts = []
  if (Number.isFinite(input)) parts.push(`${input} in`)
  if (Number.isFinite(output)) parts.push(`${output} out`)
  if (!parts.length && Number.isFinite(total)) parts.push(`${total} total`)
  return parts.join(' · ')
})

function formatMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

function elapsed(entry) {
  if (Number.isFinite(entry.execution.ms)) return formatMs(entry.execution.ms)
  const start = Date.parse(entry.execution.startedAt || '')
  const end = Date.parse(entry.execution.endedAt || '')
  if (Number.isFinite(start) && Number.isFinite(end)) return formatMs(end - start)
  return '—'
}

function when(entry) {
  const stamp = entry.execution.startedAt || entry.message?.at
  if (!stamp) return ''
  const date = new Date(stamp)
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : ''
}

function turnLabel(entry, index) {
  const whenText = when(entry)
  const query = String(entry.query || '').replace(/\s+/g, ' ').trim()
  const suffix = query ? ` · ${query.length > 42 ? `${query.slice(0, 41)}…` : query}` : ''
  return `${index + 1}. ${whenText || 'turn'}${suffix}`
}

function onKey(event) {
  if (!props.open) return
  if (event.key === 'Escape') emit('close')
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    selectedKey.value = props.live ? 'live' : entries.value.at(-1)?.key || ''
  },
  { immediate: true },
)

watch(entries, (list) => {
  if (!props.open) return
  if (!list.some((entry) => entry.key === selectedKey.value)) {
    selectedKey.value = props.live ? 'live' : list.at(-1)?.key || ''
  }
})

onMounted(() => document.addEventListener('keydown', onKey))
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="scrim" :data-open="open ? '1' : '0'" @click="emit('close')"></div>
  <div
    class="modal modal-transcript"
    :data-open="open ? '1' : '0'"
    role="dialog"
    aria-modal="true"
    aria-label="Execution transcript"
  >
    <div class="mo-head">
      <h2>Execution transcript</h2>
      <p>
        What the harness actually ran for this turn, with the model's reasoning and
        every tool call it made.
      </p>
      <button class="x mo-x" aria-label="Close transcript" @click="emit('close')">
        <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5">
          <path d="M2 2l8 8M10 2l-8 8" />
        </svg>
      </button>
    </div>

    <div v-if="entries.length > 1" class="tr-pick">
      <label class="lbl" for="tr-turn">Turn</label>
      <select id="tr-turn" v-model="selectedKey">
        <option v-for="(entry, index) in entries" :key="entry.key" :value="entry.key">
          {{ turnLabel(entry, index) }}
        </option>
      </select>
    </div>

    <div class="mo-body tr-body">
      <template v-if="selected">
        <section class="tr-meta">
          <div class="tr-meta-head">
            <span class="state" :data-s="status === 'error' || status === 'canceled' ? 'fail' : 'live'">
              <i></i>{{ status }}
            </span>
            <span v-if="selected.live" class="tr-live">streaming…</span>
            <span class="tr-when">{{ when(selected) }}</span>
          </div>
          <dl class="tr-grid">
            <div>
              <dt>Duration</dt>
              <dd>{{ elapsed(selected) }}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd class="mono">{{ selected.execution.model || 'harness default' }}</dd>
            </div>
            <div>
              <dt>Harness</dt>
              <dd>{{ selected.execution.harness || '—' }}</dd>
            </div>
            <div>
              <dt>Exit</dt>
              <dd class="mono">
                {{ Number.isFinite(selected.execution.exitCode) ? selected.execution.exitCode : '—' }}
              </dd>
            </div>
            <div v-if="usageText">
              <dt>Tokens</dt>
              <dd class="mono">{{ usageText }}</dd>
            </div>
          </dl>

          <p v-if="selected.query" class="tr-query">“{{ selected.query }}”</p>

          <div v-if="selected.execution.command" class="tr-line">
            <span>Command</span>
            <code>{{ selected.execution.command }}</code>
          </div>
          <div v-if="selected.execution.cwd" class="tr-line">
            <span>Directory</span>
            <code>{{ selected.execution.cwd }}</code>
          </div>
        </section>

        <TraceTimeline :steps="selected.steps" :execution="selected.execution" />

        <section
          v-if="selected.message?.text && (!hasText || selected.message.who === 'sys')"
          class="tr-answer"
        >
          <h3>{{ answerLabel }}</h3>
          <p>{{ selected.message.text }}</p>
        </section>
      </template>

      <div v-else class="empty-note">
        <b>No execution recorded yet.</b>
        <span>Send a message; the next turn's transcript appears here.</span>
      </div>
    </div>
  </div>
</template>
