<script setup>
import { computed, ref } from 'vue'
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
const query = ref('')
const view = ref('grid')
const sort = ref('created')

const createdLabel = (record) =>
  record?.createdAt ? new Date(record.createdAt).toLocaleDateString() : '—'

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  const rows = workspaces.items.filter((record) => {
    if (!q) return true
    return `${record.label} ${record.id} ${record.displayPath} ${record.kind}`
      .toLowerCase()
      .includes(q)
  })
  return [...rows].sort((a, b) =>
    sort.value === 'name'
      ? String(a.label).localeCompare(String(b.label))
      : String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
  )
})

const totals = computed(() =>
  workspaces.items.reduce(
    (sum, record) => ({
      entities: sum.entities + (record.counts?.entities || 0),
      skills: sum.skills + (record.counts?.skills || 0),
      machines: sum.machines + (record.counts?.machines || 0),
    }),
    { entities: 0, skills: 0, machines: 0 },
  ),
)

function run(menu, fn) {
  menu.open = false
  fn()
}

function deleteFromMenu(menu, record) {
  /* The first click arms the delete; keep the menu open so the second click is
     actually possible. */
  if (confirming.value === record.id) menu.open = false
  deleteOne(record)
}

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
  <div class="view wsl-view">
    <header class="page-head wsl-head">
      <div>
        <p class="eyebrow">Workspaces · {{ workspaces.items.length }} on this machine</p>
        <h1>Workspaces</h1>
        <p class="lede">
          Each one is a directory under <code class="mono">~/.entity/workspaces/</code> holding its
          entities, chats, skills and MCP pool. Open one to make it active, or carry it to another
          machine as a single file.
        </p>
      </div>
      <div class="head-actions">
        <button class="btn" type="button" :disabled="importing" @click="pickImport">
          <svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M8 10.5V2.6M4.8 5.8L8 2.5l3.2 3.3" />
            <path d="M2.6 10.2v2.4a1 1 0 001 1h8.8a1 1 0 001-1v-2.4" />
          </svg>
          {{ importing ? 'Importing…' : 'Import' }}
        </button>
        <button class="btn btn-ink" type="button" @click="newWorkspace">New workspace</button>
        <input ref="fileInput" class="hidden-file" type="file" accept="application/json,.json" @change="importFile" />
      </div>
    </header>

    <div class="wsl-tool">
      <label class="wsl-search">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="7" cy="7" r="4.6" />
          <path d="M10.4 10.4L14 14" />
        </svg>
        <input v-model="query" type="search" placeholder="Search name, path or kind" aria-label="Search workspaces" autocomplete="off" />
        <span v-if="query" class="cnt">{{ filtered.length }} of {{ workspaces.items.length }}</span>
      </label>
      <span class="spacer"></span>
      <label class="wsl-sort">
        <span>Sort</span>
        <select v-model="sort" aria-label="Sort workspaces">
          <option value="created">Newest first</option>
          <option value="name">Name</option>
        </select>
      </label>
      <div class="wsl-seg" role="group" aria-label="View">
        <button type="button" :aria-pressed="view === 'grid' ? 'true' : 'false'" aria-label="Grid view" title="Grid" @click="view = 'grid'">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></svg>
        </button>
        <button type="button" :aria-pressed="view === 'list' ? 'true' : 'false'" aria-label="List view" title="List" @click="view = 'list'">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 3.4h12M2 8h12M2 12.6h12" /></svg>
        </button>
      </div>
    </div>

    <div v-if="workspaces.error" class="empty-note wsl-empty">
      <b>{{ workspaces.error }}</b>
      <button class="btn btn-sm" type="button" @click="router.go(0)">Try again</button>
    </div>

    <template v-else-if="workspaces.items.length">
      <div v-if="!filtered.length" class="wsl-empty">
        <b>No workspace matches “{{ query }}”.</b>
        <p>Search looks at the name, the directory and the kind — try a shorter word.</p>
        <button class="btn" type="button" @click="query = ''">Clear search</button>
      </div>

      <div v-else-if="view === 'grid'" class="wsl-grid">
        <article
          v-for="record in filtered"
          :key="record.id"
          class="wsl-card"
          :data-active="record.id === workspaces.active ? '1' : '0'"
        >
          <div class="wsl-card-top">
            <div class="wsl-card-id">
              <h3>{{ record.label }}</h3>
              <p>{{ record.displayPath }}</p>
            </div>
            <details class="wsl-menu">
              <summary :aria-label="`Actions for ${record.label}`" aria-haspopup="menu">
                <svg viewBox="0 0 16 16" fill="currentColor"><circle cx="3.2" cy="8" r="1.35" /><circle cx="8" cy="8" r="1.35" /><circle cx="12.8" cy="8" r="1.35" /></svg>
              </summary>
              <div class="wsl-menu-pop" role="menu">
                <button type="button" role="menuitem" :disabled="Boolean(busy)" @click="run($event.currentTarget.closest('details'), () => openOne(record))">{{ record.id === workspaces.active ? 'Open overview' : 'Open & make active' }}</button>
                <button type="button" role="menuitem" :disabled="Boolean(busy)" @click="run($event.currentTarget.closest('details'), () => settingsOne(record))">Workspace settings</button>
                <button type="button" role="menuitem" :disabled="Boolean(busy)" @click="run($event.currentTarget.closest('details'), () => exportOne(record))">{{ busy === `export:${record.id}` ? 'Exporting…' : 'Export as one file' }}</button>
                <button class="danger" type="button" role="menuitem" :disabled="Boolean(busy)" @click="deleteFromMenu($event.currentTarget.closest('details'), record)">{{ confirming === record.id ? 'Click again to delete' : 'Delete workspace' }}</button>
              </div>
            </details>
          </div>
          <div class="wsl-counts">
            <span><b>{{ record.counts.entities }}</b><span>entities</span></span>
            <span><b>{{ record.counts.skills }}</b><span>skills</span></span>
            <span><b>{{ record.counts.machines }}</b><span>machines</span></span>
          </div>
          <div class="wsl-foot">
            <span class="wsl-lf"><span class="wsl-kt">{{ record.kind }}</span><span>{{ createdLabel(record) }}</span></span>
            <span v-if="record.id === workspaces.active" class="wsl-cur"><i></i>current</span>
            <button v-else class="wsl-open-link" type="button" @click="openOne(record)">Open →</button>
          </div>
        </article>
      </div>

      <div v-else class="wsl-table">
        <div class="wsl-thead">
          <span>Workspace</span><span>Entities</span><span>Skills</span><span>Machines</span><span>Kind</span><span>Created</span><span></span>
        </div>
        <div v-for="record in filtered" :key="record.id" class="wsl-row" :data-active="record.id === workspaces.active ? '1' : '0'">
          <button class="wsl-row-name" type="button" @click="openOne(record)">
            <b>{{ record.label }}</b><span>{{ record.displayPath }}</span>
          </button>
          <span class="num">{{ record.counts.entities }}</span>
          <span class="num">{{ record.counts.skills }}</span>
          <span class="num">{{ record.counts.machines }}</span>
          <span><span class="wsl-kt">{{ record.kind }}</span></span>
          <span class="wsl-date">{{ createdLabel(record) }}</span>
          <details class="wsl-menu">
            <summary :aria-label="`Actions for ${record.label}`" aria-haspopup="menu">
              <svg viewBox="0 0 16 16" fill="currentColor"><circle cx="3.2" cy="8" r="1.35" /><circle cx="8" cy="8" r="1.35" /><circle cx="12.8" cy="8" r="1.35" /></svg>
            </summary>
            <div class="wsl-menu-pop" role="menu">
              <button type="button" role="menuitem" :disabled="Boolean(busy)" @click="run($event.currentTarget.closest('details'), () => openOne(record))">{{ record.id === workspaces.active ? 'Open overview' : 'Open & make active' }}</button>
              <button type="button" role="menuitem" :disabled="Boolean(busy)" @click="run($event.currentTarget.closest('details'), () => settingsOne(record))">Workspace settings</button>
              <button type="button" role="menuitem" :disabled="Boolean(busy)" @click="run($event.currentTarget.closest('details'), () => exportOne(record))">Export as one file</button>
              <button class="danger" type="button" role="menuitem" :disabled="Boolean(busy)" @click="deleteFromMenu($event.currentTarget.closest('details'), record)">{{ confirming === record.id ? 'Click again to delete' : 'Delete workspace' }}</button>
            </div>
          </details>
        </div>
      </div>
    </template>

    <div v-else class="wsl-empty">
      <b>No workspaces on this machine.</b>
      <p>Create one, or import a bundle someone exported from another machine.</p>
      <button class="btn btn-ink" type="button" @click="newWorkspace">New workspace</button>
    </div>

    <p class="wsl-footer">
      <span><b>{{ workspaces.items.length }}</b> workspaces · <b>{{ totals.entities }}</b> entities · <b>{{ totals.skills }}</b> skills · <b>{{ totals.machines }}</b> machines</span>
      <span class="r">Export carries entities, chats, copied skills, and the MCP pool. Machine keys, the generated ssh config, and run logs stay on the machine that made them.</span>
    </p>
  </div>
</template>
