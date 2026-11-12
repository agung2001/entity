<script setup>
import { computed } from 'vue'

/**
 * A two-lane wall-clock view of one run: model time and tool time. Model time
 * is the complement of tool intervals — that is the only honest span we have
 * from a stream that stamps arrivals, not token spans.
 */
const props = defineProps({
  steps: { type: Array, default: () => [] },
  execution: { type: Object, default: () => null },
  selectedSeq: { type: Number, default: -1 },
})
const emit = defineEmits(['select'])

const ordered = computed(() => [...(props.steps || [])].sort((a, b) => a.seq - b.seq))

function timeOf(value) {
  const ms = Date.parse(value || '')
  return Number.isFinite(ms) ? ms : null
}

const startMs = computed(() => {
  const fromRun = timeOf(props.execution?.startedAt)
  if (fromRun !== null) return fromRun
  const stamps = ordered.value.map((step) => timeOf(step.at)).filter((ms) => ms !== null)
  return stamps.length ? Math.min(...stamps) : null
})

const endMs = computed(() => {
  if (startMs.value === null) return null
  const fromRun = timeOf(props.execution?.endedAt)
  if (fromRun !== null) return fromRun
  const stamps = ordered.value
    .flatMap((step) => [timeOf(step.at), timeOf(step.endedAt)])
    .filter((ms) => ms !== null)
  if (stamps.length) return Math.max(...stamps)
  if (Number.isFinite(props.execution?.ms)) return startMs.value + props.execution.ms
  return startMs.value
})

const totalMs = computed(() =>
  startMs.value === null || endMs.value === null ? 0 : Math.max(0, endMs.value - startMs.value),
)

const tools = computed(() => {
  if (startMs.value === null) return []
  const runs = []
  for (const step of ordered.value) {
    if (step.type !== 'tool_use' && step.type !== 'tool_result') continue
    const start = timeOf(step.at)
    if (start === null) continue
    let end = timeOf(step.endedAt)
    if (end === null && Number.isFinite(step.durationMs)) end = start + step.durationMs
    if (end === null || end <= start) continue
    runs.push({
      start: Math.max(startMs.value, start),
      end: Math.min(endMs.value, end),
      seq: step.seq,
      label: step.tool || 'tool',
    })
  }
  runs.sort((a, b) => a.start - b.start)
  const merged = []
  for (const run of runs) {
    const last = merged[merged.length - 1]
    if (last && run.start <= last.end) {
      last.end = Math.max(last.end, run.end)
      if (!last.labels.includes(run.label)) last.labels.push(run.label)
      continue
    }
    merged.push({ ...run, labels: [run.label] })
  }
  return merged
})

const model = computed(() => {
  if (!totalMs.value) return []
  const out = []
  let cursor = startMs.value
  for (const tool of tools.value) {
    if (tool.start > cursor) {
      out.push({ start: cursor, end: tool.start })
    }
    cursor = Math.max(cursor, tool.end)
  }
  if (cursor < endMs.value) out.push({ start: cursor, end: endMs.value })
  return out
})

const modelMs = computed(() => model.value.reduce((sum, part) => sum + (part.end - part.start), 0))
const toolMs = computed(() => tools.value.reduce((sum, part) => sum + (part.end - part.start), 0))
const selectedOffset = computed(() => {
  const step = ordered.value.find((entry) => entry.seq === props.selectedSeq)
  const at = timeOf(step?.at)
  if (at === null || !totalMs.value) return null
  return Math.max(0, Math.min(totalMs.value, at - startMs.value))
})

function formatMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

function percent(value) {
  return `${(value / totalMs.value) * 100}%`
}

function toolTitle(part) {
  const names = [...new Set(part.labels)].join(', ')
  return `${names} · ${formatMs(part.end - part.start)}`
}

function selectTool(part) {
  if (Number.isFinite(part.seq)) emit('select', part.seq)
}
</script>

<template>
  <div class="xtl" :data-empty="totalMs ? '0' : '1'">
    <div class="xtl-head">
      <span>Where the time went</span>
      <b>{{ formatMs(totalMs) }}</b>
    </div>
    <template v-if="totalMs">
      <div class="xtl-lane">
        <span class="xtl-lb">Model <b>{{ formatMs(modelMs) }}</b></span>
        <div class="xtl-track">
          <span
            v-for="(part, index) in model"
            :key="`m-${index}`"
            class="xtl-seg xtl-model"
            :style="{ left: percent(part.start - startMs), width: percent(part.end - part.start) }"
          ></span>
          <i
            v-if="selectedOffset !== null"
            class="xtl-cursor"
            :style="{ left: `${(selectedOffset / totalMs) * 100}%` }"
          ></i>
        </div>
      </div>
      <div class="xtl-lane">
        <span class="xtl-lb">Tools <b>{{ formatMs(toolMs) }}</b></span>
        <div class="xtl-track">
          <button
            v-for="(part, index) in tools"
            :key="`t-${index}`"
            class="xtl-seg xtl-tool"
            type="button"
            :style="{ left: percent(part.start - startMs), width: percent(part.end - part.start) }"
            :title="toolTitle(part)"
            :aria-label="toolTitle(part)"
            @click="selectTool(part)"
          ></button>
          <i
            v-if="selectedOffset !== null"
            class="xtl-cursor"
            :style="{ left: `${(selectedOffset / totalMs) * 100}%` }"
          ></i>
        </div>
      </div>
      <div class="xtl-legend">
        <span><i class="lg-model"></i>model time</span>
        <span><i class="lg-tool"></i>tool time</span>
        <span v-if="selectedOffset !== null" class="xtl-playhead-note">selected step</span>
      </div>
    </template>
    <p v-else class="xtl-empty">No timing was recorded for this run.</p>
  </div>
</template>
