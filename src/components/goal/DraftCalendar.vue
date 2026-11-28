<script setup>
/**
 * The draft on its calendar — a month or a single week. Same task objects as the
 * table, so a priority colour and a title match row for row. The month is for
 * "how does the plan spread"; the week is for "what actually lands this week".
 *
 * The view and the date are local state, not the address: this is a plan that
 * has not been stored yet, and a half-written draft should not leave a URL.
 */
import { computed, ref } from 'vue'
import { day, month, shiftDay, shortDay, today } from '@/lib/goals'

const props = defineProps({
  tasks: { type: Array, default: () => [] },
  deadline: { type: String, default: '' },
})

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const stamp = (value) => String(value).slice(0, 7)
const mondayOf = (value) => {
  const [year, monthNumber, date] = String(value).split('-').map(Number)
  const offset = (new Date(year, monthNumber - 1, date).getDay() + 6) % 7
  return shiftDay(value, -offset)
}
const shiftMonth = (value, delta) => {
  const [year, monthNumber] = value.split('-').map(Number)
  const at = new Date(year, monthNumber - 1 + delta, 1)
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`
}

const dated = computed(() => props.tasks.filter((task) => task.date))
const undated = computed(() => props.tasks.length - dated.value.length)
const byDate = computed(() => {
  const map = new Map()
  for (const task of dated.value) {
    const list = map.get(task.date) || []
    list.push(task)
    map.set(task.date, list)
  }
  return map
})

/** The month with most of the plan in it — a month holding one row would make a
    five-task plan look empty. Ties go to the earlier month. */
const busiest = computed(() => {
  const counts = new Map()
  for (const task of dated.value) {
    const key = stamp(task.date)
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return ranked[0]?.[0] || stamp(today())
})

const view = ref('month')
const at = ref(busiest.value)
/* the week opens on the plan's first date, not on an empty Monday */
const weekOf = ref(mondayOf([...dated.value].sort((a, b) => a.date.localeCompare(b.date))[0]?.date || today()))

function setView(next) {
  if (next === view.value) return
  if (next === 'week') {
    if (stamp(weekOf.value) !== at.value) weekOf.value = mondayOf(`${at.value}-01`)
  } else {
    at.value = stamp(weekOf.value)
  }
  view.value = next
}

function step(delta) {
  if (view.value === 'week') weekOf.value = shiftDay(weekOf.value, delta * 7)
  else at.value = shiftMonth(at.value, delta)
}

const monthCells = computed(() => {
  const [year, monthNumber] = at.value.split('-').map(Number)
  const lead = (new Date(year, monthNumber - 1, 1).getDay() + 6) % 7
  const days = new Date(year, monthNumber, 0).getDate()
  const list = Array.from({ length: lead }, () => null)
  for (let date = 1; date <= days; date += 1) {
    const key = `${at.value}-${String(date).padStart(2, '0')}`
    list.push({ date: key, day: date, tasks: byDate.value.get(key) || [] })
  }
  return list
})

const weekCells = computed(() =>
  Array.from({ length: 7 }, (_, index) => {
    const date = shiftDay(weekOf.value, index)
    return { date, day: Number(date.slice(8)), tasks: byDate.value.get(date) || [] }
  }),
)

const cells = computed(() => (view.value === 'week' ? weekCells.value : monthCells.value))
const inView = computed(() =>
  view.value === 'week'
    ? dated.value.filter((task) => task.date >= weekOf.value && task.date <= shiftDay(weekOf.value, 6)).length
    : dated.value.filter((task) => stamp(task.date) === at.value).length,
)
const outside = computed(() => dated.value.length - inView.value)
const heading = computed(() =>
  view.value === 'week'
    ? `${shortDay(weekOf.value)} – ${day(shiftDay(weekOf.value, 6))}`
    : month(at.value),
)
</script>

<template>
  <div class="dcal">
    <div class="dcal-bar">
      <button class="btn btn-sm" type="button" :aria-label="view === 'week' ? 'Previous week' : 'Previous month'" @click="step(-1)">←</button>
      <b class="dcal-m">{{ heading }}</b>
      <button class="btn btn-sm" type="button" :aria-label="view === 'week' ? 'Next week' : 'Next month'" @click="step(1)">→</button>
      <span class="pview dcal-view" role="tablist" aria-label="How much of the plan to show">
        <button type="button" role="tab" :aria-selected="view === 'month' ? 'true' : 'false'" @click="setView('month')">Month</button>
        <button type="button" role="tab" :aria-selected="view === 'week' ? 'true' : 'false'" @click="setView('week')">Week</button>
      </span>
      <span class="sp"></span>
      <span v-if="outside" class="dcal-out">{{ outside }} {{ view === 'week' ? 'outside this week' : outside === 1 ? 'in another month' : 'in other months' }}</span>
      <span v-if="undated" class="dcal-out">{{ undated }} without a date</span>
      <span v-if="deadline" class="dcal-due">due {{ month(String(deadline).slice(0, 7)) }}</span>
    </div>

    <div class="dcal-grid" :data-view="view">
      <span v-for="label in WEEKDAYS" :key="label" class="dcal-wd">{{ label }}</span>
      <div
        v-for="(cell, index) in cells"
        :key="cell?.date || `pad-${index}`"
        class="dcal-cell"
        :data-off="cell ? undefined : '1'"
      >
        <template v-if="cell">
          <span class="dcal-d" :data-today="cell.date === today() ? '1' : undefined">{{ cell.day }}</span>
          <span
            v-for="task in cell.tasks.slice(0, view === 'week' ? 8 : 3)"
            :key="task.id"
            class="dcal-chip"
            :data-p="task.priority"
            :title="task.title"
          >{{ task.title }}</span>
          <span v-if="cell.tasks.length > (view === 'week' ? 8 : 3)" class="dcal-more">
            +{{ cell.tasks.length - (view === 'week' ? 8 : 3) }}
          </span>
        </template>
      </div>
    </div>
  </div>
</template>
