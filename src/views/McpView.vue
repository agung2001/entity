<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import HarnessIcon from '@/components/HarnessIcon.vue'
import { call } from '@/composables/localBridge'
import { matchesQuery } from '@/composables/search'
import { commandLine, definitionOf, envNames, poolEntries, transportOf } from '@/lib/mcp'
import { hub, toast } from '@/stores/hub'
import { workspaces, writeMcp } from '@/stores/workspaces'

const props = defineProps({
  /* Rendered inside Workspace → MCP; the parent owns the page head. */
  embedded: { type: Boolean, default: false },
})

/**
 * MCP inventory. The workspace pool and the harness configs on this machine
 * are two scopes of the same table: same columns, same search. A row opens the
 * server's own page — the table is for scanning, not for reading details.
 */
const route = useRoute()
const router = useRouter()
const scope = ref('workspace')
const search = ref('')
const harness = ref('all')
const sortKey = ref('name')
const sortDir = ref('asc')
const globals = reactive({ loading: false, loaded: false, error: '', groups: [], count: 0 })
const addOpen = ref(false)
const addBusy = ref(false)
const addError = ref('')
const addForm = reactive({ name: '', transport: 'stdio', command: '', args: '', url: '', env: '' })

const jsonOpen = ref(false)
const jsonText = ref('')
const jsonError = ref('')
const jsonBusy = ref(false)

const pool = computed(() => poolEntries(workspaces.mcp))
const poolServers = computed(() => poolEntries(workspaces.mcp).filter((entry) => entry.enabled))
const enabledCount = computed(() => poolServers.value.length)
const disabledCount = computed(() => pool.value.length - enabledCount.value)
const totalGlobals = computed(() => globals.groups.reduce((total, group) => total + (group.servers?.length || 0), 0))

const usedBy = (name) => hub.agents.filter((agent) => agent.mcp.includes(name)).map((agent) => agent.name)
const inPool = (name) => Boolean(workspaces.mcp?.servers?.[name])

function sourcesFor(name) {
  return globals.groups
    .filter((group) => (group.servers || []).some((server) => server.name === name))
    .map((group) => group.label)
}

function poolMatches(entry) {
  return matchesQuery(
    `${entry.name} ${commandLine(entry.definition)} ${envNames(entry.definition).join(' ')} ${usedBy(entry.name).join(' ')} ${sourcesFor(entry.name).join(' ')}`,
    search.value,
  )
}

function globalMatches(row) {
  return matchesQuery(
    `${row.name} ${row.harnessLabel} ${row.file} ${commandLine(row.definition)} ${envNames(row.definition).join(' ')}`,
    search.value,
  )
}

function compare(a, b) {
  const key = sortKey.value
  const left = String(key === 'transport' ? a.transport : key === 'harness' ? a.harnessLabel : a.name)
  const right = String(key === 'transport' ? b.transport : key === 'harness' ? b.harnessLabel : b.name)
  const order = left.localeCompare(right)
  return sortDir.value === 'asc' ? order : -order
}

const workspaceRows = computed(() =>
  poolServers.value
    .map((entry) => ({
      ...entry,
      kind: 'pool',
      transport: transportOf(entry.definition),
      command: commandLine(entry.definition),
      env: envNames(entry.definition),
      used: usedBy(entry.name),
      sources: sourcesFor(entry.name),
    }))
    .filter(poolMatches)
    .sort(compare),
)

const globalRows = computed(() => {
  if (harness.value !== 'all' && !globals.groups.some((group) => group.harness === harness.value)) return []
  return globals.groups
    .filter((group) => harness.value === 'all' || group.harness === harness.value)
    .flatMap((group) =>
      (group.servers || []).map((server) => {
        const definition = definitionOf(server)
        return {
          kind: 'global',
          name: server.name,
          definition,
          transport: transportOf(definition),
          command: commandLine(definition),
          env: envNames(definition),
          harness: group.harness,
          harnessLabel: group.label,
          file: (group.files || [])[0]?.path || '',
          source: group.harness,
        }
      }),
    )
    .filter(globalMatches)
    .sort(compare)
})

const rows = computed(() => (scope.value === 'workspace' ? workspaceRows.value : globalRows.value))
const totalRows = computed(() => (scope.value === 'workspace' ? enabledCount.value : totalGlobals.value))

function toggleSort(key) {
  if (sortKey.value === key) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else {
    sortKey.value = key
    sortDir.value = 'asc'
  }
}

function setScope(next) {
  scope.value = next
  harness.value = 'all'
  search.value = ''
}

function openRow(row) {
  router.push({
    name: 'mcp-server',
    params: { workspace: route.params.workspace || hub.workspace, name: row.name },
  })
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
  } catch (error) {
    globals.error = error?.message || 'Could not read the harness MCP configs.'
    globals.groups = []
    globals.count = 0
    globals.loaded = false
  } finally {
    globals.loading = false
  }
}

function beginAdd() {
  addForm.name = ''
  addForm.transport = 'stdio'
  addForm.command = ''
  addForm.args = ''
  addForm.url = ''
  addForm.env = ''
  addError.value = ''
  addOpen.value = true
}

function definitionFromForm() {
  if (addForm.transport === 'http') {
    if (!addForm.url.trim()) throw new Error('A remote server needs a URL.')
    return { url: addForm.url.trim() }
  }
  if (!addForm.command.trim()) throw new Error('A local server needs a command.')
  const definition = { command: addForm.command.trim() }
  const args = addForm.args
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
  if (args.length) definition.args = args
  const env = addForm.env
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (env.length) definition.env = env
  return definition
}

async function saveServer() {
  if (addBusy.value) return
  addError.value = ''
  const name = addForm.name.trim()
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    addError.value = 'Use letters, digits, dots, dashes or underscores for the server name.'
    return
  }
  let definition
  try {
    definition = definitionFromForm()
  } catch (error) {
    addError.value = error.message
    return
  }
  const next = { ...(workspaces.mcp?.servers || {}) }
  if (next[name]) {
    addError.value = `${name} is already in the workspace pool.`
    return
  }
  next[name] = definition
  addBusy.value = true
  try {
    await writeMcp(next)
    toast(`${name} added to the workspace pool`)
    addOpen.value = false
  } catch (error) {
    addError.value = error?.message || 'The server could not be saved.'
  } finally {
    addBusy.value = false
  }
}

function openJson() {
  jsonText.value = JSON.stringify(workspaces.mcp?.servers || {}, null, 2)
  jsonError.value = ''
  jsonOpen.value = true
}

async function saveJson() {
  if (jsonBusy.value) return
  jsonError.value = ''
  let parsed
  try {
    parsed = jsonText.value.trim() ? JSON.parse(jsonText.value) : {}
  } catch {
    jsonError.value = 'That is not valid JSON.'
    return
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    jsonError.value = 'The pool must be an object of server name → definition.'
    return
  }
  jsonBusy.value = true
  try {
    await writeMcp(parsed)
    toast('MCP pool saved')
    jsonOpen.value = false
  } catch (error) {
    jsonError.value = error?.message || 'The MCP pool could not be saved.'
  } finally {
    jsonBusy.value = false
  }
}

onMounted(() => {
  loadGlobals().catch(() => {})
})
</script>

<template>
  <div :class="props.embedded ? 'ws-embed mcp-inv' : 'view mcp-inv'">
    <div v-if="!props.embedded" class="page-head">
      <div>
        <p class="eyebrow">MCP · {{ hub.workspaceLabel || hub.workspace }}</p>
        <h1>MCP</h1>
        <p class="lede">
          Every server the workspace carries, and every server the harnesses already know.
          Every entity gets this pool; an entity can narrow it with <code class="mono">mcp: name</code>.
        </p>
      </div>
      <div class="head-actions">
        <button class="btn" type="button" @click="openJson">JSON</button>
        <button class="btn btn-ink" type="button" @click="beginAdd">
          <svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
            <path d="M8 3v10M3 8h10" />
          </svg>
          Add server
        </button>
      </div>
    </div>

    <header v-else class="mcp-inv-head">
      <div>
        <p class="eyebrow">MCP · {{ hub.workspaceLabel || hub.workspace }}</p>
        <h2>MCP inventory</h2>
        <p class="lede">
          The workspace pool and the harness configs on this machine, in one comparison table.
          Every entity gets the pool; an entity can narrow it with <code class="mono">mcp: name</code>.
        </p>
      </div>
      <div class="mcp-inv-actions">
        <button class="btn btn-sm" type="button" @click="openJson">JSON</button>
        <button class="btn btn-sm btn-ink" type="button" @click="beginAdd">
          <svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
            <path d="M8 3v10M3 8h10" />
          </svg>
          Add server
        </button>
      </div>
    </header>

    <div class="mcp-inv-tool">
      <label class="mcp-inv-search">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="7" cy="7" r="4.6" />
          <path d="M10.4 10.4L14 14" />
        </svg>
        <input
          v-model="search"
          type="search"
          placeholder="Search name, command, env or entity"
          aria-label="Search MCP servers"
          autocomplete="off"
        />
      </label>
      <div class="mcp-inv-seg" role="group" aria-label="MCP scope">
        <button
          type="button"
          :aria-pressed="scope === 'workspace' ? 'true' : 'false'"
          @click="setScope('workspace')"
        >Workspace <span>{{ enabledCount }}</span></button>
        <button
          type="button"
          :aria-pressed="scope === 'globals' ? 'true' : 'false'"
          @click="setScope('globals')"
        >On this machine <span>{{ totalGlobals }}</span></button>
      </div>
      <div v-if="scope === 'globals'" class="mcp-inv-chips" role="group" aria-label="Harness filter">
        <button
          type="button"
          :aria-pressed="harness === 'all' ? 'true' : 'false'"
          @click="harness = 'all'"
        >All harnesses</button>
        <button
          v-for="group in globals.groups"
          :key="group.harness"
          type="button"
          :aria-pressed="harness === group.harness ? 'true' : 'false'"
          @click="harness = group.harness"
        >
          <HarnessIcon :name="group.harness" :size="11" />
          {{ group.label }}
        </button>
      </div>
      <span class="mcp-inv-spacer"></span>
      <span class="mcp-inv-count">
        {{ rows.length }} of {{ totalRows }} {{ scope === 'workspace' ? 'servers' : 'on this machine' }}
      </span>
    </div>

    <div v-if="globals.error" class="acct-error" role="alert">
      {{ globals.error }}
      <button class="btn btn-sm" type="button" @click="loadGlobals(true)">Try again</button>
    </div>

    <div v-if="scope === 'globals' && globals.loading && !globals.groups.length" class="empty-note">
      <b>Reading harness MCP configs…</b>
    </div>

    <div v-else-if="rows.length" class="mcp-inv-table" :class="{ 'is-global': scope === 'globals' }">
      <div class="mcp-inv-thead">
        <button type="button" class="mcp-inv-th" @click="toggleSort('name')">
          Server
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.2 6.2L5 3.4l2.8 2.8" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
        </button>
        <button v-if="scope === 'workspace'" type="button" class="mcp-inv-th" @click="toggleSort('transport')">
          Transport
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.2 6.2L5 3.4l2.8 2.8" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
        </button>
        <button v-else type="button" class="mcp-inv-th" @click="toggleSort('harness')">
          Harness
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.2 6.2L5 3.4l2.8 2.8" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
        </button>
        <span v-if="scope === 'workspace'">Command / URL</span>
        <span v-else>Command / URL</span>
        <span>Env</span>
        <span>{{ scope === 'workspace' ? 'Named by' : 'Source file' }}</span>
        <span v-if="scope === 'workspace'">Source</span>
        <span v-else>Pool</span>
        <span></span>
      </div>

      <div class="mcp-inv-body">
        <div
          v-for="row in rows"
          :key="`${row.kind}:${row.harness || 'pool'}:${row.name}`"
          class="mcp-inv-row"
          role="button"
          tabindex="0"
          @click="openRow(row)"
          @keydown.enter="openRow(row)"
          @keydown.space.prevent="openRow(row)"
        >
          <span class="mcp-inv-nm">
            <b>{{ row.name }}</b>
            <span>{{ row.kind === 'pool' ? (row.transport === 'http' ? 'remote' : 'local') : row.harnessLabel }}</span>
          </span>
          <span v-if="scope === 'workspace'">
            <span class="mcp-inv-tc" :data-t="row.transport"><i></i>{{ row.transport === 'http' ? 'http' : 'stdio' }}</span>
          </span>
          <span v-else class="mcp-inv-harness">
            <HarnessIcon :name="row.harness" :size="11" />
            {{ row.harnessLabel }}
          </span>
          <span class="mono mcp-inv-command">{{ row.command }}</span>
          <span class="mono mcp-inv-env">{{ row.env.length ? row.env.join(', ') : '—' }}</span>
          <span v-if="scope === 'workspace'" class="mcp-inv-used">
            <span v-if="row.used.length" v-for="entity in row.used" :key="entity" class="mcp-inv-u">{{ entity }}</span>
            <span v-else class="mcp-inv-none">every entity</span>
          </span>
          <span v-else class="mono mcp-inv-file">{{ row.file || '—' }}</span>
          <span v-if="scope === 'workspace'" class="mcp-inv-src">
            <span v-if="row.sources.length" v-for="source in row.sources" :key="source" class="mcp-inv-s">{{ source }}</span>
            <span v-else class="mcp-inv-s">only here</span>
          </span>
          <span v-else class="mcp-inv-flag" :data-on="inPool(row.name) ? '1' : '0'">
            {{ inPool(row.name) ? 'in pool' : '—' }}
          </span>
          <span class="mcp-inv-end">
            <button
              class="mcp-inv-menu"
              type="button"
              :aria-label="`Open details for ${row.name}`"
              @click.stop="openRow(row)"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <circle cx="3.2" cy="8" r="1.35" /><circle cx="8" cy="8" r="1.35" /><circle cx="12.8" cy="8" r="1.35" />
              </svg>
            </button>
          </span>
        </div>
      </div>
    </div>

    <div v-else-if="!globals.loading" class="empty-note mcp-inv-empty">
      <b>{{ scope === 'workspace' && !enabledCount ? 'No MCP servers in this pool yet.' : 'Nothing matches.' }}</b>
      <span>
        {{ scope === 'workspace' && !enabledCount ? 'Add one, or attach a server the harnesses already know.' : 'Search covers names, commands, env keys, entities and harnesses.' }}
      </span>
      <button v-if="scope === 'workspace' && !enabledCount" class="btn btn-ink" type="button" @click="beginAdd">
        Add server
      </button>
    </div>

    <div class="mcp-inv-foot">
      <span><b>{{ enabledCount }}</b> in the pool · <b>{{ hub.agents.filter((agent) => agent.mcp.length).length }}</b> narrow it · <b>{{ totalGlobals }}</b> on this machine</span>
      <span class="r">Harness configs stay read-only · strict {{ workspaces.mcp?.strict ? 'on' : 'off' }}</span>
    </div>

    <Teleport to="body">
      <div class="scrim" :data-open="addOpen || jsonOpen ? '1' : '0'" @click="addOpen = false; jsonOpen = false"></div>
      <div class="modal mcp-modal" :data-open="addOpen ? '1' : '0'" role="dialog" aria-modal="true" aria-label="MCP server">
        <div class="mo-head">
          <h2>Add MCP server</h2>
          <p>Write the definition into this workspace's pool. Env holds variable names only.</p>
          <button class="x mo-x" type="button" aria-label="Close" @click="addOpen = false">
            <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5"><path d="M2 2l8 8M10 2l-8 8" /></svg>
          </button>
        </div>
        <form class="mo-body" @submit.prevent="saveServer">
          <div class="fld">
            <label class="lbl" for="mcp-server-name">Name</label>
            <input id="mcp-server-name" v-model="addForm.name" type="text" class="acct-input mono" spellcheck="false" :disabled="addBusy" />
          </div>
          <div class="fld">
            <label class="lbl" for="mcp-server-transport">Transport</label>
            <select id="mcp-server-transport" v-model="addForm.transport" class="acct-input" :disabled="addBusy">
              <option value="stdio">Local · stdio</option>
              <option value="http">Remote · URL</option>
            </select>
          </div>
          <template v-if="addForm.transport === 'stdio'">
            <div class="fld">
              <label class="lbl" for="mcp-server-command">Command</label>
              <input id="mcp-server-command" v-model="addForm.command" type="text" class="acct-input mono" placeholder="npx" spellcheck="false" :disabled="addBusy" />
            </div>
            <div class="fld">
              <label class="lbl" for="mcp-server-args">Arguments</label>
              <textarea id="mcp-server-args" v-model="addForm.args" class="acct-input mono" rows="3" placeholder="One argument per line" spellcheck="false" :disabled="addBusy"></textarea>
            </div>
          </template>
          <div v-else class="fld">
            <label class="lbl" for="mcp-server-url">URL</label>
            <input id="mcp-server-url" v-model="addForm.url" type="url" class="acct-input mono" placeholder="https://example.com/mcp" spellcheck="false" :disabled="addBusy" />
          </div>
          <div class="fld">
            <label class="lbl" for="mcp-server-env">Env names</label>
            <input id="mcp-server-env" v-model="addForm.env" type="text" class="acct-input mono" placeholder="GITHUB_TOKEN, LINEAR_TOKEN" spellcheck="false" :disabled="addBusy" />
            <p class="mnote">Comma-separated names. Values stay in the environment, never in mcp.json.</p>
          </div>
          <p v-if="addError" class="acct-error" role="alert">{{ addError }}</p>
          <div class="mo-foot" style="padding: 8px 0 0; border: 0">
            <button class="btn" type="button" :disabled="addBusy" @click="addOpen = false">Cancel</button>
            <button class="btn btn-ink" type="submit" :disabled="addBusy">{{ addBusy ? 'Saving…' : 'Add server' }}</button>
          </div>
        </form>
      </div>

      <div class="modal modal-narrow mcp-modal" :data-open="jsonOpen ? '1' : '0'" role="dialog" aria-modal="true" aria-label="MCP pool JSON">
        <div class="mo-head">
          <h2>Pool JSON</h2>
          <p>{{ workspaces.mcp?.path || 'mcp.json' }}</p>
          <button class="x mo-x" type="button" aria-label="Close" @click="jsonOpen = false">
            <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5"><path d="M2 2l8 8M10 2l-8 8" /></svg>
          </button>
        </div>
        <div class="mo-body">
          <textarea v-model="jsonText" class="mcp-editor mono" rows="16" spellcheck="false"></textarea>
          <p v-if="jsonError" class="acct-error" role="alert">{{ jsonError }}</p>
          <div class="mo-foot" style="padding: 8px 0 0; border: 0">
            <button class="btn" type="button" @click="jsonOpen = false">Cancel</button>
            <button class="btn btn-ink" type="button" :disabled="jsonBusy" @click="saveJson">{{ jsonBusy ? 'Saving…' : 'Save pool' }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
