<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import EntityMark from '@/components/EntityMark.vue'
import { matchesQuery } from '@/composables/search'
import { playSfx } from '@/lib/sfx'
import {
  ago,
  ensureChats,
  hub,
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
    Boolean(customStart.value) ||
    Boolean(customEnd.value),
)

function pickStatus(id) {
  status.value = id
  try {
    localStorage.setItem(STATUS_KEY, id)
  } catch {
    /* session-only */
  }
}

const threads = computed(() => hub.chat.summaries || [])

function isWorking(thread) {
  return Boolean(thread.working) || (hub.chat.sending && thread.id === hub.chat.active)
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
      if (!inRange(thread)) return false
      return matchesQuery(
        `${titleOf(thread)} ${thread.preview || ''} ${thread.entity || ''}`,
        query.value,
      )
    })
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))),
)

function stateOf(thread) {
  if (isWorking(thread)) return 'Working…'
  if (!thread.queries) return 'New'
  return `${thread.queries} ${thread.queries === 1 ? 'query' : 'queries'} · ${ago(thread.updatedAt)}`
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

function openRowMenu(event, thread) {
  event?.stopPropagation?.()
  if (menuItem.value?.id === thread.id) {
    menuItem.value = null
    return
  }
  const rect = event.currentTarget.getBoundingClientRect()
  const width = 170
  const height = 116
  const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8)
  let top = rect.bottom + 5
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 5)
  menuPos.value = { top: `${top}px`, left: `${left}px` }
  menuItem.value = thread
  nextTick(() => hmenu.value?.querySelector('button')?.focus())
}

function menuPin() {
  const thread = menuItem.value
  menuItem.value = null
  if (thread) togglePin(thread)
}

function menuRename() {
  const thread = menuItem.value
  menuItem.value = null
  if (thread) startRename(thread)
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

onMounted(() => {
  ensureChats()
  document.addEventListener('click', onDocumentClick)
})

watch(
  () => hub.workspace,
  () => ensureChats(),
)

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick)
})

defineExpose({ newThread })
</script>

<template>
  <section class="rchat" aria-label="Chat history">
    <div v-if="!props.headless" class="rchat-head">
      <span>Chats</span>
      <span class="rchat-head-right">
        <span class="n">{{ threads.length }}</span>
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
      <template v-if="filteredThreads.length">
            <div
              v-for="thread in filteredThreads"
              :key="thread.id"
              class="rchat-row"
              :data-on="thread.id === hub.chat.active ? '1' : '0'"
              :data-pinned="thread.pinned ? '1' : '0'"
              :data-working="isWorking(thread) ? '1' : '0'"
              :data-status="statusOf(thread)"
            >
              <div
                class="rchat-open"
                role="button"
                tabindex="0"
                :aria-current="thread.id === hub.chat.active ? 'page' : undefined"
                :title="titleOf(thread)"
                @click="openThread(thread)"
                @keydown.enter="openThread(thread)"
                @keydown.space.prevent="openThread(thread)"
              >
                <EntityMark mini animate :entity="thread.entity" />
                <span class="rchat-text">
                  <span class="rchat-title">
                    <svg
                      v-if="thread.pinned"
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
                    <span class="rchat-entity">{{ thread.entity }}</span>
                    <span class="rchat-sep" aria-hidden="true">·</span>
                    <span>{{ stateOf(thread) }}</span>
                  </span>
                </span>
              </div>
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
      </template>

      <p v-else-if="threads.length" class="rchat-empty">
        No {{ statusNoun }} match this search and time filter.
      </p>
      <p v-else class="rchat-empty">
        No chats yet. Use + to start one.
      </p>
    </div>

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
        <button class="rchat-menu-item" type="button" role="menuitem" data-sfx="pin" @click="menuPin">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <path d="M6 2.4h4l-.7 3.1 2.2 2.2-2.9.9-1.4 4.9-1.4-4.9-2.9-.9 2.2-2.2z" />
          </svg>
          {{ menuItem.pinned ? 'Unpin thread' : 'Pin thread' }}
        </button>
        <button class="rchat-menu-item" type="button" role="menuitem" @click="menuRename">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <path d="M3 11.7l.5-2.6 6.7-6.7 2.4 2.4-6.7 6.7z" />
            <path d="M9.4 3.2l2.4 2.4" />
          </svg>
          Rename thread
        </button>
        <button
          class="rchat-menu-item rchat-menu-danger"
          type="button"
          role="menuitem"
          :class="{ confirming: confirming === menuItem.id }"
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
