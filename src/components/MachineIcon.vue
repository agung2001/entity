<script setup>
/* server icon from thesvg.org (UI / Dev / outline) */
defineProps({
  size: { type: [Number, String], default: 15 },
})
</script>

<template>
  <svg
    class="machine-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="butt"
    stroke-linejoin="miter"
    aria-hidden="true"
  >
    <path d="M5 3.5L19 3.5L20.5 5L20.5 9L19 10.5L5 10.5L3.5 9L3.5 5L5 3.5Z" />
    <path d="M5 13.5L19 13.5L20.5 15L20.5 19L19 20.5L5 20.5L3.5 19L3.5 15L5 13.5Z" />
    <path d="M7 7L8 7" />
    <path d="M7 17L8 17" />
  </svg>
</template>
