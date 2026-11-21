<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ArtifactRailPanel from '@/components/ArtifactRailPanel.vue'
import ChatHistoryRail from '@/components/ChatHistoryRail.vue'
import EntityRailPanel from '@/components/EntityRailPanel.vue'
import MachineIcon from '@/components/MachineIcon.vue'
import NavIcon from '@/components/NavIcon.vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import { activeSummaryCount, hub } from '@/stores/hub'
import { fleet, loadFleet } from '@/stores/fleet'
import { artifacts } from '@/stores/artifacts'
import { shortcutLabel } from '@/lib/shortcuts'
import { useDialogDismiss } from '@/composables/useDialog'
import { call } from '@/composables/localBridge'
import { matchesQuery } from '@/composables/search'
import { commandLine, definitionOf, poolEntries, transportOf } from '@/lib/mcp'
import { workspaces } from '@/stores/workspaces'

/**
 * The second tier. It belongs to the section in the URL, not to the whole app:
 * Overview lists the machines, Entities lists entity files, Artifacts lists the
 * shelf, Chat brings back the working/done history, and Configurations lists
 * the workspace settings tabs.
 */
const route = useRoute()
const router = useRouter()

onMounted(loadFleet)
const newThreadKey = shortcutLabel('new-thread')
const history = ref(null)
const entityPanel = ref(null)
const artifactPanel = ref(null)

const WORKSPACE_TABS = [
  { id: 'general', label: 'General', hint: 'name, id and directory' },
  { id: 'members', label: 'Members', hint: 'who belongs to this scope' },
  { id: 'skills', label: 'Skills', hint: 'attached to the workspace' },
  { id: 'connectors', label: 'Connectors', hint: 'services, with the scope of each' },
  { id: 'mcp', label: 'MCP', hint: 'servers this scope consumes' },
  { id: 'machines', label: 'Machines', hint: 'this machine and its ssh hosts' },
  { id: 'chats', label: 'Chats', hint: 'silence, archiving and removal' },
  { id: 'artifacts', label: 'Artifacts', hint: 'shelf age, archiving and removal' },
  { id: 'activity', label: 'Activity', hint: 'recent workspace events' },
]

const ACCOUNT_ROWS = [
  { to: '/account', label: 'Profile', hint: 'identity and password' },
  { to: '/account/sound', label: 'Sound', hint: 'Area 51 feedback' },
  { to: '/account/notifications', label: 'Notifications', hint: 'replies and failures' },
  { to: '/account/mcp', label: 'MCP server', hint: 'agent-facing endpoint' },
  /* Account → Integrations and the workspace's MCP inventory are one page now, in
     the workspace that owns their definitions. The old addresses redirect there,
     so this row is a shortcut, not a second surface. */
  { to: '/account/integrations', label: 'Connectors', hint: 'services this workspace can reach' },
  { to: '/account/harnesses', label: 'Harnesses', hint: 'enable and disable agent CLIs' },
  { to: '/account/backups', label: 'Backups', hint: 'workspace snapshots' },
  { to: '/account/updates', label: 'Updates', hint: 'version and releases' },
]

const railHosts = computed(() => {
  const seen = new Set()
  const local = {
    id: 'local',
    label: String(fleet.hostname || 'local').replace(/\.local$/i, ''),
    desc: `${fleet.platform || 'local'} · this machine`,
    thisMachine: true,
    state: 'online',
  }
  return [local, ...fleet.hosts].filter((host) => {
    const id = host.alias || host.id
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })
})

const section = computed(() => {
  const name = String(route.name || 'overview')
  if (hub.rail.entities) return { id: 'entities', title: 'Entities', count: hub.agents.length }
  if (hub.rail.artifacts) return { id: 'artifacts', title: 'Artifacts', count: artifacts.items.length }
  if (name === 'entity') return { id: 'entities', title: 'Entities', count: hub.agents.length }
  if (name === 'artifact') return { id: 'artifacts', title: 'Artifacts', count: artifacts.items.length }
  /* The working list only: the header must never disagree with the rows above
     the Archived divider. */
  if (name === 'chat') return { id: 'chat', title: 'Chats', count: activeSummaryCount() }
  /* Machines is a sub-page of the workspace, so it carries the same way back
     the settings page does; the host detail goes one step further up, to the
     list it came from. */
  if (name === 'machines') {
    return { id: 'machines', title: 'Machines', count: railHosts.value.length, back: 'workspace' }
  }
  if (name === 'machine') {
    return { id: 'machines', title: 'Machines', count: railHosts.value.length, back: 'machines' }
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
  if (
    name === 'account' ||
    name === 'account-sound' ||
    name === 'account-notifications' ||
    name === 'account-mcp' ||
    name === 'account-harnesses' ||
    name === 'account-integrations' ||
    name === 'account-backups' ||
    name === 'account-updates'
  ) {
    return { id: 'account', title: 'Account', count: null }
  }
  /* The server page is the same list with one row current: the panel must not
     lose the inventory when the address gains a name. */
  if (name === 'mcp' || name === 'mcp-server') {
    /* One section, two scopes: the head counts what the rows count. */
    return {
      id: 'mcp',
      title: 'MCP',
      count: mcpScope.value === 'harness' ? mcpGlobals.count : mcpPool.value.length,
    }
  }
  return { id: 'overview', title: 'Overview', count: hub.machines.length }
})

/* The workspace pool and the harness configs on this machine are two scopes of
   the same list — the switch `McpView` already has, sized for the panel. */
const mcpScope = ref('workspace')
const mcpQuery = ref('')
const mcpHarness = ref('all')
const mcpGlobals = reactive({ loading: false, loaded: false, error: '', groups: [], count: 0 })

/* ponytail: the chips are the groups `mcp.globals` returned, so a harness whose
   config declares nothing (Codex today) has no chip at all. Giving it one means
   the main process returning empty groups too — one change in mcp-store.cjs,
   none here. */

/* Parked servers stay in the list: a disabled definition that vanishes reads as
   a broken sync, and it is exactly the row that needs opening. */
const mcpPool = computed(() =>
  poolEntries(workspaces.mcp).map((entry) => {
    const definition = definitionOf(entry.definition)
    return {
      ...entry,
      definition,
      transport: transportOf(definition),
      command: commandLine(definition),
      /* Which harness configs also declare this name: the drift signal, read
         from the scan below rather than a second call. */
      declaredBy: mcpGlobals.groups
        .filter((group) => (group.servers || []).some((server) => server.name === entry.name))
        .map((group) => group.harness)
        .join(', '),
    }
  }),
)
const currentServer = computed(() =>
  route.name === 'mcp-server' ? String(route.params.name || '') : '',
)

const mcpWorkspaceRows = computed(() =>
  mcpPool.value.filter((entry) =>
    matchesQuery(`${entry.name} ${entry.command} ${entry.declaredBy}`, mcpQuery.value),
  ),
)

const mcpHarnessRows = computed(() =>
  mcpGlobals.groups
    .filter((group) => mcpHarness.value === 'all' || group.harness === mcpHarness.value)
    .flatMap((group) =>
      (group.servers || []).map((server) => {
        const definition = definitionOf(server)
        return {
          name: String(server.name || ''),
          harness: group.harness,
          harnessLabel: group.label || group.harness,
          command: commandLine(definition),
          attached: Boolean(
            workspaces.mcp?.servers?.[server.name] || workspaces.mcp?.disabled?.[server.name],
          ),
        }
      }),
    )
    .filter((row) =>
      matchesQuery(`${row.name} ${row.command} ${row.harnessLabel}`, mcpQuery.value),
    ),
)

const mcpRows = computed(() =>
  mcpScope.value === 'workspace' ? mcpWorkspaceRows.value : mcpHarnessRows.value,
)
const mcpTotal = computed(() =>
  mcpScope.value === 'harness' ? mcpGlobals.count : mcpPool.value.length,
)
const mcpEmpty = computed(() => {
  const query = mcpQuery.value.trim()
  if (query) return `No server matches "${query}".`
  if (mcpScope.value === 'harness') {
    return mcpGlobals.loading && !mcpGlobals.groups.length
      ? 'Reading harness configs…'
      : 'No harness declarations here.'
  }
  return 'No MCP servers attached to this workspace.'
})

/* The query survives a scope switch: comparing the same server across both
   lists is the reason the switch exists. The harness chip resets. */
function setMcpScope(next) {
  mcpScope.value = next
  mcpHarness.value = 'all'
}

async function loadMcpGlobals(force = false) {
  if (!force && (mcpGlobals.loading || mcpGlobals.loaded)) return
  mcpGlobals.loading = true
  mcpGlobals.error = ''
  try {
    const data = await call('mcp.globals')
    mcpGlobals.groups = data?.groups || []
    mcpGlobals.count = data?.count || 0
    mcpGlobals.loaded = true
  } catch {
    /* The pool is the page; a machine-wide read that fails must not take it
       down. `Try again` refetches. */
    mcpGlobals.error = 'Could not read harness configs.'
    mcpGlobals.groups = []
    mcpGlobals.count = 0
    mcpGlobals.loaded = false
  } finally {
    mcpGlobals.loading = false
  }
}

/* One scan for the session, paid for only while the MCP section is on screen. */
watch(
  () => section.value.id,
  (id) => {
    if (id === 'mcp') loadMcpGlobals().catch(() => {})
  },
  { immediate: true },
)

/* Escape empties the filter before it closes the rail: the query is the
   narrowest thing on screen, so it goes first. */
useDialogDismiss({
  active: () => section.value.id === 'mcp' && Boolean(mcpQuery.value),
  close: () => {
    mcpQuery.value = ''
  },
})

function openWorkspaceTab(tab) {
  router.push({ name: 'workspace', params: { workspace: hub.workspace }, query: tab === 'general' ? {} : { tab } })
}

function newChat() {
  history.value?.newThread()
}

function goBack() {
  const to = section.value.back
  if (to === 'machines') {
    router.push({ name: 'machines', params: { workspace: hub.workspace } })
    return
  }
  if (to === 'workspace') {
    router.push({ name: 'workspace', params: { workspace: hub.workspace } })
    return
  }
  /* Leaving the workspace entirely: back to the picker. */
  router.push('/workspaces')
}

const backLabel = computed(() => {
  if (section.value.back === 'machines') return 'Back to machines'
  if (section.value.back === 'workspace') return 'Back to workspace settings'
  return 'Back to workspaces'
})
</script>

<template>
  <aside class="rail-t2" aria-label="Context">
    <header class="rail-t2-head" :data-chat="section.id === 'chat' ? '1' : '0'">
      <button
        v-if="section.back"
        class="rail-t2-back"
        type="button"
        :title="backLabel"
        :aria-label="backLabel"
        @click="goBack"
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
      <button
        v-for="machine in railHosts"
        :key="machine.alias || machine.id"
        class="rail-t2-row"
        type="button"
        :aria-current="route.name === 'machine' && route.params.id === (machine.alias || machine.id) ? 'page' : undefined"
        @click="router.push({ name: 'machine', params: { workspace: hub.workspace, id: machine.alias || machine.id } })"
      >
        <span class="rail-t2-ic"><MachineIcon :size="14" /></span>
        <span class="t">
          <b>{{ machine.label }}</b>
          <span class="m">{{ machine.desc || machine.id }}</span>
        </span>
        <span class="c" :data-state="machine.state">{{ machine.thisMachine ? 'local' : 'ssh' }}</span>
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

    <div v-else-if="section.id === 'mcp'" class="rail-t2-body rail-t2-body--mcp">
      <div class="rail-t2-tools">
        <label class="rail-search">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <circle cx="7" cy="7" r="4.6" />
            <path d="M10.4 10.4L14 14" />
          </svg>
          <input
            v-model="mcpQuery"
            type="search"
            placeholder="Search servers…"
            aria-label="Search MCP servers"
            autocomplete="off"
          />
          <span class="rail-t2-q">{{ mcpRows.length }}/{{ mcpTotal }}</span>
        </label>
        <div class="rail-t2-seg" role="group" aria-label="MCP scope">
          <button
            type="button"
            :aria-pressed="mcpScope === 'workspace' ? 'true' : 'false'"
            @click="setMcpScope('workspace')"
          >Workspace <span>{{ mcpPool.length }}</span></button>
          <button
            type="button"
            :aria-pressed="mcpScope === 'harness' ? 'true' : 'false'"
            @click="setMcpScope('harness')"
          >Harness <span>{{ mcpGlobals.count }}</span></button>
        </div>
        <div
          v-if="mcpScope === 'harness'"
          class="rail-t2-chips"
          role="group"
          aria-label="Harness filter"
        >
          <button
            type="button"
            :aria-pressed="mcpHarness === 'all' ? 'true' : 'false'"
            @click="mcpHarness = 'all'"
          >All <span>{{ mcpGlobals.count }}</span></button>
          <button
            v-for="group in mcpGlobals.groups"
            :key="group.harness"
            type="button"
            :aria-pressed="mcpHarness === group.harness ? 'true' : 'false'"
            @click="mcpHarness = group.harness"
          >
            <HarnessIcon :name="group.harness" :size="11" />
            {{ group.label }} <span>{{ group.servers?.length || 0 }}</span>
          </button>
        </div>
        <p v-if="mcpGlobals.error" class="rail-t2-empty" role="alert">
          {{ mcpGlobals.error }}
          <button class="rail-t2-link" type="button" @click="loadMcpGlobals(true)">Try again</button>
        </p>
      </div>

      <div class="rail-t2-list">
        <p v-if="!mcpRows.length" class="rail-t2-empty">
          {{ mcpEmpty }}
          <button v-if="mcpQuery.trim()" class="rail-t2-link" type="button" @click="mcpQuery = ''">
            Clear search
          </button>
        </p>
        <template v-else-if="mcpScope === 'workspace'">
          <router-link
            v-for="entry in mcpWorkspaceRows"
            :key="entry.name"
            class="rail-t2-row"
            :to="{ name: 'mcp-server', params: { workspace: hub.workspace, name: entry.name } }"
            :aria-current="currentServer === entry.name ? 'page' : undefined"
          >
            <span class="rail-t2-ic">
              <svg
                v-if="entry.transport === 'http'"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M3 12h18M12 3c2.6 2.5 4 5.6 4 9s-1.4 6.5-4 9c-2.6-2.5-4-5.6-4-9s1.4-6.5 4-9z" />
              </svg>
              <svg
                v-else
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                aria-hidden="true"
              >
                <rect x="3" y="4" width="18" height="6" rx="1.6" />
                <rect x="3" y="14" width="18" height="6" rx="1.6" />
                <path d="M7 7h.01M7 17h.01" stroke-linecap="round" />
              </svg>
            </span>
            <span class="t">
              <b>{{ entry.name }}</b>
              <span class="m">{{ entry.transport }}</span>
            </span>
            <span v-if="!entry.enabled" class="c">parked</span>
            <span
              v-else-if="entry.declaredBy"
              class="c"
              data-drift="1"
              :title="`Also declared by ${entry.declaredBy}`"
            >{{ entry.declaredBy }}</span>
            <span v-else class="c">—</span>
          </router-link>
        </template>
        <template v-else>
          <router-link
            v-for="row in mcpHarnessRows"
            :key="`${row.harness}:${row.name}`"
            class="rail-t2-row"
            :to="{ name: 'mcp-server', params: { workspace: hub.workspace, name: row.name } }"
            :aria-current="currentServer === row.name ? 'page' : undefined"
          >
            <span class="rail-t2-ic"><HarnessIcon :name="row.harness" :size="14" /></span>
            <span class="t">
              <b>{{ row.name }}</b>
              <span class="m">{{ row.command }}</span>
            </span>
            <span class="c">{{ row.attached ? 'in pool' : 'attach' }}</span>
          </router-link>
        </template>
      </div>
    </div>

  </aside>
</template>
