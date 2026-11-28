<script setup>
/**
 * The goal's one figure (§2.4).
 *
 * `.big` is the count-derived percentage of the **last read**: `—` when the read
 * is null, and never `0`. `.of` is the live count, so a tick updates the words
 * immediately while the bar waits for the next Refresh — that is the rule, and
 * the footnote under the card says it. The fill takes its colour from the state,
 * and `.proj` is the pace's own stripe, not a second bar.
 */
import { computed } from 'vue'
import { ago } from '@/stores/hub'
import { barOf, day, paceOf, shortDay, today } from '@/lib/goals'

const props = defineProps({ goal: { type: Object, required: true } })

const bar = computed(() => barOf(props.goal))
const pace = computed(() => paceOf(props.goal))
const percent = computed(() => (bar.value.percent === null ? '—' : `${bar.value.percent}%`))
const paceWord = computed(() => {
  if (bar.value.state === 'stale' && props.goal.readAt) return `read ${ago(props.goal.readAt)} · Refresh`
  return bar.value.pace
})
const label = computed(() => {
  const counts = bar.value.counts
  const how = bar.value.state === 'unread' ? 'not read yet' : paceWord.value
  return `${counts.done} of ${counts.total} tasks closed, ${how}`
})
</script>

<template>
  <div class="goalbar">
    <div class="top">
      <span class="big">{{ percent }}</span>
      <span class="of">{{ bar.counts.done }} of {{ bar.counts.total }} tasks · a local tick moves the count, Refresh moves the bar</span>
      <span class="pace" :data-late="bar.state === 'missed' || bar.state === 'behind' ? '1' : undefined">{{ paceWord }}</span>
    </div>
    <div class="bar" role="img" :aria-label="label" :data-state="bar.state">
      <span class="proj" :style="{ width: `${pace}%` }"></span>
      <span class="fill" :style="{ width: `${bar.percent ?? 0}%` }"></span>
      <span class="tick" :style="{ left: `${pace}%` }"></span>
    </div>
    <div class="axis">
      <span>{{ day(goal.createdAt?.slice(0, 10) || goal.deadline) }} start</span>
      <span class="sp"></span>
      <span>▲ today, {{ shortDay(today()) }}</span>
      <span class="sp"></span>
      <span>{{ day(goal.deadline) }} deadline</span>
    </div>
  </div>
</template>
