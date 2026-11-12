<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { call } from '@/composables/localBridge'
import { hub } from '@/stores/hub'
import { workspaces } from '@/stores/workspaces'

/**
 * The MCP shelf for this chat. Every server in the workspace pool is listed
 * with the number of tools it actually advertises; opening one shows the
 * transport, env variable names and the tool names/arguments. Nothing is
 * invented: a server that cannot answer tools/list says so.
 */
const props = defineProps({
  open: { type: Boolean, default: false },
})
const emit = defineEmits(['close'])

const selectedName = ref('')
const states = reactive({})
let run = 0

const entries = computed(() => {
  const map = new Map()
  for (const [name, definition] of Object.entries(workspaces.mcp?.servers || {})) {
    map.set(name, { name, definition, enabled: true })
  }
  for (const [name, definition] of Object.entries(workspaces.mcp?.disabled || {})) {
    if (!map.has(name)) map.set(name, { name, definition, enabled: false })
  }
  return [...map.values()].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
    return a.name.localeCompare(b.name)
  })
})

const enabledCount = computed(() => entries.value.filter((entry) => entry.enabled).length)
const selected = computed(() => entries.value.find((entry) => entry.name === selectedName.value) || null)

function commandLine(entry) {
  const value = entry?.definition || {}
  if (value.command) return [value.command, ...(value.args || [])].join(' ')
  return value.url || 'no command or URL'
}

function stateFor(name) {
  return states[name] || null
}

function toolsLabel(entry) {
  const state = stateFor(entry.name)
  if (!entry.definition?.command && !entry.definition?.url) return 'no transport'
  if (!state || state.loading) return 'reading tools…'
  if (state.error) return 'tools unavailable'
  return `${state.items.length} tool${state.items.length === 1 ? '' : 's'}`
}

function parameters(tool) {
  const props = tool?.inputSchema?.properties
  return props && typeof props === 'object' ? Object.keys(props) : []
}

function requiredFor(tool) {
  return new Set(Array.isArray(tool?.inputSchema?.required) ? tool.inputSchema.required : [])
}

async function loadTools(name, force = false) {
  const entry = entries.value.find((item) => item.name === name)
  if (!entry) return
  const current = states[name]
  if (!force && (current?.loading || current?.loaded)) return
  if (!entry.definition?.command && !entry.definition?.url) {
    states[name] = {
      loading: false,
      loaded: false,
      error: 'This server has neither a command nor a URL.',
      items: [],
    }
    return
  }
  states[name] = {
    loading: true,
    loaded: false,
    error: '',
    items: current?.items || [],
  }
  try {
    const data = await call('mcp.tools', { workspace: hub.workspace, name })
    states[name] = {
      loading: false,
      loaded: true,
      error: '',
      items: Array.isArray(data?.tools) ? data.tools : [],
      readAt: data?.readAt || '',
    }
  } catch (error) {
    states[name] = {
      loading: false,
      loaded: false,
      error: error?.message || 'The server did not answer tools/list.',
      items: [],
    }
  }
}

async function loadAll(force = false) {
  const current = ++run
  const names = entries.value.map((entry) => entry.name)
  let cursor = 0
  const worker = async () => {
    while (cursor < names.length) {
      if (current !== run) return
      const name = names[cursor]
      cursor += 1
      await loadTools(name, force)
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, names.length) }, worker))
}

function openEntry(entry) {
  selectedName.value = entry.name
  loadTools(entry.name).catch(() => {})
}

function back() {
  selectedName.value = ''
}

function close() {
  emit('close')
}

watch(
  () => props.open,
  (open) => {
    if (!open) {
      selectedName.value = ''
      return
    }
    selectedName.value = ''
    loadAll().catch(() => {})
  },
)
</script>

<template>
  <Teleport to="body">
    <div class="scrim" :data-open="open ? '1' : '0'" @click="close"></div>
    <div
      class="modal ctxdlg ctxdlg-mcp"
      :data-open="open ? '1' : '0'"
      role="dialog"
      aria-modal="true"
      aria-label="Workspace MCP servers"
    >
      <div class="mo-head">
        <h2>MCP</h2>
        <p>
          {{ enabledCount }} enabled of {{ entries.length }} in this workspace. Tool counts are read
          from each server, not guessed.
        </p>
        <button class="x mo-x" aria-label="Close" @click="close">
          <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5">
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>

      <div class="mo-body ctxdlg-body">
        <template v-if="selected">
          <button class="ctxdlg-back" type="button" @click="back">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <path d="M10 3.5L5.5 8 10 12.5" />
            </svg>
            All MCP servers
          </button>

          <div class="ctxdlg-server">
            <div class="ctxdlg-server-head">
              <h3>{{ selected.name }}</h3>
              <span class="ctxdlg-state" :data-on="selected.enabled ? '1' : '0'">
                <i></i>{{ selected.enabled ? 'enabled' : 'disabled' }}
              </span>
            </div>
            <p class="ctxdlg-cmd mono">{{ commandLine(selected) }}</p>
            <div class="ctxdlg-meta">
              <span>{{ selected.definition?.url ? 'remote' : 'local stdio' }}</span>
              <span v-if="selected.definition?.env?.length">
                env names: <b class="mono">{{ selected.definition.env.join(', ') }}</b>
              </span>
              <span v-if="selected.definition?.args?.length">
                {{ selected.definition.args.length }} args
              </span>
            </div>
          </div>

          <div class="ctxdlg-tools-head">
            <span>Tools</span>
            <span class="ctxdlg-tools-count" :data-loading="stateFor(selected.name)?.loading ? '1' : '0'">
              <span v-if="stateFor(selected.name)?.loading" class="model-spin" aria-hidden="true"></span>
              {{ toolsLabel(selected) }}
            </span>
            <button
              v-if="stateFor(selected.name)?.loaded"
              class="ctxdlg-refresh"
              type="button"
              @click="loadTools(selected.name, true)"
            >Refresh</button>
          </div>

          <div v-if="stateFor(selected.name)?.error" class="ctxdlg-error">
            {{ stateFor(selected.name).error }}
          </div>
          <p v-else-if="stateFor(selected.name)?.loading && !stateFor(selected.name)?.items?.length" class="empty-note ctxdlg-empty">
            <b>Reading tools…</b>
            <span>Opening the server for one tools/list handshake.</span>
          </p>
          <p v-else-if="!stateFor(selected.name)?.items?.length" class="empty-note ctxdlg-empty">
            <b>No tools advertised.</b>
            <span>The server answered, but returned an empty tools list.</span>
          </p>
          <ul v-else class="ctxdlg-tools">
            <li v-for="tool in stateFor(selected.name).items" :key="tool.name">
              <div class="ctxdlg-tool-head">
                <code>{{ tool.name }}</code>
                <span v-if="parameters(tool).length" class="ctxdlg-params">
                  {{ parameters(tool).length }} param{{ parameters(tool).length === 1 ? '' : 's' }}
                </span>
              </div>
              <p v-if="tool.description">{{ tool.description }}</p>
              <p v-if="parameters(tool).length" class="ctxdlg-args mono">
                <span
                  v-for="param in parameters(tool)"
                  :key="param"
                  :data-required="requiredFor(tool).has(param) ? '1' : '0'"
                >{{ param }}</span>
              </p>
            </li>
          </ul>
        </template>

        <template v-else>
          <div v-if="entries.length" class="ctxdlg-list">
            <button
              v-for="entry in entries"
              :key="entry.name"
              class="ctxdlg-row"
              type="button"
              @click="openEntry(entry)"
            >
              <span class="ctxdlg-state" :data-on="entry.enabled ? '1' : '0'">
                <i></i>{{ entry.enabled ? 'enabled' : 'disabled' }}
              </span>
              <span class="ctxdlg-name">
                <b>{{ entry.name }}</b>
                <span class="ctxdlg-cmd mono">{{ commandLine(entry) }}</span>
              </span>
              <span class="ctxdlg-row-tools">{{ toolsLabel(entry) }}</span>
              <svg class="ctxdlg-go" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                <path d="M4 2l4 4-4 4" />
              </svg>
            </button>
          </div>
          <div v-else class="empty-note ctxdlg-empty">
            <b>No MCP servers in this workspace.</b>
            <span>Add one in Workspace → MCP, then an entity can opt in with <code class="mono">mcp: name</code>.</span>
          </div>
        </template>
      </div>

      <div class="mo-foot ctxdlg-foot">
        <router-link class="ctxdlg-link" :to="{ name: 'workspace', query: { tab: 'mcp' } }" @click="close">
          Open workspace MCP
        </router-link>
        <button class="btn" type="button" @click="close">Close</button>
      </div>
    </div>
  </Teleport>
</template>
