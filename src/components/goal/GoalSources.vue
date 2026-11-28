<script setup>
/**
 * Sources (§2.5) — what the last read was built from, and what a removed source
 * costs: nothing. Its tasks keep the dates they already had and their token reads
 * `missing`; no task is deleted (§4.3, F4c).
 */
import { computed } from 'vue'
import { ago } from '@/stores/hub'
import { day } from '@/lib/goals'

const props = defineProps({
  goal: { type: Object, required: true },
  refreshError: { type: String, default: '' },
})

const sources = computed(() => (Array.isArray(props.goal.read?.sources) ? props.goal.read.sources : []))
const stamp = computed(() => (props.goal.readAt ? `read ${ago(props.goal.readAt)}` : 'not read yet'))

const mark = (source) =>
  String(source.label || source.kind || '?')
    .replace(/^@/, '')
    .slice(0, 2)
    .toUpperCase()

const lineOf = (source) => {
  if (source.state === 'off') return 'removed from context'
  if (source.state === 'error') return `could not be read ${source.readAt ? ago(source.readAt) : ''}`.trim()
  return source.readAt ? `read ${ago(source.readAt)}` : 'read'
}
</script>

<template>
  <div class="panel">
    <div class="panel-h"><span class="t">Sources</span><span class="sm">{{ stamp }}</span></div>
    <div class="cxns">
      <div v-if="!sources.length" class="cxn">
        <span class="cxn-mk">—</span>
        <span class="cxn-b">
          <b>No source read yet</b>
          <span>This goal's own script counts the tasks. Refresh runs it.</span>
        </span>
      </div>
      <div v-for="source in sources" :key="`${source.kind}-${source.label}`" class="cxn" :data-state="source.state === 'off' ? 'off' : undefined">
        <span class="cxn-mk">{{ mark(source) }}</span>
        <span class="cxn-b">
          <b>{{ source.label || source.kind }}</b>
          <span>{{ lineOf(source) }}</span>
          <span v-if="source.state === 'off'" class="uses">tasks keep their dates — nothing is deleted</span>
        </span>
      </div>
    </div>
    <div v-if="refreshError" class="panel-note">
      <p class="ctx-note">Refresh changed no figure: {{ refreshError }}</p>
    </div>
    <div v-else-if="goal.read && goal.read.total === 0" class="panel-note">
      <p class="ctx-note">No task carries a date yet, so the goal has nothing to be ahead or behind of. {{ day(goal.deadline) }} is the deadline either way.</p>
    </div>
  </div>
</template>
