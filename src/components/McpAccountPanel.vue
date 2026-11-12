<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { call } from '@/composables/localBridge'
import { matchesQuery } from '@/composables/search'
import { parametersOf } from '@/lib/mcp'
import { toast } from '@/stores/hub'

/**
 * Account → MCP is the connection desk for Entity's own MCP server.
 *
 * This is the opposite direction from the workspace pool: the pool is what
 * Entity consumes, while this loopback endpoint is what an agent (Claude Code,
 * pi, an IDE) connects to so it can read and write this workspace repo.
 */
const state = reactive({
  loading: true,
  loaded: false,
  error: '',
  status: null,
})
const port = ref('4781')
const allowWrite = ref(false)
const reveal = ref(false)
const busy = ref('')
const notice = ref(null)
const testResult = ref(null)
const confirmingRotate = ref(false)
const search = ref('')
let rotateTimer = 0

const status = computed(() => state.status)
const pill = computed(() => {
  if (!status.value) return 'unknown'
  if (!status.value.enabled) return 'off'
  return status.value.running ? 'listening' : 'not bound'
})
const tokenDisplay = computed(() => {
  const token = status.value?.token || ''
  if (!token) return 'No token minted yet.'
  return reveal.value ? token : '•'.repeat(Math.min(token.length, 48))
})
const tokenForConfig = computed(() => status.value?.token || 'YOUR_TOKEN')
const endpoint = computed(() => status.value?.url || `http://127.0.0.1:${port.value}/mcp`)

const agentJson = computed(() =>
  JSON.stringify(
    {
      mcpServers: {
        entity: {
          type: 'http',
          url: endpoint.value,
          headers: { Authorization: `Bearer ${tokenForConfig.value}` },
        },
      },
    },
    null,
    2,
  ),
)
const agentJsonDisplay = computed(() =>
  agentJson.value.replace(`Bearer ${tokenForConfig.value}`, 'Bearer YOUR_TOKEN'),
)
const agentCli = computed(
  () =>
    `claude mcp add --transport http entity ${endpoint.value} --header "Authorization: Bearer ${tokenForConfig.value}"`,
)
const agentCliDisplay = computed(
  () => `claude mcp add --transport http entity ${endpoint.value} --header "Authorization: Bearer YOUR_TOKEN"`,
)

const tools = computed(() => status.value?.tools || [])
const visibleTools = computed(() =>
  tools.value.filter((tool) =>
    matchesQuery(`${tool.name} ${tool.title || ''} ${tool.description || ''}`, search.value),
  ),
)

function messageOf(error) {
  return String(error?.message || error).replace(/^Error:\s*/, '')
}

async function load(force = false) {
  if (state.loading && state.loaded) return
  state.loading = true
  state.error = ''
  try {
    const data = await call('mcpServer.status')
    state.status = data
    port.value = String(data.port)
    allowWrite.value = Boolean(data.allowWrite)
    state.loaded = true
  } catch (error) {
    state.error = messageOf(error)
  } finally {
    state.loading = false
  }
}

function applyStatus(data) {
  state.status = data
  port.value = String(data.port)
  allowWrite.value = Boolean(data.allowWrite)
  state.loaded = true
}

function validPort() {
  const value = Number(port.value)
  return Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : null
}

async function saveConfig() {
  if (busy.value) return
  const parsed = validPort()
  if (!parsed) {
    notice.value = { ok: false, text: 'The port must be a number between 1024 and 65535.' }
    return
  }
  busy.value = 'save'
  notice.value = null
  testResult.value = null
  try {
    const data = await call('mcpServer.save', {
      enabled: true,
      port: parsed,
      allowWrite: allowWrite.value,
    })
    applyStatus(data)
    notice.value = {
      ok: !data.error,
      text: data.error || (data.running ? 'Saved. The loopback listener is live.' : 'Saved, but the listener did not start.'),
    }
  } catch (error) {
    notice.value = { ok: false, text: messageOf(error) }
  } finally {
    busy.value = ''
  }
}

async function disable() {
  if (busy.value) return
  busy.value = 'save'
  notice.value = null
  testResult.value = null
  try {
    const data = await call('mcpServer.save', { enabled: false, port: validPort() || undefined })
    applyStatus(data)
    notice.value = { ok: true, text: 'Listener stopped. The token and port are kept.' }
  } catch (error) {
    notice.value = { ok: false, text: messageOf(error) }
  } finally {
    busy.value = ''
  }
}

async function testConnection() {
  if (busy.value) return
  busy.value = 'test'
  testResult.value = null
  notice.value = null
  try {
    const result = await call('mcpServer.test')
    if (result.ok) {
      testResult.value = result
      notice.value = { ok: true, text: `Connected · ${result.tools} tools · ${result.latencyMs} ms` }
    } else {
      notice.value = { ok: false, text: result.error || 'The connection test failed.' }
    }
  } catch (error) {
    notice.value = { ok: false, text: messageOf(error) }
  } finally {
    busy.value = ''
  }
}

async function copy(value, label) {
  try {
    await navigator.clipboard.writeText(value)
    toast(`${label} copied`)
  } catch {
    toast(`${label} could not be copied.`)
  }
}

async function rotate() {
  if (busy.value) return
  if (!confirmingRotate.value) {
    confirmingRotate.value = true
    clearTimeout(rotateTimer)
    rotateTimer = setTimeout(() => {
      confirmingRotate.value = false
    }, 3000)
    return
  }
  confirmingRotate.value = false
  clearTimeout(rotateTimer)
  busy.value = 'rotate'
  notice.value = null
  try {
    const data = await call('mcpServer.rotate')
    applyStatus(data)
    reveal.value = true
    notice.value = {
      ok: true,
      text: 'New token minted. Update every agent that connects to this server.',
    }
  } catch (error) {
    notice.value = { ok: false, text: messageOf(error) }
  } finally {
    busy.value = ''
  }
}

function parameters(tool) {
  return parametersOf(tool)
}

onMounted(() => {
  load().catch(() => {})
})
</script>

<template>
  <section class="acct-mcp">
    <div v-if="state.loading && !state.status" class="empty-note">
      <b>Reading MCP server status…</b>
    </div>
    <div v-else-if="state.error" class="empty-note">
      <b>{{ state.error }}</b>
      <button class="btn btn-sm" type="button" @click="load(true)">Try again</button>
    </div>

    <template v-else>
      <div class="acct-mcp-grid">
        <article class="acct-card acct-mcp-status">
          <div class="acct-card-head">
            <div>
              <h2>MCP server</h2>
              <p class="mnote">
                One loopback endpoint that serves this workspace repo to an agent. Off by default;
                writes are opt-in.
              </p>
            </div>
            <span class="acct-mcp-pill" :data-on="status?.running ? '1' : '0'">
              <i></i>{{ pill }}
            </span>
          </div>

          <div v-if="status?.error" class="acct-error" role="alert">
            {{ status.error }}
          </div>
          <div v-if="notice" class="acct-mcp-notice" :data-ok="notice.ok ? '1' : '0'" role="status">
            {{ notice.text }}
          </div>

          <div class="mcp-srv-grid">
            <div class="fld">
              <label class="lbl" for="mcp-srv-port">Port</label>
              <input
                id="mcp-srv-port"
                v-model="port"
                class="acct-input mono"
                type="number"
                min="1024"
                max="65535"
                :disabled="Boolean(busy)"
              />
            </div>
            <div class="fld">
              <label class="lbl" for="mcp-srv-endpoint">Endpoint</label>
              <input
                id="mcp-srv-endpoint"
                class="acct-input mono"
                type="text"
                :value="endpoint"
                readonly
              />
            </div>
          </div>

          <div class="mcp-srv-toggle">
            <div>
              <b>Allow writes</b>
              <span>
                Exposes <code class="mono">create_entity</code>. Reads work without it. Writes still
                land only inside the selected workspace.
              </span>
            </div>
            <button
              class="sfx-switch"
              type="button"
              role="switch"
              :aria-checked="allowWrite ? 'true' : 'false'"
              :aria-label="allowWrite ? 'Disable MCP writes' : 'Enable MCP writes'"
              :disabled="Boolean(busy)"
              @click="allowWrite = !allowWrite"
            >
              <span></span>
            </button>
          </div>

          <div class="mcp-srv-actions">
            <button class="btn btn-ink" type="button" :disabled="Boolean(busy)" @click="saveConfig">
              {{ busy === 'save' ? 'Saving…' : status?.running ? 'Save & restart' : 'Save & enable' }}
            </button>
            <button
              class="btn"
              type="button"
              :disabled="Boolean(busy) || !status?.enabled"
              @click="disable"
            >Disable</button>
            <button
              class="btn"
              type="button"
              :disabled="Boolean(busy) || !status?.running"
              @click="testConnection"
            >{{ busy === 'test' ? 'Testing…' : 'Test connection' }}</button>
            <span v-if="testResult" class="mcp-srv-test mono">
              {{ testResult.tools }} tools · {{ testResult.latencyMs }} ms
            </span>
          </div>
          <p class="mnote mcp-srv-foot">
            Loopback only. Config lives in <code class="mono">~/.entity/mcp-server.json</code>, mode 0600.
            It never lives inside the workspace.
          </p>
        </article>

        <article class="acct-card acct-mcp-access">
          <div class="acct-card-head">
            <div>
              <h2>Bearer token</h2>
              <p class="mnote">The only secret an agent needs. Rotate it if it leaks.</p>
            </div>
          </div>
          <code class="mcp-token">{{ tokenDisplay }}</code>
          <div class="mcp-srv-actions">
            <button class="btn btn-sm" type="button" :disabled="!status?.token" @click="reveal = !reveal">
              {{ reveal ? 'Hide' : 'Reveal' }}
            </button>
            <button class="btn btn-sm" type="button" :disabled="!status?.token" @click="copy(status?.token || '', 'Token')">
              Copy
            </button>
            <button
              class="btn btn-sm"
              :class="{ 'btn-danger': confirmingRotate }"
              type="button"
              :disabled="Boolean(busy) || !status?.token"
              @click="rotate"
            >{{ confirmingRotate ? 'Click again to rotate' : 'Rotate' }}</button>
          </div>
          <p class="mnote acct-mcp-note">
            Send it as <code class="mono">Authorization: Bearer …</code>. The value is masked here
            until you reveal it, and never appears in the URL or logs.
          </p>
        </article>
      </div>

      <article class="acct-card">
        <div class="acct-card-head">
          <div>
            <h2>Agent configuration</h2>
            <p class="mnote">Paste this into an MCP client. Re-copy after rotating the token.</p>
          </div>
        </div>
        <div class="acct-mcp-snippet">
          <div class="acct-mcp-snippet-head">
            <span>Agent JSON</span>
            <button class="btn btn-sm" type="button" @click="copy(agentJson, 'Agent JSON')">Copy JSON</button>
          </div>
          <pre>{{ agentJsonDisplay }}</pre>
        </div>
        <div class="acct-mcp-snippet mcp-srv-cli">
          <div class="acct-mcp-snippet-head">
            <span>Claude Code</span>
            <button class="btn btn-sm" type="button" @click="copy(agentCli, 'Claude command')">Copy command</button>
          </div>
          <pre>{{ agentCliDisplay }}</pre>
        </div>
      </article>

      <article class="acct-card acct-mcp-tools">
        <div class="acct-card-head acct-mcp-tools-head">
          <div>
            <h2>Tools</h2>
            <p class="mnote">
              The exact surface this server advertises. Reads are always available; writes require
              the switch above.
            </p>
          </div>
          <label class="acct-mcp-search">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <circle cx="7" cy="7" r="4.6" /><path d="M10.4 10.4L14 14" />
            </svg>
            <input v-model="search" type="search" placeholder="Search tools" aria-label="Search MCP tools" autocomplete="off" />
          </label>
        </div>

        <p v-if="search && !visibleTools.length" class="acct-mcp-loading">No tool matches this search.</p>
        <ul v-else class="acct-mcp-tool-list mcp-srv-tools">
          <li v-for="tool in visibleTools" :key="tool.name">
            <div class="acct-mcp-tool-head">
              <code>{{ tool.name }}</code>
              <span v-if="tool.annotations?.readOnlyHint === false" class="mcp-srv-write">write</span>
              <span>{{ parameters(tool).length }} param{{ parameters(tool).length === 1 ? '' : 's' }}</span>
            </div>
            <p>{{ tool.description }}</p>
            <p v-if="parameters(tool).length" class="acct-mcp-params mono">
              <span v-for="param in parameters(tool)" :key="param">{{ param }}</span>
            </p>
          </li>
        </ul>
      </article>
    </template>
  </section>
</template>
