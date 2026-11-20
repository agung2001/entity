<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import {
  harnesses,
  loadHarnesses,
  loadModels,
  setHarnessEnabled,
  setHarnessPath,
} from '@/stores/harnesses'

/**
 * The machine's agent CLIs, each with one switch. A harness that is off is not
 * uninstalled: it keeps its path, it stops being spawned and it stops being
 * offered in every picker on this machine. The switch is the whole action — no
 * Save, no Apply, no confirm — and a write that fails puts the old value back.
 */
const UNDO_MS = 8000

const busy = ref('')
const undo = ref(null)
const error = ref('')
const retry = ref(null)
let undoTimer = null
/* The path editor is inline, one row at a time: a CLI installed by a version
   manager or an app bundle is the one case PATH cannot answer. */
const editing = ref('')
const draft = ref('')
const pathBusy = ref('')
const pathError = ref('')

const rows = computed(() => harnesses.items)
const enabledCount = computed(() => rows.value.filter((row) => row.enabled).length)
/* A machine with none of them installed gets the empty note, not seven rows
   whose switches have nothing to turn on. */
const installedCount = computed(() => rows.value.filter((row) => row.installed).length)
const loadError = computed(() => harnesses.error)

function clearUndo() {
  clearTimeout(undoTimer)
  undoTimer = null
  undo.value = null
}

function offerUndo(text, action) {
  clearUndo()
  undo.value = { text, action }
  undoTimer = setTimeout(clearUndo, UNDO_MS)
}

async function write(id, enabled) {
  if (busy.value) return
  busy.value = id
  error.value = ''
  try {
    await setHarnessEnabled(id, enabled)
  } catch (problem) {
    error.value = problem?.message || 'the file could not be written'
    retry.value = { id, enabled }
    busy.value = ''
    return
  }
  busy.value = ''
  retry.value = null
  const row = rows.value.find((entry) => entry.id === id)
  const label = row?.label || id
  offerUndo(enabled ? `${label} is on.` : `${label} is off. New chats will not offer it.`, () =>
    write(id, !enabled),
  )
}

function toggle(row) {
  if (busy.value || locked(row)) return
  write(row.id, !row.enabled)
}

function undoNow() {
  const action = undo.value?.action
  clearUndo()
  if (action) action()
}

function retryWrite() {
  const wanted = retry.value
  if (!wanted) return
  error.value = ''
  write(wanted.id, wanted.enabled)
}

function startEdit(row) {
  if (busy.value || pathBusy.value) return
  pathError.value = ''
  editing.value = row.id
  draft.value = row.customPath || ''
  /* the field is inside the row it belongs to, so focus lands there and a
     keyboard user never has to hunt for the editor */
  nextTick(() => document.getElementById(`harness-path-${row.id}`)?.focus())
}

/* clearing the override hands the harness back to whatever PATH resolves */
function usePath(row) {
  draft.value = ''
  savePath(row)
}

function cancelEdit() {
  editing.value = ''
  draft.value = ''
  pathError.value = ''
}

async function savePath(row) {
  if (pathBusy.value) return
  pathBusy.value = row.id
  pathError.value = ''
  try {
    await setHarnessPath(row.id, String(draft.value || '').trim())
    loadModels(row.id, true).catch(() => {})
    loadHarnesses(true).catch(() => {})
    editing.value = ''
    draft.value = ''
  } catch (problem) {
    pathError.value = problem?.message || 'That path could not be saved.'
  } finally {
    pathBusy.value = ''
  }
}

/* the last one on cannot be turned off: Entity needs one harness to offer */
function locked(row) {
  return row.enabled && enabledCount.value === 1
}

function stateLine(row) {
  if (!row.installed) {
    /* a custom path that does not resolve is still the value the person saved */
    const where = row.customPath || 'not on PATH'
    return `${row.enabled ? 'on' : 'off'} · ${where}`
  }
  if (!row.enabled) return `off · ${row.path || row.command}`
  return row.path || row.command
}

function warningFor(row) {
  if (locked(row)) return 'The only one on. Turn another on before turning this off.'
  if (row.enabled && !row.installed) {
    return `No ${row.command} executable on this machine — a chat fails to start until it is installed.`
  }
  return ''
}

function a11yLabel(row) {
  if (locked(row)) return `${row.label} is on. It is the last one on, so it cannot be turned off`
  if (busy.value === row.id) return `${row.label} is ${row.enabled ? 'on' : 'off'}, saving`
  if (row.enabled && !row.installed) return `${row.label} is on, but no executable was found`
  return row.enabled ? `${row.label} is on. Turn off` : `${row.label} is off. Turn on`
}

onMounted(() => {
  /* the rail loads this too; forcing here means a switch always writes over a
     list read after this page opened */
  loadHarnesses(true).catch(() => {})
})
onBeforeUnmount(clearUndo)
</script>

<template>
  <div class="harness-page">
    <section class="acct-card">
      <div class="acct-card-head">
        <div>
          <h2>Harnesses</h2>
          <p class="mnote">
            Machine-wide. A harness that is off keeps its settings and stops appearing in every
            picker on this machine.
          </p>
        </div>
        <span class="role-badge harness-count" :data-on="enabledCount ? '1' : '0'">
          <template v-if="harnesses.loading">checking</template>
          <template v-else
            >{{ enabledCount }} of {{ rows.length || '—' }}<span class="of">&nbsp;on</span></template
          >
        </span>
      </div>

      <div class="undo-strip" role="status" v-if="undo">
        <span>{{ undo.text }}</span>
        <button class="undo-btn" type="button" @click="undoNow">Undo</button>
      </div>

      <div class="acct-error" role="alert" v-if="error">
        <span>
          Could not save — <code>~/.entity/harnesses.json</code> is not writable. Nothing changed.
          <span class="harness-reason">{{ error }}</span>
        </span>
        <button class="btn" type="button" style="flex: none" @click="retryWrite">Try again</button>
      </div>

      <ul class="harness-list" v-if="rows.length && installedCount">
        <template v-for="row in rows" :key="row.id">
        <li class="harness-row" :data-on="row.enabled ? '1' : '0'">
          <span class="harness-mark"><HarnessIcon :name="row.id" :size="18" /></span>
          <span class="harness-copy">
            <span class="harness-name">
              <b>{{ row.label }}</b><span class="id">{{ row.command }}</span>
              <button
                class="harness-path-btn"
                type="button"
                :aria-expanded="editing === row.id ? 'true' : 'false'"
                :aria-label="`${row.label} executable path`"
                :title="row.customPath ? `Path override: ${row.customPath}` : 'Set a path'"
                @click="editing === row.id ? cancelEdit() : startEdit(row)"
              >
                {{ row.customPath ? 'path · custom' : 'Path' }}
              </button>
            </span>
            <span class="harness-state" :title="row.path || row.command">
              <template v-if="row.enabled && row.installed"
                ><span class="ok">found</span> · {{ row.path }}</template
              ><template v-else>{{ stateLine(row) }}</template
              ><template v-if="busy === row.id"> · saving…</template>
            </span>
            <span class="harness-why" v-if="warningFor(row)">{{ warningFor(row) }}</span>
            <span class="harness-why" v-if="pathError && editing === row.id" data-tone="error">
              {{ pathError }}
            </span>
          </span>
          <button
            class="harness-switch"
            type="button"
            role="switch"
            :aria-checked="row.enabled ? 'true' : 'false'"
            :aria-disabled="locked(row) || Boolean(busy) ? 'true' : 'false'"
            :aria-label="a11yLabel(row)"
            @click="toggle(row)"
          >
            <span class="sfx-switch" :aria-checked="row.enabled ? 'true' : 'false'"><span></span></span>
          </button>
        </li>
        <li class="harness-path-edit-row" v-if="editing === row.id">
          <input
            :id="`harness-path-${row.id}`"
            v-model="draft"
            class="acct-input harness-path-edit mono"
            type="text"
            spellcheck="false"
            :placeholder="row.path || `${row.command} — found on PATH`"
            :aria-label="`${row.label} executable path`"
            :disabled="pathBusy === row.id"
            @keydown.enter.prevent="savePath(row)"
          />
          <button
            class="btn btn-sm btn-ink"
            type="button"
            :disabled="pathBusy === row.id"
            @click="savePath(row)"
          >
            {{ pathBusy === row.id ? 'Saving…' : 'Save' }}
          </button>
          <button
            class="btn btn-sm btn-ghost"
            type="button"
            :disabled="pathBusy === row.id"
            @click="cancelEdit"
          >
            Cancel
          </button>
          <button
            v-if="row.custom"
            class="btn btn-sm btn-ghost"
            type="button"
            :disabled="pathBusy === row.id"
            @click="usePath(row)"
          >
            Use PATH
          </button>
        </li>
        </template>
      </ul>

      <div class="empty-note" v-else-if="!harnesses.loading && loadError">
        <b>{{ loadError }}</b>
        <button class="btn" type="button" @click="loadHarnesses(true).catch(() => {})">
          Try again
        </button>
      </div>

      <div class="empty-note" v-else-if="!harnesses.loading">
        <b>No agent CLI found on this machine.</b>
        <p>
          None of the known harnesses resolves on <code>PATH</code>. Install one and reopen this
          page — entity probes each binary on open, so nothing needs restarting.
        </p>
        <span class="cmd">
          npm i -g @anthropic-ai/claude-code · npm i -g @openai/codex · npm i -g @google/gemini-cli
          · npm i -g opencode-ai · brew install ollama · pi
        </span>
        <p>
          Antigravity's <code>agy</code> and <code>hermes</code> work the same way. A CLI
          installed elsewhere is fine too — set its path on an entity.
        </p>
        <button class="btn" type="button" @click="loadHarnesses(true).catch(() => {})">
          Check again
        </button>
      </div>

      <ul class="harness-list skeleton" v-else>
        <li class="skel-row" v-for="n in 4" :key="n">
          <span class="skel skel-mark"></span>
          <span class="skel-copy">
            <span class="skel skel-line s1"></span>
            <span class="skel skel-line s2"></span>
          </span>
          <span class="skel skel-pill"></span>
        </li>
      </ul>

      <p class="harness-note mnote">
        Off is not uninstalled. The row stays, the binary is still probed, and turning it back on
        needs no restart. A CLI in a version manager or an app bundle is found with
        <code>Path</code> — the override is machine-wide, and an entity's
        <code>Harness path</code> still wins for that entity.
      </p>
    </section>

    <aside class="role-card">
      <h2>Where the list shows up</h2>
      <p class="mnote">
        One switch, every surface. Turning a harness off here is the same as deleting it from each
        of these lists by hand — except it is reversible.
      </p>
      <dl class="ws-meta">
        <dt>New thread</dt><dd>harness picker</dd>
        <dt>Entity</dt><dd>harness field</dd>
        <dt>Composer</dt><dd>harness &amp; model</dd>
        <dt>Spawn tree</dt><dd>child rows</dd>
        <dt>Activity</dt><dd>harness filter</dd>
        <dt>Config</dt><dd>~/.entity/harnesses.json</dd>
      </dl>
      <p class="mnote account-card-note">
        Applies to this machine, every workspace and every entity on it. A harness that is off is
        not spawned and cannot be selected — it is not merely hidden.
      </p>
    </aside>
  </div>
</template>
