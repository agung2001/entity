<script setup>
/**
 * The Area 51 desert stage behind the auth screens.
 *
 * Extracted from LoginView so the sign-in screen and the first-run wizard stand
 * on the same scene instead of keeping two copies of forty nodes. The styles
 * live in `login.css` (`.a51…`); this file is only the layer markup. It is
 * decoration: `aria-hidden`, no focusable children, no pointer events.
 */

/* Deterministic pixel field: no random layout on every mount. */
function starStyle(n) {
  const x = (n * 37 + 11) % 100
  const y = (n * 29 + 7) % 62
  const size = n % 9 === 0 ? 3 : n % 4 === 0 ? 2 : 1
  return {
    left: `${x}%`,
    top: `${y}%`,
    width: `${size}px`,
    height: `${size}px`,
    animationDelay: `${(n % 11) * 0.31}s`,
    animationDuration: `${2.6 + (n % 5) * 0.7}s`,
  }
}

function dustStyle(n) {
  const x = (n * 43 + 5) % 100
  return {
    left: `${x}%`,
    '--drift': `${(n % 2 ? 1 : -1) * (8 + (n % 5) * 5)}px`,
    animationDelay: `${(n % 9) * 0.9}s`,
    animationDuration: `${7 + (n % 6) * 1.5}s`,
  }
}
</script>

<template>
  <div class="a51" aria-hidden="true">
    <div class="a51-stars">
      <i v-for="n in 34" :key="`star-${n}`" :style="starStyle(n)"></i>
    </div>
    <div class="a51-sun"></div>
    <div class="a51-ufo">
      <span class="a51-dome"></span>
      <span class="a51-saucer"></span>
      <span class="a51-light a51-light--1"></span>
      <span class="a51-light a51-light--2"></span>
      <span class="a51-light a51-light--3"></span>
      <span class="a51-beam"></span>
    </div>
    <div class="a51-ridge a51-ridge--far"></div>
    <div class="a51-grid"></div>
    <div class="a51-ridge a51-ridge--near"></div>
    <div class="a51-dust">
      <i v-for="n in 12" :key="`dust-${n}`" :style="dustStyle(n)"></i>
    </div>
    <div class="a51-search a51-search--left"></div>
    <div class="a51-search a51-search--right"></div>
    <div class="a51-scan"></div>
    <span class="a51-stamp">Area 51 · local only</span>
  </div>
</template>
