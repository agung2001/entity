<script setup>
import { computed } from 'vue'
import { themeMode } from '@/lib/theme'
import { chartTheme, emptyHeatColor, heatColors, heatPieces, yearDays } from '@/lib/chart-math'
import EChart from '@/components/EChart.vue'

/**
 * A year of activity as a calendar. Values are turns per day; the visual map is
 * scaled to the busiest day so a quiet year still shows its shape.
 */
const props = defineProps({
  days: { type: Object, default: () => ({}) },
  year: { type: Number, default: () => new Date().getFullYear() },
  height: { type: Number, default: 162 },
  label: { type: String, default: 'Activity this year' },
  unit: { type: String, default: 'turns' },
})

const rows = computed(() => {
  const all = yearDays(props.year)
  const values = all.map((day) => [day, Number(props.days?.[day]?.turns) || 0])
  const max = Math.max(1, ...values.map(([, value]) => value))
  return { values, max, active: values.filter(([, value]) => value > 0).length }
})

const dark = computed(() => themeMode.value === 'dark')
const palette = computed(() => heatColors(dark.value))
const empty = computed(() => emptyHeatColor(dark.value))
/* With no active day at all, a warm ramp would suggest activity that is not
   there; the single grey step tells the truth. */
const legend = computed(() =>
  rows.value.active ? [empty.value, ...palette.value] : [empty.value],
)

const option = computed(() => {
  /* themeMode is read for its side effect: a theme switch rebuilds the option
     with the new ink, surface and heat colours. */
  void themeMode.value
  const t = chartTheme()
  return {
    backgroundColor: 'transparent',
    animationDuration: 240,
    tooltip: {
      backgroundColor: t.surface,
      borderColor: t.border,
      textStyle: { color: t.ink, fontSize: 11 },
      formatter: (params) => {
        const [day, value] = params.data
        return `<b>${day}</b><br>${value} ${props.unit}`
      },
    },
    visualMap: {
      type: 'piecewise',
      show: false,
      pieces: heatPieces(rows.value.max, palette.value, empty.value),
    },
    calendar: {
      range: String(props.year),
      left: 30,
      right: 16,
      top: 28,
      bottom: 22,
      cellSize: ['auto', 16],
      splitLine: { show: false },
      itemStyle: { color: 'transparent', borderWidth: 0 },
      dayLabel: {
        firstDay: 1,
        nameMap: ['S', 'M', 'T', 'W', 'T', 'F', 'S'],
        color: t.muted,
        fontSize: 9,
      },
      monthLabel: { color: t.muted, fontSize: 10, margin: 6 },
      yearLabel: { show: false },
    },
    series: [
      {
        type: 'heatmap',
        coordinateSystem: 'calendar',
        data: rows.value.values,
        itemStyle: {
          borderColor: t.surface,
          borderWidth: 1,
          borderRadius: 2,
        },
        emphasis: { itemStyle: { borderColor: t.ink, borderWidth: 1 } },
      },
    ],
  }
})
</script>

<template>
  <div class="calendar-chart">
    <div class="calendar-legend">
      <span>{{ rows.active }} active {{ rows.active === 1 ? 'day' : 'days' }}</span>
      <span class="legend-scale" aria-hidden="true">
        <i v-for="color in legend" :key="color" :style="{ background: color }"></i>
      </span>
    </div>
    <EChart :option="option" :height="height" :label="`${label}: ${rows.active} active days`" />
  </div>
</template>
