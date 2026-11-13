<script setup>
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import EntityActions from '@/components/EntityActions.vue'
import EntityMark from '@/components/EntityMark.vue'
import MachineIcon from '@/components/MachineIcon.vue'
import WorkspaceStats from '@/components/WorkspaceStats.vue'
import {
  ago,
  ensureChats,
  harnessById,
  hub,
  machineById,
  snippet,
} from '@/stores/hub'
import { fleet, loadFleet } from '@/stores/fleet'

const router = useRouter()

onMounted(() => {
  ensureChats()
  if (!fleet.loaded) loadFleet()
})

const runningAgents = computed(() => hub.agents.filter((agent) => agent.status === 'running'))
const runningCount = computed(() => runningAgents.value.length)
const problemRows = computed(() =>
  hub.agents.flatMap((agent) =>
    (agent.problems || []).map((what) => ({ entity: agent, what })),
  ),
)
const problemCount = computed(() => problemRows.value.length)
const machineCount = computed(() => 1 + fleet.hosts.length)
const summaries = computed(() => hub.chat.summaries || [])
const recentThreads = computed(() => summaries.value.slice(0, 5))
const sortedAgents = computed(() => [...hub.agents].sort((a, b) => a.name.localeCompare(b.name)))

const dotState = (status) =>
  ({ running: 'live', idle: 'idle', sleep: 'sleep', error: 'fail' })[status] || 'idle'

const machineLabel = (id) => machineById(id)?.label || id
const machineList = (agent) =>
  agent.machines?.length ? agent.machines.map(machineLabel).join(', ') : 'nowhere'

const lastChat = (name) => {
  const thread = summaries.value.find((item) => item.entity === name)
  return thread ? ago(thread.updatedAt) : 'never'
}

const runningThread = (name) => summaries.value.find((thread) => thread.entity === name) || null

const threadTitle = (thread) => thread.title || snippet(thread.preview) || 'New thread'

function openEntity(entity) {
  router.push({ name: 'entity', params: { workspace: hub.workspace, name: entity.id || entity.name } })
}

function openFromKeyboard(event, entity) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    openEntity(entity)
  }
}

function openChatThread(id) {
  router.push({ name: 'chat', params: { workspace: hub.workspace }, query: { thread: id } })
}

function openChat() {
  router.push({ name: 'chat', params: { workspace: hub.workspace } })
}

function openEntities() {
  hub.rail.entities = true
}
</script>

<template>
  <div class="view ovd-view">
    <header class="ovd-head">
      <div class="ovd-head-copy">
        <p class="eyebrow">Workspace · {{ hub.workspaceLabel || hub.workspace }}</p>
        <h1>Overview</h1>
        <p class="lede">
          {{ hub.agents.length }} {{ hub.agents.length === 1 ? 'entity' : 'entities' }} on
          {{ machineCount }} {{ machineCount === 1 ? 'machine' : 'machines' }},
          {{ runningCount }} running now.
          <template v-if="problemCount">
            {{ problemCount }} {{ problemCount === 1 ? 'problem needs' : 'problems need' }} a look —
            a missing directory, skill or MCP server.
          </template>
          <template v-else> Every entity file resolves.</template>
        </p>
      </div>
      <div class="ovd-head-actions">
        <button class="btn" type="button" data-sfx="nav" @click="openEntities">Entities</button>
        <button
          class="btn btn-ink"
          type="button"
          @click="router.push({ name: 'workspace', params: { workspace: hub.workspace } })"
        >
          Workspace settings
        </button>
      </div>
    </header>

    <WorkspaceStats />

    <section id="ovd-attention" class="ovd-sec">
      <div class="ovd-sec-head">
        <h2>Needs attention</h2>
        <span class="n">{{ problemCount }}</span>
      </div>
      <div v-if="problemRows.length" class="ovd-attn">
        <div v-for="row in problemRows" :key="`${row.entity.id}:${row.what}`" class="ovd-attn-row">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
            <path d="M8 2.4l6 11H2z" />
            <path d="M8 6.6v3.1M8 11.6v.1" />
          </svg>
          <div class="w">
            <b>{{ row.entity.name }}</b>
            <span>{{ row.what }}</span>
          </div>
          <button class="ovd-attn-go" type="button" @click="openEntity(row.entity)">Open entity</button>
        </div>
      </div>
      <p v-else class="ovd-empty">Nothing to fix. Every entity file resolves.</p>
    </section>

    <section class="ovd-sec">
      <div class="ovd-sec-head">
        <h2>Working now</h2>
        <span class="n">{{ runningCount }} of {{ hub.agents.length }}</span>
      </div>
      <div v-if="runningAgents.length" class="ovd-work">
        <article
          v-for="agent in runningAgents"
          :key="agent.id"
          class="ovd-wcard"
          role="button"
          tabindex="0"
          @click="openEntity(agent)"
          @keydown="openFromKeyboard($event, agent)"
        >
          <div class="top">
            <EntityMark mini animate :entity="agent.name" />
            <b>{{ agent.name }}</b>
            <span class="live"><i></i>running</span>
          </div>
          <span class="q">{{ runningThread(agent.name) ? threadTitle(runningThread(agent.name)) : 'No conversation yet' }}</span>
          <span class="m">
            {{ agent.harnessLabel }} · {{ machineList(agent) }}
            <template v-if="runningThread(agent.name)"> · {{ ago(runningThread(agent.name).updatedAt) }}</template>
          </span>
        </article>
      </div>
      <p v-else class="ovd-empty">Nothing is running right now. Open an entity to start a turn.</p>
    </section>

    <section class="ovd-sec">
      <div class="ovd-sec-head">
        <h2>Recent conversations</h2>
        <span class="n">{{ recentThreads.length }} of {{ summaries.length }}</span>
        <button class="r" type="button" @click="openChat">All chat →</button>
      </div>
      <div v-if="recentThreads.length" class="ovd-actlist">
        <div
          v-for="thread in recentThreads"
          :key="thread.id"
          class="ovd-actrow"
          role="button"
          tabindex="0"
          @click="openChatThread(thread.id)"
          @keydown.enter="openChatThread(thread.id)"
          @keydown.space.prevent="openChatThread(thread.id)"
        >
          <time>{{ ago(thread.updatedAt) }}</time>
          <EntityMark mini animate :entity="thread.entity" />
          <span class="q"><b>{{ threadTitle(thread) }}</b></span>
          <span class="where">
            {{ machineLabel(thread.machine) }} · {{ harnessById(thread.harness).label }}
          </span>
        </div>
      </div>
      <div v-else class="ovd-empty">
        No conversations yet. Open an entity and start a chat.
        <button class="empty-link" type="button" @click="openEntities">Go to entities</button>
      </div>
    </section>

    <section class="ovd-sec">
      <div class="ovd-sec-head">
        <h2>Entities</h2>
        <span class="n">{{ hub.agents.length }} {{ hub.agents.length === 1 ? 'file' : 'files' }}</span>
        <button class="r" type="button" @click="openEntities">Open Entities →</button>
      </div>
      <div v-if="sortedAgents.length" class="ovd-roster">
        <div
          v-for="agent in sortedAgents"
          :key="agent.id"
          class="ovd-rrow"
          role="button"
          tabindex="0"
          @click="openEntity(agent)"
          @keydown="openFromKeyboard($event, agent)"
        >
          <EntityMark mini animate :entity="agent.name" />
          <span class="n">
            <b>{{ agent.name }}</b>
            <em>{{ agent.harnessLabel }}<template v-if="agent.model"> · {{ agent.model }}</template></em>
          </span>
          <span class="st" :data-s="dotState(agent.status)"><i></i>{{ agent.status }}</span>
          <span class="mach">
            <template v-if="agent.machines.length">
              <span v-for="machine in agent.machines" :key="machine" class="ovd-chip">
                <MachineIcon :size="9" />{{ machineLabel(machine) }}
              </span>
            </template>
            <span v-else class="ovd-nowhere">nowhere</span>
          </span>
          <span class="sk">{{ agent.skills.length }} skills</span>
          <span class="l">{{ lastChat(agent.name) }}</span>
          <EntityActions :entity="agent" />
        </div>
      </div>
      <p v-else class="ovd-empty">No entities in this workspace yet.</p>
    </section>

    <div class="ovd-foot">
      <span>
        <b>{{ hub.agents.length }}</b> {{ hub.agents.length === 1 ? 'entity' : 'entities' }} ·
        <b>{{ hub.skills.length }}</b> {{ hub.skills.length === 1 ? 'skill' : 'skills' }} ·
        <b>{{ machineCount }}</b> {{ machineCount === 1 ? 'machine' : 'machines' }} ·
        <b>{{ summaries.length }}</b> {{ summaries.length === 1 ? 'conversation' : 'conversations' }}
      </span>
      <span class="r">Sorted by name</span>
    </div>
  </div>
</template>
