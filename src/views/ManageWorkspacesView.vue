<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { onRunEvent } from '@/composables/localBridge'
import { useDialogDismiss } from '@/composables/useDialog'
import BrandMark from '@/components/BrandMark.vue'
import RemoteConnectDialog from '@/components/RemoteConnectDialog.vue'
import RemoteSyncPanel from '@/components/RemoteSyncPanel.vue'
import { matchesQuery } from '@/composables/search'
import { hub, openWizard, toast } from '@/stores/hub'
import {
  ensureRemoteStream,
  loadRemote,
  openRemotePanel,
  remote,
  remoteFor,
} from '@/stores/remote'
import {
  exportWorkspace,
  importWorkspace,
  loadWorkspaceList,
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
const remoteOpen = ref(false)
const fileInput = ref(null)
const query = ref('')
const view = ref('grid')
const sort = ref('created')

const createdLabel = (record) =>
  record?.createdAt ? new Date(record.createdAt).toLocaleDateString() : '—'

const displayName = computed(() => {
  const local = String(hub.session?.user || 'there').split('@')[0]
  return (
    local
      .split(/[._-]/)
      .filter(Boolean)
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join(' ') || 'there'
  )
})

/* Remote state is loaded once for the page; streamed events keep it fresh. A
   workspace created outside this tab (an import, a remote connect) becomes a
   card without a reload, and an entity edit updates the counts. */
let reloadTimer = 0
let unsubscribe = null
onMounted(() => {
  ensureRemoteStream()
  loadRemote().catch(() => {})
  loadWorkspaceList().catch(() => {})
  document.addEventListener('click', onMenuDocumentClick)
  window.addEventListener('resize', onMenuReflow)
  unsubscribe = onRunEvent((event) => {
    if (event?.kind !== 'workspace-changed') return
    clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      loadWorkspaceList().catch(() => {})
      loadRemote().catch(() => {})
    }, 400)
  })
})
onBeforeUnmount(() => {
  clearTimeout(reloadTimer)
  document.removeEventListener('click', onMenuDocumentClick)
  window.removeEventListener('resize', onMenuReflow)
  unsubscribe?.()
})

const remoteTone = (state) => {
  if (!state) return 'off'
  if (state.status === 'blocked') return 'blocked'
  if (state.status === 'error' || state.status === 'unauthorized') return 'error'
  if (state.status === 'syncing') return 'busy'
  return 'ok'
}

const remoteTitle = (state) => {
  if (!state) return ''
  if (state.status === 'blocked') return 'Sync stopped — review required'
  if (state.status === 'syncing') return 'Syncing…'
  if (state.status === 'error') return state.lastError || 'Last sync failed'
  if (state.status === 'unauthorized') return 'Session rejected — reconnect'
  return state.lastSyncAt ? `Synced ${new Date(state.lastSyncAt).toLocaleString()}` : 'Connected'
}

function openConnect() {
  remoteOpen.value = true
}

function onConnected(result) {
  const id = result?.record?.id
  if (id) openRemotePanel(id)
}

const greeting = computed(() => {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
})

/* A deterministic pixel field, not a random layout on every visit. */
function sparkStyle(n) {
  const x = (n * 37 + 13) % 100
  const y = (n * 29 + 9) % 100
  const size = n % 11 === 0 ? 4 : n % 5 === 0 ? 3 : 2
  return {
    left: `${x}%`,
    top: `${y}%`,
    width: `${size}px`,
    height: `${size}px`,
    animationDelay: `${(n % 9) * 0.27}s`,
    animationDuration: `${2.4 + (n % 5) * 0.55}s`,
  }
}

const filtered = computed(() => {
  const q = query.value
  const rows = workspaces.items.filter((record) =>
    matchesQuery(`${record.label} ${record.id} ${record.displayPath} ${record.kind}`, q),
  )
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
      mcp: sum.mcp + (record.counts?.mcp || 0),
    }),
    { entities: 0, skills: 0, mcp: 0 },
  ),
)

/* ── the card menu ────────────────────────────────────────────────────────────
   It was a native `<details>` dropdown: absolutely positioned inside the card,
   so the second card's box painted over its lower items (a card is its own
   paint layer — the hover lift is a `transform`), which made the last two
   actions unclickable, and there was no measure, no flip and no dismissal but
   a second click on the trigger. It is now the same layer the rail's row menu
   and the skills roster use: one teleported, measured `position: fixed` menu,
   flipped above the trigger when the room below is short, closed by Escape and
   by a click anywhere else. */
const menuRecord = ref(null)
const menuPos = ref({})
const menuEl = ref(null)
let menuOpener = null

async function openRowMenu(event, record) {
  event.stopPropagation()
  if (menuRecord.value?.id === record.id) {
    closeRowMenu()
    return
  }
  confirming.value = ''
  const opener = event.currentTarget
  menuOpener = opener
  const rect = opener.getBoundingClientRect()
  const width = 210
  const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
  menuPos.value = { left: `${Math.round(left)}px`, top: `${Math.round(rect.bottom + 5)}px` }
  menuRecord.value = record
  await nextTick()
  /* DESIGN.md: the menu measures itself instead of assuming a height — the
     Connect item only exists when there is no remote server yet */
  const height = menuEl.value?.offsetHeight || 0
  const below = window.innerHeight - rect.bottom - 5 - 8
  if (height > below && rect.top - 13 > below) {
    menuPos.value = { left: menuPos.value.left, top: `${Math.round(rect.top - 5 - height)}px` }
  }
  menuEl.value?.querySelector('button')?.focus()
}

function closeRowMenu(refocus = true) {
  if (!menuRecord.value) return
  menuRecord.value = null
  confirming.value = ''
  menuPos.value = {}
  const opener = menuOpener
  menuOpener = null
  if (refocus && opener instanceof HTMLElement) opener.focus()
}

/* Esc is the one stack; a click anywhere else, a scroll of the page or a
   resize closes the popover the same way it closes the rail's. */
useDialogDismiss({ active: () => Boolean(menuRecord.value), close: () => closeRowMenu() })

function onMenuDocumentClick(event) {
  if (!menuRecord.value) return
  const target = event.target
  if (target instanceof Element && (target.closest('.wsl-menu-pop') || target.closest('.wsl-menu'))) return
  closeRowMenu(false)
}

/* An item acts on the workspace that opened the menu, so a change of roster
   takes the menu with it instead of leaving a stale one over a new card. */
function onMenuReflow() {
  closeRowMenu(false)
}

function run(fn) {
  /* the item acts on the workspace the menu was opened for, so the record is
     read before the menu closes: closing is what clears `menuRecord` */
  const record = menuRecord.value
  closeRowMenu()
  if (record) fn(record)
}

function deleteFromMenu(record) {
  /* The first click arms the delete; the menu stays open so the second click is
     actually possible. `deleteOne` consumes the arm itself. */
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
    router.push({ name: 'overview', params: { workspace: record.id } })
    return
  }
  busy.value = `open:${record.id}`
  try {
    await openWorkspace(record.id)
    router.push({ name: 'overview', params: { workspace: record.id } })
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
    router.push({ name: 'workspace', params: { workspace: record.id } })
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
  /* the arm is consumed before anything closes: `closeRowMenu` clears it, so a
     re-arm and a close have to be two different moments */
  confirming.value = ''
  closeRowMenu()
  busy.value = `delete:${record.id}`
  try {
    await removeWorkspace(record.id)
    toast(`${record.label} deleted`)
    /* the last room is gone: the wizard is the surface that makes one */
    if (!workspaces.items.length) router.push('/welcome')
  } catch (error) {
    toast(error?.message || 'The workspace could not be deleted.')
  } finally {
    busy.value = ''
  }
}
</script>


<template>
  <div class="view wsl-view">
    <header class="wsl-hero">
      <div class="wsl-sparks" aria-hidden="true">
        <i v-for="n in 24" :key="n" :style="sparkStyle(n)"></i>
      </div>
      <div class="wsl-hero-mark"><BrandMark hop /></div>
      <div class="wsl-hero-copy">
        <p class="eyebrow">{{ greeting }}, {{ displayName }} · {{ workspaces.items.length }} {{ workspaces.items.length === 1 ? 'room' : 'rooms' }}</p>
        <h1>Which workspace are we opening?</h1>
        <p class="lede">
          Every workspace is its own room: separate entities, conversations, artifacts
          and skills. Pick one, or open a new room of your own.
        </p>
      </div>
      <div class="wsl-hero-actions">
        <button v-if="!remote.server" class="btn" type="button" @click="openConnect">
          <svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="8" cy="8" r="5.4" />
            <path d="M2.6 8h10.8M8 2.6c1.6 1.5 2.4 3.3 2.4 5.4s-.8 3.9-2.4 5.4C6.4 11.9 5.6 10.1 5.6 8S6.4 4.1 8 2.6z" />
          </svg>
          Connect remote
        </button>
        <button class="btn" type="button" :disabled="importing" @click="pickImport">
          <svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M8 10.5V2.6M4.8 5.8L8 2.5l3.2 3.3" />
            <path d="M2.6 10.2v2.4a1 1 0 001 1h8.8a1 1 0 001-1v-2.4" />
          </svg>
          {{ importing ? 'Importing…' : 'Import one' }}
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
          role="link"
          tabindex="0"
          :aria-label="`Open ${record.label}`"
          data-sfx="workspace"
          @click="openOne(record)"
          @keydown.enter.self="openOne(record)"
          @keydown.space.prevent.self="openOne(record)"
        >
          <div class="wsl-card-top">
            <div class="wsl-card-id">
              <h3>
                {{ record.label }}
                <span
                  v-if="remoteFor(record.id)"
                  class="wsl-remote"
                  :data-tone="remoteTone(remoteFor(record.id))"
                  :title="remoteTitle(remoteFor(record.id))"
                >remote</span>
              </h3>
              <p>{{ record.displayPath }}</p>
            </div>
            <button
              class="wsl-menu"
              type="button"
              data-sfx="tap"
              :aria-label="`Actions for ${record.label}`"
              aria-haspopup="menu"
              :aria-expanded="menuRecord?.id === record.id ? 'true' : 'false'"
              @click.stop="openRowMenu($event, record)"
            >
              <svg viewBox="0 0 16 16" fill="currentColor"><circle cx="3.2" cy="8" r="1.35" /><circle cx="8" cy="8" r="1.35" /><circle cx="12.8" cy="8" r="1.35" /></svg>
            </button>
          </div>
          <div class="wsl-counts">
            <span><b>{{ record.counts.entities }}</b><span>entities</span></span>
            <span><b>{{ record.counts.skills }}</b><span>skills</span></span>
            <span><b>{{ record.counts.mcp || 0 }}</b><span>MCP</span></span>
          </div>
          <div class="wsl-foot">
            <span class="wsl-lf">
              <span v-if="remoteFor(record.id)" class="wsl-remote-chip" :data-tone="remoteTone(remoteFor(record.id))">
                <i></i>{{ remoteTitle(remoteFor(record.id)) }}
              </span>
              <span v-else class="wsl-kt">{{ record.kind }}</span>
              <span>{{ createdLabel(record) }}</span>
            </span>
            <span v-if="record.id === workspaces.active" class="wsl-cur"><i></i>current</span>
            <button v-else class="wsl-open-link" type="button" data-sfx="workspace" @click.stop="settingsOne(record)">Settings →</button>
          </div>
        </article>
      </div>

      <div v-else class="wsl-table">
        <div class="wsl-thead">
          <span>Workspace</span><span>Entities</span><span>Skills</span><span>MCP</span><span>Kind</span><span>Created</span><span></span>
        </div>
        <div v-for="record in filtered" :key="record.id" class="wsl-row" :data-active="record.id === workspaces.active ? '1' : '0'">
          <button class="wsl-row-name" type="button" data-sfx="workspace" @click="openOne(record)">
            <b>{{ record.label }} <span v-if="remoteFor(record.id)" class="wsl-remote" :data-tone="remoteTone(remoteFor(record.id))">remote</span></b><span>{{ record.displayPath }}</span>
          </button>
          <span class="num">{{ record.counts.entities }}</span>
          <span class="num">{{ record.counts.skills }}</span>
          <span class="num">{{ record.counts.mcp || 0 }}</span>
          <span><span class="wsl-kt">{{ record.kind }}</span></span>
          <span class="wsl-date">{{ createdLabel(record) }}</span>
          <button
            class="wsl-menu"
            type="button"
            data-sfx="tap"
            :aria-label="`Actions for ${record.label}`"
            aria-haspopup="menu"
            :aria-expanded="menuRecord?.id === record.id ? 'true' : 'false'"
            @click.stop="openRowMenu($event, record)"
          >
            <svg viewBox="0 0 16 16" fill="currentColor"><circle cx="3.2" cy="8" r="1.35" /><circle cx="8" cy="8" r="1.35" /><circle cx="12.8" cy="8" r="1.35" /></svg>
          </button>
        </div>
      </div>
    </template>

    <div v-else class="wsl-empty">
      <b>No workspaces on this machine.</b>
      <p>Create one, or import a bundle someone exported from another machine.</p>
      <button class="btn btn-ink" type="button" @click="newWorkspace">New workspace</button>
    </div>

    <p class="wsl-footer">
      <span><b>{{ workspaces.items.length }}</b> workspaces · <b>{{ totals.entities }}</b> entities · <b>{{ totals.skills }}</b> skills · <b>{{ totals.mcp }}</b> MCP</span>
      <span class="r">Copyright by Agung Sundoro</span>
    </p>

    <RemoteConnectDialog :open="remoteOpen" @close="remoteOpen = false" @connected="onConnected" />
    <RemoteSyncPanel :workspace="remote.panel" />

    <!-- One menu for the whole page, in the body, so no card and no hover lift
         can paint over it (DESIGN.md: a popover is a teleported, measured
         layer; the row that holds it never clips it). -->
    <Teleport to="body">
      <div
        v-if="menuRecord"
        ref="menuEl"
        class="wsl-menu-pop"
        role="menu"
        :aria-label="`Actions for ${menuRecord.label}`"
        :style="menuPos"
        @click.stop
      >
        <button type="button" role="menuitem" data-sfx="workspace" :disabled="Boolean(busy)" @click="run((record) => openOne(record))">{{ menuRecord.id === workspaces.active ? 'Open overview' : 'Open & make active' }}</button>
        <button type="button" role="menuitem" data-sfx="workspace" :disabled="Boolean(busy)" @click="run((record) => settingsOne(record))">Workspace settings</button>
        <button v-if="remoteFor(menuRecord.id)" type="button" role="menuitem" data-sfx="tap" @click="run((record) => openRemotePanel(record.id))">Remote sync…</button>
        <button v-else-if="!remote.server" type="button" role="menuitem" data-sfx="tap" @click="run(() => openConnect())">Connect to remote…</button>
        <button type="button" role="menuitem" data-sfx="download" :disabled="Boolean(busy)" @click="run((record) => exportOne(record))">{{ busy === `export:${menuRecord.id}` ? 'Exporting…' : 'Export as one file' }}</button>
        <button class="danger" type="button" role="menuitem" data-sfx="remove" :disabled="Boolean(busy)" @click="deleteFromMenu(menuRecord)">{{ confirming === menuRecord.id ? 'Click again to delete' : 'Delete workspace' }}</button>
      </div>
    </Teleport>
  </div>
</template>
