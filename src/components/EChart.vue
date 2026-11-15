<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * A canvas chart that loads ECharts on its own.
 *
 * The views hand it a plain option object; this component owns the lifecycle
 * (init, resize, dispose) so a chart that unmounts never keeps a canvas or a
 * ResizeObserver alive.
 */
const props = defineProps({
  option: { type: Object, required: true },
  height: { type: Number, default: 220 },
  label: { type: String, default: 'Chart' },
})

const el = ref(null)
let chart = null
let observer = null
let alive = true

onMounted(async () => {
  try {
    const { createChart } = await import('@/lib/echarts-core')
    if (!alive || !el.value) return
    chart = createChart(el.value)
    chart.setOption(props.option, true)
    observer = new ResizeObserver(() => chart?.resize())
    observer.observe(el.value)
  } catch {
    /* A chart is a garnish; the numbers beside it are the answer. */
  }
})

watch(
  () => props.option,
  (option) => {
    chart?.setOption(option, true)
  },
  { deep: true },
)

onBeforeUnmount(() => {
  alive = false
  observer?.disconnect()
  observer = null
  chart?.dispose()
  chart = null
})
</script>

<template>
  <div
    ref="el"
    class="echart"
    :style="{ height: `${height}px` }"
    role="img"
    :aria-label="label"
  ></div>
</template>
