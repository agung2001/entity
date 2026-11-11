<script setup>
/* a compact skill badge derived from thesvg.org's Skill (UI / Agents) icon */
defineProps({
  size: { type: [Number, String], default: 14 },
})
</script>

<template>
  <svg
    class="skill-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="9.25" r="6.25" />
    <path d="M8.15 15.9 7.35 20.7l4.65-2.35 4.65 2.35-.8-4.8" />
    <path d="M12 6.3l.78 1.62 1.77.26-1.28 1.25.3 1.77L12 10.36l-1.57.84.3-1.77-1.28-1.25 1.77-.26z" />
  </svg>
</template>
