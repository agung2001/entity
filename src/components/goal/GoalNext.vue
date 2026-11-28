<script setup>
/**
 * What to do next (§2.5) — exactly three rows, ranked lateness → priority → date.
 * A done task never appears and no task appears twice; the rule is printed under
 * the list rather than left for the reader to infer.
 */
import { computed } from 'vue'
import { PRIORITY_ORDER, day, daysTo, lateBy, priorityWord } from '@/lib/goals'

const props = defineProps({ goal: { type: Object, required: true } })

const rows = computed(() => {
  const tasks = (props.goal.tasks || []).filter((task) => !task.done)
  const rank = (task) => (task.date ? (daysTo(task.date) ?? 0) : Number.MAX_SAFE_INTEGER)
  return [...tasks]
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) ||
        String(a.date).localeCompare(String(b.date)) ||
        String(a.title).localeCompare(String(b.title)),
    )
    .slice(0, 3)
})
</script>

<template>
  <div class="panel">
    <div class="panel-h"><span class="t">What to do next</span><span class="sm">by date, then priority</span></div>
    <div class="cxns">
      <div v-if="!rows.length" class="cxn">
        <span class="cxn-mk">✓</span>
        <span class="cxn-b">
          <b>Nothing open</b>
          <span>Every task on this goal is ticked.</span>
        </span>
      </div>
      <div v-for="(task, index) in rows" :key="task.id" class="cxn" :data-state="(daysTo(task.date) ?? 0) < 0 ? 'off' : undefined">
        <span class="cxn-mk">{{ index + 1 }}</span>
        <span class="cxn-b">
          <b :title="task.title">{{ task.title }}</b>
          <span>{{ priorityWord(task.priority) }} · {{ task.date ? day(task.date) : 'no date' }}<template v-if="lateBy(task.date)"> · {{ lateBy(task.date) }}</template></span>
        </span>
      </div>
    </div>
    <div class="panel-note">
      <p class="ctx-note">Ranked by lateness, then priority, then the date. No task appears twice, and a done task never appears.</p>
    </div>
  </div>
</template>
