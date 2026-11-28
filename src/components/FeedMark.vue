<script setup>
import IntegrationMark from '@/components/IntegrationMark.vue'

/**
 * The mark a feed wears, sized by the `nv-gl` chip it sits in.
 *
 * Two of the three are the app's shipped marks, so this delegates instead of
 * redrawing them: a Google Trends feed is a Google product and wears the same
 * four-colour G the Connectors row draws, and Reddit wears `thesvg.org`'s mono
 * wordmark — one path, `currentColor`. Everything else is an RSS or Atom URL and
 * wears the RSS mark, which is `thesvg.org`'s `rss`/outline with its two masks
 * dropped: they trim the arcs where they meet the dot at 24 px, and at 12 the
 * trim is a pixel nobody can see.
 *
 * The letter that used to sit here said "a feed" and nothing else, next to a
 * label that already said the feed's name.
 */
defineProps({
  family: { type: String, default: '' },
})
</script>

<template>
  <IntegrationMark v-if="family === 'gt'" name="google-trends" />
  <IntegrationMark v-else-if="family === 'rd'" name="reddit" />
  <svg
    v-else
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.2"
    stroke-linecap="round"
    aria-hidden="true"
  >
    <path d="M5 19h.01" />
    <path d="M5 11.5a7.5 7.5 0 0 1 7.5 7.5" />
    <path d="M5 4.5A14.5 14.5 0 0 1 19.5 19" />
  </svg>
</template>
