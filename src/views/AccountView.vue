<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'

/**
 * Account is a small section with three URLs, not one page with hidden state:
 * /account, /account/sound and /account/mcp. The tabs are links, so Back and a
 * deep link both land on the same panel.
 */
const route = useRoute()
const tabs = [
  { name: 'account', label: 'Profile' },
  { name: 'account-sound', label: 'Sound' },
  { name: 'account-mcp', label: 'MCP' },
]
const active = computed(() => route.name)
</script>

<template>
  <div class="view">
    <div class="page-head">
      <div>
        <p class="eyebrow">Hub · this machine</p>
        <h1>Account</h1>
        <p class="lede">
          Set the handle and email for this hub, or replace the password. Your role decides what
          you can change inside a workspace.
        </p>
      </div>
    </div>

    <nav class="sk-tabs" role="tablist" aria-label="Account sections">
      <RouterLink
        v-for="item in tabs"
        :key="item.name"
        :to="{ name: item.name }"
        role="tab"
        :aria-selected="active === item.name ? 'true' : 'false'"
      >
        {{ item.label }}
      </RouterLink>
    </nav>

    <RouterView />
  </div>
</template>
