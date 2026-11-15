/**
 * ECharts, lazily — only the pieces the hub draws.
 *
 * Imported by `EChart.vue` with `import()`; never from a view. Keeping the
 * library here (and the formatters in `chart-math.js`) means a route chunk that
 * shows a chart does not carry it until the canvas actually mounts.
 */
import * as echarts from 'echarts/core'
import { BarChart, HeatmapChart } from 'echarts/charts'
import {
  CalendarComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  BarChart,
  HeatmapChart,
  CalendarComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer,
])

export function createChart(el) {
  return echarts.init(el, null, { renderer: 'canvas' })
}
