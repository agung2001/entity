<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { call } from '@/composables/localBridge'
import { commandLine, definitionOf, envNames, transportOf } from '@/lib/mcp'
import { hub, toast } from '@/stores/hub'
import { setMcpEnabled, workspaces, writeMcp } from '@/stores/workspaces'

/**
 * One MCP server, as a page — the same shell as the entity detail page
 * (`entp-*` is the shared detail layout, not an entity-only style).
 *
 * The inventory table is for scanning; this is where you actually read the
 * server: what it can do, what it is made of, and which entities narrow
 * themselves to it.
 */
const route = useRoute()
const router = useRouter()

const name = computed(() => String(route.params.name || ''))
const poolServers = computed(() => workspaces.mcp?.servers || {})
const poolDisabled = computed(() => workspaces.mcp?.disabled || {})
const inPool = computed(
  () => Boolean(poolServers.value[name.value]) || Boolean(poolDisabled.value[name.value]),
)
const enabled = computed(() => Boolean(poolServers.value[name.value]))
const poolDefinition = computed(() => poolServers.value[name.value] || poolDisabled.value[name.value] || null)

/* A server the harnesses already know is readable here too, with one action:
   copy it into the pool. */
const globalRow = ref(null)
const globalLoading = ref(false)

const definition = computed(() => poolDefinition.value || globalRow.value?.definition || null)
const transport = computed(() => (definition.value ? transportOf(definition.value) : 'unknown'))
const command = computed(() => (definition.value ? commandLine(definition.value) : ''))
const envKeys = computed(() => envNames(definition.value))
const namedBy = computed(() => hub.agents.filter((agent) => (agent.mcp || []).includes(name.value)))

const tools = ref({ loading: false, error: '', list: [] })
const editing = ref(false)
const draft = ref('')
const draftError = ref('')
const saving = ref(false)
const confirming = ref(false)

/** What the page shows by default: names and URLs, never a stored value. */
const redactedDefinition = computed(() => {
  if (!definition.value) return ''
  const copy = JSON.parse(JSON.stringify(definition.value))
  if (copy.headers && typeof copy.headers === 'object' && !Array.isArray(copy.headers)) {
    for (const key of Object.keys(copy.headers)) copy.headers[key] = '•••'
  }
  if (copy.env && typeof copy.env === 'object' && !Array.isArray(copy.env)) {
    for (const key of Object.keys(copy.env)) copy.env[key] = '•••'
  }
  return JSON.stringify(copy, null, 2)
})

async function loadGlobal() {
  if (inPool.value) return
  globalLoading.value = true
  try {
    const data = await call('mcp.globals')
    for (const group of data?.groups || []) {
      const hit = (group.servers || []).find((server) => server.name === name.value)
      if (!hit) continue
      globalRow.value = { ...hit, harnessLabel: group.label, definition: definitionOf(hit) }
      return
    }
    globalRow.value = null
  } catch {
    globalRow.value = null
  } finally {
    globalLoading.value = false
  }
}

async function loadTools(force = false) {
  if (!definition.value) return
  tools.value = { loading: true, error: '', list: force ? [] : tools.value.list }
  try {
    const data = await call('mcp.tools', { workspace: hub.workspace, name: name.value })
    tools.value = { loading: false, error: '', list: data?.tools || [] }
  } catch (error) {
    tools.value = { loading: false, error: error?.message || 'The server did not answer.', list: [] }
  }
}

function startEdit() {
  if (!definition.value) return
  draft.value = JSON.stringify(definition.value, null, 2)
  draftError.value = ''
  editing.value = true
}

function cancelEdit() {
  editing.value = false
  draftError.value = ''
}

async function save() {
  if (saving.value) return
  let parsed
  try {
    parsed = JSON.parse(draft.value)
  } catch (error) {
    draftError.value = `That is not valid JSON: ${error?.message || error}`
    return
  }
  saving.value = true
  draftError.value = ''
  try {
    const wasEnabled = enabled.value
    await writeMcp({ ...poolServers.value, [name.value]: parsed })
    /* writing always lands in the enabled pile; put a parked server back */
    if (!wasEnabled) await setMcpEnabled(name.value, false)
    editing.value = false
    toast(`${name.value} saved`)
    await loadTools(true)
  } catch (error) {
    draftError.value = error?.message || 'The server could not be saved.'
  } finally {
    saving.value = false
  }
}

async function attach() {
  if (!globalRow.value?.definition) {
    toast('That server has neither a command nor a URL.')
    return
  }
  try {
    await writeMcp({ ...poolServers.value, [name.value]: globalRow.value.definition })
    toast(`${name.value} added to the workspace pool`)
  } catch (error) {
    toast(error?.message || `${name.value} could not be attached.`)
  }
}

async function toggleEnabled() {
  const next = !enabled.value
  try {
    await setMcpEnabled(name.value, next)
    toast(`${name.value} ${next ? 'enabled' : 'parked'}`)
  } catch (error) {
    toast(error?.message || 'The server could not be toggled.')
  }
}

async function remove() {
  if (!confirming.value) {
    confirming.value = true
    return
  }
  const servers = { ...poolServers.value }
  const disabled = { ...poolDisabled.value }
  delete servers[name.value]
  delete disabled[name.value]
  try {
    await writeMcp(servers, { disabled })
    router.push({ name: 'mcp', params: { workspace: route.params.workspace } })
  } catch (error) {
    toast(error?.message || `${name.value} could not be removed.`)
  }
}

async function copyDefinition() {
  if (!definition.value) return
  try {
    await navigator.clipboard.writeText(JSON.stringify(definition.value, null, 2))
    toast('Definition copied')
  } catch {
    toast('The clipboard is not available.')
  }
}

function back() {
  router.push({ name: 'mcp', params: { workspace: route.params.workspace } })
}

onMounted(async () => {
  await loadGlobal()
  await loadTools()
})

watch(name, async () => {
  editing.value = false
  confirming.value = false
  globalRow.value = null
  await loadGlobal()
  await loadTools()
})
</script>

<template>
  <div class="view entp-view">
    <div class="entp-bar">
      <button class="back" type="button" @click="back">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7.5 2.5L4 6l3.5 3.5" /></svg>
        MCP
      </button>
      <span class="entp-crumb">{{ name }}</span>
      <span class="spacer"></span>
      <div class="entp-actions">
        <button class="btn btn-sm" type="button" :disabled="!definition" @click="copyDefinition">
          Copy definition
        </button>
        <button v-if="!inPool" class="btn btn-ink" type="button" :disabled="!globalRow" @click="attach">
          Add to pool
        </button>
        <button v-else class="btn btn-sm" type="button" @click="toggleEnabled">
          {{ enabled ? 'Park' : 'Enable' }}
        </button>
      </div>
    </div>

    <template v-if="definition">
      <header class="entp-idhead">
        <div class="mcpp-mark" :data-t="transport">
          <span>{{ transport === 'http' ? 'HTTP' : 'STDIO' }}</span>
        </div>
        <div class="entp-title">
          <p class="eyebrow">MCP · {{ hub.workspaceLabel || hub.workspace }}</p>
          <h1>{{ name }}</h1>
          <p class="entp-desc mono">{{ command }}</p>
          <div class="entp-chips">
            <span class="mcpp-chip" :data-on="inPool && enabled ? '1' : '0'">
              <i></i>{{ !inPool ? 'harness config' : enabled ? 'in the pool' : 'parked' }}
            </span>
            <span class="entp-chip">{{ transport === 'http' ? 'remote · http' : 'local · stdio' }}</span>
            <span class="entp-chip">{{ tools.list.length }} tools</span>
            <span class="entp-chip">
              {{ namedBy.length ? `${namedBy.length} entities narrow to it` : 'every entity' }}
            </span>
          </div>
        </div>
      </header>

      <div class="entp-grid">
        <div class="entp-main">
          <section class="entp-sec">
            <div class="entp-sec-head">
              <h2>Tools</h2>
              <span class="n">
                {{ tools.loading ? 'asking…' : tools.list.length ? `${tools.list.length} exposed` : 'none reported' }}
              </span>
              <span class="r">
                <button class="btn btn-sm" type="button" :disabled="tools.loading" @click="loadTools(true)">
                  Refresh
                </button>
              </span>
            </div>
            <p v-if="tools.error" class="mcpp-note" data-bad="1">{{ tools.error }}</p>
            <ul v-else-if="tools.list.length" class="mcp-tool-list">
              <li v-for="tool in tools.list" :key="tool.name">
                <b>{{ tool.name }}</b>
                <span v-if="tool.description">{{ tool.description }}</span>
              </li>
            </ul>
            <p v-else-if="!tools.loading" class="mcpp-note">
              This server reported no tools. An HTTP server that needs a token will answer
              empty when the token is missing.
            </p>
          </section>

          <section class="entp-sec">
            <div class="entp-sec-head">
              <h2>Definition</h2>
              <span class="n">{{ inPool ? 'stored in this workspace' : 'read-only, from a harness config' }}</span>
              <span v-if="inPool" class="r">
                <button v-if="!editing" class="btn btn-sm" type="button" @click="startEdit">Edit</button>
                <button v-else class="btn btn-sm" type="button" @click="cancelEdit">Cancel</button>
              </span>
            </div>

            <template v-if="editing">
              <textarea v-model="draft" class="mcp-editor mono" rows="14" spellcheck="false"></textarea>
              <p class="mcpp-note">
                This is what the pool stores, values included. It is only rewritten when you save.
              </p>
              <p v-if="draftError" class="acct-error" role="alert">{{ draftError }}</p>
              <div class="mcpp-actions">
                <button class="btn btn-ink" type="button" :disabled="saving" @click="save">
                  {{ saving ? 'Saving…' : 'Save definition' }}
                </button>
              </div>
            </template>
            <pre v-else class="codebox">{{ redactedDefinition }}</pre>
          </section>

          <section class="entp-sec">
            <div class="entp-sec-head">
              <h2>Environment</h2>
              <span class="n">{{ envKeys.length ? `${envKeys.length} variables` : 'none' }}</span>
            </div>
            <div class="entp-mcp-env">
              <span v-for="key in envKeys" :key="key" class="entp-skchip"><i></i>{{ key }}</span>
              <span v-if="!envKeys.length" class="entp-skchip"><i></i>no variables required</span>
            </div>
            <p class="mcpp-note">
              Values live in the pool, are handed to the harness when the turn starts, and are
              never returned by any read here.
            </p>
          </section>

          <section class="entp-sec">
            <div class="entp-sec-head">
              <h2>Entities</h2>
              <span class="n">{{ namedBy.length ? `${namedBy.length} narrow to it` : 'the whole workspace' }}</span>
            </div>
            <div class="entp-mcp-env">
              <router-link
                v-for="agent in namedBy"
                :key="agent.name"
                class="entp-skchip"
                :to="{ name: 'entity', params: { workspace: route.params.workspace, name: agent.name } }"
              >
                <i></i>{{ agent.name }}
              </router-link>
              <span v-if="!namedBy.length" class="entp-skchip">
                <i></i>no entity narrows itself — every entity gets this server
              </span>
            </div>
          </section>

          <section v-if="inPool" class="entp-sec">
            <div class="entp-sec-head">
              <h2>Danger</h2>
              <span class="n">removing affects every entity</span>
            </div>
            <div class="mcpp-actions">
              <button class="btn btn-sm" type="button" data-danger="1" @click="remove">
                {{ confirming ? 'Click again to remove' : 'Remove from the pool' }}
              </button>
              <button v-if="confirming" class="btn btn-sm" type="button" @click="confirming = false">
                Keep it
              </button>
            </div>
          </section>
        </div>

        <aside class="entp-rail">
          <p class="entp-rail-h">This server</p>
          <dl class="entp-facts">
            <div><dt>Transport</dt><dd>{{ transport === 'http' ? 'remote · http' : 'local · stdio' }}</dd></div>
            <div v-if="definition?.url"><dt>URL</dt><dd class="mono" :title="definition.url">{{ definition.url }}</dd></div>
            <div v-if="definition?.command"><dt>Command</dt><dd class="mono">{{ definition.command }}</dd></div>
            <div v-if="definition?.args?.length"><dt>Args</dt><dd class="mono" :title="definition.args.join(' ')">{{ definition.args.join(' ') }}</dd></div>
            <div><dt>Headers</dt><dd class="mono">{{ definition?.headers ? Object.keys(definition.headers).join(', ') : 'none' }}</dd></div>
            <div><dt>Source</dt><dd>{{ inPool ? 'workspace pool' : globalRow?.harnessLabel || 'harness config' }}</dd></div>
            <div><dt>Status</dt><dd>{{ !inPool ? 'not in the pool' : enabled ? 'enabled' : 'parked' }}</dd></div>
            <div><dt>Tools</dt><dd>{{ tools.loading ? 'asking…' : tools.list.length }}</dd></div>
            <div><dt>Pool file</dt><dd class="mono" :title="workspaces.mcp?.path">{{ workspaces.mcp?.path || 'mcp.json' }}</dd></div>
            <div v-if="globalRow?.configPath"><dt>Config file</dt><dd class="mono" :title="globalRow.configPath">{{ globalRow.configPath }}</dd></div>
          </dl>
        </aside>
      </div>
    </template>

    <section v-else class="cpanel cpanel-empty">
      <div class="empty-note">
        <b>{{ globalLoading ? 'Looking for that server…' : 'No MCP server called that.' }}</b>
        <span>
          It is not in this workspace's pool, and no harness on this machine declares it.
          Add it on the MCP page.
        </span>
        <button class="btn btn-sm" type="button" @click="back">Back to MCP</button>
      </div>
    </section>
  </div>
</template>
