<script setup>
import { computed } from 'vue'
import EChart from '@/components/EChart.vue'
import { chartTheme } from '@/lib/chart-math'

/**
 * One panel on the dashboard page.
 *
 * The kind is data (`stat | series | table | progress | note | unsupported`), not
 * a component name, so a producer can add a panel without this file changing. Two
 * rules come from the spec and are load-bearing here:
 *
 *   - **A failed panel keeps its frame.** The head turns red, the body carries
 *     the producer's own sentence, the values it last had stay legible (dimmed,
 *     never deleted) and the foot says when they were good.
 *   - **An empty series is not a broken one.** A source that answered with zero
 *     rows draws its axis and one caption; a blank box reads as a failed load.
 */
const props = defineProps({
  panel: { type: Object, required: true },
  /* A refresh is in flight: the skeleton keeps the panel's own height. */
  loading: { type: Boolean, default: false },
})

const emit = defineEmits(['retry'])

const failed = computed(() => props.panel.state === 'failed')
const unsupported = computed(() => props.panel.state === 'unsupported')
const points = computed(() => props.panel.points || [])

const theme = computed(() => chartTheme())
/* The series is one line of the source's own numbers; the renderer formats, it
   never smooths, averages or fills. `animation: false` because the page repaints
   on a theme change and a chart that re-animates is a chart that is not data. */
const option = computed(() => {
  const t = theme.value
  const labels = props.panel.labels || []
  return {
    animation: false,
    grid: { left: 2, right: 2, top: 6, bottom: labels.length ? 18 : 4, containLabel: false },
    xAxis: {
      type: 'category',
      data: labels.length ? labels : points.value.map((_, index) => String(index + 1)),
      axisLine: { lineStyle: { color: t.border } },
      axisTick: { show: false },
      axisLabel: { show: Boolean(labels.length), color: t.muted, fontSize: 9 },
    },
    yAxis: { type: 'value', show: false, min: 0 },
    series: [
      {
        type: 'line',
        data: points.value,
        smooth: false,
        symbol: 'none',
        lineStyle: { width: 2, color: t.accentInk },
        areaStyle: { color: t.accentSoft },
      },
    ],
  }
})

const value = computed(() => (props.panel.value === null || props.panel.value === undefined ? '—' : String(props.panel.value)))
const pct = (part) => {
  const total = Number(props.panel.total) || 0
  if (!total || !Number.isFinite(Number(part))) return 0
  return Math.max(0, Math.min(100, Math.round((Number(part) / total) * 100)))
}
const sourceLine = computed(() => {
  const panel = props.panel
  const label = panel.source?.label || panel.evidence?.[0]?.label || ''
  const scope = panel.evidence?.[0]?.value || ''
  return [label, scope].filter(Boolean).join(' · ')
})
const footRight = computed(() => (props.panel.asOf ? props.panel.asOf : ''))
/* A series' own measuring window, so `14 d` is never guessed from point count. */
const windowLabel = computed(() => {
  const labels = props.panel.labels || []
  if (!labels.length) return ''
  return `${labels[0]} – ${labels.at(-1)} · ${points.value.length} d`
})
</script>

<template>
  <article class="panel" :data-span="panel.span" :data-state="panel.state">
    <header class="panel-head">
      <svg
        v-if="failed"
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        aria-hidden="true"
        class="head-warn"
      >
        <path d="M8 2.8l5.5 10H2.5z" />
        <path d="M8 6.6v3.1M8 11.6v.1" />
      </svg>
      <h3 :title="panel.title">{{ panel.title || panel.kind }}</h3>
      <span class="spacer"></span>
      <span v-if="failed" class="panel-pill" data-state="failed"><span class="dot" aria-hidden="true"></span>failed</span>
      <span v-else class="kind">{{ panel.kind }}</span>
    </header>

    <div v-if="loading" class="skel-panel" :style="{ '--skel-panel': `${panel.kind === 'series' ? 190 : 132}px` }" aria-busy="true">
      <span class="skel s"></span>
      <span class="skel m"></span>
      <span class="skel w"></span>
    </div>

    <div v-else-if="unsupported" class="panel-body">
      <p class="note-body">{{ panel.sentence }}</p>
    </div>

    <div v-else class="panel-body">
      <template v-if="failed">
        <div class="fail-note">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M8 2.8l5.5 10H2.5z" />
            <path d="M8 6.6v3.1M8 11.6v.1" />
          </svg>
          <p>{{ panel.error }}</p>
        </div>
      </template>

      <template v-if="panel.kind === 'stat'">
        <div class="big-stat">{{ value }}<small v-if="panel.unit"> {{ panel.unit }}</small></div>
        <div v-if="panel.delta" class="delta" :data-tone="panel.tone || 'flat'">{{ panel.delta }}</div>
        <div v-if="panel.parts?.length" class="split">
          <span v-for="part in panel.parts" :key="part.name"><b>{{ part.value }}</b> {{ part.hint || part.name }}</span>
        </div>
      </template>

      <template v-else-if="panel.kind === 'series'">
        <div v-if="panel.value !== null" class="split">
          <span><b>{{ value }}</b> {{ panel.unit }}</span>
          <span v-if="panel.delta">{{ panel.delta }}</span>
        </div>
        <EChart
          v-if="points.length"
          class="chart"
          :option="option"
          :height="132"
          :label="`${panel.title || 'Series'} over the last ${points.length} days`"
        />
        <template v-else>
          <!-- The axis stays: an empty week is an answer, a blank box is a failure. -->
          <div class="chart chart-empty" aria-hidden="true"><i></i></div>
          <p class="caption">{{ panel.note || 'No rows answered for this window.' }}</p>
        </template>
      </template>

      <template v-else-if="panel.kind === 'table'">
        <table class="tbl" :class="{ dim: failed }">
          <thead v-if="panel.columns?.length">
            <tr>
              <th v-for="(column, index) in panel.columns" :key="index" :class="{ num: column.align === 'right' }">
                {{ column.label }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in panel.rows" :key="index">
              <td v-for="(cell, cellIndex) in row" :key="cellIndex" :class="{ num: panel.columns?.[cellIndex]?.align === 'right' }">
                <span class="ttl" :title="cell">{{ cell }}</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!panel.rows?.length" class="caption">{{ panel.note || 'No rows answered for this window.' }}</p>
      </template>

      <template v-else-if="panel.kind === 'progress'">
        <div class="big-stat">{{ value }}<small v-if="panel.unit"> {{ panel.unit }}</small></div>
        <div v-if="panel.parts?.length" class="prog">
          <div v-for="part in panel.parts" :key="part.name" class="prog-row">
            <span class="nm">{{ part.name }}</span>
            <span class="h">{{ part.hint }}</span>
            <div class="prog-bar"><i :style="{ width: `${pct(part.value)}%` }"></i></div>
          </div>
        </div>
      </template>

      <p v-else class="note-body">{{ panel.note || panel.delta }}</p>
    </div>

    <footer class="panel-foot">
      <span class="foot-text">{{ sourceLine }}</span>
      <span class="spacer"></span>
      <template v-if="failed">
        <span v-if="panel.lastGood" class="last-good">last good {{ panel.lastGood.replace(/^as of /, '') }}</span>
        <button class="retry" type="button" @click="emit('retry', panel)">Retry source</button>
      </template>
      <span v-else-if="panel.kind === 'series' && windowLabel" class="foot-text">{{ windowLabel }}</span>
      <span v-else class="foot-text">{{ footRight }}</span>
    </footer>
  </article>
</template>
