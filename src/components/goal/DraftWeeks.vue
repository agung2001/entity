<script setup>
/**
 * When the plan's effort lands, week by week, against its own average. The
 * full-width band is the only place on step 2 where the shape of the schedule
 * can be read, and a peak week is the honest answer to "is there room for this".
 *
 * Everything here is the draft's own dates and effort sizes: a forecast, not a
 * read. A task without a date is left off the bars and said in words.
 */
import { computed } from 'vue'
import {
  EFFORT_WEIGHT,
  PRIORITY_ORDER,
  day,
  daysBetween,
  daysTo,
  priorityWord,
  shiftDay,
  today,
} from '@/lib/goals'

const props = defineProps({
  tasks: { type: Array, default: () => [] },
  deadline: { type: String, default: '' },
})

const BAR = 112

const span = computed(() => daysTo(props.deadline))
const dated = computed(() => props.tasks.filter((task) => task.date))
const undated = computed(() => props.tasks.length - dated.value.length)
const points = computed(() => dated.value.reduce((sum, task) => sum + (EFFORT_WEIGHT[task.effort] || 1), 0))

const weeks = computed(() => {
  if (!span.value || span.value <= 0 || !dated.value.length) return null
  const count = Math.max(1, Math.ceil(span.value / 7))
  const start = today()
  const rows = Array.from({ length: count }, (_, index) => ({
    index,
    from: shiftDay(start, index * 7),
    to: shiftDay(start, Math.min(span.value, index * 7 + 6)),
    days: Math.min(7, span.value - index * 7),
    points: 0,
    parts: [],
  }))
  const tally = rows.map(() => new Map())
  for (const task of dated.value) {
    const offset = daysBetween(start, task.date)
    const index = Math.max(0, Math.min(count - 1, Math.floor((offset ?? 0) / 7)))
    const weight = EFFORT_WEIGHT[task.effort] || 1
    rows[index].points += weight
    tally[index].set(task.priority, (tally[index].get(task.priority) || 0) + weight)
  }
  rows.forEach((row, index) => {
    row.parts = PRIORITY_ORDER.filter((priority) => tally[index].get(priority)).map((priority) => ({
      priority,
      points: tally[index].get(priority),
      share: (tally[index].get(priority) / Math.max(1, row.points)) * 100,
    }))
  })
  const max = Math.max(1, ...rows.map((row) => row.points))
  const total = rows.reduce((sum, row) => sum + row.points, 0)
  const average = total / count
  const peak = rows.reduce((best, row) => (row.points > best.points ? row : best), rows[0])
  return {
    rows: rows.map((row) => ({ ...row, height: Math.round((row.points / max) * BAR) })),
    /* 10 px plot padding + the 12 px week label + its 5 px gap */
    averageBottom: 10 + 12 + 5 + Math.round((average / max) * BAR),
    averageOf: Math.round(average * 10) / 10,
    total,
    peak,
  }
})
</script>

<template>
  <section v-if="weeks" class="panel draft-weeks">
    <div class="dph">
      <h2>When the work lands</h2>
      <span class="c">{{ weeks.rows.length }} {{ weeks.rows.length === 1 ? 'week' : 'weeks' }} · to {{ day(deadline) }}</span>
    </div>

    <div class="dpw-body">
      <div class="dpw-plot" role="img" :aria-label="`Effort points by week, ${weeks.total} in total, peak ${weeks.peak.points} in the week of ${day(weeks.peak.from)}`">
        <div class="dpw-cols">
          <div v-for="row in weeks.rows" :key="row.from" class="dpw-col">
            <b class="dpw-n" :data-zero="row.points ? undefined : '1'">{{ row.points || '·' }}</b>
            <div class="dpw-bar" :style="{ height: `${row.height}px` }" :data-empty="row.points ? undefined : '1'" :title="`${row.points} effort points`">
              <i
                v-for="part in row.parts"
                :key="part.priority"
                :data-p="part.priority"
                :style="{ height: `${part.share}%` }"
                :title="`${priorityWord(part.priority)} · ${part.points} points`"
              ></i>
            </div>
            <span class="dpw-lb">{{ day(row.from).replace(/ \d{4}$/, '') }}</span>
          </div>
        </div>
        <div class="dpw-avg" :style="{ bottom: `${weeks.averageBottom}px` }" aria-hidden="true"></div>
        <span class="dpw-avg-l" :style="{ bottom: `${weeks.averageBottom + 3}px` }">average {{ weeks.averageOf }}</span>
      </div>

      <dl class="dpw-facts">
        <div>
          <dt>Effort points</dt>
          <dd>{{ weeks.total }}</dd>
        </div>
        <div>
          <dt>Peak week</dt>
          <dd>{{ day(weeks.peak.from).replace(/ \d{4}$/, '') }} <small>{{ weeks.peak.points }} pts</small></dd>
        </div>
        <div>
          <dt>Days</dt>
          <dd>{{ span }}</dd>
        </div>
        <p class="dpw-note">
          Bars are effort points by week, stacked by priority. A week above the average is where the
          plan has to hold.
          <template v-if="undated"> {{ undated }} {{ undated === 1 ? 'task has' : 'tasks have' }} no date and {{ undated === 1 ? 'is' : 'are' }} not on the bars.</template>
        </p>
      </dl>
    </div>
  </section>
</template>
