<script setup>
import { computed } from 'vue'
import { activeWorkspace } from '@/stores/workspaces'

/**
 * The rail card names the workspace in scope and opens the workspace library.
 * Choosing another one happens on that page, where its counts and actions are
 * visible; there is no nested dropdown in the rail.
 */
const current = computed(() => activeWorkspace.value)
</script>

<template>
  <div class="ws">
    <router-link
      class="ws-btn"
      to="/workspaces"
      :aria-label="`Workspace: ${current?.label || 'none'}, open the workspace library`"
    >
      <span class="k">Workspace</span>
      <span class="v">
        <span id="ws-name" class="nm">{{ current?.label || 'no workspace' }}</span>
        <em id="ws-kind">{{ current?.kind || '—' }}</em>
      </span>
    </router-link>
  </div>
</template>
