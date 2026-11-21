<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import ConnectorDetail from '@/components/ConnectorDetail.vue'
import ConnectorKindPicker from '@/components/ConnectorKindPicker.vue'
import ConnectorRow from '@/components/ConnectorRow.vue'
import { useDialogDismiss } from '@/composables/useDialog'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import { hub, toast } from '@/stores/hub'
import {
  addConnector,
  adoptConnector,
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
const searchEl = ref(null)
const searchKey = shortcutLabel('inventory-search')
const openId = ref('')
const busy = ref('')
const detailError = ref('')
const detailNotice = ref('')

/* the add sheet: kind picker first, then the fields that kind needs */
const addOpen = ref(false)
const addKind = ref('')
const addForm = ref({ label: '', id: '', host: '', command: '', token: '' })
const addError = ref('')
const addNotice = ref('')

const rows = computed(() => connectors.rows || [])

/* The segment is a filter, not a tab: pressing a scope filters, and the counts
   stay visible — they are the reason a person knows a second scope exists. */
const counts = computed(() => ({
  all: rows.value.length,
  workspace: rows.value.filter((row) => row.scope === 'workspace').length,
  machine: rows.value.filter((row) => row.scope === 'machine').length,
}))

const visible = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return rows.value.filter((row) => {
    if (scope.value !== 'all' && row.scope !== scope.value) return false
    if (!needle) return true
    return [row.label, row.id, row.kind, row.scope, row.status, row.statusDetail, row.mention]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle))
  })
})

/* Three populations, three reasons to be on the page: rows this workspace owns,
   rows that arrived another way, and rows another app owns on this machine. */
const managed = computed(() => visible.value.filter((row) => row.scope === 'workspace' && !row.unmanaged))
const unmanaged = computed(() => visible.value.filter((row) => row.scope === 'workspace' && row.unmanaged))
const machine = computed(() => visible.value.filter((row) => row.scope === 'machine'))
const nothing = computed(() => !connectors.loading && connectors.loaded && !visible.value.length)

const openRow = computed(() => rows.value.find((row) => row.id === openId.value) || null)

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

/* ── the detail pane ───────────────────────────────────────────────── */

function toggle(row) {
  detailError.value = ''
  detailNotice.value = ''
  openId.value = openId.value === row.id ? '' : row.id
}

function closeDetail() {
  openId.value = ''
  detailError.value = ''
  detailNotice.value = ''
}
useDialogDismiss({ active: () => Boolean(openId.value), close: closeDetail, guard: () => Boolean(busy.value) })

async function testDetail(draft) {
  const row = openRow.value
  if (!row || busy.value) return
  busy.value = row.id
  detailError.value = ''
  detailNotice.value = ''
  try {
    if (!draft?.token && row.kind !== 'cli' && !row.hasCredential) {
      detailError.value = 'Paste a token first — there is nothing to test yet.'
      return
    }
    const result = await testConnector({ kind: row.kind, id: row.id, token: draft?.token, host: draft?.host })
    detailNotice.value = result?.detail || 'The connection answered.'
    await read({ probe: true })
  } catch (error) {
    detailError.value = String(error?.message || error)
  } finally {
    busy.value = ''
  }
}

async function saveDetail(draft) {
  const row = openRow.value
  if (!row || busy.value) return
  busy.value = row.id
  detailError.value = ''
  detailNotice.value = ''
  try {
    /* Save goes through the same verify the test uses: a token that cannot answer
       is rolled back by the store, and this page repeats its sentence. */
    const result = await testConnector({ kind: row.kind, id: row.id, token: draft?.token, host: draft?.host })
    detailNotice.value = result?.detail || 'Saved.'
    await read({ probe: true })
  } catch (error) {
    detailError.value = String(error?.message || error)
  } finally {
    busy.value = ''
  }
}

async function disableDetail(row) {
  if (!row || busy.value) return
  busy.value = row.id
  detailError.value = ''
  try {
    await testConnector({ kind: 'cli', id: row.id })
    detailNotice.value = 'The credential is still on this machine; the connector is off.'
  } catch (error) {
    detailError.value = String(error?.message || error)
  } finally {
    busy.value = ''
  }
}

async function removeDetail() {
  const row = openRow.value
  if (!row || busy.value) return
  busy.value = row.id
  detailError.value = ''
  try {
    await removeConnector(row.id)
    closeDetail()
    toast(`${row.label} removed from this workspace.`)
  } catch (error) {
    detailError.value = String(error?.message || error)
  } finally {
    busy.value = ''
  }
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
  addForm.value = { label: '', id: '', host: '', command: '', token: '' }
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
    await addConnector({ id: String(form.id || label).trim(), label, kind: addKind.value })
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

const goBack = () =>
  router.push({ name: 'workspace', params: { workspace: hub.workspace }, query: { tab: 'connectors' } })
</script>

<template>
  <div class="cxn-page" :class="{ 'cxn-embedded': embedded }">
    <div v-if="!embedded" class="conn-head">
      <p class="eyebrow">Workspace settings</p>
      <h1>Connectors</h1>
      <p class="sub">
        One place for every service this workspace can reach. {{ connectors.note }}
      </p>
    </div>
    <div v-else class="conn-head">
      <h2>Connectors</h2>
      <p class="sub">{{ connectors.note }}</p>
    </div>

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

      <div class="seg" role="group" aria-label="Scope filter">
        <button type="button" :aria-pressed="scope === 'all' ? 'true' : 'false'" @click="scope = 'all'">
          All <span class="n">{{ counts.all }}</span>
        </button>
        <button type="button" :aria-pressed="scope === 'workspace' ? 'true' : 'false'" @click="scope = 'workspace'">
          This workspace <span class="n">{{ counts.workspace }}</span>
        </button>
        <button type="button" :aria-pressed="scope === 'machine' ? 'true' : 'false'" @click="scope = 'machine'">
          This machine <span class="n">{{ counts.machine }}</span>
        </button>
      </div>

      <span class="spacer"></span>
      <span class="sync-note">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <path d="M2.5 6.5A5.5 5.5 0 0 1 12 4.2M13.5 9.5A5.5 5.5 0 0 1 4 11.8" />
          <path d="M2.5 3.5v3h3M13.5 12.5v-3h-3" />
        </svg>
        no token ever leaves this machine
      </span>
      <button class="btn btn-primary btn-sm" type="button" @click="startAdd">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
          <path d="M8 3v10M3 8h10" />
        </svg>
        Add connector
      </button>
    </div>

    <div v-if="connectors.error" class="cxn-error" role="alert">{{ connectors.error }}</div>

    <div v-if="!connectors.loaded && connectors.loading" class="cxn-empty">Reading this workspace's connectors…</div>

    <template v-else-if="!nothing">
      <div v-if="managed.length" class="ct" role="table" aria-label="Workspace connectors">
        <div class="ct-head" role="row">
          <span role="columnheader">Connector</span>
          <span role="columnheader">Kind</span>
          <span role="columnheader">Scope</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Last verified</span>
        </div>
        <div role="rowgroup">
          <template v-for="row in managed" :key="row.id">
            <ConnectorRow :row="row" :open="openId === row.id" :busy="busy === row.id" @toggle="toggle" />
            <ConnectorDetail
              v-if="openId === row.id"
              :row="row"
              :busy="busy === row.id"
              :error="detailError"
              :notice="detailNotice"
              @test="testDetail"
              @save="saveDetail"
              @disable="disableDetail"
              @remove="removeDetail"
              @close="closeDetail"
            />
          </template>
        </div>
      </div>

      <template v-if="unmanaged.length">
        <div class="sec-h">
          <h2>In this workspace's pool, not a connector</h2>
          <p>MCP servers a teammate synced or an older add path wrote. Shown, not hidden — this is where a token lives.</p>
          <span class="spacer"></span>
          <span class="cxn-pill cxn-pill-never">unmanaged</span>
        </div>
        <div class="ct unmanaged" role="table" aria-label="Unmanaged MCP servers">
          <ConnectorRow
            v-for="row in unmanaged"
            :key="row.id"
            :row="row"
            :busy="busy === row.id"
            @adopt="adopt"
            @toggle="toggle"
          />
        </div>
      </template>

      <template v-if="machine.length">
        <div class="sec-h">
          <h2>On this machine</h2>
          <p>
            Found in harness config files. Machine-owned and read-only here — copy one into the workspace to let
            the pass use it.
          </p>
          <span class="spacer"></span>
          <span class="cxn-pill cxn-pill-never">scope: machine</span>
        </div>
        <div class="ct unmanaged" role="table" aria-label="Connectors on this machine">
          <ConnectorRow
            v-for="row in machine"
            :key="row.id"
            :row="row"
            :busy="busy === row.id"
            @copy="copyHere"
          />
        </div>
      </template>
    </template>

    <p v-else-if="query || scope !== 'all'" class="cxn-empty">
      Nothing matches “{{ query || scope }}”.
      <button class="empty-link" type="button" @click="query = ''; scope = 'all'">Clear the filter</button>
    </p>
    <p v-else class="cxn-empty">No connectors yet. Add one, or copy one from this machine.</p>

    <!-- The add sheet: kind picker, then that kind's fields, then verify, then save. -->
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
            <label v-else>
              id
              <input v-model="addForm.id" type="text" placeholder="the id the pool and @ mention use" autocomplete="off" spellcheck="false" />
            </label>
            <template v-if="addKind === 'mcp'">
              <label>
                command or URL
                <input v-model="addForm.command" type="text" placeholder="npx … or https://…/mcp" autocomplete="off" spellcheck="false" />
              </label>
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

        <p class="detail-note">
          A save is rejected when the service refuses the credential, and nothing is written.
          <button class="empty-link" type="button" @click="goBack">Workspace settings</button>
        </p>
      </div>
    </div>
  </div>
</template>
