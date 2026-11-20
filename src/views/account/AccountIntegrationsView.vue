<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import IntegrationMark from '@/components/IntegrationMark.vue'
import { useDialogDismiss } from '@/composables/useDialog'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import { hub } from '@/stores/hub'
import {
  integrations,
  loadIntegrations,
  probeIntegrations,
  saveIntegrationCredential,
  setIntegrationEnabled,
  testIntegration,
} from '@/stores/integrations'

/**
 * Account → Integrations.
 *
 * A roster, not a card grid: three third-party services a composer can mention,
 * drawn as the one table this repo already owns (bounded scroll area, sticky
 * head, a 58 px row, one separator system). The grammar is Account → Harnesses'
 * and Skills': `mark · copy · switch`, with the disclosure on the name line and
 * its editor in a sibling row on the same grid.
 *
 * The read is two calls. `integrations.list` is the switches and answers in a
 * millisecond; `integrations.probe` spawns `orca`, spawns `gh` and searches
 * YouTrack through the MCP pool, so it lands after the rows are painted and is
 * cached — coming back to this page does not re-sign-in to anything. `Refresh`
 * is the only thing that pays for the probe again.
 *
 * The state lives in `electron/integrations-store.cjs` (`~/.entity/integrations.json`);
 * the token stays in this workspace's `mcp.json`, where the MCP runtime already
 * reads it. This page is the only writer of both, and it reaches them through
 * one call table.
 */
const UNDO_MS = 8000

const rows = computed(() => integrations.rows)
const enabledCount = computed(() => rows.value.filter((row) => row.enabled).length)
const busy = ref('')
const undo = ref(null)
const error = ref('')
const retry = ref(null)
const writeError = ref('')
let undoTimer = null

/* one open panel at a time: `panel` names the row */
const panel = ref('')
const panelOpeners = new Map()
const panelBusy = ref('')
const panelError = ref('')
const panelNotice = ref('')
const draft = ref({ host: '', token: '' })
const reveal = ref(false)

/* the roster's search: the same field, the same key, every searchable list */
const query = ref('')
const searchEl = ref(null)
const searchKey = shortcutLabel('inventory-search')

function messageOf(problem) {
  return String(problem?.message || problem || '').replace(/^Error:\s*/, '')
}

function credentialMissing(problem) {
  return /^credential-missing/.test(messageOf(problem))
}

function nameOf(row) {
  return row?.label || row?.id || ''
}

/* ── the table's columns ────────────────────────────────────────
   A row answers three questions and only three: which service, is it on, and
   what will it actually do. The `@` token is part of the third, because that is
   what a person types. */

function stateOf(row) {
  return String(row?.status || 'not probed')
}

function toneOf(row) {
  const word = stateOf(row)
  if (word === 'found' || word === 'connected') return 'ok'
  if (row?.problem) return 'bad'
  return ''
}

/** The one sentence under the name. A row that has not been probed says so,
    rather than pretending its binary is missing. */
function detailOf(row) {
  if (integrations.probing && !row?.detail) return 'asking…'
  return String(row?.detail || '')
}

function titleOf(row) {
  return [stateOf(row), detailOf(row), row?.token, row?.available ? 'offered' : 'unavailable']
    .filter(Boolean)
    .join(' · ')
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

function switchLabel(row) {
  if (!row) return ''
  if (busy.value === row.id) return `${nameOf(row)} is ${row.enabled ? 'on' : 'off'}, saving`
  if (row.id === 'youtrack' && !row.hasCredential) {
    return `${nameOf(row)} is off, no token. Opens the credential panel`
  }
  return row.enabled ? `${nameOf(row)} is on. Turn off` : `${nameOf(row)} is off. Turn on`
}

/* ── the search ──────────────────────────────────────────────── */

const visible = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return rows.value
  return rows.value.filter((row) =>
    [row.label, row.id, row.idText, row.token, row.status, row.detail, row.path]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle)),
  )
})

const nothingInstalled = computed(
  () =>
    !integrations.loading &&
    integrations.loaded &&
    !integrations.error &&
    rows.value.length > 0 &&
    rows.value.every((row) => !row.installed),
)

function focusSearch() {
  const field = searchEl.value
  if (!(field instanceof HTMLInputElement)) return
  field.focus()
  field.select()
}

function onKey(event) {
  if (!matchesShortcut('inventory-search', event)) return
  event.preventDefault()
  focusSearch()
}

/* ── reading ────────────────────────────────────────────────── */

/**
 * Rows first, status second: the page is usable the moment the rows land, and a
 * row says `not probed` until the second answer arrives. The probe still asks
 * all three services in main (one spawn each, cached for minutes there), so a
 * switched-off row can carry the truth about its binary instead of "unknown" —
 * the cost was the *synchronous* wait, not the probe.
 */
async function read({ force = false } = {}) {
  await loadIntegrations({ workspace: hub.workspace })
  probeIntegrations({ workspace: hub.workspace, force }).catch(() => {})
}

/* ── writing ────────────────────────────────────────────────── */

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
  try {
    const row = await setIntegrationEnabled(id, enabled)
    if (row && enabled) offerUndo(row)
    retry.value = null
  } catch (problem) {
    if (credentialMissing(problem)) {
      openPanel(before, { field: `int-token-${id}` })
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

/* ── the panel ─────────────────────────────────────────────── */

const isOpen = (id) => panel.value === id

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
      (field && document.getElementById(field)) || document.querySelector('.int-panel .acct-input')
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
  const opener = panelOpeners.get(closing)
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
    const result = await testIntegration(panel.value)
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
    const result = await saveIntegrationCredential({
      id,
      token: saved.token,
      host: saved.host,
    })
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

/* ── the probe clock ─────────────────────────────────────────── */

const probedLabel = computed(() => {
  if (!integrations.probed) return integrations.probing ? 'asking…' : 'not asked yet'
  const then = Number(integrations.probedAt)
  if (!Number.isFinite(then) || then <= 0) return integrations.cached ? 'cached' : 'just now'
  const minutes = Math.floor((Date.now() - then) / 60_000)
  const clock = minutes < 1 ? 'just now' : minutes === 1 ? 'a minute ago' : `${minutes}m ago`
  return integrations.cached ? `${clock} · cached` : clock
})

const stamp = ref(Date.now())
/* one ticker for the label, so "just now" does not stay true for an hour */
let ticker = null

const refreshing = computed(() => integrations.probing)

/* Which file each one writes, for the aside — one fact per row, not a link. */
const WHERE = [
  { key: 'Switch', value: '~/.entity/integrations.json' },
  { key: 'Orca', value: 'orca repo list --json' },
  { key: 'YouTrack', value: 'mcp.json in this workspace' },
  { key: 'GitHub', value: 'gh auth keyring' },
  { key: 'Touches', value: 'composer @ menu' },
]

onMounted(() => {
  window.addEventListener('keydown', onKey)
  if (!integrations.loaded || integrations.workspace !== hub.workspace) read()
  else if (!integrations.probed) probeIntegrations({ workspace: hub.workspace }).catch(() => {})
  ticker = setInterval(() => {
    stamp.value = Date.now()
  }, 30_000)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  clearUndo()
  clearTimeout(undoTimer)
  clearInterval(ticker)
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
        <span
          v-if="integrations.loaded"
          class="role-badge int-badge"
          :data-on="enabledCount ? '1' : '0'"
          >{{ enabledCount }} of {{ integrations.total }}<span class="of">&nbsp;on</span></span
        >
      </div>

      <div class="undo-strip" role="status" v-if="undo">
        <span>{{ undo.text }}</span>
        <button class="undo-btn" type="button" @click="undoNow">Undo</button>
      </div>

      <div class="acct-error" role="alert" v-if="error || writeError">
        <span>
          Could not save — <code>~/.entity/integrations.json</code> is not writable. Nothing
          changed.
          <span class="int-reason" :title="error || writeError">{{ error || writeError }}</span>
        </span>
        <button class="btn btn-sm" type="button" style="flex: none" @click="retryWrite">
          Try again
        </button>
      </div>

      <!-- the bar: the same search every roster has, the probe clock, and the one
           action that pays for the probe again. The status line is the only part
           that ever needed a spawn, so it is the only part that can be stale —
           and it says when it was read. -->
      <div class="skbar int-bar" v-if="integrations.loaded && rows.length">
        <label class="sksearch int-search">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <circle cx="7" cy="7" r="4.3" />
            <path d="M10.3 10.3L14 14" />
          </svg>
          <input
            ref="searchEl"
            v-model="query"
            type="search"
            placeholder="Search name or status…"
            aria-label="Search this machine's integrations"
            spellcheck="false"
          />
          <kbd class="sksearch-key search-kbd" aria-hidden="true">{{ searchKey }}</kbd>
        </label>
        <span class="int-where" :title="integrations.probed ? 'The status line, read once and cached' : 'The status line has not been read yet'">
          {{ probedLabel }}
        </span>
        <button
          class="btn btn-sm int-refresh"
          type="button"
          :disabled="refreshing"
          title="Ask every switched-on CLI again and replace the cached status"
          @click="read({ force: true })"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <path d="M13.4 7.2a5.4 5.4 0 1 0-5.1-3.6M13.4 7.2V2.9M13.4 7.2h-4.2" />
            <path d="M2.6 8.8a5.4 5.4 0 1 0 5.1 3.6M2.6 8.8v4.3M2.6 8.8h4.2" />
          </svg>
          {{ refreshing ? 'Asking…' : 'Refresh' }}
        </button>
        <span class="skbar-where int-count">{{ visible.length }} of {{ rows.length }}</span>
      </div>

      <div class="acct-error int-probe-error" role="status" v-if="integrations.probeError">
        <span>
          The CLIs could not be asked, so every status below is what this machine knew last.
          <span class="int-reason" :title="integrations.probeError">{{ integrations.probeError }}</span>
        </span>
        <button class="btn btn-sm" type="button" @click="read({ force: true })">Try again</button>
      </div>

      <!-- the roster: a table with one bounded scroll area, the same grammar as
           the skills shelf and the machine inventories -->
      <div
        class="skt int-t"
        v-if="integrations.loaded && rows.length && !nothingInstalled"
        role="table"
        aria-label="Third-party services this machine can offer"
      >
        <div class="row head" role="row">
          <span class="k1" role="columnheader">Integration</span>
          <span class="k2" role="columnheader">Status</span>
          <span class="k3" role="columnheader">Token</span>
          <span class="acts-head k4" role="columnheader">On</span>
        </div>

        <div v-if="!visible.length" class="empty-note int-noresults" role="row">
          <b>No integration matches “{{ query.trim() }}”.</b>
          <span>Search covers the name, the id, the status line and the <code>@</code> token.</span>
          <div class="empty-actions">
            <button class="btn btn-sm" type="button" @click="query = ''">Clear the search</button>
          </div>
        </div>

        <template v-for="row in visible" :key="row.id">
          <div
            class="row int-row"
            role="row"
            :data-on="row.enabled ? '1' : '0'"
            :data-busy="busy === row.id ? '1' : '0'"
          >
            <div class="nm k1" role="cell">
              <span class="int-mark">
                <IntegrationMark :name="row.id" :size="22" />
              </span>
              <span class="nm-stack int-copy">
                <span class="nm-line int-name">
                  <b>{{ row.label }}</b><span class="id">{{ row.idText }}</span>
                </span>
              </span>
            </div>

            <span class="int-state k2" role="cell" :title="titleOf(row)">
              <span :class="toneOf(row)">{{ stateOf(row) }}</span>
              <template v-if="detailOf(row)"> · {{ detailOf(row) }}</template>
              <template v-if="busy === row.id"> · saving…</template>
            </span>

            <span class="int-token k3" role="cell">
              <code>{{ row.token }}</code>
              <span class="int-avail" :data-ok="row.available ? '1' : '0'">
                {{ row.available ? 'offered' : 'unavailable' }}
              </span>
            </span>

            <div class="acts k4 int-acts" role="cell">
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
            </div>
          </div>

          <div class="row int-panel" v-if="isOpen(row.id)" role="row">
            <span class="gutter k1"></span>
            <span class="body k2 k3 k4">
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
                <span class="lbl">{{
                  row.id === 'youtrack'
                    ? 'Permanent token'
                    : row.id === 'orca'
                      ? 'Executable path'
                      : 'Sign in with gh'
                }}</span>
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
          </div>
        </template>
      </div>

      <div class="empty-note err int-empty" v-else-if="integrations.error">
        <b>{{ integrations.error }}</b>
        <button class="btn btn-sm" type="button" @click="read()">Try again</button>
      </div>

      <div class="empty-note int-empty" v-else-if="nothingInstalled">
        <b>None of the three is installed here.</b>
        <p>
          Orca and GitHub CLI are probed on <code>PATH</code>; YouTrack is a remote server and only
          needs a token. Install one and reopen this page — nothing needs restarting.
        </p>
        <span class="cmd">brew install gh · orca repo list</span>
      </div>

      <!-- skeleton, in the real grid: nothing moves when the rows land -->
      <div
        class="skt int-t int-skeleton"
        v-else
        role="table"
        aria-busy="true"
        aria-label="Third-party services this machine can offer"
      >
        <div class="row head" role="row">
          <span class="k1" role="columnheader">Integration</span>
          <span class="k2" role="columnheader">Status</span>
          <span class="k3" role="columnheader">Token</span>
          <span class="acts-head k4" role="columnheader">On</span>
        </div>
        <div v-for="n in 3" :key="n" class="row" role="row" aria-hidden="true">
          <div class="nm k1" role="cell">
            <span class="skel skel-mark"></span>
            <span class="skel skel-line s1"></span>
          </div>
          <span class="k2" role="cell"><span class="skel skel-line s2"></span></span>
          <span class="k3" role="cell"><span class="skel skel-line s3"></span></span>
          <div class="acts k4" role="cell"><span class="skel skel-pill"></span></div>
        </div>
      </div>

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
      <p class="mnote int-aside-note">
        The status line is the only thing here that costs a process or a request, so it is read
        once and cached for five minutes. <code>Refresh</code> is the one way to pay for it again.
      </p>
    </aside>
  </div>
</template>
