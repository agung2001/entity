<script setup>
defineProps({ name: { type: String, default: 'pulse' } })
</script>

<template>
  <svg v-if="name === 'grid'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
    <rect x="1.5" y="1.5" width="5.4" height="5.4" rx="1.4" />
    <rect x="9.1" y="1.5" width="5.4" height="5.4" rx="1.4" />
    <rect x="1.5" y="9.1" width="5.4" height="5.4" rx="1.4" />
    <rect x="9.1" y="9.1" width="5.4" height="5.4" rx="1.4" />
  </svg>
  <svg v-else-if="name === 'chat'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
    <rect x="1.6" y="2.4" width="12.8" height="8.8" rx="1.6" />
    <path d="M5.2 11.2v2.7l3.1-2.7" />
  </svg>
  <svg v-else-if="name === 'agent'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
    <circle cx="8" cy="5.4" r="2.9" />
    <path d="M2.6 14c.5-2.6 2.7-4.2 5.4-4.2s4.9 1.6 5.4 4.2" />
  </svg>
  <svg v-else-if="name === 'star'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
    <path d="M8 1.8l1.9 4.1 4.3.5-3.2 3 .9 4.3L8 11.5 4.1 13.7l.9-4.3-3.2-3 4.3-.5z" />
  </svg>
  <svg v-else-if="name === 'mcp'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
    <path d="M4.4 9.2V5.5a1.4 1.4 0 012.8 0v3.4a1.4 1.4 0 002.8 0V5.5a1.4 1.4 0 012.8 0v3.7" />
    <path d="M3.4 9.2h9.2v1.3a4.6 4.6 0 01-9.2 0z" />
    <path d="M8 14.3v.8" />
  </svg>
  <svg v-else-if="name === 'artifact'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
    <path d="M3 2.4h6l4 4v7.2H3z" />
    <path d="M9 2.4v4h4M5.4 9.4h5.2M5.4 11.6h3.4" />
  </svg>
  <svg v-else-if="name === 'screen'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
    <rect x="1.6" y="2.6" width="12.8" height="8.2" rx="1.6" />
    <path d="M5.4 13.6h5.2" />
  </svg>
  <svg v-else viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
    <path d="M2 11.4l3.2-4.5 2.6 2.4L10.6 4l3.4 4.2" />
    <path d="M2 14h12" />
  </svg>
</template>
