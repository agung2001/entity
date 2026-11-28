<script setup>
/**
 * The create page's stage — the sign-in screen's bargain (a full warm sky with a
 * white card on it) in a goal's own language: a pixel skyline of bars for the
 * work left, sonar rings opening where today sits, and ticks rising like closed
 * tasks.
 *
 * CSS only — no canvas, no resize listener, no random layout on mount. Placement
 * is seeded by the index, so the same page is the same field on every visit.
 * Decoration: `aria-hidden`, no focusable children, no pointer events, and every
 * loop stops under `prefers-reduced-motion`.
 */
const BARS = 18

function tickStyle(n) {
  const x = (n * 41 + 11) % 100
  const size = n % 7 === 0 ? 9 : n % 4 === 0 ? 6 : 4
  return {
    left: `${x}%`,
    width: `${size}px`,
    height: `${size}px`,
    '--dx': `${(n % 2 ? 1 : -1) * (10 + (n % 5) * 14)}px`,
    animationDelay: `-${(n % 9) * 1.3}s`,
    animationDuration: `${8 + (n % 6) * 2}s`,
  }
}

function barStyle(n) {
  return {
    height: `${20 + ((n * 37 + 11) % 74)}px`,
    animationDelay: `-${(n % 7) * 0.9}s`,
  }
}
</script>

<template>
  <div class="goals-sky" aria-hidden="true">
    <span class="gs-glow"></span>
    <span class="gs-sonar">
      <i></i><i></i><i></i><b></b>
    </span>
    <span class="gs-bars">
      <i v-for="n in BARS" :key="n" :style="barStyle(n)" :data-tone="n % 3"></i>
    </span>
    <i v-for="n in 24" :key="`t${n}`" class="gs-tick" :style="tickStyle(n)"></i>
    <span class="gs-scan"></span>
  </div>
</template>
