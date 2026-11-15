<script setup>
import { computed } from 'vue'
import { themeMode } from '@/lib/theme'
import { chartTheme, formatTokens, formatUsd, yearDays } from '@/lib/chart-math'
import EChart from '@/components/EChart.vue'
import CalendarHeatmap from '@/components/CalendarHeatmap.vue'

/**
 * The year at a glance: what the workspace spent and when it was busy.
 *
 * Both series come from the same folded summary, so the two charts never
 * disagree about which days exist. Days with no turns stay at zero instead of
 * being dropped, which is what makes the calendar readable as a calendar.
 */
const props = defineProps({
  data: { type: Object, default: null },
  year: { type: Number, default: () => new Date().getFullYear() },
  loading: { type: Boolean, default: false },
})

const totals = computed(() => props.data?.totals || {})
const priced = computed(() => Number(totals.value.costUsd) > 0)
/* Not every harness prices its turns (pi reports zeroes for some models). An
   empty dollar chart would hide a real working year, so the same bars show
   tokens with an honest heading instead. */
const mode = computed(() => (priced.value ? 'cost' : 'tokens'))
const activeDays = computed(
  () => Object.values(props.data?.days || {}).filter((day) => Number(day.turns) > 0).length,
)

const spendOption = computed(() => {
  void themeMode.value
  const t = chartTheme()
  const all = yearDays(props.year)
  const rows = all.map((day) => {
    const cell = props.data?.days?.[day]
    return {
      day,
      cost: Number(cell?.costUsd) || 0,
      tokens: (Number(cell?.tokensIn) || 0) + (Number(cell?.tokensOut) || 0),
      turns: Number(cell?.turns) || 0,
    }
  })
  return {
    backgroundColor: 'transparent',
    animationDuration: 260,
    grid: { left: 44, right: 12, top: 16, bottom: 26 },
    tooltip: {
      backgroundColor: t.surface,
      borderColor: t.border,
      textStyle: { color: t.ink, fontSize: 11 },
      formatter: (params) => {
        const row = rows[params.dataIndex]
        if (!row) return ''
        const headline =
          mode.value === 'cost'
            ? formatUsd(row.cost)
            : `${formatTokens(row.tokens)} tokens`
        return `<b>${row.day}</b><br>${headline} · ${row.turns} turns`
      },
    },
    xAxis: {
      type: 'category',
      data: rows.map((row) => row.day),
      axisLine: { lineStyle: { color: t.border } },
      axisTick: { show: false },
      axisLabel: {
        color: t.muted,
        fontSize: 9,
        interval: (index, value) => value.endsWith('-01'),
        formatter: (value) => {
          const month = Number(value.slice(5, 7))
          return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1] || ''
        },
      },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: t.border, type: 'dashed' } },
      axisLabel: {
        color: t.muted,
        fontSize: 9,
        formatter: (value) => (mode.value === 'cost' ? formatUsd(value) : formatTokens(value)),
      },
    },
    series: [
      {
        type: 'bar',
        data: rows.map((row) => (mode.value === 'cost' ? row.cost : row.tokens)),
        barMaxWidth: 5,
        itemStyle: { color: t.accent, borderRadius: [2, 2, 0, 0] },
        emphasis: { itemStyle: { color: t.accentInk } },
      },
    ],
  }
})
</script>

<template>
  <div class="usage-stack">
    <section class="usage-charts" aria-labelledby="usage-spend">
      <header class="usage-head">
        <div>
          <p class="eyebrow">This year</p>
          <h2 id="usage-spend">Spend</h2>
        </div>
        <dl class="usage-totals">
          <div>
            <dt>Spend</dt>
            <dd>{{ priced ? formatUsd(totals.costUsd) : '—' }}</dd>
          </div>
          <div>
            <dt>Tokens</dt>
            <dd>{{ formatTokens(totals.tokensIn + totals.tokensOut) }}</dd>
          </div>
        </dl>
      </header>

      <article class="usage-card">
        <header>
          <h3>{{ mode === 'cost' ? 'Cost in dollars' : 'Tokens used' }}</h3>
          <p>
            {{
              mode === 'cost'
                ? 'Every day with a priced turn.'
                : 'The harness does not report a price, so the same bars show tokens.'
            }}
          </p>
        </header>
        <EChart
          v-if="!loading && totals.turns"
          :option="spendOption"
          :height="168"
          :label="
            mode === 'cost'
              ? `Daily cost for ${year}: ${formatUsd(totals.costUsd)} total`
              : `Daily tokens for ${year}`
          "
        />
        <p v-else-if="loading" class="usage-note">Reading the year…</p>
        <p v-else class="usage-note">No turns recorded this year yet.</p>
      </article>
    </section>

    <section class="usage-charts" aria-labelledby="usage-activity">
      <header class="usage-head">
        <div>
          <p class="eyebrow">This year</p>
          <h2 id="usage-activity">Activity</h2>
        </div>
        <dl class="usage-totals">
          <div>
            <dt>Turns</dt>
            <dd>{{ totals.turns || 0 }}</dd>
          </div>
          <div>
            <dt>Active days</dt>
            <dd>{{ activeDays }}</dd>
          </div>
        </dl>
      </header>

      <article class="usage-card">
        <header>
          <h3>One square per day</h3>
          <p>Darker when more turns ran; grey when nothing did.</p>
        </header>
        <CalendarHeatmap
          v-if="!loading && totals.turns"
          :days="data?.days || {}"
          :year="year"
          :height="168"
        />
        <p v-else class="usage-note">{{ loading ? 'Reading the year…' : 'Nothing ran this year yet.' }}</p>
      </article>
    </section>
  </div>
</template>
