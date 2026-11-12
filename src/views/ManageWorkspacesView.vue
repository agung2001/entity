<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { openWizard, toast } from '@/stores/hub'
import {
  exportWorkspace,
  importWorkspace,
  openWorkspace,
  removeWorkspace,
  workspaces,
} from '@/stores/workspaces'

/**
 * Managing workspaces is a page, not a menu. The switcher is for choosing one;
 * this is where a person adds, exports, imports, opens settings, or deletes.
 */
const router = useRouter()
const busy = ref('')
const confirming = ref('')
const importing = ref(false)
const fileInput = ref(null)

const createdLabel = (record) =>
  record?.createdAt ? new Date(record.createdAt).toLocaleDateString() : '—'

function newWorkspace() {
  openWizard()
}

function pickImport() {
  if (importing.value) return
  fileInput.value?.click()
}

function download(name, text) {
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function exportOne(record) {
  if (busy.value) return
  busy.value = `export:${record.id}`
  try {
    const bundle = await exportWorkspace(record.id)
    download(`entity-workspace-${record.id}.json`, `${JSON.stringify(bundle, null, 2)}\n`)
    toast(`${record.label} exported`)
  } catch (error) {
    toast(error?.message || 'The workspace could not be exported.')
  } finally {
    busy.value = ''
  }
}

async function importFile(event) {
  const file = event.target?.files?.[0]
  event.target.value = ''
  if (!file || importing.value) return
  importing.value = true
  try {
    const text = await file.text()
    let bundle
    try {
      bundle = JSON.parse(text)
    } catch {
      throw new Error('That file is not valid JSON.')
    }
    const result = await importWorkspace(bundle)
    const skipped = result?.skipped?.length || 0
    const label = result?.record?.label || 'Workspace'
    toast(
      skipped
        ? `${label} imported · ${skipped} item${skipped === 1 ? '' : 's'} skipped`
        : `${label} imported`,
    )
  } catch (error) {
    toast(error?.message || 'The workspace could not be imported.')
  } finally {
    importing.value = false
  }
}

async function openOne(record) {
  if (busy.value) return
  if (record.id === workspaces.active) {
    router.push('/')
    return
  }
  busy.value = `open:${record.id}`
  try {
    await openWorkspace(record.id)
    router.push('/')
  } catch (error) {
    toast(error?.message || 'That workspace could not be opened.')
  } finally {
    busy.value = ''
  }
}

async function settingsOne(record) {
  if (busy.value) return
  busy.value = `settings:${record.id}`
  try {
    if (record.id !== workspaces.active) await openWorkspace(record.id)
    router.push('/workspace')
  } catch (error) {
    toast(error?.message || 'That workspace could not be opened.')
  } finally {
    busy.value = ''
  }
}

async function deleteOne(record) {
  if (busy.value) return
  if (confirming.value !== record.id) {
    confirming.value = record.id
    setTimeout(() => {
      if (confirming.value === record.id) confirming.value = ''
    }, 2800)
    return
  }
  confirming.value = ''
  busy.value = `delete:${record.id}`
  try {
    await removeWorkspace(record.id)
    toast(`${record.label} deleted`)
    if (!workspaces.items.length) router.push('/setup')
  } catch (error) {
    toast(error?.message || 'The workspace could not be deleted.')
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div class="view">
    <div class="page-head">
      <div>
        <p class="eyebrow">Workspaces · {{ workspaces.items.length }} on this machine</p>
        <h1>Manage workspaces</h1>
        <p class="lede">
          Each workspace is a directory under <code class="mono">~/.entity/workspaces/</code>.
          Add one, open its settings, export it as one JSON file, or import a bundle here.
        </p>
      </div>
      <div class="head-actions">
        <button class="btn" type="button" :disabled="importing" @click="pickImport">
          {{ importing ? 'Importing…' : 'Import' }}
        </button>
        <button class="btn" type="button" @click="newWorkspace">New workspace</button>
        <button class="btn btn-ink" type="button" @click="router.push('/')">Overview</button>
        <input
          ref="fileInput"
          class="hidden-file"
          type="file"
          accept="application/json,.json"
          @change="importFile"
        />
      </div>
    </div>

    <div v-if="workspaces.error" class="empty-note">
      <b>{{ workspaces.error }}</b>
      <button class="btn btn-sm" type="button" @click="router.go(0)">Try again</button>
    </div>

    <div v-else-if="workspaces.items.length" class="grid2 ws-manage-grid">
      <article
        v-for="record in workspaces.items"
        :key="record.id"
        class="card2 ws-manage-card"
        :data-active="record.id === workspaces.active ? '1' : '0'"
      >
        <div class="card-top">
          <h3>{{ record.label }}</h3>
          <span class="tag">{{ record.id === workspaces.active ? 'active' : record.kind }}</span>
        </div>
        <p class="p mono">{{ record.id }} · {{ record.displayPath }}</p>
        <p class="desc">
          {{ record.counts.entities }} entities · {{ record.counts.skills }} skills ·
          {{ record.counts.machines }} machines
        </p>
        <div class="foot">
          <span>created {{ createdLabel(record) }}</span>
          <span>{{ record.kind }}</span>
        </div>
        <div class="card-actions">
          <button
            class="btn btn-sm"
            type="button"
            :disabled="Boolean(busy)"
            @click="openOne(record)"
          >
            {{ record.id === workspaces.active ? 'Open overview' : 'Open' }}
          </button>
          <button
            class="btn btn-sm"
            type="button"
            :disabled="Boolean(busy)"
            @click="settingsOne(record)"
          >
            Settings
          </button>
          <button
            class="btn btn-sm"
            type="button"
            :disabled="Boolean(busy)"
            @click="exportOne(record)"
          >
            {{ busy === `export:${record.id}` ? 'Exporting…' : 'Export' }}
          </button>
          <button
            class="btn btn-sm ws-danger"
            type="button"
            :class="{ confirming: confirming === record.id }"
            :disabled="Boolean(busy)"
            @click="deleteOne(record)"
          >
            {{ confirming === record.id ? 'Delete?' : 'Delete' }}
          </button>
        </div>
      </article>
    </div>

    <div v-else class="empty-note">
      <b>No workspaces on this machine.</b>
      <span>Create one, or import a bundle someone exported from another machine.</span>
      <button class="btn btn-ink" type="button" @click="newWorkspace">New workspace</button>
    </div>

    <p class="stat-foot">
      Export carries entities, chats, copied skills, and the MCP pool. Machine keys,
      the generated ssh config, and run logs stay on the machine that made them.
    </p>
  </div>
</template>
