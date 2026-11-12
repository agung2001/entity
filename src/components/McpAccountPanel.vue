<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import { call } from '@/composables/localBridge'
import { hub, toast } from '@/stores/hub'
import { setMcpEnabled, workspaces } from '@/stores/workspaces'

/**
 * The account-level MCP view: every server the machine knows about, whether it
 * is enabled in this workspace, which entities opted in, and the tools the
 * server exposes. Enabling does not rewrite a harness config; it puts the
 * definition into this workspace's pool, which is the only MCP scope the app
 * owns.
 */
const globals = reactive({ loading: false, loaded: false, error: '', groups: [] })
const tools = reactive({})
const busy = ref('')

function definitionOf(server) {
  if (!server) return null
  if (server.url) return { url: String(server.url) }
  if (!server.command) return null
  const value = { command: String(server.command) }
  if (Array.isArray(server.args) && server.args.length) value.args = server.args.map(String)
  if (Array.isArray(server.env) && server.env.length) value.env = server.env.map(String)
  return value
}

const entries = computed(() => {
  const map = new Map()
  for (const [name, definition] of Object.entries(workspaces.mcp?.servers || {})) {
    map.set(name, {
      name,
      definition,
      enabled: true,
      source: 'workspace',
      harness: '',
      harnessLabel: 'Workspace pool',
    })
  }
  for (const [name, definition] of Object.entries(workspaces.mcp?.disabled || {})) {
    if (map.has(name)) continue
    map.set(name, {
      name,
      definition,
      enabled: false,
      source: 'workspace',
      harness: '',
      harnessLabel: 'Workspace pool',
    })
  }
  for (const group of globals.groups) {
    for (const server of group.servers || []) {
      const found = map.get(server.name)
      if (found) {
        found.harness = found.harness || group.harness
        found.harnessLabel = found.harnessLabel || group.label
        continue
      }
      map.set(server.name, {
        name: server.name,
        definition: definitionOf(server),
        enabled: false,
        source: group.harness,
        harness: group.harness,
        harnessLabel: group.label,
      })
    }
  }
  return [...map.values()].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
    return a.name.localeCompare(b.name)
  })
})

const enabledCount = computed(() => entries.value.filter((entry) => entry.enabled).length)
const commandLine = (entry) => {
  const value = entry.definition || {}
  if (value.command) return [value.command, ...(value.args || [])].join(' ')
  return value.url || 'no command or URL'
}
const entitiesFor = (name) => hub.agents.filter((agent) => agent.mcp.includes(name))

async function loadGlobals(force = false) {
  if (!force && (globals.loading || globals.loaded)) return
  globals.loading = true
  globals.error = ''
  try {
    const data = await call('mcp.globals')
    globals.groups = data?.groups || []
    globals.loaded = true
  } catch (error) {
    globals.error = error?.message || 'Could not read the harness MCP configs.'
  } finally {
    globals.loading = false
  }
}

async function toggle(entry) {
  if (busy.value) return
  busy.value = entry.name
  try {
    await setMcpEnabled(entry.name, !entry.enabled, entry.definition)
    toast(entry.enabled ? `${entry.name} disabled` : `${entry.name} enabled`)
    if (!entry.enabled) loadTools(entry)
  } catch (error) {
    toast(error?.message || `${entry.name} could not be changed.`)
  } finally {
    busy.value = ''
  }
}

async function loadTools(entry) {
  const current = tools[entry.name]
  if (current?.loading) return
  tools[entry.name] = { loading: true, loaded: false, error: '', items: [] }
  try {
    const data = await call('mcp.tools', { workspace: hub.workspace, name: entry.name })
    tools[entry.name] = {
      loading: false,
      loaded: true,
      error: '',
      items: Array.isArray(data?.tools) ? data.tools : [],
      readAt: data?.readAt || '',
    }
  } catch (error) {
    tools[entry.name] = {
      loading: false,
      loaded: false,
      error: error?.message || 'The server did not answer tools/list.',
      items: [],
    }
  }
}

onMounted(async () => {
  await loadGlobals()
  const enabled = entries.value.filter((item) => item.enabled)
  /* show the tools of what is enabled; if the pool is empty, read the first
     few discovered servers so the tab is useful before anything is switched on */
  const initial = enabled.length ? enabled.slice(0, 6) : entries.value.slice(0, 3)
  for (const entry of initial) loadTools(entry)
})
</script>

<template>
  <section class="mcp-acct">
    <div class="mcp-acct-head">
      <div>
        <h2>MCP servers</h2>
        <p class="mnote">
          Enable a server here to put it in this workspace's pool. An entity calls it with
          <code class="mono">mcp: name</code>; the tool list is read from the server itself.
        </p>
      </div>
      <span class="meta">{{ enabledCount }} enabled · {{ entries.length }} known</span>
    </div>

    <div v-if="globals.error" class="acct-error" role="alert">
      {{ globals.error }}
      <button class="btn btn-sm" type="button" @click="loadGlobals(true)">Try again</button>
    </div>

    <div v-if="globals.loading && !entries.length" class="empty-note">
      <b>Reading MCP configs…</b>
    </div>
    <div v-else-if="!entries.length" class="empty-note">
      <b>No MCP servers found.</b>
      <span>Add one in the MCP page, or configure a harness on this machine.</span>
    </div>

    <ul v-else class="mcp-acct-list">
      <li
        v-for="entry in entries"
        :key="entry.name"
        class="mcp-acct-row"
        :data-on="entry.enabled ? '1' : '0'"
      >
        <div class="mcp-acct-top">
          <span class="mcp-acct-state"><i></i>{{ entry.enabled ? 'enabled' : 'disabled' }}</span>
          <b>{{ entry.name }}</b>
          <span class="mcp-acct-src">
            <HarnessIcon v-if="entry.harness" :name="entry.harness" :size="11" />
            {{ entry.harnessLabel }}
          </span>
          <button
            class="mcp-toggle"
            type="button"
            role="switch"
            :aria-checked="entry.enabled ? 'true' : 'false'"
            :disabled="busy === entry.name || (!entry.enabled && !entry.definition)"
            :title="entry.enabled ? 'Disable in this workspace' : 'Enable in this workspace'"
            @click="toggle(entry)"
          >
            <span class="mcp-toggle-knob"></span>
          </button>
        </div>

        <p class="mcp-acct-cmd mono">{{ commandLine(entry) }}</p>

        <div class="mcp-acct-meta">
          <span v-if="entitiesFor(entry.name).length" class="mcp-acct-ents">
            used by
            <span v-for="entity in entitiesFor(entry.name)" :key="entity.name" class="mcp-ent">
              {{ entity.name }}
            </span>
          </span>
          <span v-else class="mcp-acct-none">no entity opts in yet</span>
        </div>

        <div class="mcp-acct-tools">
          <button
            v-if="!tools[entry.name]?.loaded"
            class="btn btn-sm"
            type="button"
            :disabled="tools[entry.name]?.loading || !entry.definition"
            @click="loadTools(entry)"
          >
            {{ tools[entry.name]?.loading ? 'Reading tools…' : 'List tools' }}
          </button>
          <template v-else>
            <details
              v-if="tools[entry.name].items.length"
              class="mcp-tools-fold"
              :open="tools[entry.name].items.length <= 12"
            >
              <summary class="mcp-tools-count">
                {{ tools[entry.name].items.length }}
                {{ tools[entry.name].items.length === 1 ? 'tool' : 'tools' }}
              </summary>
              <ul class="mcp-tools">
                <li v-for="tool in tools[entry.name].items" :key="tool.name">
                  <b class="mono">{{ tool.name }}</b>
                  <span v-if="tool.description">{{ tool.description }}</span>
                </li>
              </ul>
            </details>
            <span v-else class="mcp-acct-none">The server exposes no tools.</span>
          </template>
          <span v-if="tools[entry.name]?.error" class="mcp-tools-error">
            {{ tools[entry.name].error }}
            <button class="mcp-link" type="button" @click="loadTools(entry)">retry</button>
          </span>
        </div>
      </li>
    </ul>
  </section>
</template>
