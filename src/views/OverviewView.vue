<script setup>
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import EntityActions from '@/components/EntityActions.vue'
import EntityMark from '@/components/EntityMark.vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import MachineIcon from '@/components/MachineIcon.vue'
import WorkspaceStats from '@/components/WorkspaceStats.vue'
import {
  ago,
  ensureChats,
  harnessById,
  hub,
  machineById,
  problemCount,
  snippet,
} from '@/stores/hub'
import { workspaces } from '@/stores/workspaces'

const router = useRouter()

onMounted(() => {
  ensureChats()
})

const running = computed(() => hub.agents.filter((a) => a.status === 'running').length)
const problems = computed(() => problemCount())
const machineCount = computed(() => workspaces.machines.length)

const dotState = (status) =>
  ({ running: 'live', idle: 'idle', sleep: 'sleep', error: 'fail' })[status] || 'idle'

const recentThreads = computed(() => (hub.chat.summaries || []).slice(0, 15))

const machineLabel = (id) => machineById(id)?.label || id

const lastChat = (name) => {
  const thread = hub.chat.summaries.find((item) => item.entity === name)
  return thread ? ago(thread.updatedAt) : 'never'
}

function openChatThread(id) {
  router.push({ name: 'chat', query: { thread: id } })
}

function openFromKeyboard(e, id) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    router.push({ name: 'entity', params: { name: id } })
  }
}
</script>

<template>
  <div class="view">
    <div class="page-head">
      <div>
        <p class="eyebrow">Workspace · {{ hub.workspaceLabel || hub.workspace }}</p>
        <h1>Overview</h1>
        <p class="lede">
          {{ hub.agents.length }} {{ hub.agents.length === 1 ? 'entity' : 'entities' }} on
          {{ machineCount }} {{ machineCount === 1 ? 'machine' : 'machines' }},
          {{ running }} running now.
          <template v-if="problems">
            {{ problems }} {{ problems === 1 ? 'problem needs' : 'problems need' }} a look —
            a missing directory, skill or MCP server.
          </template>
          <template v-else> Every entity file resolves.</template>
        </p>
      </div>
      <div class="head-actions">
        <button class="btn" @click="hub.rail.entities = true">Entities</button>
        <button class="btn btn-ink" @click="router.push('/workspace')">Workspace settings</button>
      </div>
    </div>

    <WorkspaceStats />

    <div class="sec-head">
      <h2>Entities</h2>
      <span class="meta">sorted by name · {{ hub.agents.length }} files</span>
    </div>
    <div class="tbl">
      <div class="tr th">
        <span>Entity</span><span>State</span><span class="col-machines">Machines</span>
        <span class="col-skills">Skills</span><span class="col-last">Last chat</span>
        <span class="col-actions">Actions</span>
      </div>
      <div
        v-for="a in hub.agents"
        :key="a.id"
        class="tr"
        tabindex="0"
        role="button"
        @click="router.push({ name: 'entity', params: { name: a.id } })"
        @keydown="openFromKeyboard($event, a.id)"
      >
        <span class="cell-agent">
          <EntityMark :entity="a.name" />
          <span>
            <span class="nm2">
              {{ a.name }}
              <em v-if="a.problems.length" class="row-warn" :title="a.problems.join('\n')">
                {{ a.problems.length }}
              </em>
            </span>
            <span class="sub2">{{ a.harnessLabel }}<template v-if="a.model"> · {{ a.model }}</template></span>
          </span>
        </span>
        <span class="col-state">
          <span class="state" :data-s="dotState(a.status)"><i></i>{{ a.status }}</span>
        </span>
        <span class="col-machines">
          <span class="chipm chipm--harness">
            <HarnessIcon :name="a.harness" :size="10" />{{ a.harnessLabel }}
          </span>
          <template v-if="a.machines.length">
            <span v-for="m in a.machines" :key="m" class="chipm">
              <MachineIcon :size="10" />{{ machineLabel(m) }}
            </span>
          </template>
          <span v-else class="unplaced">nowhere</span>
        </span>
        <span class="num col-skills">{{ a.skills.length }}</span>
        <span class="last col-last">{{ lastChat(a.name) }}</span>
        <EntityActions :entity="a" />
      </div>
      <div
        v-if="!hub.agents.length"
        class="tr"
        style="grid-column: 1 / -1; cursor: default; color: var(--muted); font-size: 12.5px"
      >
        No entities in this workspace yet.
      </div>
    </div>

    <div class="log">
      <div class="sec-head">
        <h2>Conversations</h2>
        <span class="meta">
          newest first ·
          <router-link to="/chat">{{ recentThreads.length ? 'all threads' : 'open chat' }}</router-link>
        </span>
      </div>
      <ol>
        <li
          v-for="t in recentThreads"
          :key="t.id"
          class="log-row"
          tabindex="0"
          role="button"
          @click="openChatThread(t.id)"
          @keydown.enter="openChatThread(t.id)"
          @keydown.space.prevent="openChatThread(t.id)"
        >
          <time>{{ ago(t.updatedAt) }}</time>
          <span class="who"><EntityMark mini :entity="t.entity" />{{ t.entity }}</span>
          <span class="what"><b>{{ t.title || snippet(t.preview) || 'New thread' }}</b></span>
          <span class="where">
            <MachineIcon :size="10" />{{ machineLabel(t.machine) }}
            <span aria-hidden="true">·</span>
            <HarnessIcon :name="t.harness" :size="10" />{{ harnessById(t.harness).label }}
          </span>
        </li>
        <li v-if="!recentThreads.length" class="log-empty">
          No conversations yet. Open an entity and start a chat.
          <button class="empty-link" type="button" @click="hub.rail.entities = true">Go to entities</button>
        </li>
      </ol>
    </div>
  </div>
</template>
