<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import ConnectorKindPicker from '@/components/ConnectorKindPicker.vue'
import IntegrationMark from '@/components/IntegrationMark.vue'
import ConnectorRow from '@/components/ConnectorRow.vue'
import { useDialogDismiss } from '@/composables/useDialog'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import { hub, toast } from '@/stores/hub'
import { workspaces, writeMcp } from '@/stores/workspaces'
import {
  addConnector,
  adoptConnector,
  installConnector,
  uninstallConnector,
  connectors,
  copyConnector,
  loadConnectors,
  probeConnectors,
  removeConnector,
  testConnector,
} from '@/stores/connectors'

/**
 * Workspace settings → Connectors.
 *
 * One page replacing Account → Integrations and Account → MCP. The merge is not
 * cosmetic: the old page sat under Account, was stored per machine, and read one
 * of its three credentials from a workspace file — a scope that was wrong about
 * itself. Here every row states its scope, the filter segment mirrors it, and the
 * one thing that must never be guessed is written on the page:
 * *definitions travel with the workspace; tokens stay on this machine.*
 *
 * Two rules shape the interactions:
 *   - **Verify before save.** `Test connection` runs against the service, and a
 *     refusal leaves the list's row count unchanged with a sentence that says
 *     nothing was saved — the same rule `integrations-store` already keeps.
 *   - **No edit verb on a machine row.** Another application's configuration is
 *     read-only here; its only verb is `Copy here`, which creates a workspace
 *     connector from the definition and carries no credential.
 */
const props = defineProps({
  /* Rendered inside Workspace settings, which owns the page head. */
  embedded: { type: Boolean, default: false },
})

const query = ref('')
const scope = ref('all')
const kind = ref('all')
/* The third filter, and the one that answers "which of these is actually live":
   `ready` is a row that answered, `off` is one that is installed but not usable
   (not probed, needs sign-in, parked), `unmanaged` is a server that arrived
   without a connector row. */
const state = ref('all')
const STATE_OF = (row) => {
  if (row.unmanaged) return 'unmanaged'
  const word = String(row.status || '').toLowerCase()
  if (/connected|found|in the pool/.test(word)) return 'ready'
  return 'off'
}
const searchEl = ref(null)
const searchKey = shortcutLabel('inventory-search')
const busy = ref('')

/* the add sheet: kind picker first, then the fields that kind needs */
/* The raw `mcp.json` editor, carried over from the retired MCP tab: it was the
   only surface that could fix a definition by hand, and a roster of rows cannot
   express a bulk edit. It stays on this page because `mcp.json` is one of the two
   files a connector's definition lives in. */
const jsonOpen = ref(false)
const jsonText = ref('')
const jsonError = ref('')
const jsonBusy = ref(false)

function openJson() {
  jsonText.value = JSON.stringify(workspaces.mcp?.servers || {}, null, 2)
  jsonError.value = ''
  jsonOpen.value = true
}

function closeJson() {
  if (!jsonBusy.value) jsonOpen.value = false
}

useDialogDismiss({ active: () => jsonOpen.value, close: closeJson, guard: () => jsonBusy.value })

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
    jsonError.value = 'This must be an object of server name → definition.'
    return
  }
  jsonBusy.value = true
  try {
    await writeMcp(parsed)
    toast('MCP servers saved')
    jsonOpen.value = false
    await read({ probe: false })
  } catch (error) {
    jsonError.value = error?.message || 'The MCP servers could not be saved.'
  } finally {
    jsonBusy.value = false
  }
}

const addOpen = ref(false)
const addKind = ref('')
const addForm = ref({
  label: '',
  id: '',
  host: '',
  command: '',
  args: '',
  env: '',
  token: '',
  paste: '',
  verifyArgv: '',
})
const pasteNote = ref('')

/**
 * Read the three shapes a docs page hands out into the fields below.
 *
 * Deliberately not a copy of `McpServerView`'s reader: that one parses a paste
 * into a *definition* and drives a two-step wizard with a model fallback. Here a
 * paste only fills the form — one URL, one command line, a `command` + `args`
 * pair — because this dialog writes an index row and a binding, and the wizard
 * that owns credentials is one link away.
 */
function readPasteIntoForm() {
  const text = String(addForm.value.paste || '').trim()
  pasteNote.value = ''
  if (!text) return
  const url = text.match(/https?:\/\/\S+/)
  if (url && !text.startsWith('{') && !text.startsWith('[')) {
    addForm.value.command = url[0]
    pasteNote.value = 'Read as a URL.'
    return
  }
  try {
    const parsed = JSON.parse(text)
    const servers = parsed?.mcpServers || parsed?.mcp || parsed?.servers || null
    const first = servers ? Object.entries(servers)[0] : ['', parsed]
    if (!first) {
      pasteNote.value = 'That wrapper has no servers inside it.'
      return
    }
    const [name, def] = first
    if (name && !addForm.value.id) addForm.value.id = name
    if (!addForm.value.label && name) addForm.value.label = name
    addForm.value.command = def?.url || def?.command || ''
    addForm.value.args = Array.isArray(def?.args) ? def.args.join('\n') : ''
    addForm.value.env = Object.keys(def?.env || {}).join(', ') || (Array.isArray(def?.env) ? def.env.join(', ') : '')
    pasteNote.value = name ? `Read “${name}” out of the paste.` : 'Read one definition out of the paste.'
  } catch {
    pasteNote.value = 'Not JSON — the fields below are unchanged. A command line pasted here goes in “command or URL”.'
    if (!addForm.value.command) addForm.value.command = text.split(/\r?\n/)[0].trim()
  }
}
const addError = ref('')
const addNotice = ref('')

/* One pane at a time. `installed` is the roster this page has always drawn;
   `builtin` is the catalog's read-only list, whose only verb is Install;
   `machine` is another app's configuration, which may only be copied. */
const pane = ref('installed')
const PANES = [
  { id: 'installed', label: 'Installed', count: () => connectors.counts.workspace },
  { id: 'builtin', label: 'Built-in', count: () => connectors.counts.available },
  { id: 'machine', label: 'On this machine', count: () => connectors.counts.machine },
]
const setPane = (id) => {
  pane.value = id
  query.value = ''
  scope.value = 'all'
  kind.value = 'all'
  state.value = 'all'
}

const rows = computed(() => (pane.value === 'machine' ? connectors.machine || [] : connectors.rows || []))
const catalogRows = computed(() => connectors.available || [])

/* Two filters, both segments: scope and kind. They are the columns' own values,
   so a person can narrow to "machine MCP servers" without reading three
   sections — the roster is one table, and a group header is not a filter. */
const counts = computed(() => ({
  all: rows.value.length,
  workspace: rows.value.filter((row) => row.scope === 'workspace').length,
  machine: rows.value.filter((row) => row.scope === 'machine').length,
  builtIn: rows.value.filter((row) => row.builtIn).length,
}))

const KINDS = computed(() => {
  const seen = new Map()
  for (const row of rows.value) seen.set(row.kind, (seen.get(row.kind) || 0) + 1)
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([kind, n]) => ({ kind, n }))
})

const STATE_COUNTS = computed(() => {
  const out = { all: rows.value.length, ready: 0, off: 0, unmanaged: 0 }
  for (const row of rows.value) out[STATE_OF(row)] += 1
  return out
})

const visible = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (pane.value === 'builtin') {
    return catalogRows.value.filter((row) =>
      !needle
        ? true
        : [row.label, row.id, row.kind, row.work?.resolves]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(needle)),
    )
  }
  return rows.value.filter((row) => {
    if (scope.value !== 'all' && row.scope !== scope.value) return false
    if (kind.value !== 'all' && row.kind !== kind.value) return false
    if (state.value !== 'all' && STATE_OF(row) !== state.value) return false
    if (!needle) return true
    return [row.label, row.id, row.kind, row.scope, row.status, row.statusDetail, row.mention]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle))
  })
})

const nothing = computed(() => !connectors.loading && connectors.loaded && !visible.value.length)

async function read({ probe = true } = {}) {
  await loadConnectors()
  if (probe) probeConnectors().catch(() => {})
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  read()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

function onKey(event) {
  if (!matchesShortcut('inventory-search', event)) return
  event.preventDefault()
  searchEl.value?.focus()
  searchEl.value?.select?.()
}

/* ── the two copy verbs ────────────────────────────────────────────── */

async function adopt(row) {
  if (!row || busy.value) return
  busy.value = row.id
  try {
    await adoptConnector(row.id)
    toast(`${row.label} is now a connector of this workspace.`)
  } catch (error) {
    toast(String(error?.message || error))
  } finally {
    busy.value = ''
  }
}

async function install(row) {
  if (!row || busy.value) return
  busy.value = row.id
  try {
    await installConnector(row.id)
    toast(`${row.label} installed into this workspace.`)
    pane.value = 'installed'
  } catch (error) {
    toast(String(error?.message || error))
  } finally {
    busy.value = ''
  }
}

async function uninstall(row) {
  if (!row || busy.value) return
  busy.value = row.id
  try {
    await uninstallConnector(row.id)
    toast(`${row.label} uninstalled. Its sign-in stays on this machine.`)
  } catch (error) {
    toast(String(error?.message || error))
  } finally {
    busy.value = ''
  }
}

async function copyHere(row) {
  if (!row || busy.value) return
  busy.value = row.id
  try {
    await copyConnector(row.id)
    toast(`${row.label} copied into this workspace. Its credential did not travel.`)
  } catch (error) {
    toast(String(error?.message || error))
  } finally {
    busy.value = ''
  }
}

/* ── the add sheet ─────────────────────────────────────────────────── */

function startAdd() {
  addKind.value = ''
  addForm.value = {
    label: '',
    id: '',
    host: '',
    command: '',
    args: '',
    env: '',
    token: '',
    paste: '',
    verifyArgv: '',
  }
  pasteNote.value = ''
  addError.value = ''
  addNotice.value = ''
  addOpen.value = true
}

function closeAdd() {
  if (busy.value === 'add') return
  addOpen.value = false
}

useDialogDismiss({ active: () => addOpen.value, close: closeAdd, guard: () => busy.value === 'add' })

function pickKind(kind) {
  addKind.value = kind
  nextTick(() => document.querySelector('.cxn-fields input')?.focus())
}

async function testAdd() {
  const form = addForm.value
  if (!addKind.value || busy.value) return
  busy.value = 'add'
  addError.value = ''
  addNotice.value = ''
  try {
    const result = await testConnector({
      kind: addKind.value,
      id: String(form.id || form.label || '').trim(),
      token: form.token,
      host: form.host,
    })
    addNotice.value = result?.detail || 'The connection answered.'
  } catch (error) {
    /* Nothing has been written: the kind picker is still a draft. */
    addError.value = `${String(error?.message || error)} Nothing was saved.`
  } finally {
    busy.value = ''
  }
}

async function saveAdd() {
  const form = addForm.value
  if (!addKind.value || busy.value) return
  const label = String(form.label || '').trim()
  if (!label) {
    addError.value = 'A connector needs a label.'
    return
  }
  busy.value = 'add'
  addError.value = ''
  try {
    /* Verify before save, always: the row count must not change on a rejected
       credential, and the sentence must be able to say so. */
    try {
      await testConnector({
        kind: addKind.value,
        id: String(form.id || label).trim(),
        token: form.token,
        host: form.host,
      })
    } catch (error) {
      addError.value = `${String(error?.message || error)} Nothing was saved.`
      return
    }
    /* An MCP connector's definition is what the harness runs, so the form's
       command/URL is the binding written before the index row. */
    await addConnector({
      id: String(form.id || label).trim(),
      label,
      kind: addKind.value,
      command: form.command,
      url: form.host,
      args: form.args,
      env: form.env,
      binary: addKind.value === 'cli' ? String(form.id || label).trim() : '',
      verify: addKind.value === 'cli' && form.verifyArgv ? { argv: form.verifyArgv.split(/\s+/), okExit: 0 } : null,
    })
    const count = rows.value.length
    addOpen.value = false
    toast(`${label} added · ${count} connectors in this workspace.`)
  } catch (error) {
    addError.value = String(error?.message || error)
  } finally {
    busy.value = ''
  }
}

const kindLabel = computed(
  () => ({ mcp: 'MCP server', cli: 'CLI on this machine', rest: 'REST token' })[addKind.value] || '',
)

</script>

<template>
  <div class="cxn-page" :class="{ 'cxn-embedded': embedded }">
    <!-- The heading row carries the page's one action. The title is an `h1` at the
         Machines page's size, and the sub carries the one mandated sentence. -->
    <div class="conn-head">
      <div class="conn-head-top">
        <div class="conn-head-id">
          <p class="eyebrow">Workspace settings</p>
          <h1>Connectors</h1>
        </div>
        <button class="btn btn-sm" type="button" title="Edit mcp.json as JSON" @click="openJson">
          mcp.json
        </button>
        <button class="btn btn-primary btn-sm" type="button" @click="startAdd">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
            <path d="M8 3v10M3 8h10" />
          </svg>
          Add connector
        </button>
      </div>
      <p class="sub">{{ connectors.note }}</p>
    </div>

    <!-- Three populations, three panes: what this workspace has, what the app
         ships and this workspace has not installed, and what another app holds on
         this machine. The verbs differ per pane, so the tables are separate. -->
    <div class="cxn-panes" role="tablist" aria-label="Connector groups">
      <button
        v-for="entry in PANES"
        :key="entry.id"
        type="button"
        role="tab"
        :aria-selected="pane === entry.id ? 'true' : 'false'"
        @click="setPane(entry.id)"
      >
        {{ entry.label }} <span class="n">{{ entry.count() }}</span>
      </button>
    </div>

    <!-- One line at every measure: the field takes the room, the segment hugs its
         three short labels. -->
    <div class="conn-bar">
      <label class="cxn-search">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.4 10.4L14 14" />
        </svg>
        <input
          ref="searchEl"
          v-model="query"
          type="search"
          placeholder="Search connectors"
          aria-label="Search connectors"
          autocomplete="off"
        />
        <kbd v-if="!query" class="search-kbd" aria-hidden="true">{{ searchKey }}</kbd>
      </label>

      <div v-if="pane === 'installed'" class="seg" role="group" aria-label="Scope filter">
        <button type="button" :aria-pressed="scope === 'all' ? 'true' : 'false'" @click="scope = 'all'">
          All <span class="n">{{ counts.all }}</span>
        </button>
        <button type="button" :aria-pressed="scope === 'workspace' ? 'true' : 'false'" @click="scope = 'workspace'">
          Workspace <span class="n">{{ counts.workspace }}</span>
        </button>
        <button type="button" :aria-pressed="scope === 'machine' ? 'true' : 'false'" @click="scope = 'machine'">
          Machine <span class="n">{{ counts.machine }}</span>
        </button>
      </div>

      <div v-if="pane === 'installed'" class="seg" role="group" aria-label="Status filter">
        <button type="button" :aria-pressed="state === 'all' ? 'true' : 'false'" @click="state = 'all'">All</button>
        <button type="button" :aria-pressed="state === 'ready' ? 'true' : 'false'" @click="state = 'ready'">
          ready <span class="n">{{ STATE_COUNTS.ready }}</span>
        </button>
        <button type="button" :aria-pressed="state === 'off' ? 'true' : 'false'" @click="state = 'off'">
          off <span class="n">{{ STATE_COUNTS.off }}</span>
        </button>
        <button type="button" :aria-pressed="state === 'unmanaged' ? 'true' : 'false'" @click="state = 'unmanaged'">
          unmanaged <span class="n">{{ STATE_COUNTS.unmanaged }}</span>
        </button>
      </div>

      <div v-if="pane === 'installed'" class="seg" role="group" aria-label="Kind filter">
        <button type="button" :aria-pressed="kind === 'all' ? 'true' : 'false'" @click="kind = 'all'">All</button>
        <button
          v-for="entry in KINDS"
          :key="entry.kind"
          type="button"
          :aria-pressed="kind === entry.kind ? 'true' : 'false'"
          @click="kind = entry.kind"
        >
          {{ entry.kind }} <span class="n">{{ entry.n }}</span>
        </button>
      </div>
    </div>

    <div v-if="connectors.error" class="cxn-error" role="alert">{{ connectors.error }}</div>

    <div v-if="!connectors.loaded && connectors.loading" class="cxn-empty">Reading this workspace's connectors…</div>

    <!-- One table, one bounded scroll box: the page height stays put while a
         200-row roster scrolls inside it (`DESIGN.md`). No groups: every row is a
         row, and the two filters above are how a person narrows the list. -->
    <div v-else-if="!nothing" class="ct-box">
      <div class="ct" role="table" :aria-label="pane === 'builtin' ? 'Built-in connectors' : 'Connectors'">
        <div class="ct-head" role="row">
          <span role="columnheader">Connector</span>
          <span v-if="pane === 'builtin'" role="columnheader" data-col="kind">Kind</span>
          <span v-if="pane === 'builtin'" role="columnheader" data-col="scope">Needs</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Action</span>
        </div>

        <!-- the catalog: nothing is installed yet, so the only verb is Install -->
        <template v-if="pane === 'builtin'">
          <div v-for="row in visible" :key="row.id" class="ct-row" role="row">
            <span class="ct-who" role="cell">
              <span class="ct-mk" data-brand="1" aria-hidden="true">
                <IntegrationMark :name="row.builtIn" :size="18" />
              </span>
              <span class="ct-copy">
                <span class="ct-name" :title="row.label">{{ row.label }}</span>
                <span class="ct-line" :title="row.work?.resolves">{{ row.work?.resolves }}</span>
              </span>
            </span>
            <span class="ct-kind" role="cell">{{ row.kind }}</span>
            <span class="ct-scope" role="cell" :title="row.statusDetail">{{ row.statusDetail || '—' }}</span>
            <span class="ct-status" role="cell" data-s="off">
              <span class="ct-s1"><span class="dot" aria-hidden="true"></span><span class="ct-word">not installed</span></span>
            </span>
            <span class="ct-act" role="cell">
              <button class="btn btn-sm" type="button" :disabled="busy === row.id" @click="install(row)">
                Install
              </button>
            </span>
          </div>
        </template>

        <!-- installed, and the machine's own config -->
        <template v-else>
          <ConnectorRow
            v-for="row in visible"
            :key="row.id"
            :row="row"
            :busy="busy === row.id"
            @adopt="adopt"
            @copy="copyHere"
            @uninstall="uninstall"
          />
        </template>
      </div>
    </div>

    <p v-else-if="query || scope !== 'all' || kind !== 'all' || state !== 'all'" class="cxn-empty">
      Nothing matches this view.
      <button class="empty-link" type="button" @click="query = ''; scope = 'all'; kind = 'all'; state = 'all'">
        Clear the filters
      </button>
    </p>
    <p v-else class="cxn-empty">No connectors yet. Add one, or copy one from this machine.</p>

    <!-- The add sheet: kind picker, then that kind's fields, then verify, then save.
         Teleported, like every other fixed sheet in this app: inside the page's
         container-query box a `position: fixed` child would measure against that
         box rather than the window. -->
    <Teleport to="body">
    <div v-if="jsonOpen" class="cxn-scrim" @click.self="closeJson">
      <div class="cxn-dialog" role="dialog" aria-labelledby="cxn-json-h">
        <h2 id="cxn-json-h">mcp.json</h2>
        <p class="sub">{{ workspaces.mcp?.path || 'mcp.json' }} — the binding every harness is given.</p>
        <textarea v-model="jsonText" class="cxn-editor" rows="16" spellcheck="false" :disabled="jsonBusy"></textarea>
        <p v-if="jsonError" class="cxn-error" role="alert">{{ jsonError }}</p>
        <div class="cxn-acts">
          <span class="spacer"></span>
          <button class="btn btn-sm" type="button" @click="closeJson">Cancel</button>
          <button class="btn btn-sm btn-primary" type="button" :disabled="jsonBusy" @click="saveJson">
            {{ jsonBusy ? 'Saving…' : 'Save servers' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="addOpen" class="cxn-scrim" @click.self="closeAdd">
      <div class="cxn-dialog" role="dialog" aria-labelledby="cxn-add-h">
        <h2 id="cxn-add-h">
          {{ addKind ? `Add a ${kindLabel.toLowerCase()}` : 'Add a connector' }}
        </h2>
        <p class="sub">One dialog, three kinds. The row looks the same; only the fields differ.</p>

        <ConnectorKindPicker v-if="!addKind" :busy="busy === 'add'" @pick="pickKind" />
        <div v-if="!addKind" class="cxn-acts">
          <span class="spacer"></span>
          <button class="btn btn-sm" type="button" @click="closeAdd">Cancel</button>
        </div>

        <template v-else>
          <div class="cxn-fields">
            <label>
              name
              <input v-model="addForm.label" type="text" placeholder="a label a person reads" autocomplete="off" />
            </label>
            <label v-if="addKind === 'cli'">
              binary
              <input v-model="addForm.id" type="text" placeholder="the command on PATH" autocomplete="off" spellcheck="false" />
            </label>
            <template v-if="addKind === 'cli'">
              <label>
                verify command
                <input
                  v-model="addForm.verifyArgv"
                  type="text"
                  placeholder="auth status"
                  autocomplete="off"
                  spellcheck="false"
                />
              </label>
              <p class="cxn-note">
                What `Test connection` runs. The exit code decides; the last line it prints
                becomes the status. Without one, the row reads <b>no verify command</b> — it is
                never guessed from the name.
              </p>
            </template>
            <label v-else>
              id
              <input v-model="addForm.id" type="text" placeholder="the id the pool and @ mention use" autocomplete="off" spellcheck="false" />
            </label>
            <template v-if="addKind === 'mcp'">
              <label>
                paste from the docs page
                <textarea
                  v-model="addForm.paste"
                  class="cxn-paste mono"
                  rows="3"
                  spellcheck="false"
                  placeholder='{ "mcpServers": { … } }, [mcp_servers.x], or just https://…/mcp'
                  @input="readPasteIntoForm"
                ></textarea>
              </label>
              <p v-if="pasteNote" class="cxn-note">{{ pasteNote }}</p>
              <label>
                command or URL
                <input v-model="addForm.command" type="text" placeholder="npx … or https://…/mcp" autocomplete="off" spellcheck="false" />
              </label>
              <label>
                arguments
                <input v-model="addForm.args" type="text" placeholder="one per line — -y, @playwright/mcp" autocomplete="off" spellcheck="false" />
              </label>
              <label>
                env names
                <input v-model="addForm.env" type="text" placeholder="GITHUB_TOKEN, LINEAR_TOKEN" autocomplete="off" spellcheck="false" />
              </label>
              <p class="cxn-note">
                Names only: the values stay in this machine's environment, never in
                <code class="mono">mcp.json</code>.
              </p>
            </template>
            <template v-if="addKind === 'rest'">
              <label>
                base URL
                <input v-model="addForm.host" type="text" placeholder="https://…" autocomplete="off" spellcheck="false" />
              </label>
              <label>
                token
                <input v-model="addForm.token" type="password" placeholder="verified before it is saved" autocomplete="off" />
              </label>
            </template>
          </div>

          <div v-if="addError" class="cxn-error" role="alert">{{ addError }}</div>
          <div v-else-if="addNotice" class="cxn-ok" role="status">{{ addNotice }}</div>

          <div class="cxn-acts">
            <button class="btn btn-sm" type="button" :disabled="busy === 'add'" @click="testAdd">
              {{ busy === 'add' ? 'Testing…' : 'Test connection' }}
            </button>
            <span class="spacer"></span>
            <button class="btn btn-sm btn-ghost" type="button" :disabled="busy === 'add'" @click="addKind = ''">
              Back
            </button>
            <button class="btn btn-sm" type="button" :disabled="busy === 'add'" @click="closeAdd">Cancel</button>
            <button class="btn btn-sm btn-primary" type="button" :disabled="busy === 'add'" @click="saveAdd">
              Save connector
            </button>
          </div>
        </template>

      </div>
    </div>
    </Teleport>
  </div>
</template>
