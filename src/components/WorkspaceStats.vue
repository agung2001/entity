<script setup>
import { computed } from 'vue'
import { ago, hub, problemCount } from '@/stores/hub'
import { workspaces } from '@/stores/workspaces'

/**
 * The overview opens on the state of the workspace, not on a chat prompt. The
 * conversation surface lives on /chat; this is the dashboard that answers
 * "what is in here, and is anything wrong?" before a decision is made.
 */
const summaries = computed(() => hub.chat.summaries || [])

const running = computed(() => hub.agents.filter((agent) => agent.status === 'running').length)
const problems = computed(() => problemCount())
const queries = computed(() =>
  summaries.value.reduce((sum, thread) => sum + (thread.queries || 0), 0),
)
const replies = computed(() =>
  summaries.value.reduce((sum, thread) => sum + (thread.replies || 0), 0),
)
const skillsDeclared = computed(() =>
  hub.agents.reduce((sum, agent) => sum + (agent.skills?.length || 0), 0),
)
const localMachines = computed(
  () => workspaces.machines.filter((machine) => machine.thisMachine).length,
)
const remoteMachines = computed(
  () => workspaces.machines.filter((machine) => !machine.thisMachine).length,
)
const lastActivity = computed(() => {
  const newest = summaries.value[0]
  return newest ? ago(newest.updatedAt) : 'never'
})
</script>

<template>
  <section class="stat-grid" aria-label="Workspace statistics">
    <router-link class="stat-card" to="/entities">
      <span class="stat-k">Entities</span>
      <span class="stat-v">{{ hub.agents.length }}</span>
      <span class="stat-m">
        {{ running }} running · {{ problems }} {{ problems === 1 ? 'problem' : 'problems' }}
      </span>
    </router-link>

    <router-link class="stat-card" to="/chat">
      <span class="stat-k">Conversations</span>
      <span class="stat-v">{{ summaries.length }}</span>
      <span class="stat-m">{{ queries }} queries · {{ replies }} responses</span>
    </router-link>

    <router-link class="stat-card" to="/skills">
      <span class="stat-k">Skills</span>
      <span class="stat-v">{{ hub.skills.length }}</span>
      <span class="stat-m">
        {{ skillsDeclared }} {{ skillsDeclared === 1 ? 'declaration' : 'declarations' }} on entities
      </span>
    </router-link>

    <router-link class="stat-card" to="/machines">
      <span class="stat-k">Machines</span>
      <span class="stat-v">{{ workspaces.machines.length }}</span>
      <span class="stat-m">{{ localMachines }} local · {{ remoteMachines }} remote</span>
    </router-link>
  </section>

  <p class="stat-foot">
    Last activity <b>{{ lastActivity }}</b>
    <span aria-hidden="true">·</span>
    <router-link :to="{ name: 'workspace', query: { tab: 'activity' } }">Open the journal</router-link>
  </p>
</template>
