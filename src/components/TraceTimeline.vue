<script setup>
import { computed } from 'vue'

/**
 * One run's steps, in the order the harness emitted them. The same component
 * serves the inline disclosure under a chat message and the full dialog; the
 * compact form simply leaves out the answer text (the bubble already has it).
 */
const props = defineProps({
  steps: { type: Array, default: () => [] },
  execution: { type: Object, default: () => null },
  compact: { type: Boolean, default: false },
})

const ordered = computed(() => [...(props.steps || [])].sort((a, b) => a.seq - b.seq))
const visible = computed(() =>
  props.compact ? ordered.value.filter((step) => step.type !== 'text') : ordered.value,
)
const startedAt = computed(() => {
  const stamp = props.execution?.startedAt || ordered.value[0]?.at
  const ms = Date.parse(stamp || '')
  return Number.isFinite(ms) ? ms : null
})

function offset(at) {
  if (startedAt.value === null) return ''
  const ms = Date.parse(at || '')
  if (!Number.isFinite(ms)) return ''
  const total = Math.max(0, Math.floor((ms - startedAt.value) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `+${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function duration(step) {
  let ms = step.durationMs
  if (!Number.isFinite(ms) && step.at && step.endedAt) {
    const start = Date.parse(step.at)
    const end = Date.parse(step.endedAt)
    if (Number.isFinite(start) && Number.isFinite(end)) ms = end - start
  }
  return formatMs(ms)
}

function formatMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 100) return '<0.1s'
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
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

function outputSize(text) {
  const chars = String(text || '').length
  if (chars < 1000) return `${chars} chars`
  return `${(chars / 1000).toFixed(1)}k chars`
}
</script>

<template>
  <div class="tr-log">
    <div
      v-for="step in visible"
      :key="step.seq"
      class="tr-step"
      :data-kind="step.type"
      :data-error="step.isError ? '1' : '0'"
    >
      <span class="tr-dot" aria-hidden="true"></span>
      <div class="tr-main">
        <div class="tr-head">
          <span class="tr-kind">{{ kindLabel(step) }}</span>
          <span v-if="offset(step.at)" class="tr-off">{{ offset(step.at) }}</span>
          <span v-if="duration(step)" class="tr-dur">{{ duration(step) }}</span>
          <span v-if="step.isError" class="tr-fail">failed</span>
        </div>

        <template v-if="step.type === 'thinking'">
          <details class="tr-think" :open="!compact">
            <summary>Reasoning · {{ outputSize(step.content) }}</summary>
            <div class="tr-thinking">{{ step.content }}</div>
          </details>
        </template>

        <template v-else-if="step.type === 'text'">
          <p class="tr-text">{{ step.content }}</p>
        </template>

        <template v-else-if="step.type === 'tool_use' || step.type === 'tool_result'">
          <div class="tr-tool">
            <code v-if="toolSummary(step)" class="tr-args">{{ toolSummary(step) }}</code>
            <details v-if="step.output" class="tr-out">
              <summary>{{ step.isError ? 'Error output' : 'Output' }} · {{ outputSize(step.output) }}</summary>
              <pre>{{ step.output }}</pre>
            </details>
            <span v-else class="tr-muted">No output recorded.</span>
          </div>
        </template>

        <template v-else>
          <p class="tr-error">{{ step.content || step.output || 'The harness reported an error.' }}</p>
        </template>
      </div>
    </div>

    <p v-if="!visible.length" class="tr-muted tr-empty">
      {{ compact ? 'No tool calls or thinking in this run.' : 'No timeline steps were recorded.' }}
    </p>
  </div>
</template>
