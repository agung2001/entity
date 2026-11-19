<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { call } from '@/composables/localBridge'
import { useDialogDismiss } from '@/composables/useDialog'
import IntegrationMark from '@/components/IntegrationMark.vue'
import { hub } from '@/stores/hub'

/**
 * Account → Integrations.
 *
 * Three third-party services a composer can mention, one switch each. Off is not
 * uninstalled: the binary keeps its place and stops being offered in the `@` menu
 * of every composer on this machine.
 *
 * The switch is the whole action — no Save, no Apply, no confirm. A write is
 * optimistic and snaps back on rejection, and YouTrack never flips at all
 * without a token: its switch opens the panel that stores one, because "on"
 * without a credential is a promise the next `@youtrack:` would break.
 *
 * The state lives in `electron/integrations-store.cjs` (`~/.entity/integrations.json`);
 * the token stays in this workspace's `mcp.json`, where the MCP runtime already
 * reads it. This page is the only writer of both, and it reaches them through
 * one call table.
 */
const UNDO_MS = 8000

const state = ref({ loading: true, loaded: false, error: '', total: 3 })
/* the list is the one mutable copy: `rows` is what the template paints, and a
   write replaces the row it touched rather than refetching three probes */
const rows = ref([])
const busy = ref('')
const undo = ref(null)
const error = ref('')
const retry = ref(null)
let undoTimer = null

/* one open panel at a time: `panel` names the row */
const panel = ref('')
const panelOpeners = new Map()
const panelBusy = ref('')
const panelError = ref('')
const panelNotice = ref('')
const draft = ref({ host: '', token: '' })
const reveal = ref(false)

const enabledCount = computed(() => rows.value.filter((row) => row.enabled).length)

/** `N of 3` in the head. A plain leading space before `on` is trimmed by the
    flex badge, so the phrase carries its own `&nbsp;` (finding F1). */
const badgeOf = computed(() => `${enabledCount.value} of ${state.value.total || 3}`)

function messageOf(problem) {
  return String(problem?.message || problem || '').replace(/^Error:\s*/, '')
}

function credentialMissing(problem) {
  return /^credential-missing/.test(messageOf(problem))
}

/* ── copy ─────────────────────────────────────────────────────────
   The vocabulary is closed: found, connected, off, not probed, not on PATH,
   not runnable, not signed in, saving… Every line ends with its `@` token, so a
   row answers "what will I be able to type" and not only "is this on". */

function nameOf(row) {
  return row?.label || row?.id || ''
}

function disclosureFor(row) {
  if (row?.id === 'orca') return 'Path'
  if (row?.id === 'github') return 'Sign-in'
  return 'Token'
}

function disclosureLabel(row) {
  if (row?.id === 'orca') return `${nameOf(row)} executable path`
  if (row?.id === 'github') return `${nameOf(row)} sign-in`
  return `${nameOf(row)} credential settings`
}

/** The one line under the name, split into the parts the template paints so the
    status word, the detail and the `@` token can each carry their own tone.
    `saving…` is appended by the template while a write is in flight and never
    replaces the state the row already knew. */
function stateParts(row) {
  if (!row) return []
  const parts = [{ kind: 'word', text: String(row.status || 'off') }]
  if (row.detail) parts.push({ kind: 'sep', text: ' · ' }, { kind: 'detail', text: String(row.detail) })
  parts.push(
    { kind: 'sep', text: ' · ' },
    { kind: 'token', text: String(row.token || '') },
    { kind: 'sep', text: ' ' },
    { kind: 'word', text: row.available ? 'offered' : 'unavailable' },
  )
  return parts
}

/** The same sentence, plain, for `title` — the state line ellipsises at one line
    and the full value has to be reachable without opening the panel. */
function stateTitle(row) {
  return stateParts(row)
    .map((part) => part.text)
    .join('')
    .trim()
}

function switchLabel(row) {
  if (!row) return ''
  if (busy.value === row.id) return `${nameOf(row)} is ${row.enabled ? 'on' : 'off'}, saving`
  if (row.id === 'youtrack' && !row.hasCredential) {
    return `${nameOf(row)} is off, no token. Opens the credential panel`
  }
  return row.enabled ? `${nameOf(row)} is on. Turn off` : `${nameOf(row)} is off. Turn on`
}

/* ── reading ──────────────────────────────────────────────────── */

async function load({ quiet = false } = {}) {
  if (!quiet) state.value.loading = true
  state.value.error = ''
  try {
    const data = await call('integrations.list', { workspace: hub.workspace })
    rows.value = data?.rows || []
    state.value = { ...state.value, loading: false, loaded: true, error: '', total: data?.total || 3 }
  } catch (problem) {
    rows.value = []
    state.value = { ...state.value, loading: false, loaded: false, error: messageOf(problem) }
  }
}

/* ── writing ──────────────────────────────────────────────────── */

function clearUndo() {
  clearTimeout(undoTimer)
  undoTimer = null
  undo.value = null
}

function offerUndo(row) {
  if (!row) return
  clearUndo()
  undo.value = {
    text: `${nameOf(row)} is on. ${row.token} is offered in every composer.`,
    action: () => write(row.id, false),
  }
  undoTimer = setTimeout(clearUndo, UNDO_MS)
}

function undoNow() {
  const action = undo.value?.action
  clearUndo()
  if (action) action()
}

async function write(id, enabled) {
  if (busy.value) return
  const before = rows.value.find((row) => row.id === id)
  if (!before) return
  busy.value = id
  error.value = ''
  /* optimistic: the switch moves now, the row dims, `saving…` is appended */
  const optimistic = rows.value.map((row) => (row.id === id ? { ...row, enabled } : row))
  rows.value = optimistic
  try {
    const row = await call('integrations.setEnabled', {
      workspace: hub.workspace,
      id,
      enabled,
    })
    if (row) {
      rows.value = rows.value.map((entry) => (entry.id === id ? row : entry))
      if (enabled) offerUndo(row)
    }
    retry.value = null
  } catch (problem) {
    /* no optimistic value survives a rejection */
    rows.value = rows.value.map((entry) => (entry.id === id ? before : entry))
    if (credentialMissing(problem)) {
      openPanel(before, { field: `int-token-${id}` })
      busy.value = ''
      return
    }
    error.value = messageOf(problem)
    retry.value = { id, enabled }
  } finally {
    busy.value = ''
  }
}

function toggle(row) {
  if (!row || busy.value) return
  /* YouTrack with no token never flips: the switch is a door to the panel */
  if (row.id === 'youtrack' && !row.enabled && !row.hasCredential) {
    openPanel(row, { field: `int-token-${row.id}` })
    return
  }
  write(row.id, !row.enabled)
}

function retryWrite() {
  const wanted = retry.value
  if (!wanted) return
  error.value = ''
  write(wanted.id, wanted.enabled)
}

/* ── the panel ───────────────────────────────────────────────── */

const isOpen = (id) => panel.value === id

function openerFor(id) {
  return panelOpeners.get(id) || null
}

function openPanel(row, { field = '' } = {}) {
  if (!row) return
  const disclosure = document.querySelector(`[data-int-cfg="${row.id}"]`)
  if (disclosure) panelOpeners.set(row.id, disclosure)
  panel.value = row.id
  panelError.value = ''
  panelNotice.value = ''
  reveal.value = false
  draft.value = {
    host: row.id === 'youtrack' ? row.path || '' : '',
    token: '',
  }
  nextTick(() => {
    /* The switch that was clicked is not the field: a person who pressed it
       meant "give me the token", so the caret goes into the panel's first
       input rather than to the disclosure. */
    const target =
      (field && document.getElementById(field)) ||
      document.querySelector('.int-panel .acct-input')
    target?.focus()
  })
}

function closePanel({ restore = true } = {}) {
  const closing = panel.value
  panel.value = ''
  panelError.value = ''
  panelNotice.value = ''
  reveal.value = false
  draft.value = { host: '', token: '' }
  if (!restore || !closing) return
  /* Esc and Cancel both land here: focus goes back to what opened the panel */
  const opener = openerFor(closing)
  nextTick(() => opener?.focus?.())
}

/* the one Escape stack — the panel is a dismissible surface like any other */
useDialogDismiss({
  active: () => Boolean(panel.value),
  close: () => closePanel(),
  guard: () => Boolean(panelBusy.value),
})

function togglePanel(row) {
  if (panel.value === row?.id) closePanel()
  else openPanel(row)
}

async function testConnection() {
  if (panelBusy.value) return
  panelBusy.value = panel.value
  panelError.value = ''
  panelNotice.value = ''
  try {
    const result = await call('integrations.test', {
      workspace: hub.workspace,
      id: panel.value,
    })
    panelNotice.value = result?.detail || 'The connection answered.'
  } catch (problem) {
    panelError.value = messageOf(problem)
  } finally {
    panelBusy.value = ''
  }
}

async function saveCredential() {
  if (panelBusy.value) return
  const id = panel.value
  panelBusy.value = id
  panelError.value = ''
  panelNotice.value = ''
  const saved = { ...draft.value }
  draft.value = { ...draft.value, token: '' }
  try {
    const result = await call('integrations.saveCredential', {
      workspace: hub.workspace,
      id,
      token: saved.token,
      host: saved.host,
    })
    if (result?.row) {
      rows.value = rows.value.map((entry) => (entry.id === id ? result.row : entry))
    }
    /* the switch turns on in the same write, so there is nothing left to click */
    if (result?.row && !result.row.enabled) await write(id, true)
    closePanel({ restore: false })
  } catch (problem) {
    /* the field keeps its value and says why; the stored token is untouched */
    draft.value = { ...draft.value, token: saved.token }
    panelError.value = messageOf(problem)
  } finally {
    panelBusy.value = ''
  }
}

function cancelPanel() {
  closePanel()
}

/* ── empty / error ───────────────────────────────────────────── */

const nothingInstalled = computed(
  () =>
    !state.value.loading &&
    state.value.loaded &&
    !state.value.error &&
    rows.value.length > 0 &&
    rows.value.every((row) => !row.installed),
)

/* Which file each one writes, for the aside — one fact per row, not a link. */
const WHERE = [
  { key: 'Switch', value: '~/.entity/integrations.json' },
  { key: 'Orca', value: 'orca repo list --json' },
  { key: 'YouTrack', value: 'mcp.json in this workspace' },
  { key: 'GitHub', value: 'gh auth keyring' },
  { key: 'Touches', value: 'composer @ menu' },
]

onMounted(() => {
  load()
})
onBeforeUnmount(() => {
  clearUndo()
})
</script>

<template>
  <div class="acct-page int-page">
    <section class="acct-card">
      <div class="acct-card-head int-head">
        <div>
          <h2>Integrations</h2>
          <p class="mnote">
            Machine-wide. An integration that is off stays installed and stops appearing in the
            <code>@</code> menu of every composer.
          </p>
        </div>
        <!-- absent until the count is known: an empty pill reads as "0 of 3" -->
        <span
          v-if="state.loaded"
          class="role-badge int-badge"
          :data-on="enabledCount ? '1' : '0'"
          >{{ badgeOf }}<span class="of">&nbsp;on</span></span
        >
      </div>

      <div class="undo-strip" role="status" v-if="undo">
        <span>{{ undo.text }}</span>
        <button class="undo-btn" type="button" @click="undoNow">Undo</button>
      </div>

      <div class="acct-error" role="alert" v-if="error">
        <span>
          Could not save — <code>~/.entity/integrations.json</code> is not writable. Nothing
          changed.
          <span class="int-reason" :title="error">{{ error }}</span>
        </span>
        <button class="btn btn-sm" type="button" style="flex: none" @click="retryWrite">
          Try again
        </button>
      </div>

      <ul class="int-list" v-if="state.loaded && rows.length && !nothingInstalled">
        <template v-for="row in rows" :key="row.id">
          <li class="int-row" :data-on="row.enabled ? '1' : '0'" :data-busy="busy === row.id ? '1' : '0'">
            <span class="int-mark" aria-hidden="true">
              <IntegrationMark :name="row.id" :size="22" />
            </span>

            <span class="int-copy">
              <span class="int-name">
                <b>{{ row.label }}</b><span class="id">{{ row.idText }}</span>
                <button
                  class="int-cfg-btn"
                  type="button"
                  :data-int-cfg="row.id"
                  :aria-expanded="isOpen(row.id) ? 'true' : 'false'"
                  :aria-label="disclosureLabel(row)"
                  @click="togglePanel(row)"
                >
                  {{ disclosureFor(row) }}<span
                    class="dot"
                    v-if="row.id === 'youtrack' && !row.hasCredential"
                    aria-hidden="true"
                  ></span>
                </button>
              </span>
              <span class="int-state" :title="stateTitle(row)">
                <template v-for="(part, at) in stateParts(row)" :key="at"
                  ><span v-if="part.kind === 'sep'">{{ part.text }}</span
                  ><span v-else-if="part.kind === 'token'" class="token">{{ part.text }}</span
                  ><span v-else-if="part.kind === 'word'" :class="part.text === 'found' || part.text === 'connected' ? 'ok' : ''">{{ part.text }}</span
                  ><span v-else>{{ part.text }}</span></template
                ><template v-if="busy === row.id"> · saving…</template>
              </span>
            </span>

            <button
              class="int-switch"
              type="button"
              role="switch"
              :aria-checked="row.enabled ? 'true' : 'false'"
              :aria-disabled="busy === row.id ? 'true' : 'false'"
              :aria-label="switchLabel(row)"
              @click="toggle(row)"
            >
              <span class="sfx-switch" :aria-checked="row.enabled ? 'true' : 'false'"><span></span></span>
            </button>
          </li>

          <li class="int-panel" v-if="isOpen(row.id)">
            <span class="gutter"></span>
            <span class="body">
              <label class="fld" v-if="row.id === 'youtrack'">
                <span class="lbl">Host</span>
                <input
                  id="int-panel-host"
                  v-model="draft.host"
                  class="acct-input mono"
                  type="text"
                  spellcheck="false"
                  :disabled="panelBusy === row.id"
                />
              </label>

              <label class="fld">
                <span class="lbl">{{ row.id === 'youtrack' ? 'Permanent token' : row.id === 'orca' ? 'Executable path' : 'Sign in with gh' }}</span>
                <input
                  :id="`int-token-${row.id}`"
                  v-model="draft.token"
                  class="acct-input mono"
                  :type="row.id === 'youtrack' && !reveal ? 'password' : 'text'"
                  spellcheck="false"
                  :disabled="panelBusy === row.id"
                  @keydown.enter.prevent="saveCredential"
                />
                <span class="fld-hint" v-if="row.id === 'youtrack'">
                  Stored in <code>mcp.json</code> of this workspace. Masked here until you reveal
                  it — never in a URL, never in a log.
                </span>
                <span class="fld-hint" v-else-if="row.id === 'orca'">
                  Machine-wide. An entity's <code>Harness path</code> still wins for that entity.
                </span>
                <span class="fld-hint" v-else>
                  <code>gh auth login</code> writes your keyring; this switch decides whether a
                  composer offers <code>@github:</code>.
                </span>
              </label>

              <span class="fld-hint int-bad" role="alert" v-if="panelError">{{ panelError }}</span>
              <span class="fld-hint int-good" role="status" v-else-if="panelNotice">{{ panelNotice }}</span>

              <span class="panel-actions">
                <button
                  class="btn btn-sm"
                  type="button"
                  :disabled="panelBusy === row.id"
                  @click="reveal = !reveal"
                >
                  {{ reveal ? 'Hide' : 'Reveal' }}
                </button>
                <button
                  class="btn btn-sm"
                  type="button"
                  :disabled="panelBusy === row.id"
                  @click="testConnection"
                >
                  {{ panelBusy === row.id ? 'Testing…' : 'Test connection' }}
                </button>
                <span class="sep"></span>
                <button
                  class="btn btn-sm btn-ghost"
                  type="button"
                  :disabled="panelBusy === row.id"
                  @click="cancelPanel"
                >
                  Cancel
                </button>
                <button
                  class="btn btn-sm btn-ink"
                  type="button"
                  :disabled="panelBusy === row.id"
                  @click="saveCredential"
                >
                  Save
                </button>
              </span>
              <span class="mnote">
                Writing to this workspace only. Another workspace needs its own token — a token is
                not copied between workspaces.
              </span>
            </span>
          </li>
        </template>
      </ul>

      <div class="empty-note err int-empty" v-else-if="state.error">
        <b>{{ state.error }}</b>
        <button class="btn btn-sm" type="button" @click="load()">Try again</button>
      </div>

      <div class="empty-note int-empty" v-else-if="nothingInstalled">
        <b>None of the three is installed here.</b>
        <p>
          Orca and GitHub CLI are probed on <code>PATH</code>; YouTrack is a remote server and only
          needs a token. Install one and reopen this page — nothing needs restarting.
        </p>
        <span class="cmd">brew install gh · orca repo list</span>
      </div>

      <ul class="int-list int-skeleton" v-else>
        <li class="skel-row" v-for="n in 3" :key="n" :data-skeleton="'1'">
          <span class="skel skel-mark"></span>
          <span class="skel-copy">
            <span class="skel skel-line s1"></span>
            <span class="skel skel-line s2"></span>
          </span>
          <span class="skel skel-pill"></span>
        </li>
      </ul>

      <p class="mnote int-note">
        Off is not uninstalled. Turning one on makes its <code>@</code> token appear in the composer
        of every entity on this machine — nothing else about the CLI changes.
      </p>
    </section>

    <aside class="role-card">
      <h2>Where each one lives</h2>
      <p class="mnote">
        The switch is one file. A credential is not: it stays wherever the tool already reads it, so
        revoking it in GitHub or YouTrack still works.
      </p>
      <dl class="ws-meta int-meta">
        <template v-for="entry in WHERE" :key="entry.key + entry.value">
          <dt>{{ entry.key }}</dt>
          <dd><code>{{ entry.value }}</code></dd>
        </template>
      </dl>
      <p class="mnote int-aside-note">
        Machine-wide, every workspace and every entity on it. A disabled integration cannot be
        mentioned by accident — the token is not offered, not merely hidden.
      </p>
    </aside>
  </div>
</template>
