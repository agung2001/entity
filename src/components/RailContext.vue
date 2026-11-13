<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ArtifactRailPanel from '@/components/ArtifactRailPanel.vue'
import ChatHistoryRail from '@/components/ChatHistoryRail.vue'
import EntityRailPanel from '@/components/EntityRailPanel.vue'
import MachineIcon from '@/components/MachineIcon.vue'
import NavIcon from '@/components/NavIcon.vue'
import { hub } from '@/stores/hub'
import { artifacts } from '@/stores/artifacts'
import { shortcutLabel } from '@/lib/shortcuts'
import { workspaces } from '@/stores/workspaces'

/**
 * The second tier. It belongs to the section in the URL, not to the whole app:
 * Overview lists machines, Entities lists entity files, Artifacts lists the
 * shelf, Chat brings back the working/done history, and Configurations lists
 * the workspace settings tabs.
 */
const route = useRoute()
const router = useRouter()
const newThreadKey = shortcutLabel('new-thread')
const history = ref(null)
const entityPanel = ref(null)
const artifactPanel = ref(null)

const WORKSPACE_TABS = [
  { id: 'general', label: 'General', hint: 'name, id and directory' },
  { id: 'members', label: 'Members', hint: 'who belongs to this scope' },
  { id: 'skills', label: 'Skills', hint: 'attached to the workspace' },
  { id: 'mcp', label: 'MCP', hint: 'servers this scope consumes' },
  { id: 'machines', label: 'Machines', hint: 'local and ssh hosts' },
  { id: 'activity', label: 'Activity', hint: 'recent workspace events' },
]

const ACCOUNT_ROWS = [
  { to: '/account', label: 'Profile', hint: 'identity and password' },
  { to: '/account/sound', label: 'Sound', hint: 'Area 51 feedback' },
  { to: '/account/notifications', label: 'Notifications', hint: 'replies and failures' },
  { to: '/account/mcp', label: 'MCP server', hint: 'agent-facing endpoint' },
]

const section = computed(() => {
  const name = String(route.name || 'overview')
  if (hub.rail.entities) return { id: 'entities', title: 'Entities', count: hub.agents.length }
  if (hub.rail.artifacts) return { id: 'artifacts', title: 'Artifacts', count: artifacts.items.length }
  if (name === 'entity') return { id: 'entities', title: 'Entities', count: hub.agents.length }
  if (name === 'artifact') return { id: 'artifacts', title: 'Artifacts', count: artifacts.items.length }
  if (name === 'chat') return { id: 'chat', title: 'Chats', count: hub.chat.summaries.length }
  if (name === 'machines' || name === 'machine') {
    return { id: 'machines', title: 'Machines', count: hub.machines.length }
  }
  if (name === 'skills' || name === 'skill') {
    return { id: 'skills', title: 'Skills', count: hub.skills.length }
  }
  if (name === 'workspace') {
    return {
      id: 'workspace',
      title: hub.workspaceLabel || hub.workspace || 'Workspace',
      count: null,
      back: true,
    }
  }
  if (name === 'account' || name === 'account-sound' || name === 'account-notifications' || name === 'account-mcp') {
    return { id: 'account', title: 'Account', count: null }
  }
  if (name === 'mcp') {
    return { id: 'mcp', title: 'MCP', count: Object.keys(workspaces.mcp?.servers || {}).length }
  }
  return { id: 'overview', title: 'Overview', count: hub.machines.length }
})

function openWorkspaceTab(tab) {
  router.push({ name: 'workspace', params: { workspace: hub.workspace }, query: tab === 'general' ? {} : { tab } })
}

function newChat() {
  history.value?.newThread()
}

function backToWorkspaces() {
  router.push('/workspaces')
}
</script>

<template>
  <aside class="rail-t2" aria-label="Context">
    <header class="rail-t2-head" :data-chat="section.id === 'chat' ? '1' : '0'">
      <button
        v-if="section.back"
        class="rail-t2-back"
        type="button"
        title="Back to workspaces"
        aria-label="Back to workspaces"
        @click="backToWorkspaces"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M10 3L5 8l5 5" />
        </svg>
      </button>
      <h2>{{ section.title }}</h2>
      <span v-if="section.count !== null" class="rail-t2-count">{{ section.count }}</span>
      <button
        v-if="section.id === 'chat'"
        class="rail-t2-add"
        type="button"
        :title="`New chat (${newThreadKey})`"
        aria-label="New chat"
        data-sfx="spark"
        @click="newChat"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M8 3.2v9.6M3.2 8h9.6" />
        </svg>
      </button>
      <button
        v-else-if="section.id === 'entities'"
        class="rail-t2-add"
        type="button"
        title="Add entity"
        aria-label="Add entity"
        data-sfx="spark"
        @click="entityPanel?.openCreate()"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M8 3.2v9.6M3.2 8h9.6" />
        </svg>
      </button>
      <button
        v-else-if="section.id === 'artifacts'"
        class="rail-t2-add"
        type="button"
        title="Upload artifact"
        aria-label="Upload artifact"
        data-sfx="upload"
        @click="artifactPanel?.pickUpload()"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <path d="M8 10.5V2.6M4.8 5.8L8 2.5l3.2 3.3" />
          <path d="M2.6 10.2v2.4a1 1 0 001 1h8.8a1 1 0 001-1v-2.4" />
        </svg>
      </button>
    </header>

    <div v-if="section.id === 'chat'" class="rail-t2-body rail-t2-body--chat">
      <ChatHistoryRail ref="history" headless />
    </div>

    <div v-else-if="section.id === 'entities'" class="rail-t2-body">
      <EntityRailPanel ref="entityPanel" />
    </div>

    <div v-else-if="section.id === 'artifacts'" class="rail-t2-body">
      <ArtifactRailPanel ref="artifactPanel" />
    </div>

    <div v-else-if="section.id === 'overview' || section.id === 'machines'" class="rail-t2-body">
      <p v-if="!hub.machines.length" class="rail-t2-empty">No machines attached.</p>
      <button
        v-for="machine in hub.machines"
        :key="machine.id"
        class="rail-t2-row"
        type="button"
        :aria-current="route.name === 'machine' && route.params.id === machine.id ? 'page' : undefined"
        @click="router.push({ name: 'machine', params: { workspace: hub.workspace, id: machine.id } })"
      >
        <span class="rail-t2-ic"><MachineIcon :size="14" /></span>
        <span class="t">
          <b>{{ machine.label }}</b>
          <span class="m">{{ machine.desc || machine.id }}</span>
        </span>
        <span class="c" :data-state="machine.state">{{ machine.thisMachine ? 'local' : machine.state }}</span>
      </button>
    </div>

    <div v-else-if="section.id === 'skills'" class="rail-t2-body">
      <p v-if="!hub.skills.length" class="rail-t2-empty">No skills attached to this workspace.</p>
      <button
        v-for="skill in hub.skills"
        :key="skill.name"
        class="rail-t2-row"
        type="button"
        :aria-current="route.name === 'skill' && route.params.name === skill.name ? 'page' : undefined"
        @click="router.push({ name: 'skill', params: { workspace: hub.workspace, name: skill.name } })"
      >
        <span class="rail-t2-ic"><NavIcon name="star" /></span>
        <span class="t">
          <b>{{ skill.name }}</b>
          <span class="m">{{ skill.missing ? 'missing file' : skill.harnessLabel || 'workspace skill' }}</span>
        </span>
      </button>
    </div>

    <div v-else-if="section.id === 'workspace'" class="rail-t2-body">
      <button
        v-for="tab in WORKSPACE_TABS"
        :key="tab.id"
        class="rail-t2-row"
        type="button"
        :aria-current="
          route.name === 'workspace' && String(route.query.tab || 'general') === tab.id
            ? 'page'
            : undefined
        "
        @click="openWorkspaceTab(tab.id)"
      >
        <span class="t">
          <b>{{ tab.label }}</b>
          <span class="m">{{ tab.hint }}</span>
        </span>
      </button>
    </div>

    <div v-else-if="section.id === 'account'" class="rail-t2-body">
      <button
        v-for="row in ACCOUNT_ROWS"
        :key="row.to"
        class="rail-t2-row"
        type="button"
        :aria-current="route.path === row.to ? 'page' : undefined"
        @click="router.push(row.to)"
      >
        <span class="t">
          <b>{{ row.label }}</b>
          <span class="m">{{ row.hint }}</span>
        </span>
      </button>
    </div>

    <div v-else-if="section.id === 'mcp'" class="rail-t2-body">
      <p v-if="!Object.keys(workspaces.mcp?.servers || {}).length" class="rail-t2-empty">
        No MCP servers in this workspace pool.
      </p>
      <button
        v-for="(server, name) in workspaces.mcp?.servers || {}"
        :key="name"
        class="rail-t2-row"
        type="button"
        @click="router.push({ name: 'mcp', params: { workspace: hub.workspace } })"
      >
        <span class="t">
          <b>{{ name }}</b>
          <span class="m">{{ server?.transport || server?.command || 'stdio' }}</span>
        </span>
      </button>
    </div>

  </aside>
</template>
