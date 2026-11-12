<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import { call } from '@/composables/localBridge'
import { hub, toast } from '@/stores/hub'
import { workspaces, writeMcp } from '@/stores/workspaces'

/**
 * MCP is its own page now: the workspace pool on one tab, and the servers each
 * harness already has configured on the other. The globals tab is read-only —
 * this app does not rewrite another tool's config.
 */
const tab = ref('workspace')
const mcpText = ref('')
const error = ref('')
const busy = ref(false)
const globals = reactive({ loading: false, loaded: false, error: '', groups: [], count: 0 })

const servers = computed(() =>
  Object.entries(workspaces.mcp?.servers || {}).map(([name, value]) => ({
    name,
    command: String(value?.command || ''),
    args: Array.isArray(value?.args) ? value.args.map(String) : [],
    url: String(value?.url || ''),
    env: Array.isArray(value?.env) ? value.env : [],
  })),
)

const commandLine = (server) => {
  if (server.command) return [server.command, ...(server.args || [])].join(' ')
  return server.url || '—'
}

function syncMcp() {
  const source = workspaces.mcp?.servers || {}
  mcpText.value = Object.keys(source).length ? JSON.stringify(source, null, 2) : '{\n  \n}'
  error.value = ''
}

async function saveMcp() {
  if (busy.value) return
  error.value = ''
  let parsed
  try {
    parsed = mcpText.value.trim() ? JSON.parse(mcpText.value) : {}
  } catch {
    error.value = 'That is not valid JSON.'
    return
  }
  busy.value = true
  try {
    await writeMcp(parsed)
    toast('MCP pool saved')
  } catch (problem) {
    error.value = problem?.message || 'The MCP pool could not be saved.'
  } finally {
    busy.value = false
  }
}

async function loadGlobals(force = false) {
  if (!force && (globals.loading || globals.loaded)) return
  globals.loading = true
  globals.error = ''
  try {
    const data = await call('mcp.globals')
    globals.groups = data?.groups || []
    globals.count = data?.count || 0
    globals.loaded = true
  } catch (problem) {
    globals.error = problem?.message || 'Could not read the harness MCP configs.'
    globals.groups = []
    globals.count = 0
    globals.loaded = false
  } finally {
    globals.loading = false
  }
}

onMounted(syncMcp)

watch(() => workspaces.mcp, syncMcp, { deep: true })
watch(tab, (value) => {
  if (value === 'globals') loadGlobals()
})
</script>

<template>
  <div class="view">
    <div class="page-head">
      <div>
        <p class="eyebrow">MCP · {{ hub.workspaceLabel || hub.workspace }}</p>
        <h1>MCP</h1>
        <p class="lede">
          The workspace pool is what an entity opts into with <code class="mono">mcp: name</code>.
          Globals are read from each harness's own configuration on this machine —
          <code class="mono">~/.claude.json</code>, <code class="mono">~/.codex/config.toml</code>,
          <code class="mono">~/.pi/agent/mcp.json</code>, and the rest.
        </p>
      </div>
      <div class="head-actions">
        <span class="meta">
          {{ servers.length }} in the workspace ·
          {{ globals.loaded ? `${globals.count} global` : 'globals on demand' }}
        </span>
      </div>
    </div>

    <div class="sk-tabs" role="tablist" aria-label="MCP scope">
      <button
        role="tab"
        :aria-selected="tab === 'workspace' ? 'true' : 'false'"
        @click="tab = 'workspace'"
      >
        Workspace <span class="n">{{ servers.length }}</span>
      </button>
      <button
        role="tab"
        :aria-selected="tab === 'globals' ? 'true' : 'false'"
        @click="tab = 'globals'"
      >
        Globals <span v-if="globals.loaded" class="n">{{ globals.count }}</span>
      </button>
    </div>

    <template v-if="tab === 'workspace'">
      <div class="lib-bar">
        <span class="lib-meta">
          One pool for the workspace; an entity opts in with
          <code class="mono">mcp: name</code>.
        </span>
        <span class="lib-meta mono">{{ workspaces.mcp?.path || '' }}</span>
      </div>

      <div v-if="servers.length" class="grid3">
        <article v-for="server in servers" :key="server.name" class="card2">
          <div class="card-top">
            <h3>{{ server.name }}</h3>
          </div>
          <p class="p mono">{{ commandLine(server) }}</p>
          <p v-if="server.env.length" class="desc">
            env keys: <span class="mono">{{ server.env.join(', ') }}</span>
          </p>
          <div class="foot">
            <span>{{ server.url ? 'remote' : 'local' }}</span>
            <span>{{ server.args.length }} args</span>
          </div>
        </article>
      </div>
      <div v-else class="empty-note">
        <b>No MCP servers in this workspace yet.</b>
        <span>Add one below; an entity can then name it in its frontmatter.</span>
      </div>

      <section class="acct-card" style="margin-top: 16px">
        <div class="acct-card-head">
          <h2>Pool editor</h2>
          <span class="mnote">JSON · env holds variable names</span>
        </div>
        <p class="mnote">
          <code class="mono">env</code> holds variable <em>names</em> — values resolve from the
          environment when a chat starts and are never written here. Enforced for
          <b>claude</b> conversations only (<code class="mono">--strict-mcp-config</code>:
          {{ workspaces.mcp.strict ? 'on' : 'off' }}).
        </p>
        <textarea
          v-model="mcpText"
          class="mcp-editor mono"
          rows="10"
          spellcheck="false"
          :disabled="busy"
        ></textarea>
        <p v-if="error" class="acct-error" role="alert">{{ error }}</p>
        <div class="acct-actions">
          <button class="btn btn-ink" type="button" :disabled="busy" @click="saveMcp">
            {{ busy ? 'Saving…' : 'Save pool' }}
          </button>
        </div>
      </section>
    </template>

    <template v-else>
      <div class="lib-bar">
        <span class="lib-meta">
          Read-only. Every MCP server each harness already has configured on this machine.
        </span>
        <button class="btn btn-sm" type="button" :disabled="globals.loading" @click="loadGlobals(true)">
          {{ globals.loading ? 'Reading…' : 'Refresh' }}
        </button>
      </div>

      <div v-if="globals.loading" class="empty-note">
        <b>Reading harness MCP configs…</b>
      </div>
      <div v-else-if="globals.error" class="empty-note">
        <b>{{ globals.error }}</b>
        <button class="btn btn-sm" type="button" @click="loadGlobals(true)">Try again</button>
      </div>
      <div v-else-if="!globals.groups.length" class="empty-note">
        <b>No global MCP servers found.</b>
        <span>The harnesses on this machine do not have an MCP config with servers yet.</span>
      </div>

      <template v-else>
        <section v-for="group in globals.groups" :key="group.harness" class="mcp-group">
          <div class="sec-head">
            <h2 class="mcp-group-title">
              <HarnessIcon :name="group.harness" :size="14" />
              {{ group.label }}
            </h2>
            <span class="meta">{{ group.servers.length }} servers</span>
          </div>
          <p class="mnote mcp-files">
            {{ group.files.map((file) => file.path).join(' · ') }}
          </p>
          <div class="grid3">
            <article v-for="server in group.servers" :key="`${group.harness}:${server.name}`" class="card2">
              <div class="card-top">
                <h3>{{ server.name }}</h3>
              </div>
              <p class="p mono">{{ commandLine(server) }}</p>
              <p v-if="server.env.length" class="desc">
                env keys: <span class="mono">{{ server.env.join(', ') }}</span>
              </p>
              <div class="foot">
                <span>{{ server.url ? 'remote' : 'local' }}</span>
                <span class="mono">{{ server.configPath }}</span>
              </div>
            </article>
          </div>
        </section>
      </template>
    </template>
  </div>
</template>
