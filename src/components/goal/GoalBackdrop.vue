<script setup>
/**
 * The create page's stage, in the sign-in screen's spirit with a different
 * animation: a pace track sliding under the card, ticks rising like closed
 * tasks, and one ring opening where today sits.
 *
 * CSS only — no canvas, no resize listener, no random layout on mount. The
 * placement is seeded by the index, so the same page is the same field on every
 * visit. Decoration: `aria-hidden`, no focusable children, no pointer events,
 * and every loop stops under `prefers-reduced-motion`.
 */
function tickStyle(n) {
  const x = (n * 47 + 13) % 100
  const size = n % 5 === 0 ? 5 : n % 3 === 0 ? 4 : 3
  return {
    left: `${x}%`,
    width: `${size}px`,
    height: `${size}px`,
    animationDelay: `-${(n % 7) * 1.6}s`,
    animationDuration: `${9 + (n % 5) * 2}s`,
  }
}
</script>

<template>
  <div class="goals-sky" aria-hidden="true">
    <span class="gs-glow"></span>
    <span class="gs-ring"></span>
    <span class="gs-track"></span>
    <i v-for="n in 14" :key="n" class="gs-tick" :style="tickStyle(n)"></i>
    <span class="gs-scan"></span>
  </div>
</template>
