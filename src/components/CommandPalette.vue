<script setup>
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { fleet, loadFleet } from '@/stores/fleet'
import { loadLibrary, openWorkspace, workspaces } from '@/stores/workspaces'
import { matchesQuery } from '@/composables/search'
import { ago, ensureChats, hub, initials, snippet, toast } from '@/stores/hub'

/**
 * Jump-to palette, grouped by the thing being searched.
 *
 * The list is a set of categories, not one flat dump: workspace switching,
 * chat history, entities, skills, machines and activity each get a header and
 * their own page. Every category is capped and has a "Load more" step, so a
 * workspace with hundreds of skills does not paint them all on one keystroke.
 */
const router = useRouter()
const input = ref(null)
const limits = reactive({ navigation: 6, workspace: 3, chat: 4, entity: 4, skill: 4, machine: 4, activity: 4 })

const LIMIT_START = { navigation: 6, workspace: 3, chat: 4, entity: 4, skill: 4, machine: 4, activity: 4 }
const LIMIT_STEP = 8

/** Hosts are read lazily, the first time the palette is opened. */
const hosts = computed(() => (fleet.loaded ? fleet.hosts : workspaces.hosts))

function resetLimits() {
  Object.assign(limits, LIMIT_START)
}

watch(
  () => hub.palette.open,
  async (open) => {
    if (!open) return
    hub.palette.query = ''
    hub.palette.active = 0
    resetLimits()
    await nextTick()
    input.value?.focus()
    /* these are all reads; the palette is where they are first needed */
    ensureChats()
    if (!fleet.loaded) loadFleet()
  },
)

/* the harness libraries are the expensive scan; pay for them only once the
   person starts typing a skill name */
watch(
  () => hub.palette.query,
  (value) => {
    if (value.trim() && !workspaces.library) loadLibrary()
  },
)

const chatLabel = (thread) => thread.title || snippet(thread.preview) || `Thread with ${thread.entity}`

/* Destinations, not just records: the palette is also how someone jumps to
   Account, Manage workspaces, or workspace settings without hunting the rail. */
const navigationItems = computed(() => [
  {
    id: 'nav:overview',
    label: 'Overview',
    meta: 'Workspace dashboard',
    act: () => router.push({ name: 'overview', params: { workspace: hub.workspace } }),
  },
  {
    id: 'nav:workspaces',
    label: 'Workspaces',
    meta: 'Choose a workspace to open',
    act: () => router.push('/workspaces'),
  },
  {
    id: 'nav:workspace',
    label: 'Configurations',
    meta: 'General, members, skills, MCP, machines',
    act: () => router.push({ name: 'workspace', params: { workspace: hub.workspace } }),
  },
  {
    id: 'nav:account',
    label: 'Account settings',
    meta: 'Profile and password',
    act: () => router.push('/account'),
  },
  {
    id: 'nav:account-sound',
    label: 'Sound settings',
    meta: 'Pixel Area 51 cues and volume',
    act: () => router.push('/account/sound'),
  },
  {
    id: 'nav:account-mcp',
    label: 'MCP server',
    meta: 'Status, bearer token and tools',
    act: () => router.push('/account/mcp'),
  },
  {
    id: 'nav:entities',
    label: 'Entities',
    meta: 'Entity directory',
    act: () => {
      hub.rail.entities = true
      hub.rail.artifacts = false
    },
  },
  {
    id: 'nav:artifacts',
    label: 'Artifacts',
    meta: 'Files in this workspace',
    act: () => {
      hub.rail.entities = false
      hub.rail.artifacts = true
    },
  },
  {
    id: 'nav:skills',
    label: 'Skills',
    meta: 'Workspace skills and harness libraries',
    act: () => router.push({ name: 'skills', params: { workspace: hub.workspace } }),
  },
  {
    id: 'nav:mcp',
    label: 'MCP',
    meta: 'Workspace pool and global configs',
    act: () => router.push({ name: 'mcp', params: { workspace: hub.workspace } }),
  },
  {
    id: 'nav:machines',
    label: 'Machines',
    meta: 'Attached machines and the fleet',
    act: () => router.push({ name: 'machines', params: { workspace: hub.workspace } }),
  },
  {
    id: 'nav:activity',
    label: 'Activity',
    meta: 'Journal and harness sessions',
    act: () => router.push({ name: 'workspace', params: { workspace: hub.workspace }, query: { tab: 'activity' } }),
  },
])

const entityItems = computed(() =>
  hub.agents.map((agent) => ({
    id: `entity:${agent.id}`,
    label: agent.name,
    meta: `${agent.harnessLabel} · ${agent.skills.length} skills`,
    act: () => router.push({ name: 'entity', params: { workspace: hub.workspace, name: agent.name } }),
  })),
)

const chatItems = computed(() =>
  hub.chat.summaries.map((thread) => ({
    id: `chat:${thread.id}`,
    label: chatLabel(thread),
    meta: `${thread.entity} · ${ago(thread.updatedAt)}`,
    act: () => router.push({ name: 'chat', params: { workspace: hub.workspace }, query: { thread: thread.id } }),
  })),
)

const workspaceItems = computed(() =>
  workspaces.items.map((workspace) => ({
    id: `workspace:${workspace.id}`,
    label: workspace.label,
    meta: `${workspace.id}${workspace.id === workspaces.active ? ' · current' : ''} · ${workspace.counts?.entities || 0} entities`,
    act: async () => {
      if (workspace.id !== workspaces.active) await openWorkspace(workspace.id)
      hub.rail.entities = false
      hub.rail.artifacts = false
      router.push({ name: 'overview', params: { workspace: workspace.id } })
    },
  })),
)

const skillItems = computed(() => {
  const seen = new Set()
  const rows = []
  for (const skill of workspaces.skills) {
    const key = `${skill.harness || 'workspace'}:${skill.name}`.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({
      id: `skill:${key}`,
      label: skill.name,
      meta: `${skill.harnessLabel || 'workspace'} · attached`,
      act: () => router.push({ name: 'skill', params: { workspace: hub.workspace, name: skill.name } }),
    })
  }
  for (const skill of workspaces.library?.items || []) {
    const key = `${skill.harness || 'harness'}:${skill.name}`.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({
      id: `skill:${key}`,
      label: skill.name,
      meta: `${skill.harnessLabel || skill.harness || 'harness'} · library`,
      act: () =>
        router.push({
          name: 'skill',
          params: { workspace: hub.workspace, name: skill.name },
          query: { harness: skill.harness },
        }),
    })
  }
  return rows
})

const machineItems = computed(() => {
  const seen = new Map()
  for (const machine of workspaces.machines) {
    seen.set(machine.id, {
      id: `machine:${machine.id}`,
      label: machine.label || machine.id,
      meta: `${machine.thisMachine ? 'local' : 'ssh'} · attached`,
      act: () => router.push({ name: 'machine', params: { workspace: hub.workspace, id: machine.id } }),
    })
  }
  for (const host of hosts.value || []) {
    const id = host.alias || host.id
    if (!id || seen.has(id)) continue
    seen.set(id, {
      id: `machine:${id}`,
      label: host.label || host.alias || id,
      meta: `${host.spec || host.hostName || 'ssh'} · fleet`,
      act: () => router.push({ name: 'machine', params: { workspace: hub.workspace, id } }),
    })
  }
  return [...seen.values()]
})

const activityItems = computed(() => [
  {
    id: 'activity:open',
    label: 'Activity',
    meta: 'Journal and harness sessions',
    act: () => router.push({ name: 'workspace', params: { workspace: hub.workspace }, query: { tab: 'activity' } }),
  },
  {
    id: 'activity:journal',
    label: 'Journal',
    meta: 'Conversation history',
    act: () => router.push({ name: 'workspace', params: { workspace: hub.workspace }, query: { tab: 'activity' } }),
  },
  {
    id: 'activity:sessions',
    label: 'Harness sessions',
    meta: 'Session IDs and resume commands',
    act: () => router.push({ name: 'workspace', params: { workspace: hub.workspace }, query: { tab: 'activity' } }),
  },
  ...hub.runs.map((run) => ({
    id: `run:${run.id}`,
    label: `${run.entity || 'Run'} · ${run.status}`,
    meta: `${run.harness || 'harness'} · ${ago(run.startedAt)}`,
    act: () => router.push({ name: 'workspace', params: { workspace: hub.workspace }, query: { tab: 'activity' } }),
  })),
])

const groups = computed(() => {
  const q = hub.palette.query.trim().toLowerCase()
  const make = (id, label, source) => {
    const matched = q
      ? source.filter((item) => matchesQuery(`${item.label} ${item.meta}`, q))
      : source
    const limit = limits[id] || LIMIT_START[id] || 4
    return {
      id,
      label,
      items: matched.slice(0, limit),
      total: matched.length,
      hasMore: matched.length > limit,
    }
  }

  return [
    make('navigation', 'Go to', navigationItems.value),
    make('workspace', 'Workspace', workspaceItems.value),
    make('chat', 'Chat', chatItems.value),
    make('entity', 'Entities', entityItems.value),
    make('skill', 'Skills', skillItems.value),
    make('machine', 'Machines', machineItems.value),
    make('activity', 'Activity', activityItems.value),
  ].filter((group) => group.items.length || (q && group.total))
})

const flat = computed(() => groups.value.flatMap((group) => group.items))

function close() {
  hub.palette.open = false
}

async function run(item) {
  if (!item) return
  close()
  try {
    await item.act()
  } catch (error) {
    toast(error?.message || 'That destination could not be opened.')
  }
}

function more(id) {
  limits[id] = (limits[id] || LIMIT_START[id] || 4) + LIMIT_STEP
}

function onInput(event) {
  hub.palette.query = event.target.value
  hub.palette.active = 0
  resetLimits()
}

function onKey(event) {
  const list = flat.value
  if (!list.length) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const next =
      event.key === 'ArrowDown'
        ? Math.min(list.length - 1, hub.palette.active + 1)
        : Math.max(0, hub.palette.active - 1)
    hub.palette.active = next
  } else if (event.key === 'Enter') {
    event.preventDefault()
    run(list[hub.palette.active])
  }
}
</script>

<template>
  <div
    class="palette"
    :data-open="hub.palette.open ? '1' : '0'"
    role="dialog"
    aria-modal="true"
    aria-label="Command palette"
  >
    <div class="pin">
      <span>›</span>
      <input
        ref="input"
        :value="hub.palette.query"
        placeholder="Search pages, workspaces, chats, entities, skills, machines…"
        autocomplete="off"
        spellcheck="false"
        @input="onInput"
        @keydown="onKey"
      />
      <kbd>esc</kbd>
    </div>
    <div class="plist" role="listbox" aria-label="Results">
      <template v-if="flat.length">
        <div v-for="group in groups" :key="group.id" class="pgroup">
          <div class="pgh">
            <span>{{ group.label }}</span>
            <span class="pn">{{ group.total }}</span>
          </div>
          <div
            v-for="item in group.items"
            :key="item.id"
            class="pitem"
            :data-on="flat.indexOf(item) === hub.palette.active ? '1' : '0'"
            role="option"
            :aria-selected="flat.indexOf(item) === hub.palette.active ? 'true' : 'false'"
            @click="run(item)"
          >
            <span class="sq">{{ initials(item.label) }}</span>
            <span class="pname">{{ item.label }}</span>
            <span class="pmet">{{ item.meta }}</span>
          </div>
          <button v-if="group.hasMore" class="pmore" type="button" @click="more(group.id)">
            Load {{ Math.min(LIMIT_STEP, group.total - group.items.length) }} more
          </button>
        </div>
      </template>
      <div v-else class="pempty">No matches</div>
    </div>
  </div>
</template>
