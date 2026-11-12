<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import EntityMark from '@/components/EntityMark.vue'
import {
  ago,
  ensureChats,
  hub,
  pinThread,
  removeThread,
  renameThread,
  snippet,
  toast,
} from '@/stores/hub'

/**
 * The chat history, folded into the left rail. It is intentionally one line
 * per thread: the character and its mood are the recognisable part, the title
 * names it, the state says whether it is new or how far it has gone, and the
 * three-dot menu keeps the rare actions out of the way.
 */
const router = useRouter()
const editing = ref('')
const editTitle = ref('')
const confirming = ref('')
const menuItem = ref(null)
const menuPos = ref({ top: 0, left: 0 })
const hmenu = ref(null)

const threads = computed(() => hub.chat.summaries || [])

function titleOf(thread) {
  return thread.title || (thread.queries ? snippet(thread.preview) : `New thread · ${thread.entity}`)
}

function stateOf(thread) {
  if (hub.chat.sending && thread.id === hub.chat.active) return 'Thinking…'
  if (!thread.queries) return 'New'
  return `${thread.queries} ${thread.queries === 1 ? 'query' : 'queries'} · ${ago(thread.updatedAt)}`
}

function openThread(thread) {
  menuItem.value = null
  router.push({ name: 'chat', query: { thread: thread.id } })
}

function newThread() {
  menuItem.value = null
  const current = router.currentRoute.value
  const query = current.name === 'chat' ? { ...current.query, new: '1' } : { new: '1' }
  router.push({ name: 'chat', query })
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
</script>

<template>
  <section class="rchat" aria-label="Chat history">
    <div class="rchat-head">
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

    <div class="rchat-list">
      <div
        v-for="thread in threads"
        :key="thread.id"
        class="rchat-row"
        :data-on="thread.id === hub.chat.active ? '1' : '0'"
        :data-pinned="thread.pinned ? '1' : '0'"
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
            <span class="rchat-state">{{ stateOf(thread) }}</span>
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

      <p v-if="!threads.length" class="rchat-empty">
        No chats yet. Use + or the top bar to start one.
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
        <button class="rchat-menu-item" type="button" role="menuitem" @click="menuPin">
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
