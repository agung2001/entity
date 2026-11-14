<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { call } from '@/composables/localBridge'
import { playSfx } from '@/lib/sfx'
import { ago, hub, toast } from '@/stores/hub'
import { loadWorkspaceList } from '@/stores/workspaces'

/**
 * Account → Backups.
 *
 * A snapshot is one ZIP of a workspace, stored outside it under a target folder
 * that defaults to `~/.entity/backups/` and can be changed per workspace. The
 * page owns the schedule, the folder and the shelf; the policy lives in
 * `electron/backup-store.cjs` so the timer, the page and the tests agree on what
 * "smart" means.
 *
 * Default is smart: daily for the last 7 days, one a week this month, one a
 * month this year. Other modes trade frequency for a longer window, and Manual
 * only turns the timer off.
 */
const state = reactive({
  loading: true,
  loaded: false,
  error: '',
  data: null,
})
const selectedId = ref('')
const busy = ref('')
const confirming = ref('')
const folderDraft = ref('')
const folderDirty = ref(false)
const folderInput = ref(null)
let confirmTimer = 0
let pollTimer = 0
let request = 0

const modes = computed(() => state.data?.modes || [])
const rows = computed(() => state.data?.workspaces || [])
const selected = computed(
  () => rows.value.find((row) => row.id === selectedId.value) || rows.value[0] || null,
)
const mode = computed(
  () => modes.value.find((entry) => entry.id === selected.value?.mode) || modes.value[0] || null,
)
const anyRunning = computed(() => rows.value.some((row) => row.running))
const checkMinutes = computed(() =>
  Math.max(1, Math.round(Number(state.data?.intervalMs || 0) / 60_000)),
)
const folderChanged = computed(
  () => folderDraft.value.trim() !== String(selected.value?.directory || '').trim(),
)

function messageOf(error) {
  return String(error?.message || error).replace(/^Error:\s*/, '')
}

function sizeLabel(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function when(iso) {
  if (!iso) return ''
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return ''
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function lastLabel(entry) {
  if (!entry?.lastBackupAt) return 'Never'
  return ago(entry.lastBackupAt)
}

function nextLabel(entry) {
  if (!entry) return ''
  if (!entry.automatic) return 'Manual only'
  if (entry.due) return 'Due now'
  return entry.nextDueAt ? when(entry.nextDueAt) : ''
}

function pickDefault(data) {
  if (data.workspaces.some((row) => row.id === hub.workspace)) return hub.workspace
  return data.workspaces[0]?.id || ''
}

async function load({ quiet = false } = {}) {
  const id = ++request
  if (!quiet) state.loading = true
  state.error = ''
  try {
    const data = await call('backup.status')
    if (id !== request) return
    state.data = data
    state.loaded = true
    if (!data.workspaces.some((row) => row.id === selectedId.value)) {
      selectedId.value = pickDefault(data)
    }
    if (!folderDirty.value) {
      const entry = data.workspaces.find((row) => row.id === selectedId.value)
      folderDraft.value = entry?.directory || ''
    }
  } catch (error) {
    if (id !== request) return
    state.error = messageOf(error)
  } finally {
    if (id === request) state.loading = false
  }
  schedulePoll()
}

/* A scheduled backup or another window's run shows up without a reload. */
function schedulePoll() {
  clearTimeout(pollTimer)
  pollTimer = 0
  if (!anyRunning.value) return
  pollTimer = setTimeout(() => load({ quiet: true }), 2500)
}

function selectWorkspace(event) {
  selectedId.value = event.target.value
  confirming.value = ''
  folderDirty.value = false
  folderDraft.value =
    rows.value.find((row) => row.id === selectedId.value)?.directory || ''
}

function onFolderInput(event) {
  folderDraft.value = event.target.value
  folderDirty.value = true
}

async function applyFolder() {
  if (!selected.value || busy.value || selected.value.running || !folderChanged.value) return
  const id = selected.value.id
  const directory = folderDraft.value.trim()
  busy.value = 'folder'
  try {
    await call('backup.setDirectory', { id, directory })
    folderDirty.value = false
    await load({ quiet: true })
    playSfx('confirm')
    toast('Backup folder saved')
  } catch (error) {
    playSfx('error')
    toast(messageOf(error) || 'The backup folder could not be saved.')
  } finally {
    busy.value = ''
  }
}

async function chooseFolder() {
  if (!selected.value || busy.value || selected.value.running) return
  try {
    const result = await call('backup.chooseFolder', { id: selected.value.id })
    if (result?.canceled) return
    folderDirty.value = false
    await load({ quiet: true })
    playSfx('confirm')
    toast('Backup folder saved')
  } catch (error) {
    playSfx('error')
    toast(messageOf(error) || 'The folder picker is not available here — type the path instead.')
    folderInput.value?.focus()
  }
}

async function setMode(next) {
  if (!selected.value || busy.value || next === selected.value.mode) return
  const id = selected.value.id
  busy.value = 'mode'
  try {
    await call('backup.setMode', { id, mode: next })
    await load({ quiet: true })
    playSfx('confirm')
    toast(`Backup schedule: ${modes.value.find((entry) => entry.id === next)?.label || next}`)
  } catch (error) {
    playSfx('error')
    toast(messageOf(error) || 'The backup schedule could not be saved.')
    await load({ quiet: true })
  } finally {
    busy.value = ''
  }
}

async function runNow() {
  if (!selected.value || busy.value) return
  const id = selected.value.id
  busy.value = 'run'
  try {
    await call('backup.run', { id })
    await load({ quiet: true })
    playSfx('download')
    toast('Workspace backed up')
  } catch (error) {
    playSfx('error')
    toast(messageOf(error) || 'The backup could not be created.')
    await load({ quiet: true })
  } finally {
    busy.value = ''
  }
}

async function openFolder() {
  if (!selected.value || busy.value) return
  try {
    await call('backup.reveal', { id: selected.value.id })
  } catch (error) {
    toast(messageOf(error) || 'The backup folder could not be opened.')
  }
}

async function restore(item) {
  if (!selected.value || busy.value) return
  const id = selected.value.id
  busy.value = `restore:${item.name}`
  try {
    const result = await call('backup.restore', { id, name: item.name })
    await loadWorkspaceList()
    await load({ quiet: true })
    playSfx('upload')
    const warnings = Array.isArray(result?.warnings) ? result.warnings.length : 0
    toast(
      warnings
        ? `${result.record.label} restored · ${warnings} item${warnings === 1 ? '' : 's'} skipped`
        : `${result.record.label} restored · open it from Workspaces`,
    )
  } catch (error) {
    playSfx('error')
    toast(messageOf(error) || 'The backup could not be restored.')
  } finally {
    busy.value = ''
  }
}

function armRemove(name) {
  clearTimeout(confirmTimer)
  if (confirming.value !== name) {
    confirming.value = name
    confirmTimer = setTimeout(() => {
      if (confirming.value === name) confirming.value = ''
    }, 4000)
    return false
  }
  confirming.value = ''
  return true
}

async function remove(item) {
  if (!selected.value || busy.value) return
  if (!armRemove(item.name)) return
  const id = selected.value.id
  busy.value = `remove:${item.name}`
  try {
    await call('backup.remove', { id, name: item.name })
    await load({ quiet: true })
    playSfx('remove')
    toast('Backup deleted')
  } catch (error) {
    playSfx('error')
    toast(messageOf(error) || 'The backup could not be deleted.')
  } finally {
    busy.value = ''
  }
}

onMounted(() => {
  load()
})

onBeforeUnmount(() => {
  clearTimeout(confirmTimer)
  clearTimeout(pollTimer)
})
</script>

<template>
  <div class="backups-page">
    <section class="acct-card bkp-card">
      <div class="acct-card-head bkp-head">
        <div>
          <h2>Workspace backups</h2>
          <p class="mnote">
            A ZIP snapshot of one workspace's entities, chats, skills, files and settings, stored
            outside the workspace in the folder you choose.
          </p>
        </div>
        <span v-if="selected" class="role-badge">{{ selected.items.length }} saved</span>
      </div>

      <p v-if="state.loading && !state.loaded" class="bkp-empty">Reading backup status…</p>

      <div v-else-if="state.error" class="bkp-error" role="alert">
        <b>Backups are unavailable</b>
        <span>{{ state.error }}</span>
        <button class="btn btn-sm" type="button" @click="load()">Try again</button>
      </div>

      <p v-else-if="!rows.length" class="bkp-empty">
        No workspace is available to back up. Create one first.
      </p>

      <template v-else>
        <div class="bkp-toolbar">
          <label class="bkp-select">
            <span>Workspace</span>
            <select :value="selected?.id" :disabled="Boolean(busy)" @change="selectWorkspace">
              <option v-for="row in rows" :key="row.id" :value="row.id">
                {{ row.label }}<template v-if="row.label !== row.id"> · {{ row.id }}</template>
              </option>
            </select>
          </label>
          <div class="bkp-toolbar-actions">
            <button class="btn btn-sm" type="button" :disabled="Boolean(busy)" @click="openFolder">
              Open folder
            </button>
            <button
              class="btn btn-sm btn-ink"
              type="button"
              :disabled="Boolean(busy) || Boolean(selected?.running)"
              @click="runNow"
            >
              {{ busy === 'run' || selected?.running ? 'Backing up…' : 'Back up now' }}
            </button>
          </div>
        </div>

        <div v-if="selected" class="bkp-folder">
          <label class="bkp-folder-copy" for="backup-folder">
            <span>Backup folder</span>
            <small>ZIPs are written to {{ selected.backupDirDisplay }}</small>
          </label>
          <div class="bkp-folder-line">
            <input
              id="backup-folder"
              ref="folderInput"
              class="bkp-folder-input"
              type="text"
              spellcheck="false"
              autocomplete="off"
              :value="folderDraft"
              :disabled="Boolean(busy) || selected.running"
              aria-label="Backup folder"
              @input="onFolderInput"
              @keydown.enter.prevent="applyFolder"
            />
            <button
              class="bkp-btn"
              type="button"
              :disabled="Boolean(busy) || selected.running"
              title="Choose a folder"
              @click="chooseFolder"
            >
              Choose…
            </button>
            <button
              class="bkp-btn"
              type="button"
              :disabled="Boolean(busy) || selected.running || !folderChanged"
              @click="applyFolder"
            >
              {{ busy === 'folder' ? 'Saving…' : 'Apply' }}
            </button>
          </div>
        </div>

        <div v-if="selected" class="bkp-status">
          <div class="bkp-stat">
            <span>Last backup</span>
            <b :title="when(selected.lastBackupAt)">{{ lastLabel(selected) }}</b>
          </div>
          <div class="bkp-stat">
            <span>Next automatic</span>
            <b :title="when(selected.nextDueAt)">{{ nextLabel(selected) }}</b>
          </div>
          <div class="bkp-stat">
            <span>On disk</span>
            <b>{{ sizeLabel(selected.totalBytes) }}</b>
          </div>
          <div class="bkp-stat">
            <span>Schedule</span>
            <b>{{ mode?.label || 'Smart' }}</b>
          </div>
        </div>

        <p v-if="selected?.running" class="bkp-running" role="status">
          <span class="bkp-spinner" aria-hidden="true"></span>
          Writing a snapshot of {{ selected.label }}…
        </p>

        <p v-if="selected?.lastError" class="bkp-warning" role="alert">
          <b>Last automatic run failed</b>
          <span>{{ selected.lastError.message }} · {{ when(selected.lastError.at) }}</span>
        </p>

        <fieldset class="bkp-fieldset" :disabled="Boolean(busy)">
          <legend>Schedule</legend>
          <div class="bkp-modes" role="radiogroup" aria-label="Backup schedule">
            <label
              v-for="option in modes"
              :key="option.id"
              class="bkp-mode"
              :data-on="selected?.mode === option.id ? '1' : '0'"
            >
              <input
                class="bkp-radio"
                type="radio"
                name="backup-mode"
                :value="option.id"
                :checked="selected?.mode === option.id"
                @change="setMode(option.id)"
              />
              <span class="bkp-dot" aria-hidden="true"></span>
              <span class="bkp-mode-copy">
                <b>{{ option.label }}</b>
                <span>{{ option.desc }}</span>
              </span>
              <span class="bkp-mode-tag">{{ option.tag }}</span>
            </label>
          </div>
        </fieldset>

        <div class="acct-sep">
          <span>Snapshots</span>
          <small>newest first</small>
        </div>

        <p v-if="!selected?.items.length" class="bkp-empty">
          No ZIPs yet. Smart backup runs once a day, or press <b>Back up now</b>.
        </p>

        <div v-else class="bkp-list">
          <div v-for="item in selected.items" :key="item.name" class="bkp-row">
            <span class="bkp-row-ic" aria-hidden="true">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
                <path d="M2 5.2c0-.9.7-1.6 1.6-1.6h3.1l1.3 1.5h4.4c.9 0 1.6.7 1.6 1.6v4.6c0 .9-.7 1.6-1.6 1.6H3.6c-.9 0-1.6-.7-1.6-1.6z" />
                <path d="M2.2 6.4h11.6" />
              </svg>
            </span>
            <span class="bkp-row-copy">
              <b>{{ when(item.createdAt) }}</b>
              <span class="bkp-row-meta">
                <span class="bkp-badge" :data-reason="item.reason">{{ item.reason === 'manual' ? 'manual' : 'automatic' }}</span>
                {{ sizeLabel(item.bytes) }} ZIP · {{ item.files }} file{{ item.files === 1 ? '' : 's' }}
              </span>
            </span>
            <span class="bkp-row-actions">
              <button
                class="bkp-btn"
                type="button"
                :disabled="Boolean(busy) || Boolean(selected?.running)"
                :title="`Restore ${item.name} as a new workspace`"
                @click="restore(item)"
              >
                {{ busy === `restore:${item.name}` ? 'Restoring…' : 'Restore' }}
              </button>
              <button
                class="bkp-btn"
                type="button"
                :data-danger="confirming === item.name ? '1' : '0'"
                :disabled="Boolean(busy) || Boolean(selected?.running)"
                :title="confirming === item.name ? 'Click again to delete this snapshot' : 'Delete this snapshot'"
                @click="remove(item)"
              >
                {{ busy === `remove:${item.name}` ? 'Deleting…' : confirming === item.name ? 'Delete?' : 'Delete' }}
              </button>
            </span>
          </div>
        </div>
      </template>
    </section>

    <aside class="role-card bkp-note">
      <h2>Smart backup</h2>
      <p class="mnote">
        The default schedule keeps a rolling set of snapshots instead of a pile:
      </p>
      <ul class="bkp-rules">
        <li><b>7 daily</b><span>one for each of the last seven days</span></li>
        <li><b>This month</b><span>one per week</span></li>
        <li><b>This year</b><span>one per month</span></li>
      </ul>
      <p class="mnote">
        Older snapshots are pruned after every run, so the shelf stays around two dozen entries
        instead of growing forever. A manual backup is kept by the same policy.
      </p>

      <dl class="ws-meta">
        <dt>Format</dt>
        <dd>ZIP · one file per run</dd>
        <dt>Folder</dt>
        <dd class="mono">{{ selected?.directoryDisplay || state.data?.displayRoot || '~/.entity/backups' }}</dd>
        <dt>Runs</dt>
        <dd>While entity is open</dd>
        <dt>Checks</dt>
        <dd>Every {{ checkMinutes }} min</dd>
        <dt>Restore</dt>
        <dd>As a new workspace</dd>
      </dl>

      <p class="mnote account-card-note">
        Secrets and transient state are left out of a ZIP: the remote token and sync state,
        <code class="mono">.bin/</code> and harness logs in <code class="mono">runs/</code>.
        Restoring extracts the ZIP into a new workspace and never overwrites the one you are using.
        ZIPs are plain archives, not encrypted — choose a private folder.
      </p>
    </aside>
  </div>
</template>
