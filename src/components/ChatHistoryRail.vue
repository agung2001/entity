<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import EntityMark from '@/components/EntityMark.vue'
import SpawnTreeDialog from '@/components/SpawnTreeDialog.vue'
import { onRunEvent } from '@/composables/localBridge'
import { useDialogDismiss } from '@/composables/useDialog'
import { matchesQuery } from '@/composables/search'
import { shareHref } from '@/lib/share-url'
import { copyText } from '@/lib/clipboard'
import { isDesktopApp } from '@/lib/shortcuts'
import { playSfx } from '@/lib/sfx'
import {
  ago,
  archiveThread,
  ensureChats,
  hub,
  isSending,
  liveSummaries,
  liveTags,
  loadChats,
  pinThread,
  removeThread,
  renameThread,
  selectThread,
  snippet,
  toast,
} from '@/stores/hub'

/**
 * The rail history is one list. Search is always visible; time and status live
 * behind the advanced-filter button so the rows get the default space. Status
 * starts on All, and the time menu adds an explicit custom date range.
 */
const props = defineProps({
  /* the second-tier shell owns the heading and the new-chat control */
  headless: { type: Boolean, default: false },
})
const router = useRouter()
/* What "copy" means here depends on where the rail is running: a tab can share a
   URL, the packaged app has none, so it hands over the id the app addresses the
   thread by. The label says which one it is. */
const desktopApp = isDesktopApp()
const editing = ref('')
const editTitle = ref('')
const confirming = ref('')
const menuItem = ref(null)
const menuPos = ref({ top: 0, left: 0 })
const hmenu = ref(null)
const query = ref('')
const range = ref('all')
const RANGE_OPTIONS = [
  { id: 'all', label: 'Any time' },
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'custom', label: 'Custom range…' },
]
const STATUS_OPTIONS = [
  { id: 'all', label: 'All' },
  { id: 'working', label: 'Working' },
  { id: 'done', label: 'Done' },
  { id: 'failed', label: 'Failed' },
]
const STATUS_KEY = 'entity.rail.chatStatus.v2'
const status = ref(readStatus())
const filtersOpen = ref(false)
/* The archived group remembers being opened; a query is temporary and must not
   overwrite that. */
const ARCHIVE_KEY = 'entity.rail.archivedOpen'
const archivedOpen = ref(readArchivedOpen())

function readArchivedOpen() {
  try {
    return localStorage.getItem(ARCHIVE_KEY) === '1'
  } catch {
    return false
  }
}

function toggleArchived() {
  archivedOpen.value = !archivedOpen.value
  try {
    localStorage.setItem(ARCHIVE_KEY, archivedOpen.value ? '1' : '0')
  } catch {
    /* session-only */
  }
}
const tagFilter = ref('')
const customStart = ref('')
const customEnd = ref('')

function readStatus() {
  try {
    const saved = localStorage.getItem(STATUS_KEY)
    return STATUS_OPTIONS.some((entry) => entry.id === saved) ? saved : 'all'
  } catch {
    return 'all'
  }
}

const advancedActive = computed(
  () =>
    status.value !== 'all' ||
    range.value !== 'all' ||
    Boolean(tagFilter.value) ||
    Boolean(customStart.value) ||
    Boolean(customEnd.value),
)

/* Tags are thread metadata, so the rail's tag list is derived from the rows it
   already has. A tag that no longer exists cannot remain selected. */
const tags = computed(() => liveTags())

watch(tags, (list) => {
  if (tagFilter.value && !list.some((tag) => tag.toLowerCase() === tagFilter.value.toLowerCase())) {
    tagFilter.value = ''
  }
})

function pickStatus(id) {
  status.value = id
  try {
    localStorage.setItem(STATUS_KEY, id)
  } catch {
    /* session-only */
  }
}

function toggleTag(tag) {
  const value = String(tag || '')
  tagFilter.value = tagFilter.value.toLowerCase() === value.toLowerCase() ? '' : value
}

/**
 * A delegated mention now leaves a session behind, so a busy thread can own a
 * dozen conversations. They are **not** rows: the rail is a list of the
 * conversations you started, and each parent carries its count and a tree.
 */
const threads = computed(() => liveSummaries().filter((thread) => !thread.spawnedFrom))

function isWorking(thread) {
  return Boolean(thread?.working) || isSending(thread?.id)
}

function statusOf(thread) {
  if (isWorking(thread)) return 'working'
  if (thread.failed) return 'failed'
  return 'done'
}

const statusCounts = computed(() => {
  const counts = { all: threads.value.length, working: 0, done: 0, failed: 0 }
  for (const thread of threads.value) counts[statusOf(thread)] += 1
  return counts
})

const statusLabel = computed(
  () => STATUS_OPTIONS.find((entry) => entry.id === status.value)?.label || 'All',
)
const statusNoun = computed(() =>
  status.value === 'all' ? 'threads' : `${statusLabel.value.toLowerCase()} threads`,
)

function titleOf(thread) {
  return thread.title || (thread.queries ? snippet(thread.preview) : `New thread · ${thread.entity}`)
}

function dayStart(value) {
  const date = new Date(value || '')
  if (!Number.isFinite(date.getTime())) return null
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function dateBoundary(value, end = false) {
  if (!value) return null
  const date = new Date(`${value}T${end ? '23:59:59.999' : '00:00:00'}`)
  return Number.isFinite(date.getTime()) ? date : null
}

function inRange(thread) {
  if (range.value === 'all') return true
  const date = new Date(thread.updatedAt || '')
  if (!Number.isFinite(date.getTime())) return false
  const today = dayStart(new Date())
  if (range.value === 'today') return date >= today
  if (range.value === 'yesterday') {
    const start = new Date(today)
    start.setDate(start.getDate() - 1)
    return date >= start && date < today
  }
  if (range.value === 'custom') {
    const start = dateBoundary(customStart.value)
    const end = dateBoundary(customEnd.value, true)
    if (start && date < start) return false
    if (end && date > end) return false
    return true
  }
  const days = range.value === '7d' ? 7 : 30
  return date >= new Date(today.getTime() - days * 86_400_000)
}

const filteredThreads = computed(() =>
  threads.value
    .filter((thread) => {
      if (status.value !== 'all' && statusOf(thread) !== status.value) return false
      if (tagFilter.value) {
        const wanted = tagFilter.value.toLowerCase()
        if (!(thread.tags || []).some((tag) => String(tag).toLowerCase() === wanted)) return false
      }
      if (!inRange(thread)) return false
      return matchesQuery(
        `${titleOf(thread)} ${thread.preview || ''} ${thread.entity || ''} ${(thread.tags || []).join(' ')}`,
        query.value,
      )
    })
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))),
)

/** Every filter the rail has: search, tag, status, time. */
const filtering = computed(
  () => Boolean(query.value.trim()) || advancedActive.value,
)

const activeRows = computed(() => filteredThreads.value.filter((thread) => !thread.archived))

/* The archive ignores the pin: it is a pile, newest archived first. */
const archivedRows = computed(() =>
  filteredThreads.value
    .filter((thread) => thread.archived)
    .sort((a, b) =>
      String(b.archivedAt || b.updatedAt || '').localeCompare(
        String(a.archivedAt || a.updatedAt || ''),
      ),
    ),
)

/**
 * A query force-opens the group, but only when something in it matches: an
 * empty result while an archived thread is a hit would be a lie, and a group
 * that opens to nothing is noise.
 */
const archivedShown = computed(
  () => archivedOpen.value || (filtering.value && archivedRows.value.length > 0),
)

/* A group with no rows is not rendered at all — an empty section would swallow
   the list's own empty state and leave the rail looking broken. */
const groups = computed(() =>
  [
    { id: 'working', rows: activeRows.value },
    { id: 'archived', rows: archivedRows.value, open: archivedShown.value },
  ].filter((group) => group.rows.length > 0),
)

/** Under a query the count is the match count, so it explains the open group. */
const archivedCount = computed(() => {
  const total = archivedRows.value.length
  if (!filtering.value) return String(total)
  return total === 1 ? '1 match' : `${total} matches`
})

/**
 * Sessions, by the conversation that started them.
 *
 * One pass over the list, because a per-row scan of every thread is O(n²) on a
 * history the retention pass can leave at 400 rows. `kids` counts the live ones:
 * an archived session is not something the parent still owes you.
 */
const spawnIndex = computed(() => {
  const rows = hub.chat.summaries || []
  const byId = new Map(rows.map((row) => [row.id, row]))
  const parentOf = new Map()
  const kids = new Map()
  for (const row of rows) {
    const from = row.spawnedFrom?.id
    if (!from) continue
    parentOf.set(row.id, from)
    if (!row.archived) kids.set(from, (kids.get(from) || 0) + 1)
  }
  return { byId, parentOf, kids }
})

const kidsOf = (id) => spawnIndex.value.kids.get(id) || 0

/**
 * The row a session belongs to. A child is not a row, so opening one must still
 * light up the conversation it came from — otherwise the rail shows nothing
 * selected and the person is lost.
 */
const activeRoot = computed(() => {
  let id = hub.chat.active
  const seen = new Set()
  while (id && !seen.has(id)) {
    seen.add(id)
    const from = spawnIndex.value.parentOf.get(id)
    if (!from) return id
    /* a parent that was deleted leaves a dangling link; the child is its own
       root then */
    if (!spawnIndex.value.byId.has(from)) return id
    id = from
  }
  return id || ''
})

function stateOf(thread) {
  if (isWorking(thread)) return 'Working…'
  if (!thread.queries) return 'New'
  return `${thread.queries} ${thread.queries === 1 ? 'query' : 'queries'} · ${ago(thread.updatedAt)}`
}

const treeRoot = ref('')

function openTree(thread) {
  menuItem.value = null
  treeRoot.value = thread.id
}

function closeTree() {
  treeRoot.value = ''
}

useDialogDismiss({ active: () => Boolean(treeRoot.value), close: closeTree })

/** A session opened from the tree is a thread like any other. */
function openSession(id) {
  const row = (hub.chat.summaries || []).find((thread) => thread.id === id)
  if (!row) return
  closeTree()
  openThread(row)
}

function openThread(thread) {
  menuItem.value = null
  /* Put the thread on screen now and let the address catch up. Waiting for the
     router guard before rendering added a round trip to every switch. */
  if (hub.chat.active !== thread.id) selectThread(thread.id).catch(() => {})
  router.push({ name: 'chat', params: { workspace: hub.workspace }, query: { thread: thread.id } })
}

function newThread() {
  menuItem.value = null
  const current = router.currentRoute.value
  const query = current.name === 'chat' ? { ...current.query, new: '1' } : { new: '1' }
  router.push({ name: 'chat', params: { workspace: hub.workspace }, query })
}

let menuTrigger = null

/**
 * The menu is positioned from its own height, measured after it renders.
 *
 * It used to assume 152 px to decide whether to flip above the row; Archive made
 * it a five-item, 170 px menu, and a hardcoded number would have been wrong
 * again on the next item. The trigger is kept so Escape can hand focus back.
 */
function openRowMenu(event, thread) {
  event?.stopPropagation?.()
  if (menuItem.value?.id === thread.id) {
    closeMenu(false)
    return
  }
  menuTrigger = event?.currentTarget || null
  const rect = event.currentTarget.getBoundingClientRect()
  const width = 170
  const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8)
  menuPos.value = { top: `${rect.bottom + 5}px`, left: `${left}px` }
  menuItem.value = thread
  nextTick(() => {
    const el = hmenu.value
    const height = el?.offsetHeight || 170
    let top = rect.bottom + 5
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 5)
    menuPos.value = { top: `${top}px`, left: `${left}px` }
    el?.querySelector('button')?.focus()
  })
}

/** Escape and every other dismissal path go through here. */
function closeMenu(refocus = true) {
  const trigger = menuTrigger
  menuItem.value = null
  menuTrigger = null
  if (refocus && trigger instanceof HTMLElement) nextTick(() => trigger.focus())
}

useDialogDismiss({ active: () => Boolean(menuItem.value), close: () => closeMenu() })

function menuPin() {
  const thread = menuItem.value
  menuItem.value = null
  if (thread) togglePin(thread)
}

async function menuArchive() {
  const thread = menuItem.value
  closeMenu(false)
  if (!thread) return
  playSfx('tap')
  try {
    await archiveThread(thread.id, !thread.archived)
  } catch {
    /* the store already put the row back and said why */
  }
}

async function restoreThread(thread) {
  playSfx('open')
  try {
    await archiveThread(thread.id, false)
  } catch {
    /* the store already put the row back and said why */
  }
}

function menuRename() {
  const thread = menuItem.value
  menuItem.value = null
  if (thread) startRename(thread)
}

/**
 * Copy the thread's address, in whatever form this window can actually hand
 * over: the URL in a browser tab, the id in the packaged app (which has no
 * origin of its own to share). No quoted reference block — it pasted as prose
 * wherever a link was wanted.
 */
async function menuCopyLink() {
  const thread = menuItem.value
  menuItem.value = null
  if (!thread) return
  const href = router.resolve({
    name: 'chat',
    params: { workspace: hub.workspace },
    query: { thread: thread.id },
  }).href
  const url = desktopApp ? '' : shareHref(href, hub.workspace)
  const payload = url || thread.id
  const copied = await copyText(payload)
  if (copied) playSfx('confirm')
  toast(
    copied
      ? desktopApp || !url
        ? 'Thread id copied'
        : 'Thread link copied'
      : 'The thread could not be copied.',
  )
}

async function menuDelete() {
  const thread = menuItem.value
  if (!thread) return
  const final = confirming.value === thread.id
  await deleteThread(thread)
  if (final && menuItem.value?.id === thread.id) menuItem.value = null
}

function startRename(thread) {
  editing.value = thread.id
  editTitle.value = thread.title || ''
  nextTick(() => document.getElementById(`rchat-rename-${thread.id}`)?.focus())
}

function cancelRename() {
  editing.value = ''
  editTitle.value = ''
}

async function saveRename(thread) {
  if (editing.value !== thread.id) return
  const title = editTitle.value.trim()
  try {
    await renameThread(thread.id, title)
    playSfx('confirm')
    toast(title ? 'Thread title saved' : 'Thread title cleared')
    cancelRename()
  } catch (error) {
    toast(error?.message || 'The title could not be saved.')
  }
}

function onRenameKey(event, thread) {
  event.stopPropagation()
  if (event.key === 'Enter') {
    event.preventDefault()
    saveRename(thread)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    cancelRename()
  }
}

async function togglePin(thread) {
  try {
    await pinThread(thread.id, !thread.pinned)
    toast(thread.pinned ? 'Thread unpinned' : 'Thread pinned')
  } catch (error) {
    toast(error?.message || 'The thread could not be pinned.')
  }
}

async function deleteThread(thread) {
  if (isWorking(thread)) {
    toast('Stop the turn before deleting this thread.')
    return
  }
  if (confirming.value !== thread.id) {
    confirming.value = thread.id
    setTimeout(() => {
      if (confirming.value === thread.id) confirming.value = ''
    }, 2600)
    return
  }
  confirming.value = ''
  try {
    await removeThread(thread.id)
    toast('Thread deleted')
  } catch (error) {
    toast(error?.message || 'The thread could not be deleted.')
  }
}

function onDocumentClick(event) {
  if (!menuItem.value) return
  const target = event.target
  if (target instanceof Element && target.closest('.rchat-menu-pop, .rchat-dots')) return
  menuItem.value = null
}

let reloadTimer = 0
let historyStale = false
let unsubscribe = null

function refreshHistory() {
  /* A turn of our own writes the thread file repeatedly; the list settles on
     its own when the turn finishes. */
  if (Object.keys(hub.chat.sending || {}).length) {
    historyStale = true
    return
  }
  historyStale = false
  clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => {
    loadChats(hub.workspace).catch(() => {})
  }, 450)
}

function onWorkspaceEvent(event) {
  if (event?.kind !== 'workspace-changed' || event.workspace !== hub.workspace) return
  const paths = event.paths || []
  if (
    paths.some(
      (file) => file.startsWith('chats/') || file.startsWith('entities/'),
    )
  ) {
    refreshHistory()
  }
}

onMounted(() => {
  ensureChats()
  document.addEventListener('click', onDocumentClick)
  unsubscribe = onRunEvent(onWorkspaceEvent)
  window.addEventListener('focus', refreshHistory)
})

watch(
  () => hub.workspace,
  () => ensureChats(),
)

watch(
  () => Object.keys(hub.chat.sending || {}).length,
  (count) => {
    if (!count && historyStale) refreshHistory()
  },
)

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick)
  window.removeEventListener('focus', refreshHistory)
  clearTimeout(reloadTimer)
  unsubscribe?.()
})

defineExpose({ newThread })
</script>

<template>
  <section class="rchat" aria-label="Chat history">
    <div v-if="!props.headless" class="rchat-head">
      <span>Chats</span>
      <span class="rchat-head-right">
        <span class="n">{{ activeRows.length }}</span>
        <button class="rchat-new" type="button" title="New chat" aria-label="New chat" @click="newThread">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M8 3.2v9.6M3.2 8h9.6" />
          </svg>
        </button>
      </span>
    </div>

    <div class="rchat-tools">
      <div class="rchat-search-row">
        <label class="rchat-search">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <circle cx="7" cy="7" r="4.6" />
            <path d="M10.5 10.5L14 14" />
          </svg>
          <input
            v-model="query"
            type="search"
            placeholder="Search threads"
            aria-label="Search threads"
            autocomplete="off"
            spellcheck="false"
          />
          <button v-if="query" type="button" aria-label="Clear search" @click="query = ''">×</button>
        </label>
        <button
          class="rchat-filter-btn"
          type="button"
          :data-active="advancedActive ? '1' : '0'"
          :aria-expanded="filtersOpen ? 'true' : 'false'"
          aria-controls="rchat-advanced"
          title="Advanced filters"
          aria-label="Advanced filters"
          @click="filtersOpen = !filtersOpen"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M2.5 4h11M4.5 8h7M6.5 12h3" />
          </svg>
          <i v-if="advancedActive" aria-hidden="true"></i>
        </button>
      </div>

      <div v-if="filtersOpen" id="rchat-advanced" class="rchat-advanced">
        <div class="rchat-filter">
          <label class="rchat-filter-label" for="rchat-time">Time</label>
          <select id="rchat-time" v-model="range" class="rchat-time-select" aria-label="Filter threads by time">
            <option v-for="option in RANGE_OPTIONS" :key="option.id" :value="option.id">
              {{ option.label }}
            </option>
          </select>
          <div v-if="range === 'custom'" class="rchat-custom-range">
            <label>
              <span>From</span>
              <input v-model="customStart" type="date" :max="customEnd || undefined" aria-label="Start date" />
            </label>
            <label>
              <span>To</span>
              <input v-model="customEnd" type="date" :min="customStart || undefined" aria-label="End date" />
            </label>
          </div>
        </div>
        <div class="rchat-filter">
          <span class="rchat-filter-label">Tags</span>
          <div v-if="tags.length" class="rchat-tagfilter" role="group" aria-label="Filter threads by tag">
            <button
              type="button"
              :aria-pressed="tagFilter === '' ? 'true' : 'false'"
              @click="tagFilter = ''"
            >
              Any tag
            </button>
            <button
              v-for="tag in tags"
              :key="tag"
              type="button"
              :aria-pressed="tagFilter.toLowerCase() === tag.toLowerCase() ? 'true' : 'false'"
              @click="toggleTag(tag)"
            >
              {{ tag }}
            </button>
          </div>
          <p v-else class="rchat-tagfilter-empty">No tags yet. Add them from a thread’s header.</p>
        </div>
        <div class="rchat-filter">
          <span class="rchat-filter-label">Status</span>
          <div class="rchat-status-switch rchat-status-switch--grid" role="group" aria-label="Filter threads by status">
            <button
              v-for="option in STATUS_OPTIONS"
              :key="option.id"
              type="button"
              :data-status="option.id"
              :aria-pressed="status === option.id ? 'true' : 'false'"
              @click="pickStatus(option.id)"
            >
              <span>{{ option.label }}</span>
              <b>{{ statusCounts[option.id] }}</b>
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="rchat-list">
      <template v-if="groups.length">
        <div
          v-for="group in groups"
          :key="group.id"
          class="rchat-section"
          :data-group="group.id"
        >
          <!-- The working group has no header: an "Active" label above the rows
               the person came for is chrome. The archive needs one, because it
               is the only signal that those rows are a different place. -->
          <button
            v-if="group.id === 'archived'"
            class="rchat-section-head"
            type="button"
            :aria-expanded="group.open ? 'true' : 'false'"
            aria-controls="rchat-archived"
            @click="toggleArchived"
          >
            <svg class="rchat-group-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
              <path d="M6 3.5L10.5 8 6 12.5" />
            </svg>
            <span class="rchat-section-label">Archived</span>
            <span class="rchat-section-count" :data-matches="filtering ? '1' : '0'">{{ archivedCount }}</span>
          </button>
          <div
            v-show="group.id !== 'archived' || group.open"
            :id="group.id === 'archived' ? 'rchat-archived' : undefined"
            class="rchat-section-body"
          >
            <div
              v-for="thread in group.rows"
              :key="thread.id"
              class="rchat-row"
              :data-on="thread.id === activeRoot ? '1' : '0'"
              :data-pinned="thread.pinned ? '1' : '0'"
              :data-working="isWorking(thread) ? '1' : '0'"
              :data-status="statusOf(thread)"
            >
              <div
                class="rchat-open"
                role="button"
                tabindex="0"
                :aria-current="thread.id === activeRoot ? 'page' : undefined"
                :title="titleOf(thread)"
                @click="openThread(thread)"
                @keydown.enter="openThread(thread)"
                @keydown.space.prevent="openThread(thread)"
              >
                <EntityMark mini animate :entity="thread.entity" />
                <span class="rchat-text">
                  <span class="rchat-title">
                    <!-- the archive sort ignores the pin, so an archived row
                         must not advertise one -->
                    <svg
                      v-if="thread.pinned && !thread.archived"
                      class="rchat-pin"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.4"
                      aria-label="Pinned"
                    >
                      <path d="M6 2.4h4l-.7 3.1 2.2 2.2-2.9.9-1.4 4.9-1.4-4.9-2.9-.9 2.2-2.2z" />
                    </svg>
                    <input
                      v-if="editing === thread.id"
                      :id="`rchat-rename-${thread.id}`"
                      v-model="editTitle"
                      class="rchat-rename"
                      type="text"
                      placeholder="Thread title"
                      spellcheck="false"
                      @click.stop
                      @keydown="onRenameKey($event, thread)"
                      @blur="cancelRename"
                    />
                    <b v-else>{{ titleOf(thread) }}</b>
                  </span>
                  <span class="rchat-state">
                    <span class="rchat-health" :data-s="statusOf(thread)"><i></i>{{ statusOf(thread) }}</span>
                    <!-- The sessions of this conversation: a count, and a tree
                         behind it. Rows would drown the list the moment a thread
                         delegates a few jobs. -->
                    <button
                      v-if="kidsOf(thread.id)"
                      class="rchat-kids"
                      type="button"
                      :title="`Show the ${kidsOf(thread.id)} session${kidsOf(thread.id) === 1 ? '' : 's'} this conversation started`"
                      @click.stop="openTree(thread)"
                    >
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                        <path d="M3 4v4.4h10V12" />
                        <path d="M10.6 9.6L13 12l-2.4 2.4" />
                      </svg>
                      spawned {{ kidsOf(thread.id) }} {{ kidsOf(thread.id) === 1 ? 'chat' : 'chats' }}
                    </button>
                    <template v-else>
                      <span class="rchat-entity">{{ thread.entity }}</span>
                      <span class="rchat-sep" aria-hidden="true">·</span>
                      <span>{{ stateOf(thread) }}</span>
                    </template>
                  </span>
                  <span v-if="thread.tags?.length" class="rchat-tags">
                    <button
                      v-for="tag in thread.tags"
                      :key="tag"
                      type="button"
                      class="rchat-tag"
                      :data-on="tagFilter.toLowerCase() === tag.toLowerCase() ? '1' : '0'"
                      :title="`Filter by ${tag}`"
                      @click.stop="toggleTag(tag)"
                    >
                      {{ tag }}
                    </button>
                  </span>
                </span>
              </div>
              <button
                v-if="thread.archived"
                class="rchat-restore"
                type="button"
                data-sfx="open"
                title="Restore thread"
                aria-label="Restore thread"
                @click.stop="restoreThread(thread)"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                  <path d="M3.4 7.2a4.6 4.6 0 118 3" />
                  <path d="M3.2 3.4v3.9h3.9" />
                </svg>
              </button>
              <button
                class="rchat-dots"
                type="button"
                :aria-expanded="menuItem?.id === thread.id ? 'true' : 'false'"
                title="Thread actions"
                aria-label="Thread actions"
                @click="openRowMenu($event, thread)"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <circle cx="3.2" cy="8" r="1.2" />
                  <circle cx="8" cy="8" r="1.2" />
                  <circle cx="12.8" cy="8" r="1.2" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </template>

      <p v-else-if="threads.length" class="rchat-empty">
        No {{ statusNoun }} match this search, tag and time filter.
      </p>
      <p v-else class="rchat-empty">
        No chats yet. Use + to start one.
      </p>
    </div>

    <SpawnTreeDialog :root-id="treeRoot" @close="closeTree" @open="openSession" />

    <Teleport to="body">
      <div
        v-if="menuItem"
        ref="hmenu"
        class="rchat-menu-pop"
        role="menu"
        aria-label="Thread actions"
        :style="{ top: menuPos.top, left: menuPos.left }"
        @click.stop
      >
        <button
          v-if="!menuItem.archived"
          class="rchat-menu-item"
          type="button"
          role="menuitem"
          data-sfx="pin"
          @click="menuPin"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <path d="M6 2.4h4l-.7 3.1 2.2 2.2-2.9.9-1.4 4.9-1.4-4.9-2.9-.9 2.2-2.2z" />
          </svg>
          {{ menuItem.pinned ? 'Unpin thread' : 'Pin thread' }}
        </button>
        <!-- A pin has no effect inside the archive, so an archived row offers
             Restore in its place rather than an action that cannot apply. -->
        <button
          v-else
          class="rchat-menu-item"
          type="button"
          role="menuitem"
          data-sfx="open"
          @click="menuArchive"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <path d="M3.4 7.2a4.6 4.6 0 118 3" />
            <path d="M3.2 3.4v3.9h3.9" />
          </svg>
          Restore thread
        </button>
        <button class="rchat-menu-item" type="button" role="menuitem" @click="menuRename">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <path d="M3 11.7l.5-2.6 6.7-6.7 2.4 2.4-6.7 6.7z" />
            <path d="M9.4 3.2l2.4 2.4" />
          </svg>
          Rename thread
        </button>
        <button class="rchat-menu-item" type="button" role="menuitem" @click="menuCopyLink">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <path d="M6.4 9.6l3.2-3.2M5.2 10.8l-1 .9a2.2 2.2 0 01-3.1-3.1l2-2a2.2 2.2 0 013.1 0" />
            <path d="M10.8 5.2l1-.9a2.2 2.2 0 013.1 3.1l-2 2a2.2 2.2 0 01-3.1 0" />
          </svg>
          {{ desktopApp ? 'Copy thread id' : 'Copy link' }}
        </button>
        <button
          v-if="!menuItem.archived"
          class="rchat-menu-item"
          type="button"
          role="menuitem"
          :disabled="isWorking(menuItem)"
          :title="isWorking(menuItem) ? 'Stop the turn before archiving this thread' : ''"
          @click="menuArchive"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <path d="M2.6 3.6h10.8v2.6H2.6z" />
            <path d="M3.6 6.2v6.2h8.8V6.2" />
            <path d="M8 7.6v3.4M6.4 9.4L8 11l1.6-1.6" />
          </svg>
          Archive thread
        </button>
        <button
          class="rchat-menu-item rchat-menu-danger"
          type="button"
          role="menuitem"
          :class="{ confirming: confirming === menuItem.id }"
          :disabled="isWorking(menuItem)"
          :title="isWorking(menuItem) ? 'Stop the turn before deleting this thread' : ''"
          @click="menuDelete"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <path d="M3.2 4.4h9.6M6.1 4.4V2.8h3.8v1.6M4.4 4.4l.6 8.8h6l.6-8.8" />
          </svg>
          {{ confirming === menuItem.id ? 'Click again to delete' : 'Delete thread' }}
        </button>
      </div>
    </Teleport>
  </section>
</template>
