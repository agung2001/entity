<script setup>
import { computed } from 'vue'

/**
 * The inline trace under a chat reply. It is a digest, not a transcript:
 * reasoning is one fold, each tool call is one row with its output behind a
 * second fold, and the summary says where the time went.
 */
const props = defineProps({
  steps: { type: Array, default: () => [] },
  execution: { type: Object, default: () => null },
})

const ordered = computed(() => [...(props.steps || [])].sort((a, b) => a.seq - b.seq))
const thoughts = computed(() => ordered.value.filter((step) => step.type === 'thinking'))
const errors = computed(() => ordered.value.filter((step) => step.type === 'error' || step.isError))
const totalMs = computed(() => {
  if (Number.isFinite(props.execution?.ms)) return props.execution.ms
  const steps = ordered.value
  const first = Date.parse(steps[0]?.at || '')
  const last = Date.parse(steps.at(-1)?.endedAt || steps.at(-1)?.at || '')
  return Number.isFinite(first) && Number.isFinite(last) ? Math.max(0, last - first) : 0
})
const firstStepMs = computed(() =>
  Number.isFinite(props.execution?.ttfbMs) ? props.execution.ttfbMs : null,
)
const thoughtChars = computed(() =>
  thoughts.value.reduce((total, step) => total + String(step.content || '').length, 0),
)
/* the workspace MCP servers this turn actually ran with */
const mcpServers = computed(() =>
  Array.isArray(props.execution?.mcp) ? props.execution.mcp : [],
)
/* what the @mentions in the question resolved to, before the harness ran */
const mentions = computed(() =>
  Array.isArray(props.execution?.mentions) ? props.execution.mentions : [],
)

function mentionSummary(mention) {
  if (mention.kind === 'entity') {
    const answer = String(mention.answer || '').replace(/\s+/g, ' ').trim()
    return answer ? `answer: ${answer.slice(0, 180)}` : mention.note || 'no answer'
  }
  if (!mention.items?.length) return mention.note || 'nothing found'
  return mention.items.map((item) => item.label).join(' · ')
}

const tools = computed(() => {
  const rows = []
  const byCall = new Map()
  for (const step of ordered.value) {
    if (step.type === 'tool_use') {
      const row = {
        key: step.callId || `seq-${step.seq}`,
        name: step.tool || 'tool',
        input: step.input || null,
        output: '',
        isError: false,
        at: step.at,
        durationMs: Number.isFinite(step.durationMs) ? step.durationMs : null,
        endedAt: step.endedAt || '',
      }
      rows.push(row)
      if (step.callId) byCall.set(step.callId, row)
    } else if (step.type === 'tool_result') {
      let row = step.callId ? byCall.get(step.callId) : null
      if (!row) {
        row = [...rows]
          .reverse()
          .find((entry) => entry.name === (step.tool || 'tool') && !entry.output)
      }
      if (row) {
        row.output = String(step.output || step.content || '')
        row.isError = Boolean(step.isError)
        if (Number.isFinite(step.durationMs) && !row.durationMs) row.durationMs = step.durationMs
        if (step.endedAt) row.endedAt = step.endedAt
      } else {
        const fallback = {
          key: step.callId || `result-${step.seq}`,
          name: step.tool || 'tool',
          input: null,
          output: String(step.output || step.content || ''),
          isError: Boolean(step.isError),
          at: step.at,
          durationMs: Number.isFinite(step.durationMs) ? step.durationMs : null,
          endedAt: step.endedAt || '',
        }
        rows.push(fallback)
      }
    }
  }
  return rows
})

function formatMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  if (ms < 100) return '<0.1s'
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  return `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`
}

function offset(at) {
  const start = Date.parse(props.execution?.startedAt || ordered.value[0]?.at || '')
  const ms = Date.parse(at || '')
  if (!Number.isFinite(start) || !Number.isFinite(ms)) return ''
  const total = Math.max(0, Math.floor((ms - start) / 1000))
  return `+${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function duration(row) {
  let ms = row.durationMs
  if (!Number.isFinite(ms) && row.at && row.endedAt) {
    const start = Date.parse(row.at)
    const end = Date.parse(row.endedAt)
    if (Number.isFinite(start) && Number.isFinite(end)) ms = end - start
  }
  return formatMs(ms)
}

function chars(value) {
  const length = typeof value === 'number' ? value : String(value || '').length
  return length < 1000 ? `${length} chars` : `${(length / 1000).toFixed(1)}k chars`
}

function toolSummary(row) {
  const input = row.input
  if (!input || typeof input !== 'object') return ''
  if (typeof input.command === 'string') return input.command
  if (typeof input.cmd === 'string') return input.cmd
  if (Array.isArray(input.changes)) return `${input.changes.length} files changed`
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.path === 'string') return input.path
  if (typeof input.query === 'string') return input.query
  try {
    const text = JSON.stringify(input)
    return text.length > 220 ? `${text.slice(0, 217)}…` : text
  } catch {
    return ''
  }
}

function errorText(step) {
  return String(step.content || step.output || 'The harness reported an error.')
}
</script>

<template>
  <div class="trace-digest">
    <div class="trace-digest-stats">
      <span v-if="totalMs" class="trace-stat">
        <b>{{ formatMs(totalMs) }}</b>
      </span>
      <span v-if="firstStepMs !== null" class="trace-stat" title="Time from spawn to the first streamed event">
        first step {{ formatMs(firstStepMs) }}
      </span>
      <span v-if="thoughts.length" class="trace-stat">
        <i class="trace-stat-dot" data-kind="thinking"></i>
        {{ thoughts.length }} reasoning
      </span>
      <span v-if="tools.length" class="trace-stat">
        <i class="trace-stat-dot" data-kind="tool"></i>
        {{ tools.length }} tool{{ tools.length === 1 ? '' : 's' }}
      </span>
      <span v-if="errors.length" class="trace-stat trace-stat--bad">
        {{ errors.length }} error{{ errors.length === 1 ? '' : 's' }}
      </span>
      <span v-if="mentions.length" class="trace-stat">
        <i class="trace-stat-dot" data-kind="mention"></i>
        {{ mentions.length }} mention{{ mentions.length === 1 ? '' : 's' }}
      </span>
      <span v-if="mcpServers.length" class="trace-stat" :title="`MCP: ${mcpServers.join(', ')}`">
        <i class="trace-stat-dot" data-kind="mcp"></i>
        {{ mcpServers.join(', ') }}
      </span>
    </div>

    <p v-if="execution?.mcpNote" class="trace-digest-note">{{ execution.mcpNote }}</p>

    <details v-if="mentions.length" class="trace-thoughts trace-mentions">
      <summary>
        <span class="trace-thought-title">Mentions</span>
        <span class="trace-thought-meta">{{ mentions.length }} resolved</span>
        <svg class="trace-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <path d="M6 3.5L10.5 8 6 12.5" />
        </svg>
      </summary>
      <div class="trace-thought-list">
        <div v-for="mention in mentions" :key="mention.token || mention.raw" class="trace-thought">
          <span class="trace-off">{{ mention.kind }}</span>
          <p>
            <code class="trace-mention-raw">{{ mention.token || mention.raw }}</code>
            <span class="trace-mention-what">{{ mentionSummary(mention) }}</span>
          </p>
        </div>
      </div>
    </details>

    <details v-if="thoughts.length" class="trace-thoughts">
      <summary>
        <span class="trace-thought-title">Reasoning</span>
        <span class="trace-thought-meta">{{ thoughts.length }} block{{ thoughts.length === 1 ? '' : 's' }} · {{ chars(thoughtChars) }}</span>
        <svg class="trace-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <path d="M6 3.5L10.5 8 6 12.5" />
        </svg>
      </summary>
      <div class="trace-thought-list">
        <div v-for="step in thoughts" :key="step.seq" class="trace-thought">
          <span class="trace-off">{{ offset(step.at) }}</span>
          <p>{{ step.content || 'No reasoning text was recorded.' }}</p>
        </div>
      </div>
    </details>

    <ol v-if="tools.length" class="trace-tools">
      <li v-for="row in tools" :key="row.key" class="trace-tool" :data-error="row.isError ? '1' : '0'">
        <div class="trace-tool-head">
          <span class="trace-tool-name">{{ row.name }}</span>
          <span class="trace-off">{{ offset(row.at) }}</span>
          <span v-if="duration(row)" class="trace-tool-dur">{{ duration(row) }}</span>
        </div>
        <code v-if="toolSummary(row)" class="trace-tool-cmd">{{ toolSummary(row) }}</code>
        <details v-if="row.output" class="trace-tool-output">
          <summary>{{ row.isError ? 'Error output' : 'Output' }} · {{ chars(row.output) }}</summary>
          <pre>{{ row.output }}</pre>
        </details>
      </li>
    </ol>

    <div v-if="errors.length" class="trace-errors">
      <div v-for="step in errors" :key="step.seq" class="trace-error">
        <span class="trace-off">{{ offset(step.at) }}</span>
        <p>{{ errorText(step) }}</p>
      </div>
    </div>

    <p v-if="!thoughts.length && !tools.length && !errors.length" class="trace-digest-empty">
      No tool calls or reasoning in this run.
    </p>
  </div>
</template>
