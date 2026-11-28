<script setup>
/**
 * The decision aid on step 2: what the plan is made of, who carries it, and
 * where it lands against the deadline. Hand-drawn SVG and bars — a chart
 * library for three shapes would be a dependency for nothing.
 *
 * Every number is a count of the tasks on screen; none of it is a read, so none
 * of it claims to be progress. The pace line is the plan's own shape against an
 * even spread (dashed), which is what "can I finish this" actually asks.
 */
import { computed } from 'vue'
import { EFFORT_WEIGHT, PRIORITY_ORDER, day, daysBetween, daysTo, priorityWord, today } from '@/lib/goals'

const props = defineProps({
  tasks: { type: Array, default: () => [] },
  deadline: { type: String, default: '' },
})

const total = computed(() => props.tasks.length)
const counts = computed(() =>
  PRIORITY_ORDER.map((priority) => ({
    priority,
    label: priorityWord(priority),
    n: props.tasks.filter((task) => task.priority === priority).length,
  })),
)
const points = computed(() => props.tasks.reduce((sum, task) => sum + (EFFORT_WEIGHT[task.effort] || 1), 0))
const entityCount = computed(() => new Set(props.tasks.map((task) => task.entity).filter(Boolean)).size)

const R = 44
const CIRCUMFERENCE = 2 * Math.PI * R
const donut = computed(() => {
  let at = 0
  return counts.value
    .filter((slice) => slice.n)
    .map((slice) => {
      const share = slice.n / Math.max(1, total.value)
      const dash = `${(share * CIRCUMFERENCE).toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}`
      const offset = (-at * CIRCUMFERENCE).toFixed(2)
      at += share
      return { ...slice, dash, offset }
    })
})

const byEntity = computed(() => {
  const map = new Map()
  for (const task of props.tasks) {
    const key = task.entity || 'unassigned'
    map.set(key, (map.get(key) || 0) + 1)
  }
  const rows = [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  const max = Math.max(1, ...rows.map((row) => row.count))
  return rows.map((row) => ({ ...row, width: Math.round((row.count / max) * 100) }))
})

/** The plan's cumulative effort by date, against a straight line to the deadline. */
const pace = computed(() => {
  const span = daysTo(props.deadline)
  if (span === null || span <= 0) return null
  const dated = props.tasks.filter((task) => task.date).sort((a, b) => a.date.localeCompare(b.date))
  if (!dated.length) return null
  const start = today()
  const stack = [{ x: 0, y: 0 }]
  let running = 0
  for (const task of dated) {
    running += EFFORT_WEIGHT[task.effort] || 1
    const offset = Math.max(0, Math.min(span, daysBetween(start, task.date) ?? 0))
    stack.push({ x: offset, y: running })
  }
  const width = 280
  const height = 86
  const max = Math.max(1, running)
  const px = (value) => 6 + (value / span) * (width - 12)
  const py = (value) => height - 6 - (value / max) * (height - 12)
  return {
    total: running,
    span,
    plan: stack.map((point, index) => `${index ? 'L' : 'M'}${px(point.x).toFixed(1)} ${py(point.y).toFixed(1)}`).join(' '),
    target: `M${px(0).toFixed(1)} ${py(0).toFixed(1)} L${px(span).toFixed(1)} ${py(max).toFixed(1)}`,
  }
})
</script>

<template>
  <div class="panel draft-charts">
    <div class="panel-h"><span class="t">What the draft used</span><span class="sm">{{ total }} tasks</span></div>
    <div class="panel-body">
      <div class="dch-donut">
        <svg viewBox="0 0 120 120" role="img" :aria-label="`${total} tasks by priority`">
          <circle class="dch-track" cx="60" cy="60" :r="R" />
          <circle
            v-for="slice in donut"
            :key="slice.priority"
            class="dch-slice"
            :data-p="slice.priority"
            cx="60"
            cy="60"
            :r="R"
            :stroke-dasharray="slice.dash"
            :stroke-dashoffset="slice.offset"
          />
        </svg>
        <ul class="dch-legend">
          <li v-for="slice in counts" :key="slice.priority">
            <i :data-p="slice.priority"></i>{{ slice.label }} <b>{{ slice.n }}</b>
          </li>
        </ul>
      </div>

      <div v-if="byEntity.length" class="dch-bars">
        <div class="dch-sub">By entity <span>{{ entityCount }} assigned</span></div>
        <div v-for="row in byEntity" :key="row.name" class="dch-bar">
          <span class="nm" :title="row.name">{{ row.name }}</span>
          <span class="track"><i :style="{ width: `${row.width}%` }"></i></span>
          <b>{{ row.count }}</b>
        </div>
      </div>

      <div v-if="pace" class="dch-pace">
        <div class="dch-sub">The plan against the deadline <span>{{ points }} effort points</span></div>
        <svg viewBox="0 0 280 86" role="img" aria-label="Cumulative effort by date against an even spread">
          <path class="dch-target" :d="pace.target" />
          <path class="dch-plan" :d="pace.plan" />
        </svg>
        <p class="ctx-note">
          Solid is when the plan's effort actually lands; the dashed line is the same work spread
          evenly to {{ day(deadline) }}. Above the line is front-loaded, below it is left to the end.
        </p>
      </div>
    </div>
  </div>
</template>
