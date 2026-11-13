<script setup>
import { computed } from 'vue'

/**
 * A CSS-only pixel field. No canvas, no requestAnimationFrame, no resize
 * listener: the handful of squares animate transform/opacity on the compositor
 * while the grid and scanline stay inside one contained paint layer.
 */
const props = defineProps({
  variant: { type: String, default: 'chat' },
  color: { type: String, default: '' },
  active: { type: Boolean, default: false },
  count: { type: Number, default: 10 },
})

const style = computed(() => ({ '--px': props.color || 'var(--accent)' }))

/* Seeded placement: the same page gets the same field on every visit. */
function pixelStyle(n) {
  const off = props.variant === 'hero' ? 0 : 23
  const x = (n * 37 + off * 3) % 100
  const y = (n * 53 + off) % 100
  const hero = props.variant === 'hero'
  const size = n % 9 === 0 ? (hero ? 5 : 3) : n % 4 === 0 ? (hero ? 4 : 2) : hero ? 3 : 2
  const dx = (n % 2 ? -1 : 1) * (3 + (n % 5) * 3)
  return {
    left: `${x}%`,
    top: `${y}%`,
    width: `${size}px`,
    height: `${size}px`,
    '--dx': `${dx}px`,
    animationDelay: `-${(n % 8) * 1.15}s`,
    animationDuration: `${(props.variant === 'hero' ? 6 : 9) + (n % 5) * 1.4}s`,
  }
}
</script>

<template>
  <div
    class="pxbg"
    :class="`pxbg--${variant}`"
    :data-active="active ? '1' : '0'"
    :style="style"
    aria-hidden="true"
  >
    <span class="pxbg-glow"></span>
    <span class="pxbg-grid"></span>
    <i v-for="n in count" :key="n" class="pxbg-px" :style="pixelStyle(n)"></i>
    <span class="pxbg-scan"></span>
  </div>
</template>
