<script setup>
/**
 * The Goals sub-nav — three pages of one destination (§2.1).
 *
 * Backlog and Calendar are pages, not tabs, so the rail keeps one cell and this
 * strip is the second tier the shell does not draw for us. `aria-current` sits
 * on the one page you are on; a goal page keeps `Goals` current, because the
 * goal you opened is a page *inside* that tab.
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { goals, openGoalCount } from '@/stores/goals'

const route = useRoute()

const workspace = computed(() => String(route.params.workspace || ''))
const at = computed(() => String(route.name || ''))
const link = (name) => ({ name, params: { workspace: workspace.value } })
const inGoals = computed(() => ['goals', 'goal', 'goal-new'].includes(at.value))
</script>

<template>
  <nav class="subnav" aria-label="Goals pages">
    <router-link :to="link('goals')" :aria-current="inGoals ? 'page' : undefined">
      Goals<span class="n">{{ goals.loaded ? openGoalCount() : '—' }}</span>
    </router-link>
    <router-link :to="link('goals-backlog')" :aria-current="at === 'goals-backlog' ? 'page' : undefined">
      Backlog
    </router-link>
    <router-link :to="link('goals-calendar')" :aria-current="at === 'goals-calendar' ? 'page' : undefined">
      Calendar
    </router-link>
  </nav>
</template>
