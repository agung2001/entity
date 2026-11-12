<script setup>
import { computed } from 'vue'

/**
 * A compact Gantt of one run. A stream only stamps arrivals, so a step with no
 * explicit `endedAt` ends where the next step begins; tool calls that do carry
 * an end use it. The longest bar is marked, which is the useful answer to
 * "what took the time?" without guessing at token-level timing.
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

function labelOf(step) {
  if (step.type === 'thinking') return 'Thinking'
  if (step.type === 'text') return 'Response'
  if (step.type === 'tool_use') return step.tool || 'Tool'
  if (step.type === 'tool_result') return `${step.tool || 'Tool'} result`
  return 'Error'
}

function typeOf(step) {
  if (step.type === 'thinking') return 'thinking'
  if (step.type === 'text') return 'text'
  if (step.type === 'error' || step.isError) return 'error'
  return 'tool'
}

const bars = computed(() => {
  const startAll = startMs.value
  const endAll = endMs.value
  if (startAll === null || endAll === null || endAll <= startAll) return []
  const list = ordered.value
  const out = []
  for (let index = 0; index < list.length; index += 1) {
    const step = list[index]
    const at = timeOf(step.at)
    if (at === null) continue
    const start = Math.max(startAll, Math.min(endAll, at))
    let end = timeOf(step.endedAt)
    if (end === null && Number.isFinite(step.durationMs)) end = start + step.durationMs
    if (end === null) {
      const next = list
        .slice(index + 1)
        .map((entry) => timeOf(entry.at))
        .find((value) => value !== null && value > start)
      end = next === undefined ? endAll : Math.min(endAll, next)
    }
    end = Math.min(endAll, Math.max(start + 1, end))
    out.push({
      seq: step.seq,
      label: labelOf(step),
      type: typeOf(step),
      start,
      end,
      ms: end - start,
      error: step.type === 'error' || Boolean(step.isError),
    })
  }
  if (!out.length) return []
  const longest = out.reduce((best, bar) => (bar.ms > best.ms ? bar : best), out[0])
  return out.map((bar) => ({ ...bar, longest: bar.seq === longest.seq }))
})

const longestBar = computed(() => bars.value.find((bar) => bar.longest) || null)

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

function titleOf(bar) {
  return `${bar.label} · ${formatMs(bar.ms)}${bar.longest ? ' · longest step' : ''}`
}
</script>

<template>
  <div class="gt" :data-empty="bars.length ? '0' : '1'">
    <div class="gt-head">
      <span>Where the time went</span>
      <b>{{ formatMs(totalMs) }}</b>
    </div>
    <template v-if="bars.length">
      <div class="gt-meta">
        <span>{{ bars.length }} {{ bars.length === 1 ? 'step' : 'steps' }}</span>
        <span v-if="longestBar">
          longest · <b>{{ longestBar.label }}</b> {{ formatMs(longestBar.ms) }}
        </span>
      </div>
      <div class="gt-list" role="list" aria-label="Step durations">
        <button
          v-for="bar in bars"
          :key="bar.seq"
          class="gt-row"
          type="button"
          role="listitem"
          :data-selected="selectedSeq === bar.seq ? '1' : '0'"
          :data-longest="bar.longest ? '1' : '0'"
          :title="titleOf(bar)"
          :aria-label="titleOf(bar)"
          @click="emit('select', bar.seq)"
        >
          <span class="gt-label">
            {{ bar.label }}
            <em v-if="bar.longest">longest</em>
          </span>
          <span class="gt-track">
            <i
              :data-type="bar.type"
              :data-error="bar.error ? '1' : '0'"
              :style="{ left: percent(bar.start - startMs), width: percent(bar.end - bar.start) }"
            ></i>
          </span>
          <span class="gt-dur">{{ formatMs(bar.ms) }}</span>
        </button>
      </div>
      <div class="gt-legend">
        <span><i class="lg-model"></i>thinking</span>
        <span><i class="lg-text"></i>response</span>
        <span><i class="lg-tool"></i>tool</span>
      </div>
    </template>
    <p v-else class="gt-empty">No timing was recorded for this run.</p>
  </div>
</template>
