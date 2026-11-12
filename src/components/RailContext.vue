<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ChatHistoryRail from '@/components/ChatHistoryRail.vue'
import EntityMark from '@/components/EntityMark.vue'
import MachineIcon from '@/components/MachineIcon.vue'
import NavIcon from '@/components/NavIcon.vue'
import { ago, hub, openWizard, toast } from '@/stores/hub'
import { artifacts } from '@/stores/artifacts'
import {
  exportWorkspace,
  importWorkspace,
  openWorkspace,
  removeWorkspace,
  workspaces,
} from '@/stores/workspaces'

/**
 * The second tier. It belongs to the section in the URL, not to the whole app:
 * Overview lists machines, Entities lists entity files, Artifacts lists the
 * shelf, and Chat brings back the working/done history. The Workspaces panel
 * is the one list opened from the icon strip; choosing a row goes straight to
 * that workspace's settings.
 */
const route = useRoute()
const router = useRouter()
const history = ref(null)

const WORKSPACE_GROUPS = [
  {
    id: 'overview',
    label: 'Overview',
    tabs: [{ id: 'overview', label: 'Overview', hint: 'workspace dashboard', to: '/' }],
  },
  {
    id: 'configurations',
    label: 'Configurations',
    tabs: [
      { id: 'general', label: 'General', hint: 'name, id and directory' },
      { id: 'members', label: 'Members', hint: 'who belongs to this scope' },
      { id: 'skills', label: 'Skills', hint: 'attached to the workspace' },
      { id: 'mcp', label: 'MCP', hint: 'servers this scope consumes' },
      { id: 'machines', label: 'Machines', hint: 'local and ssh hosts' },
      { id: 'activity', label: 'Activity', hint: 'recent workspace events' },
    ],
  },
]

const ACCOUNT_ROWS = [
  { to: '/account', label: 'Profile', hint: 'identity and password' },
  { to: '/account/sound', label: 'Sound', hint: 'Area 51 feedback' },
  { to: '/account/mcp', label: 'MCP server', hint: 'agent-facing endpoint' },
]

const section = computed(() => {
  if (hub.rail.workspaces) {
    return { id: 'workspaces', title: 'Workspaces', count: workspaces.items.length, back: false }
  }
  const name = String(route.name || 'overview')
  if (name === 'chat') return { id: 'chat', title: 'Chats', count: hub.chat.summaries.length }
  if (name === 'entities' || name === 'entity') {
    return { id: 'entities', title: 'Entities', count: hub.agents.length }
  }
  if (name === 'artifacts') return { id: 'artifacts', title: 'Artifacts', count: artifacts.items.length }
  if (name === 'machines' || name === 'machine') {
    return { id: 'machines', title: 'Machines', count: hub.machines.length }
  }
  if (name === 'skills' || name === 'skill') {
    return { id: 'skills', title: 'Skills', count: hub.skills.length }
  }
  if (name === 'workspace' || (hub.rail.workspace && name === 'overview')) {
    return {
      id: 'workspace',
      title: hub.workspaceLabel || hub.workspace || 'Workspace',
      count: null,
      back: true,
    }
  }
  if (name === 'account' || name === 'account-sound' || name === 'account-mcp') {
    return { id: 'account', title: 'Account', count: null }
  }
  if (name === 'mcp') {
    return { id: 'mcp', title: 'MCP', count: Object.keys(workspaces.mcp?.servers || {}).length }
  }
  return { id: 'overview', title: 'Overview', count: hub.machines.length }
})

const threadCount = (name) =>
  hub.chat.summaries.filter((thread) => thread.entity === name).length

function sizeLabel(bytes) {
  if (!Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`
}

function openArtifact(item) {
  router.push({ name: 'artifacts', query: { file: item.id } })
}

function openWorkspaceTab(tab) {
  router.push({ name: 'workspace', query: tab === 'general' ? {} : { tab } })
}

function openWorkspaceMenu(tab) {
  if (tab.to) {
    hub.rail.workspace = true
    router.push(tab.to)
  } else {
    openWorkspaceTab(tab.id)
  }
}

function newChat() {
  history.value?.newThread()
}

/* ── Workspaces panel ─────────────────────────────────────────────────── */
const importing = ref(false)
const importInput = ref(null)
const wsBusy = ref('')
const wsConfirming = ref('')
const wsMenu = ref(null)
const wsMenuEl = ref(null)
const wsMenuPos = ref({ top: '0px', left: '0px' })

function backToWorkspaces() {
  wsMenu.value = null
  hub.rail.workspaces = true
}

function newWorkspace() {
  openWizard()
}

function pickImport() {
  if (importing.value) return
  importInput.value?.click()
}

async function importFile(event) {
  const file = event.target?.files?.[0]
  event.target.value = ''
  if (!file || importing.value) return
  importing.value = true
  try {
    const text = await file.text()
    let bundle
    try {
      bundle = JSON.parse(text)
    } catch {
      throw new Error('That file is not valid JSON.')
    }
    const result = await importWorkspace(bundle)
    const skipped = result?.skipped?.length || 0
    const label = result?.record?.label || 'Workspace'
    toast(
      skipped
        ? `${label} imported · ${skipped} item${skipped === 1 ? '' : 's'} skipped`
        : `${label} imported`,
    )
  } catch (error) {
    toast(error?.message || 'The workspace could not be imported.')
  } finally {
    importing.value = false
  }
}

async function openSettings(record) {
  if (wsBusy.value) return
  wsMenu.value = null
  wsBusy.value = `open:${record.id}`
  try {
    if (record.id !== workspaces.active) await openWorkspace(record.id)
    hub.rail.workspaces = false
    hub.rail.workspace = true
    router.push({ name: 'workspace', query: {} })
  } catch (error) {
    toast(error?.message || 'That workspace could not be opened.')
  } finally {
    wsBusy.value = ''
  }
}

function download(name, text) {
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function exportOne(record) {
  if (wsBusy.value) return
  wsBusy.value = `export:${record.id}`
  try {
    const bundle = await exportWorkspace(record.id)
    download(`entity-workspace-${record.id}.json`, `${JSON.stringify(bundle, null, 2)}\n`)
    toast(`${record.label} exported`)
  } catch (error) {
    toast(error?.message || 'The workspace could not be exported.')
  } finally {
    wsBusy.value = ''
  }
}

async function deleteOne(record) {
  if (wsBusy.value) return
  wsBusy.value = `delete:${record.id}`
  try {
    await removeWorkspace(record.id)
    toast(`${record.label} deleted`)
    if (!workspaces.items.length) router.push('/setup')
  } catch (error) {
    toast(error?.message || 'The workspace could not be deleted.')
  } finally {
    wsBusy.value = ''
  }
}

function openWsMenu(event, record) {
  event?.stopPropagation?.()
  if (wsMenu.value?.id === record.id) {
    wsMenu.value = null
    return
  }
  const rect = event.currentTarget.getBoundingClientRect()
  const width = 170
  const height = 90
  const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8)
  let top = rect.bottom + 5
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 5)
  wsMenuPos.value = { top: `${top}px`, left: `${left}px` }
  wsMenu.value = record
  nextTick(() => wsMenuEl.value?.querySelector('button')?.focus())
}

function menuExport() {
  const record = wsMenu.value
  wsMenu.value = null
  if (record) exportOne(record)
}

function menuDelete() {
  const record = wsMenu.value
  if (!record) return
  if (wsConfirming.value !== record.id) {
    wsConfirming.value = record.id
    setTimeout(() => {
      if (wsConfirming.value === record.id) wsConfirming.value = ''
    }, 2600)
    return
  }
  wsConfirming.value = ''
  wsMenu.value = null
  deleteOne(record)
}

function onDocumentClick(event) {
  if (!wsMenu.value) return
  const target = event.target
  if (target instanceof Element && target.closest('.rchat-menu-pop, .rail-ws-dots')) return
  wsMenu.value = null
}

onMounted(() => document.addEventListener('click', onDocumentClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocumentClick))
</script>

<template>
  <aside class="rail-t2" aria-label="Context">
    <header class="rail-t2-head">
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
        title="New chat"
        aria-label="New chat"
        @click="newChat"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M8 3.2v9.6M3.2 8h9.6" />
        </svg>
      </button>
      <span v-else-if="section.id === 'workspaces'" class="rail-t2-actions">
        <button
          class="rail-t2-add"
          type="button"
          title="Import a workspace bundle"
          aria-label="Import a workspace bundle"
          :disabled="importing"
          @click="pickImport"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <path d="M8 10.5V2.6M4.8 5.8L8 2.5l3.2 3.3" />
            <path d="M2.6 10.2v2.4a1 1 0 001 1h8.8a1 1 0 001-1v-2.4" />
          </svg>
        </button>
        <button
          class="rail-t2-add"
          type="button"
          title="New workspace"
          aria-label="New workspace"
          @click="newWorkspace"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M8 3.2v9.6M3.2 8h9.6" />
          </svg>
        </button>
      </span>
    </header>

    <div v-if="section.id === 'chat'" class="rail-t2-body rail-t2-body--chat">
      <ChatHistoryRail ref="history" headless />
    </div>

    <div v-else-if="section.id === 'workspaces'" class="rail-t2-body">
      <p v-if="!workspaces.items.length" class="rail-t2-empty">
        No workspaces on this machine. Create one, or import a bundle.
      </p>
      <div
        v-for="record in workspaces.items"
        :key="record.id"
        class="rail-t2-row rail-ws-row"
        :data-active="record.id === workspaces.active ? '1' : '0'"
      >
        <button
          class="rail-t2-open"
          type="button"
          :aria-current="record.id === workspaces.active ? 'page' : undefined"
          :disabled="Boolean(wsBusy)"
          @click="openSettings(record)"
        >
          <span class="t">
            <b>{{ record.label }}</b>
            <span class="m">{{ record.kind || 'local' }} · {{ record.counts?.entities || 0 }} entities</span>
          </span>
          <span v-if="record.id === workspaces.active" class="c">current</span>
        </button>
        <button
          class="rail-ws-dots"
          type="button"
          aria-haspopup="menu"
          :aria-expanded="wsMenu?.id === record.id ? 'true' : 'false'"
          :aria-label="`Actions for ${record.label}`"
          @click.stop="openWsMenu($event, record)"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <circle cx="3.2" cy="8" r="1.2" />
            <circle cx="8" cy="8" r="1.2" />
            <circle cx="12.8" cy="8" r="1.2" />
          </svg>
        </button>
      </div>
      <input
        ref="importInput"
        class="hidden-file"
        type="file"
        accept="application/json,.json"
        @change="importFile"
      />
    </div>

    <div v-else-if="section.id === 'entities'" class="rail-t2-body">
      <p v-if="!hub.agents.length" class="rail-t2-empty">No entities in this workspace yet.</p>
      <button
        v-for="entity in hub.agents"
        :key="entity.id"
        class="rail-t2-row"
        type="button"
        :aria-current="route.name === 'entity' && route.params.name === entity.id ? 'page' : undefined"
        @click="router.push({ name: 'entity', params: { name: entity.id } })"
      >
        <EntityMark mini :entity="entity.name" />
        <span class="t">
          <b>{{ entity.name }}</b>
          <span class="m">{{ entity.harnessLabel }}</span>
        </span>
        <span class="c">{{ threadCount(entity.name) }}</span>
      </button>
    </div>

    <div v-else-if="section.id === 'artifacts'" class="rail-t2-body">
      <p v-if="!artifacts.items.length" class="rail-t2-empty">
        No artifacts yet. Upload one from the shelf.
      </p>
      <button
        v-for="item in artifacts.items"
        :key="item.id"
        class="rail-t2-row"
        type="button"
        :title="item.name"
        @click="openArtifact(item)"
      >
        <span class="rail-t2-ic"><NavIcon name="artifact" /></span>
        <span class="t">
          <b>{{ item.name }}</b>
          <span class="m">{{ item.ext || 'file' }} · {{ sizeLabel(item.size) }}</span>
        </span>
        <span class="c">{{ ago(item.modifiedAt) }}</span>
      </button>
    </div>

    <div v-else-if="section.id === 'overview' || section.id === 'machines'" class="rail-t2-body">
      <p v-if="!hub.machines.length" class="rail-t2-empty">No machines attached.</p>
      <button
        v-for="machine in hub.machines"
        :key="machine.id"
        class="rail-t2-row"
        type="button"
        :aria-current="route.name === 'machine' && route.params.id === machine.id ? 'page' : undefined"
        @click="router.push({ name: 'machine', params: { id: machine.id } })"
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
        @click="router.push({ name: 'skill', params: { name: skill.name } })"
      >
        <span class="rail-t2-ic"><NavIcon name="star" /></span>
        <span class="t">
          <b>{{ skill.name }}</b>
          <span class="m">{{ skill.missing ? 'missing file' : skill.harnessLabel || 'workspace skill' }}</span>
        </span>
      </button>
    </div>

    <div v-else-if="section.id === 'workspace'" class="rail-t2-body">
      <div v-for="group in WORKSPACE_GROUPS" :key="group.id" class="rail-t2-group">
        <div class="rail-t2-group-head">{{ group.label }}</div>
        <button
          v-for="tab in group.tabs"
          :key="tab.id"
          class="rail-t2-row"
          type="button"
          :aria-current="
            tab.to
              ? route.path === tab.to
                ? 'page'
                : undefined
              : route.name === 'workspace' && String(route.query.tab || 'general') === tab.id
                ? 'page'
                : undefined
          "
          @click="openWorkspaceMenu(tab)"
        >
          <span class="t">
            <b>{{ tab.label }}</b>
            <span class="m">{{ tab.hint }}</span>
          </span>
        </button>
      </div>
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
        @click="router.push('/mcp')"
      >
        <span class="t">
          <b>{{ name }}</b>
          <span class="m">{{ server?.transport || server?.command || 'stdio' }}</span>
        </span>
      </button>
    </div>

    <Teleport to="body">
      <div
        v-if="wsMenu"
        ref="wsMenuEl"
        class="rchat-menu-pop"
        role="menu"
        aria-label="Workspace actions"
        :style="{ top: wsMenuPos.top, left: wsMenuPos.left }"
        @click.stop
      >
        <button class="rchat-menu-item" type="button" role="menuitem" @click="menuExport">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <path d="M8 2.6v8M4.8 7.4L8 10.6l3.2-3.2" />
            <path d="M2.6 12.4v.6a1 1 0 001 1h8.8a1 1 0 001-1v-.6" />
          </svg>
          Export
        </button>
        <button
          class="rchat-menu-item rchat-menu-danger"
          type="button"
          role="menuitem"
          :class="{ confirming: wsConfirming === wsMenu.id }"
          @click="menuDelete"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <path d="M3.2 4.4h9.6M6.1 4.4V2.8h3.8v1.6M4.4 4.4l.6 8.8h6l.6-8.8" />
          </svg>
          {{ wsConfirming === wsMenu.id ? 'Click again to delete' : 'Delete workspace' }}
        </button>
      </div>
    </Teleport>
  </aside>
</template>
