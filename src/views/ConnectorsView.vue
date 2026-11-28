<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import ConnectorKindPicker from '@/components/ConnectorKindPicker.vue'
import ConnectorShareDialog from '@/components/ConnectorShareDialog.vue'
import ConnectorAlreadyHereDialog from '@/components/ConnectorAlreadyHereDialog.vue'
import IntegrationMark from '@/components/IntegrationMark.vue'
import { call } from '@/composables/localBridge'
import { readPaste } from '@/lib/mcp-paste'
import { readTransferFile } from '@/lib/transfer'
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

const router = useRouter()
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
 * Read a paste into the fields below, with the same reader the MCP wizard uses.
 *
 * One parser, two doors: `src/lib/mcp-paste.js` is pure, so the surface that
 * writes a definition and the surface that opens a two-step wizard cannot
 * disagree about what a docs page meant.
 */
function readPasteIntoForm() {
  const text = String(addForm.value.paste || '').trim()
  pasteNote.value = ''
  if (!text) return
  const read = readPaste(text)
  if (read.error && !read.servers.length) {
    pasteNote.value = read.error
    return
  }
  const first = read.servers[0]
  if (!first) {
    pasteNote.value = 'That paste held no server.'
    return
  }
  const definition = first.definition || {}
  if (first.name) {
    if (!addForm.value.id) addForm.value.id = first.name
    if (!addForm.value.label) addForm.value.label = first.name
  }
  addForm.value.command = definition.url || definition.command || ''
  addForm.value.args = Array.isArray(definition.args) ? definition.args.join('\n') : ''
  const env = definition.env
  addForm.value.env = Array.isArray(env)
    ? env.join(', ')
    : env && typeof env === 'object'
      ? Object.keys(env).join(', ')
      : ''
  const more = read.servers.length > 1 ? ` — ${read.servers.length} found, the first was used` : ''
  pasteNote.value = `${first.name ? `Read “${first.name}”` : 'Read one definition'} out of the paste${more}.`
  if (read.dropped?.length) {
    pasteNote.value += ` Dropped: ${read.dropped.join(', ')}.`
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

/** One line about a catalog row: what its mention resolves, or — for an entry
 *  that ships no resolver — the catalog's summary of what it is for. */
const describe = (row) => row?.work?.resolves || row?.statusDetail || ''

const visible = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (pane.value === 'builtin') {
    return catalogRows.value.filter((row) =>
      !needle
        ? true
        : [row.label, row.id, row.kind, row.work?.resolves, row.statusDetail]
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
    /* An account-bearing connector is finished on its own page — the account is
       connected there — so installing it lands you where the verb is, the same
       place the sheet's own card does. */
    if (row.oauth) router.push({ name: 'connector-page', params: { workspace: hub.workspace, id: row.id } })
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
    /* An added oauth row is not `builtIn`, so `connector.uninstall` would refuse
       it. Its removal is the same verb the connector's own page offers. */
    if (row.builtIn) await uninstallConnector(row.id)
    else await removeConnector(row.id)
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

/* `Connect account` on a row with nothing connected: the same page, sheet not
   opened. The account verbs live where the account list does (design §2). */
function connectAccount(row) {
  if (!row || busy.value) return
  router.push({ name: 'connector-page', params: { workspace: hub.workspace, id: row.id } })
}

/* ── a connector file, in either direction ─────────────────────────── */

/* Send: one row, one sheet. The sheet asks the store what would travel, so the
   two lists it prints are the store's answer rather than a copy of its rules. */
const shareRow = ref(null)
const shareOpen = ref(false)
function share(row) {
  if (!row || busy.value) return
  shareRow.value = row
  shareOpen.value = true
}
function closeShare() {
  shareOpen.value = false
  shareRow.value = null
}

/* Receive: a dropped file. `hereFile` is the inspect answer; `hereLocked` is the
   file's name while a passphrase stands between us and that answer. Both live in
   one sheet because both are the same question — what does this file do here? */
const hereOpen = ref(false)
const hereFile = ref(null)
const hereLocked = ref('')
const hereError = ref('')
const hereBusy = ref(false)
const herePass = ref('')
const dropping = ref(0)
const picked = ref(null)

const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files')

function onDragEnter(event) {
  if (!hasFiles(event)) return
  dropping.value += 1
}
function onDragOver(event) {
  if (!hasFiles(event)) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
}
function onDragLeave() {
  dropping.value = Math.max(0, dropping.value - 1)
}
function onDrop(event) {
  dropping.value = 0
  if (!hasFiles(event)) return
  event.preventDefault()
  take(event.dataTransfer.files?.[0])
}

/* The reader is in the renderer because the main process never sees a dropped
   file: the bytes come from the drag, not from a path. */
async function take(file) {
  if (!file || hereBusy.value) return
  try {
    const read = await readTransferFile(file)
    picked.value = { name: read.name, data: read.data }
    await openFile('')
  } catch (error) {
    /* A refused file is a toast, never a sheet: there is nothing to decide. */
    toast(error.message)
  }
}

/* One read, two callers: the drop (no passphrase yet) and the sheet's own
   unlock. The store decides whether an answer is reachable without a key, so
   this does not guess from the extension. */
async function openFile(passphrase = '') {
  if (!picked.value || hereBusy.value) return
  hereBusy.value = true
  hereError.value = ''
  try {
    const found = await call('transfer.connectorInspect', {
      workspace: hub.workspace,
      filename: picked.value.name,
      data: picked.value.data,
      passphrase,
    })
    herePass.value = passphrase
    hereFile.value = found
    hereLocked.value = ''
    if (found.present) {
      hereOpen.value = true
      return
    }
    /* Nothing here has that name: there is no choice to put in a sheet, so the
       row is written and the toast says whether a sign-in is still owed. */
    hereOpen.value = false
    await installThe({ mode: 'update' })
  } catch (error) {
    if (error.code === 'passphrase') {
      hereLocked.value = picked.value.name
      hereFile.value = null
      hereOpen.value = true
      hereError.value = passphrase ? 'Wrong passphrase. Nothing was installed.' : ''
    } else {
      hereError.value = error.message
      hereOpen.value = false
      toast(error.message)
    }
  } finally {
    hereBusy.value = false
  }
}

async function installThe({ mode }) {
  if (!picked.value) return
  hereBusy.value = true
  hereError.value = ''
  try {
    const result = await call('transfer.connectorInstall', {
      workspace: hub.workspace,
      filename: picked.value.name,
      data: picked.value.data,
      passphrase: herePass.value,
      mode,
    })
    hereOpen.value = false
    hereFile.value = null
    picked.value = null
    toast(
      `${result.label} ${
        result.updated ? 'updated' : `installed${result.beside ? ` as ${result.id}` : ''}`
      }${result.needsSignIn ? ' · it needs a sign-in here' : ''}`,
    )
    pane.value = 'installed'
    await read({ probe: false })
  } catch (error) {
    hereError.value = error.message
  } finally {
    hereBusy.value = false
  }
}

function closeHere() {
  if (hereBusy.value) return
  hereOpen.value = false
  hereFile.value = null
  hereLocked.value = ''
  hereError.value = ''
  herePass.value = ''
  picked.value = null
}

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
  /* `More connectors` is a door into the roster's Built-in pane, not a fifth kind:
     nothing is added, and the sheet closes behind it. */
  if (kind === 'builtin') {
    addOpen.value = false
    setPane('builtin')
    return
  }
  /* An account-bearing connector has no second step: picking the card writes one
     row and lands on that connector's page, where the accounts are connected. The
     sheet answers "what does this workspace get", one card per connector — a
     token field or an account chooser here would make it a directory of mailboxes
     (spec §2). */
  if (OAUTH_KINDS.value.has(kind)) {
    addOauth(kind)
    return
  }
  addKind.value = kind
  nextTick(() => document.querySelector('.cxn-fields input')?.focus())
}

async function addOauth(kind) {
  if (busy.value) return
  busy.value = 'add'
  addError.value = ''
  try {
    await addConnector({ id: kind, label: oauthLabel(kind), kind: 'rest', oauth: true })
    addOpen.value = false
    toast(`${oauthLabel(kind)} added · connect an account on its page.`)
    router.push({ name: 'connector-page', params: { workspace: hub.workspace, id: kind } })
  } catch (error) {
    /* Stay on the sheet: a failure is the one sentence the person needs, and the
       sheet is where the card they pressed still is. */
    addError.value = String(error?.message || error)
  } finally {
    busy.value = ''
  }
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
    /* Verify before save — except for `mcp`, where there is nothing to verify
       yet: the server is not in `mcp.json` until this call writes it, so asking
       `tools/list` here would always fail. An MCP connector is verified by the
       `Connect a server` wizard on its page, which writes first and probes the
       file it just wrote. Every other kind is checked before anything is stored,
       and a refusal leaves the row count unchanged. */
    if (addKind.value !== 'mcp' && addKind.value !== 'rss') {
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
    }
    /* An MCP connector's definition is what the harness runs, so the form's
       command/URL is the binding written before the index row. */
    const created = await addConnector({
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
    /* An MCP connector is finished on the page that owns its definition and its
       credential: this dialog collects a name and a paste, and `Connect a server`
       writes and tests. So hand over rather than duplicate that wizard here. */
    const id = String(form.id || label).trim()
    if (addKind.value === 'mcp' && created) {
      router.push({
        name: 'connector-page',
        params: { workspace: hub.workspace, id },
        query: { edit: '1' },
      })
    }
  } catch (error) {
    addError.value = String(error?.message || error)
  } finally {
    busy.value = ''
  }
}

const kindLabel = computed(
  () =>
    ({ mcp: 'MCP server', cli: 'CLI on this machine', rest: 'REST token', rss: 'RSS or Atom feed' })[
      addKind.value
    ] || '',
)

/* The connectors that carry an account rather than a token, read from the shipped
   catalog so a fifth provider is one entry there and no edit here. Picking one
   writes the row and lands on its page; it never reaches `saveAdd()`'s field step
   or its pre-save verify, because there is no credential to check until a consent
   screen has answered (spec §3, §10 question 2). */
const OAUTH_KINDS = computed(
  () => new Set((connectors.catalog || []).filter((entry) => entry.oauth).map((entry) => entry.id)),
)
const oauthLabel = (kind) =>
  (connectors.catalog || []).find((entry) => entry.id === kind)?.label || kind

/* The sheet only grows for the kind picker: `credential → refresh token, this
   machine` clips in a 520px two-up card grid, and the field step is still one
   column of inputs. */
const wideSheet = computed(() => !addKind.value)

</script>

<template>
  <div
    class="cxn-page"
    :class="{ 'cxn-embedded': embedded }"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
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

    <!-- A file can be dropped anywhere on this page, so the page says so while a
         drag is in flight. It is a band and not an overlay: the roster underneath
         is still the thing being looked at. -->
    <div v-if="dropping" class="tr-band cxn-drop" role="status">
      Drop a connector file to install it here. One file, one connector.
    </div>

    <div v-if="!connectors.loaded && connectors.loading" class="cxn-empty">Reading this workspace's connectors…</div>

    <!-- One table, one bounded scroll box: the page height stays put while a
         200-row roster scrolls inside it (`DESIGN.md`). No groups: every row is a
         row, and the two filters above are how a person narrows the list. -->
    <div v-else-if="!nothing" class="ct-box">
      <div class="ct" role="table" :aria-label="pane === 'builtin' ? 'Built-in connectors' : 'Connectors'">
        <div class="ct-head" role="row">
          <span role="columnheader">Connector</span>
          <!-- Five tracks, five labels — the row always has five cells, so the
               head must always have five too or the labels sit over the wrong
               columns. Below a 560px container the two middle cells are hidden
               and these two labels hide with them. -->
          <span role="columnheader" data-col="kind">Kind</span>
          <span role="columnheader" data-col="scope">Scope</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Action</span>
        </div>

        <!-- the catalog: nothing is installed yet, so the only verb is Install —
             but the name is still a link. The pitch (what a mention does with it,
             what it needs, what it binds) is the reason to install, so it has to be
             readable *before* the decision, not after it. -->
        <template v-if="pane === 'builtin'">
          <router-link
            v-for="row in visible"
            :key="row.id"
            class="ct-row ct-row-link"
            role="row"
            :to="{ name: 'connector-page', params: { workspace: hub.workspace, id: row.id } }"
            :title="`What ${row.label} does, before you install it`"
          >
            <span class="ct-who" role="cell">
              <span class="ct-mk" data-brand="1" :data-mk="row.builtIn" aria-hidden="true">
                <IntegrationMark :name="row.builtIn" :size="18" />
              </span>
              <span class="ct-copy">
                <span class="ct-name" :title="row.label">{{ row.label }}</span>
                <!-- A shipped resolver is the best sentence about what a row
                     gives you; a context-only entry (the account-bearing four)
                     ships none, so the catalog's own summary speaks instead. -->
                <span class="ct-line" :title="describe(row)">{{ describe(row) }}</span>
              </span>
            </span>
            <span class="ct-kind" role="cell">{{ row.kind }}</span>
            <span class="ct-scope" role="cell" :title="row.statusDetail">{{ row.statusDetail || '—' }}</span>
            <span class="ct-status" role="cell" data-s="off">
              <span class="ct-s1"><span class="dot" aria-hidden="true"></span><span class="ct-word">not installed</span></span>
            </span>
            <span class="ct-act" role="cell">
              <!-- A button inside a link is invalid; the row navigates, so this
                   stops the click from doing both. -->
              <button
                class="btn btn-sm"
                type="button"
                :disabled="busy === row.id"
                @click.prevent.stop="install(row)"
              >
                Install
              </button>
            </span>
          </router-link>
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
            @connect="connectAccount"
            @share="share"
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

    <!-- The two connector-file sheets. Both are dialogs, so both are teleported:
         `.cxn-page` is a query container, and `layout` containment would make it
         the containing block for a `position: fixed` child. -->
    <Teleport to="body">
      <ConnectorShareDialog
        :open="shareOpen"
        :row="shareRow"
        :workspace="String(hub.workspace || '')"
        @close="closeShare"
      />
      <ConnectorAlreadyHereDialog
        :open="hereOpen"
        :file="hereFile"
        :locked="hereLocked"
        :busy="hereBusy"
        :error="hereError"
        @close="closeHere"
        @unlock="openFile"
        @install="installThe"
      />
    </Teleport>

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
      <div class="cxn-dialog" :class="{ 'cxn-dialog--wide': wideSheet }" role="dialog" aria-labelledby="cxn-add-h">
        <h2 id="cxn-add-h">
          {{ addKind ? (addKind === 'rss' ? 'Add a feed' : `Add a ${kindLabel.toLowerCase()}`) : 'Add a connector' }}
        </h2>
        <p class="sub">
          Pick what this workspace gets. Accounts are connected on the connector's page afterwards,
          so this list grows by one card per connector and never by one card per mailbox.
        </p>

        <ConnectorKindPicker v-if="!addKind" :busy="busy === 'add'" @pick="pickKind" />
        <!-- A card that failed to write says so on the step it was pressed on. -->
        <div v-if="!addKind && addError" class="cxn-error" role="alert">{{ addError }}</div>
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
            <label v-else-if="addKind !== 'rss'">
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
            <template v-if="addKind === 'rss'">
              <label>
                any RSS or Atom URL
                <input
                  v-model="addForm.host"
                  type="url"
                  placeholder="https://example.org/feed.xml"
                  autocomplete="off"
                  spellcheck="false"
                />
              </label>
              <p class="cxn-note">
                <code class="mono">http</code>/<code class="mono">https</code> only · 8 s timeout ·
                512 kB cap · a page that answers with HTML instead of XML is refused with its
                reason, not stored. News reads the result; it cannot add, edit or remove a feed.
              </p>
            </template>
          </div>

          <div v-if="addError" class="cxn-error" role="alert">{{ addError }}</div>
          <div v-else-if="addNotice" class="cxn-ok" role="status">{{ addNotice }}</div>

          <div class="cxn-acts">
            <button
              v-if="addKind !== 'rss'"
              class="btn btn-sm"
              type="button"
              :disabled="busy === 'add'"
              @click="testAdd"
            >
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
