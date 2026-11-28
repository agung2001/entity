<script setup>
/**
 * The draft on its month — the plan's own dates, read the way a calendar reads
 * them. It is the same task objects as the table, so a priority colour and a
 * title match row for row; a task with no date has no month and is said so.
 *
 * The month is local state, not the address: this is a view of a draft that has
 * not been stored yet, and a half-written plan should not leave a URL behind.
 */
import { computed, ref } from 'vue'
import { month, today } from '@/lib/goals'

const props = defineProps({
  tasks: { type: Array, default: () => [] },
  deadline: { type: String, default: '' },
})

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const stamp = (at) => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`
const shift = (value, delta) => {
  const [year, monthNumber] = value.split('-').map(Number)
  return stamp(new Date(year, monthNumber - 1 + delta, 1))
}

const dated = computed(() => props.tasks.filter((task) => task.date))
const undated = computed(() => props.tasks.length - dated.value.length)
/** The month with the most of the plan in it — opening on a month that holds one
    row would make a five-task plan look empty. Ties go to the earlier month. */
const busiest = computed(() => {
  const counts = new Map()
  for (const task of dated.value) {
    const key = String(task.date).slice(0, 7)
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return ranked[0]?.[0] || today().slice(0, 7)
})
const at = ref(busiest.value)

const byDate = computed(() => {
  const map = new Map()
  for (const task of dated.value) {
    const list = map.get(task.date) || []
    list.push(task)
    map.set(task.date, list)
  }
  return map
})

const cells = computed(() => {
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

const outside = computed(
  () => dated.value.filter((task) => String(task.date).slice(0, 7) !== at.value).length,
)
</script>

<template>
  <div class="dcal">
    <div class="dcal-bar">
      <button class="btn btn-sm" type="button" aria-label="Previous month" @click="at = shift(at, -1)">←</button>
      <b class="dcal-m">{{ month(at) }}</b>
      <button class="btn btn-sm" type="button" aria-label="Next month" @click="at = shift(at, 1)">→</button>
      <span class="sp"></span>
      <span v-if="outside" class="dcal-out">{{ outside }} in {{ outside === 1 ? 'another month' : 'other months' }}</span>
      <span v-if="undated" class="dcal-out">{{ undated }} without a date</span>
      <span v-if="deadline" class="dcal-due">due {{ month(String(deadline).slice(0, 7)) }}</span>
    </div>

    <div class="dcal-grid">
      <span v-for="label in WEEKDAYS" :key="label" class="dcal-wd">{{ label }}</span>
      <div v-for="(cell, index) in cells" :key="cell?.date || `pad-${index}`" class="dcal-cell" :data-off="cell ? undefined : '1'">
        <template v-if="cell">
          <span class="dcal-d" :data-today="cell.date === today() ? '1' : undefined">{{ cell.day }}</span>
          <span
            v-for="task in cell.tasks.slice(0, 3)"
            :key="task.id"
            class="dcal-chip"
            :data-p="task.priority"
            :title="task.title"
          >{{ task.title }}</span>
          <span v-if="cell.tasks.length > 3" class="dcal-more">+{{ cell.tasks.length - 3 }}</span>
        </template>
      </div>
    </div>
  </div>
</template>
