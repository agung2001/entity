<script setup>
import EntityMark from '@/components/EntityMark.vue'

/**
 * The brand is the animated voxel character — the same one that fronts an
 * entity — but without a mood badge: a logo is a character, not a reaction.
 * `hop` is for the sign-in and setup screens, where the mark is the whole
 * statement rather than a label beside the wordmark.
 */
defineProps({
  hop: { type: Boolean, default: false },
})
</script>

<template>
  <EntityMark class="brand-mark" :hop="hop" />
</template>
