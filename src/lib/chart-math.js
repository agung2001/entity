/**
 * Chart helpers with no library attached.
 *
 * Views need tokens, formatting and a year of day buckets before a chart ever
 * mounts. Keeping them out of `echarts-core.js` means importing a formatter
 * does not drag the renderer into the route chunk.
 */

export function chartTheme() {
  const css = typeof document === 'undefined' ? null : getComputedStyle(document.documentElement)
  const read = (name, fallback) => css?.getPropertyValue(name).trim() || fallback
  return {
    ink: read('--ink', '#0a0a0a'),
    muted: read('--muted', '#6b6e73'),
    border: read('--border', '#e3e2dd'),
    surface: read('--surface', '#f9f8f5'),
    accent: read('--accent', '#f8b956'),
    accentSoft: read('--accent-soft', '#ffeed1'),
    accentInk: read('--accent-ink', '#7a5005'),
  }
}

/** Five warm steps, faint to strong. A dark theme needs a dark empty cell, or
    the year reads as a glowing block against the surface. */
export const HEAT_COLORS = {
  light: ['#fdf2da', '#fbe0ad', '#f6c56a', '#e3a137', '#a96f16'],
  dark: ['#292419', '#4c3d22', '#7c6128', '#b78a34', '#f3bc57'],
}

export function heatColors(dark = false) {
  return dark ? HEAT_COLORS.dark : HEAT_COLORS.light
}

/** A day with nothing on it is grey, not the faintest step of the warm ramp. */
export function emptyHeatColor(dark = false) {
  return dark ? '#2b2822' : '#ebe8e1'
}

/**
 * Piecewise bands so zero is a colour of its own. A continuous map would make
 * the first turn look almost like no turn, and "nothing happened" should read
 * as nothing, not as a paler yes.
 */
export function heatPieces(max, palette, empty) {
  const top = Math.max(1, Math.round(Number(max) || 0))
  const pieces = [{ value: 0, color: empty }]
  const steps = palette.length
  let low = 1
  for (let index = 0; index < steps; index += 1) {
    const high = index === steps - 1 ? top : Math.max(low, Math.ceil(((index + 1) * top) / steps))
    pieces.push({ min: low, max: high, color: palette[index] })
    low = high + 1
    if (low > top) break
  }
  return pieces
}

const COMPACT_NUMBER = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

export function formatTokens(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '0'
  return COMPACT_NUMBER.format(n)
}

export function formatUsd(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '$0'
  if (n < 0.01) return '<$0.01'
  if (n < 100) return `$${n.toFixed(2)}`
  return `$${Math.round(n)}`
}

/** Day buckets for a calendar year, including the days with no activity. */
export function yearDays(year) {
  const days = []
  const cursor = new Date(year, 0, 1)
  while (cursor.getFullYear() === year) {
    const month = String(cursor.getMonth() + 1).padStart(2, '0')
    const day = String(cursor.getDate()).padStart(2, '0')
    days.push(`${year}-${month}-${day}`)
    cursor.setDate(cursor.getDate() + 1)
  }
  return days
}
