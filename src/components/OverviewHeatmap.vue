<script setup>
import { computed } from 'vue'
import { emptyHeatColor, heatColors, heatPieces, yearDays } from '@/lib/chart-math'
import { themeMode } from '@/lib/theme'

/**
 * A year of turns as one square per day, drawn inline.
 *
 * The overview is the page that opens first, and the two ECharts instances
 * behind the old usage panels were the reason that route carried a chart
 * renderer. This is the mockup's own geometry instead — 9.5 px cells on a
 * 12 px pitch, Monday first, months lettered above their first week — so the
 * page keeps the picture and loses the chunk.
 */
const props = defineProps({
  days: { type: Object, default: () => ({}) },
  year: { type: Number, default: () => new Date().getFullYear() },
  unit: { type: String, default: 'turns' },
})

const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']
/* The row letters the mockup prints: Monday, Wednesday, Friday, Saturday. */
const DAY_ROWS = [
  { row: 0, letter: 'M' },
  { row: 2, letter: 'W' },
  { row: 4, letter: 'F' },
  { row: 6, letter: 'S' },
]

const dark = computed(() => themeMode.value === 'dark')
const palette = computed(() => heatColors(dark.value))
const empty = computed(() => emptyHeatColor(dark.value))

function dayValue(day) {
  const cell = props.days?.[day]
  if (cell && typeof cell === 'object') return Number(cell[props.unit]) || 0
  return Number(cell) || 0
}

const grid = computed(() => {
  const all = yearDays(props.year)
  /* Monday-first: a column is a week, a row is a weekday. */
  const offset = (new Date(props.year, 0, 1).getDay() + 6) % 7
  const cells = all.map((day, index) => {
    const column = Math.floor((index + offset) / 7)
    const row = (index + offset) % 7
    return { day, value: dayValue(day), x: 22 + column * 12, y: 13 + row * 12 }
  })
  const max = cells.reduce((top, cell) => Math.max(top, cell.value), 0)
  const pieces = heatPieces(max, palette.value, empty.value)
  const paint = (value) => {
    if (value <= 0) return empty.value
    const piece = pieces.find((step) => step.value !== 0 && value >= step.min && value <= step.max)
    return piece?.color || palette.value[0]
  }
  /* 660 is the mockup's box; only a leap year that starts on a Saturday needs
     a 54th column, and a box 12 px wider beats clipping 31 December. */
  const columns = Math.ceil((all.length + offset) / 7)
  return {
    width: 22 + columns * 12 + 2,
    cells: cells.map((cell) => ({ ...cell, color: paint(cell.value) })),
    months: MONTHS.map((letter, month) => {
      const index = Math.round(
        (new Date(props.year, month, 1) - new Date(props.year, 0, 1)) / 86_400_000,
      )
      return { letter, x: 22 + Math.floor((index + offset) / 7) * 12 }
    }),
    total: cells.reduce((sum, cell) => sum + cell.value, 0),
    active: cells.filter((cell) => cell.value > 0).length,
  }
})

const label = computed(() => {
  const { total, active } = grid.value
  const unit = props.unit.charAt(0).toUpperCase() + props.unit.slice(1)
  return `${unit} per day in ${props.year}: ${total} ${props.unit} on ${active} ${
    active === 1 ? 'day' : 'days'
  }`
})
</script>

<template>
  <svg class="hm" :viewBox="`0 0 ${grid.width} 97`" role="img" :aria-label="label">
    <text v-for="month in grid.months" :key="`m${month.x}`" :x="month.x" y="7" class="hm-m">
      {{ month.letter }}
    </text>
    <text v-for="row in DAY_ROWS" :key="row.letter" x="0" :y="21.5 + row.row * 12" class="hm-d">
      {{ row.letter }}
    </text>
    <rect
      v-for="cell in grid.cells"
      :key="cell.day"
      :x="cell.x"
      :y="cell.y"
      width="9.5"
      height="9.5"
      rx="1.6"
      :fill="cell.color"
    />
  </svg>
</template>
