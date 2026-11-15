<script setup>
import { computed } from 'vue'
import { formatTokens, formatUsd } from '@/lib/chart-math'
import { daysFor, loadUsage, usage } from '@/stores/usage'
import CalendarHeatmap from '@/components/CalendarHeatmap.vue'

/**
 * The entity's own year: when it was asked to work, and what that cost. Read
 * from the same folded summary as the overview, filtered by the entity name.
 */
const props = defineProps({
  entity: { type: String, required: true },
})

const days = computed(() => daysFor(props.entity))
const summary = computed(() => usage.data?.entities?.[props.entity] || {})
const year = computed(() => usage.year)

loadUsage().catch(() => {})
</script>

<template>
  <section class="entp-cal" aria-label="Entity activity this year">
    <header>
      <div>
        <p class="eyebrow">Activity · {{ year }}</p>
        <h3>When this entity worked</h3>
      </div>
      <p class="entp-cal-stats">
        <span><b>{{ summary.turns || 0 }}</b> turns</span>
        <span><b>{{ formatTokens((summary.tokensIn || 0) + (summary.tokensOut || 0)) }}</b> tokens</span>
        <span><b>{{ Number(summary.costUsd) > 0 ? formatUsd(summary.costUsd) : '—' }}</b> spend</span>
      </p>
    </header>
    <CalendarHeatmap :days="days" :year="year" :height="150" :label="`${entity} activity in ${year}`" />
  </section>
</template>
