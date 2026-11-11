<script setup>
/**
 * The hairline bar above every hub view. `crumbs` is for nested pages (the
 * skill detail), `crumb` for the flat ones.
 */
defineProps({
  crumb: { type: String, default: '' },
  crumbs: { type: Array, default: null },
})
</script>

<template>
  <div class="topbar">
    <div class="crumbs">
      <template v-if="crumbs && crumbs.length">
        <template v-for="(c, i) in crumbs" :key="c.label + i">
          <router-link v-if="c.to" :to="c.to">{{ c.label }}</router-link>
          <b v-else class="now">{{ c.label }}</b>
          <span v-if="i < crumbs.length - 1" class="sep" aria-hidden="true">/</span>
        </template>
      </template>
      <template v-else>
        entity <span class="sep" aria-hidden="true">/</span>
        <b class="now">{{ crumb }}</b>
      </template>
    </div>
    <div class="tools">
      <slot />
    </div>
  </div>
</template>
