<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import EntityMark from '@/components/EntityMark.vue'
import ExecutionTimeline from '@/components/ExecutionTimeline.vue'
import { toast } from '@/stores/hub'

/**
 * The full execution record for one chat turn. The header carries the turns
 * and the wall clock; the body is an outline plus one expanded step, so a long
 * run stays browsable instead of becoming a single wall of text.
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  thread: { type: Object, default: null },
  live: { type: Object, default: null },
})
const emit = defineEmits(['close'])

const selectedKey = ref('')
const selectedSeq = ref(-1)

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

const steps = computed(() => {
  if (!selected.value) return []
  const base = selected.value.steps?.length
    ? selected.value.steps
    : selected.value.message?.text
      ? [
          {
            seq: 0,
            type: selected.value.message.who === 'sys' ? 'error' : 'text',
            content: selected.value.message.text,
            at: selected.value.execution.startedAt,
          },
        ]
      : []
  return [...base].sort((a, b) => a.seq - b.seq)
})

const selectedIndex = computed(() => steps.value.findIndex((step) => step.seq === selectedSeq.value))
const selectedStep = computed(() => steps.value[selectedIndex.value] || null)

const status = computed(() => {
  if (!selected.value) return ''
  if (selected.value.live) return 'running'
  return selected.value.execution.status || 'done'
})

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

function offset(at) {
  const start = Date.parse(selected.value?.execution?.startedAt || '')
  const ms = Date.parse(at || '')
  if (!Number.isFinite(start) || !Number.isFinite(ms)) return ''
  const total = Math.max(0, Math.floor((ms - start) / 1000))
  return `+${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function duration(step) {
  let ms = step.durationMs
  if (!Number.isFinite(ms) && step.at && step.endedAt) {
    const start = Date.parse(step.at)
    const end = Date.parse(step.endedAt)
    if (Number.isFinite(start) && Number.isFinite(end)) ms = end - start
  }
  return Number.isFinite(ms) ? formatMs(ms) : ''
}

function kindLabel(step) {
  if (step.type === 'thinking') return 'Thinking'
  if (step.type === 'text') return 'Response'
  if (step.type === 'tool_use') return step.tool || 'Tool'
  if (step.type === 'tool_result') return step.tool || 'Tool result'
  return 'Error'
}

function toolSummary(step) {
  const input = step.input
  if (!input || typeof input !== 'object') return ''
  if (typeof input.command === 'string') return input.command
  if (typeof input.cmd === 'string') return input.cmd
  if (Array.isArray(input.changes)) return `${input.changes.length} file${input.changes.length === 1 ? '' : 's'} changed`
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.path === 'string') return input.path
  if (typeof input.query === 'string') return input.query
  try {
    const text = JSON.stringify(input)
    return text.length > 180 ? `${text.slice(0, 177)}…` : text
  } catch {
    return ''
  }
}

function stepSummary(step) {
  if (step.type === 'thinking') return String(step.content || '').replace(/\s+/g, ' ').slice(0, 120)
  if (step.type === 'text') return String(step.content || '').replace(/\s+/g, ' ').slice(0, 120)
  if (step.type === 'tool_use' || step.type === 'tool_result') {
    return toolSummary(step) || step.output?.replace(/\s+/g, ' ').slice(0, 120) || 'tool call'
  }
  return String(step.content || step.output || 'error').replace(/\s+/g, ' ').slice(0, 120)
}

function prettyInput(step) {
  if (!step.input) return ''
  try {
    return JSON.stringify(step.input, null, 2)
  } catch {
    return String(step.input)
  }
}

function selectStep(seq) {
  selectedSeq.value = seq
}

function stepBy(delta) {
  if (!steps.value.length) return
  const next = Math.min(Math.max(0, (selectedIndex.value < 0 ? 0 : selectedIndex.value) + delta), steps.value.length - 1)
  selectedSeq.value = steps.value[next].seq
}

function firstSeq(entry) {
  const list = entry?.steps?.length
    ? [...entry.steps].sort((a, b) => a.seq - b.seq)
    : entry?.message?.text
      ? [{ seq: 0 }]
      : []
  return list[0]?.seq ?? -1
}

function onKey(event) {
  if (!props.open) return
  if (event.key === 'Escape') {
    emit('close')
    return
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    stepBy(1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    stepBy(-1)
  }
}

async function copyTimeline() {
  if (!selected.value) return
  const entry = selected.value
  const lines = [
    `Execution timeline · ${props.thread?.entity || 'workspace'}`,
    `Query: ${entry.query || '—'}`,
    `Status: ${entry.live ? 'running' : entry.execution.status || 'done'}`,
    `When: ${when(entry) || '—'}`,
    `Duration: ${elapsed(entry)}`,
    `Model: ${entry.execution.model || 'harness default'}`,
    `Harness: ${entry.execution.harness || '—'}`,
    '',
    ...steps.value.map((step) => {
      const head = `[${offset(step.at) || '+00:00'}] ${kindLabel(step)}${duration(step) ? ` (${duration(step)})` : ''}`
      const body =
        step.type === 'tool_use' || step.type === 'tool_result'
          ? [toolSummary(step), prettyInput(step), step.output].filter(Boolean).join('\n')
          : step.content || step.output || ''
      return `${head}\n${body}`.trim()
    }),
  ]
  try {
    await navigator.clipboard.writeText(lines.join('\n\n'))
    toast('Timeline copied')
  } catch {
    toast('The timeline could not be copied.')
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    selectedKey.value = props.live ? 'live' : entries.value.at(-1)?.key || ''
    selectedSeq.value = firstSeq(entries.value.find((entry) => entry.key === selectedKey.value))
  },
  { immediate: true },
)

watch(entries, (list) => {
  if (!props.open) return
  if (!list.some((entry) => entry.key === selectedKey.value)) {
    selectedKey.value = props.live ? 'live' : list.at(-1)?.key || ''
  }
})

watch(selectedKey, () => {
  selectedSeq.value = firstSeq(selected.value)
})

watch(steps, (list) => {
  if (!list.some((step) => step.seq === selectedSeq.value)) selectedSeq.value = list[0]?.seq ?? -1
})

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="scrim" :data-open="open ? '1' : '0'" @click="emit('close')"></div>
  <div
    class="modal modal-timeline td"
    :data-open="open ? '1' : '0'"
    role="dialog"
    aria-modal="true"
    aria-label="Execution timeline"
  >
    <header class="td-head">
      <div class="td-top">
        <EntityMark :entity="thread?.entity || ''" />
        <div class="td-id">
          <h2>
            Execution timeline
            <span class="td-sub">{{ thread?.entity || 'workspace' }} · {{ entries.length }} turns</span>
          </h2>
        </div>
        <span class="td-hint"><kbd>↑</kbd><kbd>↓</kbd> steps <span aria-hidden="true">·</span> <kbd>esc</kbd> close</span>
        <button class="x mo-x" aria-label="Close timeline" @click="emit('close')">
          <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5">
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>

      <div v-if="entries.length" class="td-trails" role="tablist" aria-label="Turns">
        <button
          v-for="(entry, index) in entries"
          :key="entry.key"
          class="td-trail"
          type="button"
          role="tab"
          :aria-selected="selectedKey === entry.key ? 'true' : 'false'"
          @click="selectedKey = entry.key"
        >
          <span>Turn {{ index + 1 }}</span>
          <span class="n">{{ elapsed(entry) }}</span>
          <span v-if="entry.live" class="td-live-dot" aria-label="running"></span>
          <span v-else-if="entry.execution.status === 'error'" class="td-err-dot" aria-label="failed"></span>
        </button>
      </div>
    </header>

    <template v-if="selected">
      <section class="td-sum">
        <div class="td-q">
          <p>{{ selected.query || 'No question recorded.' }}</p>
          <dl>
            <div><dt>Status</dt><dd><span class="state" :data-s="status === 'error' || status === 'canceled' ? 'fail' : 'live'"><i></i>{{ status }}</span></dd></div>
            <div><dt>When</dt><dd>{{ when(selected) || '—' }}</dd></div>
            <div><dt>Tokens</dt><dd>{{ usageText || '—' }}</dd></div>
            <div><dt>Model</dt><dd class="mono">{{ selected.execution.model || 'harness default' }}</dd></div>
            <div><dt>Exit</dt><dd class="mono">{{ Number.isFinite(selected.execution.exitCode) ? selected.execution.exitCode : '—' }}</dd></div>
          </dl>
          <div v-if="selected.execution.command" class="td-runmeta">
            <span>Command</span>
            <code>{{ selected.execution.command }}</code>
          </div>
          <div v-if="selected.execution.cwd" class="td-runmeta">
            <span>Directory</span>
            <code>{{ selected.execution.cwd }}</code>
          </div>
        </div>
        <ExecutionTimeline
          :steps="steps"
          :execution="selected.execution"
          :selected-seq="selectedSeq"
          @select="selectStep"
        />
      </section>

      <div class="td-body">
        <nav class="td-outline" aria-label="Steps">
          <div class="td-grp">Steps <span>{{ steps.length }}</span></div>
          <button
            v-for="(step, index) in steps"
            :key="step.seq"
            class="td-orow"
            type="button"
            :aria-current="selectedSeq === step.seq ? 'true' : 'false'"
            :data-error="step.isError || step.type === 'error' ? '1' : '0'"
            @click="selectedSeq = step.seq"
          >
            <span class="td-off">{{ offset(step.at) }}</span>
            <span class="td-ot">
              <span class="td-kind">{{ kindLabel(step) }}</span>
              <span class="td-osm">{{ stepSummary(step) }}</span>
            </span>
            <span class="td-od">{{ duration(step) }}</span>
          </button>
          <p v-if="!steps.length" class="td-empty-note">No steps were recorded for this turn.</p>
        </nav>

        <div class="td-pane">
          <template v-if="selectedStep">
            <div class="td-phead">
              <span class="td-kind">{{ kindLabel(selectedStep) }}</span>
              <span class="td-off">{{ offset(selectedStep.at) }}</span>
              <span v-if="duration(selectedStep)" class="td-od">{{ duration(selectedStep) }}</span>
              <span class="td-pos">{{ selectedIndex + 1 }} / {{ steps.length }}</span>
            </div>
            <div class="td-pbody">
              <template v-if="selectedStep.type === 'thinking' || selectedStep.type === 'text'">
                <pre class="td-text" :data-kind="selectedStep.type">{{ selectedStep.content }}</pre>
              </template>
              <template v-else-if="selectedStep.type === 'tool_use' || selectedStep.type === 'tool_result'">
                <div v-if="toolSummary(selectedStep)" class="td-command">
                  <span>Command / arguments</span>
                  <code>{{ toolSummary(selectedStep) }}</code>
                </div>
                <details v-if="selectedStep.input" class="td-detail" open>
                  <summary>Input</summary>
                  <pre>{{ prettyInput(selectedStep) }}</pre>
                </details>
                <details v-if="selectedStep.output" class="td-detail" open>
                  <summary>{{ selectedStep.isError ? 'Error output' : 'Output' }}</summary>
                  <pre>{{ selectedStep.output }}</pre>
                </details>
                <p v-if="!selectedStep.input && !selectedStep.output" class="td-empty-note">
                  No input or output was recorded for this tool call.
                </p>
              </template>
              <pre v-else class="td-error">{{ selectedStep.content || selectedStep.output || 'The harness reported an error.' }}</pre>
            </div>
            <div class="td-nav">
              <button type="button" :disabled="selectedIndex <= 0" @click="stepBy(-1)">← Previous step</button>
              <button type="button" :disabled="selectedIndex >= steps.length - 1" @click="stepBy(1)">Next step →</button>
              <span class="td-posn">{{ selectedIndex + 1 }} / {{ steps.length }}</span>
            </div>
          </template>
          <div v-else class="empty-note">
            <b>No steps were recorded for this turn.</b>
            <span>The answer is shown in the chat; the harness did not emit a stream.</span>
          </div>
        </div>
      </div>

      <footer class="td-foot">
        <p>{{ thread?.entity || 'workspace' }} · {{ entries.length }} {{ entries.length === 1 ? 'turn' : 'turns' }} · {{ selected.execution.harness || 'harness' }}</p>
        <div class="td-foot-actions">
          <button type="button" @click="copyTimeline">Copy timeline</button>
          <button class="td-done" type="button" @click="emit('close')">Done</button>
        </div>
      </footer>
    </template>

    <div v-else class="td-empty">
      <div class="empty-note">
        <b>No execution recorded yet.</b>
        <span>Send a message; the next turn's timeline appears here.</span>
      </div>
    </div>
  </div>
</template>
