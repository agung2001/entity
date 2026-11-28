<script setup>
/**
 * What the plan is made of: priority mix and who carries it. Counts of the rows
 * on screen, never a read — this card answers "what did the draft spend itself
 * on", which is the first half of deciding whether the goal is worth pursuing.
 */
import { computed } from 'vue'
import EntityMark from '@/components/EntityMark.vue'
import { PRIORITY_ORDER, priorityWord } from '@/lib/goals'

const props = defineProps({
  tasks: { type: Array, default: () => [] },
})

const total = computed(() => props.tasks.length)
const slices = computed(() =>
  PRIORITY_ORDER.map((priority) => ({
    priority,
    label: priorityWord(priority),
    n: props.tasks.filter((task) => task.priority === priority).length,
  })),
)

const R = 34
const C = 2 * Math.PI * R
const ring = computed(() => {
  let at = 0
  return slices.value
    .filter((slice) => slice.n)
    .map((slice) => {
      const share = slice.n / Math.max(1, total.value)
      const dash = `${(share * C).toFixed(2)} ${C.toFixed(2)}`
      const offset = (-at * C).toFixed(2)
      at += share
      return { ...slice, dash, offset }
    })
})

const byEntity = computed(() => {
  const map = new Map()
  for (const task of props.tasks) {
    const key = task.entity || 'Nobody yet'
    map.set(key, (map.get(key) || 0) + 1)
  }
  const rows = [...map.entries()]
    .map(([name, count]) => ({ name, count, assigned: name !== 'Nobody yet' }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  const max = Math.max(1, ...rows.map((row) => row.count))
  return { rows: rows.map((row) => ({ ...row, share: Math.round((row.count / max) * 100) })), assigned: rows.filter((row) => row.assigned).length }
})
</script>

<template>
  <div class="draft-shape">
    <div class="dsh-head">
      <span class="dsh-t">What it is made of</span>
      <span class="dsh-by">{{ total }} tasks</span>
    </div>

    <div class="ds-top">
      <div class="ds-donut">
        <svg viewBox="0 0 88 88" role="img" :aria-label="`${total} tasks by priority`">
          <circle class="ds-track" cx="44" cy="44" :r="R" />
          <circle
            v-for="slice in ring"
            :key="slice.priority"
            class="ds-slice"
            :data-p="slice.priority"
            cx="44"
            cy="44"
            :r="R"
            :stroke-dasharray="slice.dash"
            :stroke-dashoffset="slice.offset"
          />
        </svg>
        <span class="ds-n"><b>{{ total }}</b><small>tasks</small></span>
      </div>
      <ul class="ds-legend">
        <li v-for="slice in slices" :key="slice.priority" :data-zero="slice.n ? undefined : '1'">
          <i :data-p="slice.priority"></i>{{ slice.label }}<b>{{ slice.n }}</b>
        </li>
      </ul>
    </div>

    <div class="ds-sub">By entity <span>{{ byEntity.assigned }} of {{ total }} assigned</span></div>
    <ul class="ds-bars">
      <li v-for="row in byEntity.rows" :key="row.name" :data-empty="row.assigned ? undefined : '1'">
        <EntityMark v-if="row.assigned" mini animate :entity="row.name" />
        <span v-else class="ds-dot" aria-hidden="true"></span>
        <span class="nm">{{ row.name }}</span>
        <span class="track"><i v-if="row.assigned" :style="{ width: `${row.share}%` }"></i></span>
        <b>{{ row.count }}</b>
      </li>
    </ul>
  </div>
</template>
