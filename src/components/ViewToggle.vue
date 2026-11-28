<script setup>
/**
 * The one grid/list toggle: Workspaces and News draw the same two buttons, so
 * they share one component. The two glyphs are the workspaces sheet's own
 * 16-unit paths, moved here verbatim — they are the app's drawing of a grid and
 * a list, not a new icon set.
 *
 * `aria-pressed`, never `disabled`, and both buttons stay in the tab order: the
 * pressed one says which drawing is on, it does not remove the other.
 */
defineProps({
  view: { type: String, default: 'grid' },
  /* Passed through as `aria-disabled`: a control that has nothing to change yet
     still has to be reachable by the keyboard that reaches it. */
  ariaDisabled: { type: Boolean, default: false },
})
defineEmits(['update:view'])
</script>

<template>
  <div class="seg-toggle" role="group" aria-label="View">
    <button
      type="button"
      :aria-pressed="view === 'grid' ? 'true' : 'false'"
      :aria-disabled="ariaDisabled ? 'true' : undefined"
      aria-label="Grid view"
      title="Grid"
      @click="$emit('update:view', 'grid')"
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></svg>
    </button>
    <button
      type="button"
      :aria-pressed="view === 'list' ? 'true' : 'false'"
      :aria-disabled="ariaDisabled ? 'true' : undefined"
      aria-label="List view"
      title="List"
      @click="$emit('update:view', 'list')"
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 3.4h12M2 8h12M2 12.6h12" /></svg>
    </button>
  </div>
</template>
