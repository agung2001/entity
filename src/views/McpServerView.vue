<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { call } from '@/composables/localBridge'
import { copyText } from '@/lib/clipboard'
import { commandLine, definitionOf, envNames, transportOf } from '@/lib/mcp'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import { hub, toast } from '@/stores/hub'
import { setMcpEnabled, workspaces, writeMcp } from '@/stores/workspaces'

/**
 * One MCP server, as a page — the same shell as the entity detail page
 * (`entp-*` is the shared detail layout, not an entity-only style).
 *
 * Two columns, one question each: the main column is what it can do (`Tools`)
 * and what it needs (`Environment`); the rail is the definition — the facts,
 * the places that name it, and the verbs. Per-entity reach is not drawn here:
 * a server in `mcp.json` is offered to every entity, and an `mcp:` line is an
 * override an entity's author typed, not something this page hands out.
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
const poolEntry = computed(() => poolServers.value[name.value] || poolDisabled.value[name.value] || null)
/* Set when sync parked it: the definition points at the machine that shared
   it, so enabling it here would offer a server that cannot answer. */
const parkedReason = computed(() =>
  enabled.value ? '' : String(poolDisabled.value[name.value]?.__unavailable || ''),
)

/* Every harness config on this machine, read once per visit. The rail lists
   what this returns and nothing else — a path or a label is never guessed. */
const globalGroups = ref([])
const globalLoading = ref(false)
/* The first harness copy of this name: the definition `Attach` copies in, and
   what a server the workspace does not own is drawn from. */
const globalRow = ref(null)

const definition = computed(() => poolEntry.value || globalRow.value?.definition || null)
const transport = computed(() => (definition.value ? transportOf(definition.value) : 'unknown'))
const command = computed(() => (definition.value ? commandLine(definition.value) : ''))
const envKeys = computed(() => envNames(definition.value))

const tools = ref({ loading: false, error: '', list: [] })
const query = ref('')
const searchEl = ref(null)
const kind = ref('all')
const searchKey = shortcutLabel('inventory-search')
const editing = ref(false)
const draft = ref('')
const draftError = ref('')
const saving = ref(false)
const confirming = ref(false)

/**
 * `write` means this call can change something over there.
 *
 * ponytail: it is read off the verb the tool name leads with — the page has no
 * other signal. When a server sends `annotations.readOnlyHint` (MCP) or
 * `x-mcp-group`, read those instead and delete both derivations below.
 */
const WRITE_VERBS = new Set([
  'add', 'assign', 'attach', 'change', 'close', 'create', 'delete', 'detach', 'edit', 'link',
  'log', 'manage', 'merge', 'move', 'patch', 'post', 'publish', 'put', 'remove', 'rename',
  'replace', 'run', 'set', 'submit', 'update', 'write',
])

/* `issues` → `issue`, so a name that says `get_issue` and one that says
   `search_issues` count as the same group. ponytail: this is spelling, not
   grammar — `statuses` → `statuse`. Real group metadata replaces it. */
const singular = (word) =>
  word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word

/** The name as words, camelCase included, leading verb first. */
function wordsOf(toolName) {
  return String(toolName || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/**
 * One row per tool, from what the server reported and nothing else.
 *
 * The group tag is the server's own vocabulary, derived: the first noun after
 * the leading verb that more than one tool name in this list also carries, or
 * the verb itself when nothing is shared.
 */
const toolRows = computed(() => {
  const list = tools.value.list || []
  const words = list.map((tool) => wordsOf(tool.name))
  const shared = new Map()
  for (const tokens of words) {
    for (const noun of new Set(tokens.slice(1).map(singular))) {
      shared.set(noun, (shared.get(noun) || 0) + 1)
    }
  }
  return list.map((tool, index) => {
    const tokens = words[index]
    const noun = tokens.slice(1).map(singular).find((word) => (shared.get(word) || 0) > 1)
    return {
      name: tool.name,
      about: String(tool.description || ''),
      index: String(index + 1).padStart(2, '0'),
      group: noun || tokens[0] || '',
      write: WRITE_VERBS.has(tokens[0] || ''),
    }
  })
})

const counts = computed(() => {
  const write = toolRows.value.filter((row) => row.write).length
  return { all: toolRows.value.length, write, read: toolRows.value.length - write }
})

/** Name and description: what a person remembers about a tool is one or the other. */
const searchedTools = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return toolRows.value
  return toolRows.value.filter((row) => `${row.name} ${row.about}`.toLowerCase().includes(needle))
})

/* The filters count what the search left, so each label is the number of rows
   that clicking it shows; the section head keeps the server's own totals. */
const kindFilters = computed(() => {
  const write = searchedTools.value.filter((row) => row.write).length
  return [
    { id: 'all', label: 'All', count: searchedTools.value.length },
    { id: 'read', label: 'Read', count: searchedTools.value.length - write },
    { id: 'write', label: 'Write', count: write },
  ]
})

const visibleTools = computed(() =>
  kind.value === 'all'
    ? searchedTools.value
    : searchedTools.value.filter((row) => (row.write ? 'write' : 'read') === kind.value),
)

const toolsHead = computed(() => {
  if (tools.value.loading) return 'asking…'
  const { all, read, write } = counts.value
  if (!all) return 'none reported'
  return `${all} from the server · ${read} read · ${write} write`
})

/* Why the section has no rows — silence used to be the answer, and it reads
   exactly like a server that exposes nothing. */
const toolsNote = computed(() => {
  if (tools.value.loading || tools.value.error || toolRows.value.length) return ''
  if (!definition.value) {
    return globalLoading.value
      ? 'Still looking for a definition of this server on this machine.'
      : 'No definition to read: no harness here declares this server, so there is nothing to ask for a tool list.'
  }
  return 'This server reported no tools. An HTTP server that needs a token will answer empty when the token is missing.'
})

const noMatchNote = computed(() =>
  query.value.trim()
    ? 'No tool matches that. The list is whatever the server reported — refresh to re-ask it.'
    : `This server has no ${kind.value} tools.`,
)

/* Where this name is defined: the workspace pool, then one row per harness. */
const places = computed(() => {
  const rows = [
    {
      id: 'workspace',
      label: 'this workspace',
      path: workspaces.mcp?.path || 'mcp.json',
      on: inPool.value,
    },
  ]
  for (const group of globalGroups.value) {
    const declares = (group.servers || []).some((server) => server.name === name.value)
    rows.push({
      id: group.harness,
      label: group.label,
      path: declares ? group.files?.[0]?.path || '' : 'not defined',
      on: declares,
    })
  }
  return rows
})

const definedPlaces = computed(() => places.value.filter((place) => place.on).length)

/** What the page shows by default: names and URLs, never a stored value. */
const masked = computed(() => {
  if (!definition.value) return ''
  const copy = JSON.parse(JSON.stringify(definition.value))
  /* `__remote` / `__pinned` / `__unavailable` are workspace bookkeeping, not part
     of the definition; the page states the parked reason in prose instead. */
  for (const key of Object.keys(copy)) {
    if (key.startsWith('__')) delete copy[key]
  }
  if (copy.headers && typeof copy.headers === 'object' && !Array.isArray(copy.headers)) {
    for (const key of Object.keys(copy.headers)) copy.headers[key] = '•••'
  }
  if (copy.env && typeof copy.env === 'object' && !Array.isArray(copy.env)) {
    for (const key of Object.keys(copy.env)) copy.env[key] = '•••'
  }
  return JSON.stringify(copy, null, 2)
})

async function loadGlobal() {
  globalLoading.value = true
  try {
    const data = await call('mcp.globals')
    globalGroups.value = data?.groups || []
    globalRow.value = null
    for (const group of globalGroups.value) {
      const hit = (group.servers || []).find((server) => server.name === name.value)
      if (!hit) continue
      globalRow.value = { ...hit, harnessLabel: group.label, definition: definitionOf(hit) }
      break
    }
  } catch {
    /* A read that failed draws no places: never guess a path. */
    globalGroups.value = []
    globalRow.value = null
  } finally {
    globalLoading.value = false
  }
}

async function loadTools(force = false) {
  if (!definition.value) {
    tools.value = { loading: false, error: '', list: [] }
    return
  }
  tools.value = { loading: true, error: '', list: force ? [] : tools.value.list }
  try {
    const data = await call('mcp.tools', { workspace: hub.workspace, name: name.value })
    tools.value = { loading: false, error: '', list: data?.tools || [] }
  } catch (error) {
    tools.value = { loading: false, error: error?.message || 'The server did not answer.', list: [] }
  }
}

function focusSearch() {
  const field = searchEl.value
  if (!(field instanceof HTMLInputElement)) return
  field.focus()
  field.select()
}

/* The catalog's list-search combo focuses the tool search — but only when the
   caret is not already in a field, so typing a path or a command still types. */
function onKey(event) {
  if (!matchesShortcut('inventory-search', event)) return
  event.preventDefault()
  focusSearch()
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

/* Attach copies another file's definition in verbatim, so it asks twice like
   Detach: the first click arms the button, the second one copies. The two verbs
   never render together, so they share the one flag and the one disarm. */
function confirmAttach() {
  if (!confirming.value) {
    confirming.value = true
    return
  }
  confirming.value = false
  attach()
}

async function attach() {
  if (!globalRow.value?.definition) {
    toast('That server has neither a command nor a URL.')
    return
  }
  try {
    await writeMcp({ ...poolServers.value, [name.value]: globalRow.value.definition })
    toast(`${name.value} attached to this workspace`)
    await loadTools(true)
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

async function copyJson() {
  if (!definition.value) return
  const copied = await copyText(JSON.stringify(definition.value, null, 2))
  toast(copied ? 'definition copied' : 'The clipboard is not available.')
}

function back() {
  router.push({ name: 'mcp', params: { workspace: route.params.workspace } })
}

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  await loadGlobal()
  await loadTools()
})

onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

watch(name, async () => {
  editing.value = false
  confirming.value = false
  globalRow.value = null
  await loadGlobal()
  await loadTools()
})
</script>

<template>
  <div class="view detail-view">
    <div class="entp-bar">
      <button class="back" type="button" @click="back">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7.5 2.5L4 6l3.5 3.5" /></svg>
        MCP
      </button>
      <span class="entp-crumb">{{ name }}</span>
      <span class="spacer"></span>
      <div class="entp-actions">
        <button class="btn btn-sm" type="button" :disabled="!definition" @click="copyJson">
          Copy definition
        </button>
      </div>
    </div>

    <template v-if="definition">
      <header class="entp-idhead">
        <div class="mcpp-mark" :data-t="transport" aria-hidden="true">
          <svg v-if="transport === 'http'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3c2.6 2.5 4 5.6 4 9s-1.4 6.5-4 9c-2.6-2.5-4-5.6-4-9s1.4-6.5 4-9z" />
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="4" width="18" height="6" rx="1.6" />
            <rect x="3" y="14" width="18" height="6" rx="1.6" />
            <path d="M7 7h.01M7 17h.01" stroke-linecap="round" />
          </svg>
        </div>
        <div class="entp-title">
          <p class="eyebrow">MCP · {{ hub.workspaceLabel || hub.workspace }}</p>
          <h1>{{ name }}</h1>
          <code class="mcpp-cmd" :title="command">{{ command }}</code>
          <div class="entp-chips">
            <span class="mcpp-chip" :data-on="inPool && enabled ? '1' : '0'">
              <i aria-hidden="true"></i>{{ !inPool ? 'not attached' : enabled ? 'attached' : 'parked' }}
            </span>
            <button
              v-if="inPool"
              class="mcpp-chip mcpp-chip-btn"
              type="button"
              :title="
                enabled
                  ? 'Park keeps the definition and takes it out of every turn'
                  : 'Enable puts it back into every turn'
              "
              @click="toggleEnabled"
            >{{ enabled ? 'park' : 'enable' }}</button>
            <span class="entp-chip">{{ transport === 'http' ? 'remote · http' : 'local · stdio' }}</span>
            <span class="entp-chip">{{ tools.loading ? 'asking…' : `${counts.all} tools` }}</span>
            <span class="entp-chip">every entity</span>
          </div>
          <p v-if="parkedReason" class="mcpp-note">
            Parked because {{ parkedReason }}. Enable it if this machine really does run it —
            the pin then keeps the next sync from parking it again.
          </p>
        </div>
      </header>

      <div class="entp-grid">
        <div class="entp-main">
          <section class="entp-sec">
            <div class="entp-sec-head">
              <h2>Tools</h2>
              <span class="n">{{ toolsHead }}</span>
              <button class="r" type="button" :disabled="tools.loading" @click="loadTools(true)">
                Refresh
              </button>
            </div>

            <p v-if="tools.error" class="mcpp-note" data-bad="1">{{ tools.error }}</p>
            <template v-else>
              <div class="skbar">
                <label class="sksearch mcpp-tool-search">
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                    aria-hidden="true"
                  >
                    <circle cx="7" cy="7" r="4.3" />
                    <path d="M10.3 10.3L14 14" />
                  </svg>
                  <input
                    ref="searchEl"
                    v-model="query"
                    type="search"
                    :placeholder="`Search ${toolRows.length} tools — name, or what it does`"
                    aria-label="Search this server's tools by name or description"
                    spellcheck="false"
                  />
                  <kbd class="sksearch-key search-kbd" aria-hidden="true">{{ searchKey }}</kbd>
                </label>
                <div class="mcpp-seg" role="group" aria-label="Filter tools by kind">
                  <button
                    v-for="filter in kindFilters"
                    :key="filter.id"
                    type="button"
                    :aria-pressed="kind === filter.id ? 'true' : 'false'"
                    @click="kind = filter.id"
                  >
                    {{ filter.label }} <span>{{ filter.count }}</span>
                  </button>
                </div>
              </div>

              <ul v-if="visibleTools.length" class="mcp-tool-list">
                <li v-for="tool in visibleTools" :key="tool.name">
                  <span class="ix">{{ tool.index }}</span>
                  <b :title="tool.name">{{ tool.name }}</b>
                  <span class="about">{{ tool.about || 'no description from the server' }}</span>
                  <span class="grp" :title="tool.group">{{ tool.group }}</span>
                  <span class="kind" :data-w="tool.write ? '1' : '0'">{{ tool.write ? 'write' : 'read' }}</span>
                </li>
              </ul>
              <p v-else-if="toolRows.length && !tools.loading" class="mcpp-note">{{ noMatchNote }}</p>
              <p v-else-if="toolsNote" class="mcpp-note">{{ toolsNote }}</p>
            </template>
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
              Values live in this workspace, are handed to the harness when the turn starts,
              and are never returned by any read here.
            </p>
          </section>
        </div>

        <aside class="entp-rail mcpp-rail">
          <p class="entp-rail-h">This server</p>
          <dl class="entp-facts">
            <div><dt>Status</dt><dd>{{ !inPool ? 'not attached' : enabled ? 'attached' : 'parked' }}</dd></div>
            <div><dt>Transport</dt><dd>{{ transport === 'http' ? 'remote · http' : 'local · stdio' }}</dd></div>
            <div v-if="definition.url">
              <dt>URL</dt><dd class="mono" :title="definition.url">{{ definition.url }}</dd>
            </div>
            <div v-else><dt>Command</dt><dd class="mono">{{ definition.command }}</dd></div>
            <div>
              <dt>Headers</dt>
              <dd class="mono">{{ definition.headers ? Object.keys(definition.headers).join(', ') : 'none' }}</dd>
            </div>
            <div v-if="definition.args?.length">
              <dt>Args</dt><dd class="mono" :title="definition.args.join(' ')">{{ definition.args.join(' ') }}</dd>
            </div>
            <div><dt>Tools</dt><dd>{{ tools.loading ? 'asking…' : tools.list.length }}</dd></div>
          </dl>

          <p class="entp-rail-h">
            Defined in<span class="n">{{ definedPlaces }} of {{ places.length }} places</span>
          </p>
          <div class="mcpp-places">
            <div
              v-for="place in places"
              :key="place.id"
              :data-off="place.on ? '0' : '1'"
            >
              <i class="dot" aria-hidden="true"></i>
              <span class="pn">{{ place.label }}</span>
              <span class="pp" :title="place.path">{{ place.path }}</span>
              <button
                v-if="place.id === 'workspace' && place.on"
                class="edit"
                type="button"
                :aria-expanded="editing ? 'true' : 'false'"
                @click="editing ? cancelEdit() : startEdit()"
              >{{ editing ? 'Cancel' : 'Edit' }}</button>
            </div>

            <div v-if="editing" class="editbox">
              <pre class="codebox">{{ masked }}</pre>
              <textarea
                v-model="draft"
                class="mcp-editor mono"
                rows="10"
                spellcheck="false"
                aria-label="This workspace's JSON, values included"
              ></textarea>
              <p class="mcpp-note">
                Above is what is stored, values masked. The text rewrites it here, tokens
                included, when you save.
              </p>
              <p v-if="draftError" class="acct-error" role="alert">{{ draftError }}</p>
              <div class="mcpp-actions">
                <button class="btn btn-ink btn-sm" type="button" :disabled="saving" @click="save">
                  {{ saving ? 'Saving…' : 'Save definition' }}
                </button>
              </div>
            </div>

            <p v-if="definedPlaces > 1" class="warn">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                <circle cx="8" cy="8" r="6" />
                <path d="M8 5v3.5M8 11h.01" />
              </svg>
              <span>
                Two copies, one name: a turn reads the file it runs from, so they can drift,
                and editing here does not touch the other file.
              </span>
            </p>
          </div>

          <p class="entp-rail-h">Manage</p>
          <div class="entp-rail-actions">
            <button type="button" :disabled="!definition" @click="copyJson">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                <rect x="3.4" y="3.4" width="9.2" height="10.2" rx="1.6" />
                <path d="M6 3.4V2.6h4v.8M5.8 7.2h4.4M5.8 9.8h3.2" />
              </svg>
              <span class="nm">Copy definition</span>
              <span class="hint">JSON</span>
            </button>

            <button
              v-if="!inPool"
              class="tall"
              type="button"
              :disabled="!globalRow?.definition"
              :title="
                globalRow?.definition
                  ? 'Copy the harness definition in verbatim and attach it to this workspace'
                  : 'No harness on this machine declares this server — there is nothing to copy in'
              "
              :aria-label="
                confirming
                  ? 'Click again to copy that definition in and attach this server to the workspace'
                  : 'Attach — copy the definition a harness config already declares into this workspace'
              "
              @click="confirmAttach"
              @blur="confirming = false"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                <path d="M8 2.8v5.6M5.6 6L8 8.4 10.4 6M3 11.2v1.6a1 1 0 001 1h8a1 1 0 001-1v-1.6" />
              </svg>
              <span class="row2">
                <span class="nm">Attach</span>
                <i>
                  find other instance — {{ globalRow?.harnessLabel || 'a harness' }} defines
                  this too; copied in verbatim, tokens differ
                </i>
              </span>
              <span class="hint">{{ confirming ? 'click again' : `${definedPlaces} found` }}</span>
            </button>
            <template v-else>
              <div class="sep" aria-hidden="true"></div>
              <button
                type="button"
                data-danger="1"
                :aria-label="
                  confirming
                    ? 'Click again to detach this server from the workspace, for every entity'
                    : 'Detach this server from the workspace, for every entity'
                "
                @click="remove"
                @blur="confirming = false"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                  <path d="M3.2 4.6h9.6M6.2 4.6V3.2h3.6v1.4M4.6 4.6l.6 8.4h5.6l.6-8.4" />
                </svg>
                <span class="nm">Detach</span>
                <span class="hint">{{ confirming ? 'click again' : 'click twice' }}</span>
              </button>
            </template>
          </div>
        </aside>
      </div>
    </template>

    <section v-else class="cpanel cpanel-empty">
      <div class="empty-note">
        <b>{{ globalLoading ? 'Looking for that server…' : 'No MCP server called that.' }}</b>
        <span>
          It is not attached to this workspace, and no harness on this machine declares it.
          Add it on the MCP page.
        </span>
        <button class="btn btn-sm" type="button" @click="back">Back to MCP</button>
      </div>
    </section>
  </div>
</template>
