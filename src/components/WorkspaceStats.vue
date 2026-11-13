<script setup>
import { computed, onMounted } from 'vue'
import { ago, hub, problemCount } from '@/stores/hub'
import { fleet, loadFleet } from '@/stores/fleet'

/**
 * The overview opens on the state of the workspace, not on a chat prompt. The
 * four tiles are the reference dashboard's attention-first order: what exists,
 * where it runs, what has been said, and what needs a look.
 */
const summaries = computed(() => hub.chat.summaries || [])

const running = computed(() => hub.agents.filter((agent) => agent.status === 'running').length)
const problems = computed(() => problemCount())
const problemEntities = computed(
  () => hub.agents.filter((agent) => agent.problems?.length).length,
)
const queries = computed(() =>
  summaries.value.reduce((sum, thread) => sum + (thread.queries || 0), 0),
)
const replies = computed(() =>
  summaries.value.reduce((sum, thread) => sum + (thread.replies || 0), 0),
)
const skillsDeclared = computed(() =>
  hub.agents.reduce((sum, agent) => sum + (agent.skills?.length || 0), 0),
)
onMounted(() => {
  if (!fleet.loaded) loadFleet()
})
const localMachines = computed(() => 1)
const remoteMachines = computed(() => fleet.hosts.length)
const machineCount = computed(() => localMachines.value + remoteMachines.value)
const lastActivity = computed(() => {
  const newest = summaries.value[0]
  return newest ? ago(newest.updatedAt) : 'never'
})

function focusAttention() {
  document.getElementById('ovd-attention')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
</script>

<template>
  <section class="ovd-stats" aria-label="Workspace statistics">
    <button class="ovd-stat" type="button" @click="hub.rail.entities = true">
      <b>{{ hub.agents.length }}</b>
      <span>entities</span>
      <em>{{ running }} running · {{ problems }} {{ problems === 1 ? 'problem' : 'problems' }}</em>
    </button>

    <router-link class="ovd-stat" :to="{ name: 'machines', params: { workspace: hub.workspace } }">
      <b>{{ machineCount }}</b>
      <span>fleet</span>
      <em>{{ localMachines }} local · {{ remoteMachines }} ssh</em>
    </router-link>

    <router-link class="ovd-stat" :to="{ name: 'chat', params: { workspace: hub.workspace } }">
      <b>{{ summaries.length }}</b>
      <span>conversations</span>
      <em>{{ queries }} {{ queries === 1 ? 'query' : 'queries' }} · {{ replies }} {{ replies === 1 ? 'response' : 'responses' }}</em>
    </router-link>

    <button
      class="ovd-stat"
      type="button"
      :data-tone="problems ? 'warn' : 'ok'"
      @click="focusAttention"
    >
      <b>{{ problems }}</b>
      <span>needs a look</span>
      <em>{{ problemEntities ? `${problemEntities} ${problemEntities === 1 ? 'entity' : 'entities'}` : 'all clear' }}</em>
    </button>
  </section>

  <p class="ovd-stat-foot">
    <span>
      <b>{{ hub.skills.length }}</b> skills
      <span aria-hidden="true">·</span>
      <b>{{ skillsDeclared }}</b> declarations
      <span aria-hidden="true">·</span>
      last activity <b>{{ lastActivity }}</b>
    </span>
    <router-link :to="{ name: 'workspace', params: { workspace: hub.workspace }, query: { tab: 'activity' } }">
      Open the journal →
    </router-link>
  </p>
</template>
