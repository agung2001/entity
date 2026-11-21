<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import {
  bandPanels,
  countLabel,
  initialOf,
  panelVisual,
  priceLabel,
} from '@/lib/dashboard'
import { hub } from '@/stores/hub'

/**
 * The band on Overview: one row of the numbers a producer entity just fetched.
 *
 * Three rules decide this component, and each one is a way the old Overview lied:
 *
 *   - **Nothing at all without a snapshot.** No heading, no empty frame, no
 *     "connect a service" — an Overview with no dashboard has to look exactly
 *     like one that never had the feature.
 *   - **A failed band keeps its frame and invents no number.** Every source
 *     failed means the cells are gone, not zeroed: one sentence from the
 *     producer, one Retry, and the reason it could not read.
 *   - **The state is a word.** Colour is the second signal; `fresh`, `stale` and
 *     `failed` are the first, so the row reads on a screen that cannot see hue.
 */
const props = defineProps({
  /* A parsed document from `src/lib/dashboard.js`, or null when nothing ran. */
  dashboard: { type: Object, default: null },
  /* The dashboard's id, for the page link and the refresh call. */
  id: { type: String, default: '' },
  refreshing: { type: Boolean, default: false },
  /* `permission`: this account may read the cache and not spend on a refresh. */
  canRefresh: { type: Boolean, default: true },
})

const emit = defineEmits(['refresh'])
const router = useRouter()

const panels = computed(() => bandPanels(props.dashboard))

const state = computed(() => props.dashboard?.state || 'never')
const failed = computed(() => state.value === 'failed')
const stale = computed(() => state.value === 'stale')
const stamp = computed(() => {
  const doc = props.dashboard
  if (!doc?.snapshot) return ''
  const parts = [doc.asOfLabel]
  if (stale.value && doc.ageLabel) parts.push(doc.ageLabel)
  if (doc.schedule?.cadence === 'daily' && doc.schedule.at) parts.push(`daily ${doc.schedule.at}`)
  return parts.filter(Boolean).join(' · ')
})
const price = computed(() => priceLabel(props.dashboard))
const producerLine = computed(() => {
  const doc = props.dashboard
  const file = props.id ? `${props.id.split('/').pop()}` : 'dashboard'
  const produced = doc?.snapshot?.run ? ' · produced on another machine' : ''
  return `${file} · ${countLabel(panels.value.length, 'panel', 'panels')} of ${doc?.panels?.length || 0}${produced}`
})
/* One sentence, from the producer's own words; the band never translates it. */
const failureSentence = computed(() => props.dashboard?.sentence || 'The last pass could not read its sources.')

const openDashboard = () => {
  if (!props.id) return
  hub.rail.artifacts = false
  router.push({ name: 'artifact', params: { workspace: hub.workspace, id: props.id } })
}

const refresh = () => {
  if (!props.canRefresh || props.refreshing) return
  emit('refresh')
}

/* A cell's number and its unit are two type sizes; the headline never truncates,
   the label after it does. */
const bigOf = (panel) => (panel.value === null || panel.value === undefined ? '—' : String(panel.value))
const visualOf = (panel) => panelVisual(panel)
const deltaTone = (panel) => (panel.tone ? { 'data-tone': panel.tone } : {})
/* The accessible sentence for a visual, because the bars are `aria-hidden`. */
const visualLabel = (panel) => {
  const visual = visualOf(panel)
  if (visual.kind === 'spark') return `${panel.title || panel.source?.label || 'series'}: ${visual.bars.length} points`
  if (visual.kind === 'bar') return `${bigOf(panel)} of ${panel.total} ${panel.unit}`
  return ''
}
</script>

<template>
  <section v-if="panels.length || failed" class="band" aria-labelledby="band-title">
    <header class="band-head">
      <h2 id="band-title">From your services</h2>
      <span class="stamp">{{ stamp }}</span>
      <span class="spacer"></span>
      <span class="band-pill" :data-state="state">
        <span class="dot" aria-hidden="true"></span>{{ state }}
      </span>
      <button
        v-if="stale && canRefresh"
        class="btn btn-ghost btn-sm"
        type="button"
        :disabled="refreshing"
        :title="`Runs the producer now, ${price}`"
        @click="refresh"
      >
        Refresh
      </button>
    </header>

    <div v-if="failed" class="band-fail">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <path d="M8 2.8l5.5 10H2.5z" />
        <path d="M8 6.6v3.1M8 11.6v.1" />
      </svg>
      <p>{{ failureSentence }}</p>
      <button
        class="btn btn-sm"
        type="button"
        :disabled="!canRefresh || refreshing"
        :title="`Runs the producer now, ${price}`"
        @click="refresh"
      >
        Retry
      </button>
    </div>

    <div v-else class="band-grid" :style="{ '--band-count': panels.length }">
      <div v-for="panel in panels" :key="panel.id" class="bp" :data-state="panel.state">
        <div class="bp-label">
          <span class="sq" aria-hidden="true">{{ initialOf(panel.source?.label || panel.evidence?.[0]?.label) }}</span>
          <span class="bp-lbl" :title="panel.title">{{ panel.title || panel.source?.label }}</span>
        </div>
        <div class="bp-big">
          {{ bigOf(panel) }}<small v-if="panel.unit"> {{ panel.unit }}</small>
        </div>
        <div v-if="panel.delta" class="bp-delta" v-bind="deltaTone(panel)">{{ panel.delta }}</div>
        <div
          v-else-if="panel.state === 'failed'"
          class="bp-delta"
          data-tone="risk"
          :title="panel.error"
        >
          {{ panel.error }}
        </div>

        <div
          v-if="visualOf(panel).kind === 'spark'"
          class="spark"
          aria-hidden="true"
        >
          <i v-for="(height, index) in visualOf(panel).bars" :key="index" :style="{ height: `${height}%` }"></i>
        </div>
        <div
          v-else-if="visualOf(panel).kind === 'bar'"
          class="bp-bar"
          role="img"
          :aria-label="visualLabel(panel)"
        >
          <i :style="{ width: `${visualOf(panel).pct}%` }"></i>
        </div>
        <div v-else-if="visualOf(panel).kind === 'list'" class="list" aria-hidden="true">
          <span v-for="(row, index) in visualOf(panel).rows" :key="index">{{ row }}</span>
        </div>

        <div class="bp-foot">
          <span class="bp-src">{{ panel.source?.label || panel.evidence?.[0]?.label }}</span>
          <span class="sep" aria-hidden="true">·</span>
          <span v-if="panel.state === 'failed'" class="bad">failed</span>
          <span v-else>{{ panel.evidence?.[0]?.value || panel.asOf || stamp }}</span>
        </div>
      </div>
    </div>

    <footer class="band-foot">
      <span class="stamp">{{ producerLine }}</span>
      <span class="spacer"></span>
      <button class="band-open" type="button" @click="openDashboard">
        Open dashboard<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 8h7.5M8.5 4.5L12 8l-3.5 3.5" /></svg>
      </button>
    </footer>
  </section>
</template>
