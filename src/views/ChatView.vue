<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import EntityMark from '@/components/EntityMark.vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import MachineIcon from '@/components/MachineIcon.vue'
import MessageList from '@/components/MessageList.vue'
import NewThreadDialog from '@/components/NewThreadDialog.vue'
import PickMenu from '@/components/PickMenu.vue'
import SlashComposer from '@/components/SlashComposer.vue'
import TranscriptDialog from '@/components/TranscriptDialog.vue'
import { onRunEvent } from '@/composables/localBridge'
import { loadArtifacts } from '@/stores/artifacts'
import { HARNESSES } from '@/data/mock'
import {
  activeThread,
  agentById,
  ago,
  chatSend,
  ensureChats,
  harnessById,
  hub,
  machineById,
  pinThread,
  removeThread,
  renameThread,
  selectThread,
  setChatFilter,
  setThreadContext,
  snippet,
  threadContext,
  threadCounts,
  threadStarted,
  toast,
  visibleThreads,
} from '@/stores/hub'

/**
 * The chat surface reads its threads from `<workspace>/chats`. History is a
 * collapsible rail: title, pin and delete are per-thread, and search narrows by
 * title/entity/preview. The composer floats over the transcript.
 */
const route = useRoute()
const router = useRouter()
const newOpen = ref(false)
const historyOpen = ref(true)
const search = ref('')
const editing = ref('')
const editTitle = ref('')
const confirming = ref('')
const transcriptOpen = ref(false)
const live = ref(null)
let offEvent = null

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
const historyShortcut = isMac ? '⌘⇧B' : 'Ctrl+Shift+B'
const transcriptShortcut = isMac ? '⌘⇧E' : 'Ctrl+Shift+E'

const HISTORY_KEY = 'entity.chat.history'
try {
  historyOpen.value = localStorage.getItem(HISTORY_KEY) !== '0'
} catch {
  /* session-only */
}

const chips = ['Where do you run?', 'What do you carry?', 'Show ENTITY.md']

const filterOptions = {
  entity: () => hub.agents.map((a) => ({ id: a.id, label: a.name, meta: `${a.skills.length} skills` })),
  machine: () => hub.machines.map((m) => ({ id: m.id, label: m.label, meta: m.thisMachine ? 'local' : 'remote' })),
  harness: () => HARNESSES.map((h) => ({ id: h.id, label: h.label })),
}

const contextOptions = {
  entity: () => hub.agents.map((a) => ({ id: a.id, label: a.name })),
  machine: () => hub.machines.map((m) => ({ id: m.id, label: m.label, meta: m.thisMachine ? 'local' : 'remote' })),
  harness: () => HARNESSES.map((h) => ({ id: h.id, label: h.label })),
}

const thread = computed(() => activeThread())
const ctx = computed(() => threadContext())
const agent = computed(() => agentById(ctx.value.entity) || hub.agents[0])
const counts = computed(() => threadCounts(thread.value))
const filtering = computed(() => Object.values(hub.chat.filters).some((v) => v !== 'all'))
const contextLocked = computed(() => threadStarted(thread.value))

const visible = computed(() => {
  const rows = visibleThreads()
  const q = search.value.trim().toLowerCase()
  if (!q) return rows
  return rows.filter((item) =>
    [item.title, item.entity, item.harness, item.machine, snippet(item.preview)]
      .join(' ')
      .toLowerCase()
      .includes(q),
  )
})

const historyNote = computed(() => {
  const total = hub.chat.summaries.length
  if (search.value.trim() || filtering.value) return `${visible.value.length} of ${total}`
  return `${total} ${total === 1 ? 'thread' : 'threads'}`
})

const messages = computed(() => {
  const t = thread.value
  if (!t) return []
  if (!hub.chat.sending || hub.chat.active !== t.id) return t.messages
  return [
    ...t.messages,
    { who: 'sys', text: `Waiting for ${agent.value?.name || 'the entity'}…`, pending: true },
  ]
})

const statLabel = computed(
  () =>
    `This thread: ${counts.value.q} ${counts.value.q === 1 ? 'query' : 'queries'} sent, ` +
    `${counts.value.r} ${counts.value.r === 1 ? 'response' : 'responses'} received`,
)

const latestTrace = computed(() => {
  const messages = thread.value?.messages || []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].execution || messages[i].steps?.length) return messages[i]
  }
  return null
})

const canTranscript = computed(() => Boolean(live.value || latestTrace.value))

const threadLabel = (summary) =>
  summary.title || snippet(summary.preview) || `Thread with ${summary.entity}`

const lastAsked = (summary) => snippet(summary.preview) || 'New thread'
const threadQueries = (summary) => summary.queries || 0
const threadWhen = (summary) => ago(summary.updatedAt)

function toggleHistory() {
  historyOpen.value = !historyOpen.value
  try {
    localStorage.setItem(HISTORY_KEY, historyOpen.value ? '1' : '0')
  } catch {
    /* session-only */
  }
}

function onChatKey(event) {
  if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return
  const target = event.target
  const editable =
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  if (editable) return
  const key = event.key.toLowerCase()
  if (key === 'b') {
    event.preventDefault()
    toggleHistory()
  } else if (key === 'e' && canTranscript.value) {
    event.preventDefault()
    transcriptOpen.value = true
  }
}

async function pickThread(id) {
  try {
    await selectThread(id)
  } catch {
    await ensureChats()
  }
}

function startThread() {
  if (!hub.agents.length) return
  newOpen.value = true
}

function onCreated(created) {
  newOpen.value = false
  if (created?.id && route.query.thread !== created.id) {
    router.replace({ name: 'chat', query: { thread: created.id } })
  }
}

async function send(text) {
  await chatSend(text)
}

function startRename(item) {
  editing.value = item.id
  editTitle.value = item.title || ''
  nextTick(() => document.getElementById(`rename-${item.id}`)?.focus())
}

function cancelRename() {
  editing.value = ''
  editTitle.value = ''
}

async function saveRename(item) {
  if (editing.value !== item.id) return
  const title = editTitle.value.trim()
  try {
    await renameThread(item.id, title)
    toast(title ? 'Thread title saved' : 'Thread title cleared')
    cancelRename()
  } catch (error) {
    toast(error?.message || 'The title could not be saved.')
  }
}

function onRenameKey(event, item) {
  event.stopPropagation()
  if (event.key === 'Enter') {
    event.preventDefault()
    saveRename(item)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    cancelRename()
  }
}

async function togglePin(item) {
  try {
    await pinThread(item.id, !item.pinned)
    toast(item.pinned ? 'Thread unpinned' : 'Thread pinned')
  } catch (error) {
    toast(error?.message || 'The thread could not be pinned.')
  }
}

async function deleteThread(item) {
  if (confirming.value !== item.id) {
    confirming.value = item.id
    setTimeout(() => {
      if (confirming.value === item.id) confirming.value = ''
    }, 2600)
    return
  }
  confirming.value = ''
  const wasActive = hub.chat.active === item.id
  try {
    await removeThread(item.id)
    if (wasActive) {
      router.replace({
        name: 'chat',
        query: hub.chat.active ? { thread: hub.chat.active } : {},
      })
    }
    toast('Thread deleted')
  } catch (error) {
    toast(error?.message || 'The thread could not be deleted.')
  }
}

function onLiveEvent(event) {
  if (!event || event.kind !== 'chat.turn') return
  if (event.workspace !== hub.workspace) return
  if (event.threadId !== hub.chat.active) return

  if (event.phase === 'start') {
    live.value = {
      messageId: event.messageId,
      execution: event.data?.execution || {},
      steps: live.value?.messageId === event.messageId ? live.value.steps : [],
    }
    return
  }

  if (!live.value || live.value.messageId !== event.messageId) {
    live.value = {
      messageId: event.messageId,
      execution: event.data?.execution || {},
      steps: [],
    }
  }

  if (event.phase === 'step') {
    const step = event.data?.step
    if (!step) return
    const steps = [...live.value.steps]
    const index = steps.findIndex((entry) => entry.seq === step.seq)
    if (index >= 0) steps[index] = step
    else steps.push(step)
    live.value = { ...live.value, steps }
    return
  }

  if (event.phase === 'done') {
    const message = event.data?.message
    const current = hub.chat.threads[event.threadId]
    if (message && current && !current.messages.some((entry) => entry.id === message.id)) {
      hub.chat.threads = {
        ...hub.chat.threads,
        [event.threadId]: { ...current, messages: [...current.messages, message] },
      }
    }
    live.value = null
    /* an entity may have written a document or screenshot during the turn */
    loadArtifacts().catch(() => {})
  }
}

onMounted(async () => {
  offEvent = onRunEvent(onLiveEvent)
  document.addEventListener('keydown', onChatKey)
  await ensureChats()
  const wanted = typeof route.query.thread === 'string' ? route.query.thread : ''
  if (wanted) {
    await pickThread(wanted)
    return
  }
  if (!hub.chat.active && hub.chat.summaries.length) await pickThread(hub.chat.summaries[0].id)
})

onBeforeUnmount(() => {
  offEvent?.()
  offEvent = null
  document.removeEventListener('keydown', onChatKey)
})

watch(
  () => hub.workspace,
  async () => {
    search.value = ''
    cancelRename()
    confirming.value = ''
    live.value = null
    transcriptOpen.value = false
    await ensureChats()
    if (!hub.chat.active && hub.chat.summaries.length) await pickThread(hub.chat.summaries[0].id)
  },
)

watch(
  () => route.query.thread,
  async (id) => {
    if (typeof id === 'string' && id) await pickThread(id)
  },
)

watch(
  () => hub.chat.active,
  () => {
    live.value = null
    transcriptOpen.value = false
  },
)

/* a dropped SSE frame must not leave the live trace spinning forever */
watch(
  () => hub.chat.sending,
  (sending) => {
    if (!sending && live.value) live.value = null
  },
)
</script>

<template>
  <div class="view view--chat">
    <div class="cpage">
      <header class="cbar">
        <button
          class="chat-hist-toggle"
          type="button"
          :data-open="historyOpen ? '1' : '0'"
          :aria-expanded="historyOpen ? 'true' : 'false'"
          :title="`${historyOpen ? 'Collapse history' : 'Open history'} (${historyShortcut})`"
          :aria-label="`${historyOpen ? 'Collapse history' : 'Open history'} (${historyShortcut})`"
          @click="toggleHistory"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <rect x="1.7" y="2.3" width="12.6" height="11.4" rx="1.7" />
            <path d="M5.9 2.3v11.4" />
          </svg>
        </button>
        <h1>Chat</h1>
        <p class="sub">Every thread in this workspace, pinned to the entity, machine and harness it started on.</p>
        <div class="right">
          <button class="btn btn-ink" :disabled="!hub.agents.length" @click="startThread">
            New thread
          </button>
        </div>
      </header>

      <div class="cbody">
        <aside v-if="historyOpen" class="chist">
          <div class="hhead">
            <h2>History</h2>
            <kbd class="panel-kbd">{{ historyShortcut }}</kbd>
            <span class="n">{{ historyNote }}</span>
          </div>

          <div class="hsearch">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
              <circle cx="7" cy="7" r="4.6" />
              <path d="M10.5 10.5L14 14" />
            </svg>
            <input
              v-model="search"
              type="text"
              placeholder="Search threads by title"
              autocomplete="off"
              spellcheck="false"
              aria-label="Search threads by title"
            />
            <button
              v-if="search"
              class="hclear"
              type="button"
              aria-label="Clear search"
              @click="search = ''"
            >
              ×
            </button>
          </div>

          <div class="cfilt" role="group" aria-label="Filter history">
            <PickMenu
              head="Entity"
              all-label="All entities"
              include-all
              :options="filterOptions.entity()"
              :model-value="hub.chat.filters.entity"
              @update:model-value="setChatFilter('entity', $event)"
            />
            <PickMenu
              head="Machine"
              all-label="All machines"
              include-all
              icons="machine"
              :options="filterOptions.machine()"
              :model-value="hub.chat.filters.machine"
              @update:model-value="setChatFilter('machine', $event)"
            />
            <PickMenu
              head="Harness"
              all-label="All harnesses"
              include-all
              icons="harness"
              :options="filterOptions.harness()"
              :model-value="hub.chat.filters.harness"
              @update:model-value="setChatFilter('harness', $event)"
            />
          </div>

          <div class="hlist" role="group" aria-label="History">
            <template v-if="visible.length">
              <div
                v-for="t in visible"
                :key="t.id"
                class="hrow"
                :data-on="t.id === hub.chat.active ? '1' : '0'"
                :data-pinned="t.pinned ? '1' : '0'"
              >
                <EntityMark mini :entity="t.entity" />
                <div
                  class="hrow-main"
                  role="button"
                  tabindex="0"
                  @click="pickThread(t.id)"
                  @keydown.enter="pickThread(t.id)"
                  @keydown.space.prevent="pickThread(t.id)"
                >
                  <span class="hl">
                    <svg
                      v-if="t.pinned"
                      class="pin-ic"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.4"
                      aria-label="Pinned"
                    >
                      <path d="M6 2.4h4l-.7 3.1 2.2 2.2-2.9.9-1.4 4.9-1.4-4.9-2.9-.9 2.2-2.2z" />
                    </svg>
                    <template v-if="editing === t.id">
                      <input
                        :id="`rename-${t.id}`"
                        v-model="editTitle"
                        class="hrename"
                        type="text"
                        placeholder="Thread title"
                        spellcheck="false"
                        @click.stop
                        @keydown="onRenameKey($event, t)"
                        @blur="cancelRename"
                      />
                    </template>
                    <b v-else>{{ threadLabel(t) }}</b>
                    <time>{{ threadWhen(t) }}</time>
                  </span>
                  <span class="hs">{{ lastAsked(t) }}</span>
                  <span class="hm">
                    <MachineIcon :size="10" />
                    {{ machineById(t.machine)?.label }}
                    <span aria-hidden="true">·</span>
                    <HarnessIcon :name="t.harness" :size="10" />
                    {{ harnessById(t.harness).label }}
                    <template v-if="!threadQueries(t)"> · new</template>
                  </span>
                </div>
                <span class="hrow-acts" @click.stop>
                  <button
                    class="hact"
                    type="button"
                    :title="t.pinned ? 'Unpin thread' : 'Pin thread'"
                    :aria-label="t.pinned ? 'Unpin thread' : 'Pin thread'"
                    @click="togglePin(t)"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
                      <path d="M6 2.4h4l-.7 3.1 2.2 2.2-2.9.9-1.4 4.9-1.4-4.9-2.9-.9 2.2-2.2z" />
                    </svg>
                  </button>
                  <button
                    class="hact"
                    type="button"
                    title="Edit title"
                    aria-label="Edit title"
                    @click="startRename(t)"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
                      <path d="M3 11.7l.5-2.6 6.7-6.7 2.4 2.4-6.7 6.7z" />
                      <path d="M9.4 3.2l2.4 2.4" />
                    </svg>
                  </button>
                  <button
                    class="hact hact--danger"
                    type="button"
                    :class="{ confirming: confirming === t.id }"
                    :title="confirming === t.id ? 'Click again to delete' : 'Delete thread'"
                    :aria-label="confirming === t.id ? 'Click again to delete' : 'Delete thread'"
                    @click="deleteThread(t)"
                  >
                    <svg v-if="confirming !== t.id" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
                      <path d="M3.2 4.4h9.6M6.1 4.4V2.8h3.8v1.6M4.4 4.4l.6 8.8h6l.6-8.8" />
                    </svg>
                    <span v-else class="hconfirm">Delete?</span>
                  </button>
                </span>
              </div>
            </template>
            <div v-else class="hempty">
              <b>{{ search ? 'No thread matches' : 'No thread matches' }}</b>
              {{
                search
                  ? 'Try a different title, entity or preview.'
                  : hub.chat.summaries.length
                    ? 'Nothing has started with this combination yet. Clear a filter, or start a new thread.'
                    : 'No conversation has started in this workspace yet. Open an entity and send the first message.'
              }}
            </div>
          </div>
        </aside>

        <section v-if="!hub.agents.length" class="cpanel cpanel-empty">
          <div class="empty-note">
            <b>No entity in this workspace yet.</b>
            <span>A thread is a real conversation with one entity's file. Create an entity first.</span>
            <router-link to="/entities">Go to entities</router-link>
          </div>
        </section>

        <section v-else-if="thread" class="cpanel">
          <header class="cp-head">
            <EntityMark :entity="agent.name" />
            <div class="cp-id">
              <h2>{{ agent.name }}</h2>
              <p>
                <MachineIcon :size="10" />
                {{ machineById(ctx.machine)?.label }}
                <span aria-hidden="true">·</span>
                <HarnessIcon :name="ctx.harness" :size="10" />
                {{ harnessById(ctx.harness).label }}
                <template v-if="ctx.model">
                  <span aria-hidden="true">·</span>
                  <span class="mono">{{ ctx.model }}</span>
                </template>
              </p>
            </div>
            <div class="cp-right">
              <span class="ask-stat" :aria-label="statLabel">
                <span class="u"><b>{{ counts.q }}</b> queries</span>
                <span class="vs" aria-hidden="true"></span>
                <span class="u"><b>{{ counts.r }}</b> responses</span>
              </span>
              <button
                class="trace-open"
                type="button"
                :disabled="!canTranscript"
                :aria-expanded="transcriptOpen ? 'true' : 'false'"
                :title="`View execution transcript (${transcriptShortcut})`"
                :aria-label="`View execution transcript (${transcriptShortcut})`"
                @click="transcriptOpen = true"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
                  <path d="M3 2.5h10v11H3z" />
                  <path d="M5.2 5.5h5.6M5.2 8h5.6M5.2 10.5h3.4" />
                </svg>
                <span>Transcript</span>
                <kbd class="trace-kbd">{{ transcriptShortcut }}</kbd>
              </button>
            </div>
          </header>

          <MessageList
            :messages="messages"
            :chips="chips"
            :live="live"
            :entity-name="agent.name"
            list-class="c-thread"
            @chip="send"
          />

          <div class="cp-dockwrap">
            <div class="cp-dock">
              <div class="cp-picks" role="group" aria-label="Thread context">
                <PickMenu
                  head="Entity"
                  :options="contextOptions.entity()"
                  :model-value="ctx.entity"
                  :count="agent.skills.length"
                  :disabled="contextLocked"
                  @update:model-value="setThreadContext('entity', $event)"
                />
                <PickMenu
                  head="Machine"
                  icons="machine"
                  :options="contextOptions.machine()"
                  :model-value="ctx.machine"
                  :disabled="contextLocked"
                  @update:model-value="setThreadContext('machine', $event)"
                />
                <PickMenu
                  head="Harness"
                  icons="harness"
                  :options="contextOptions.harness()"
                  :model-value="ctx.harness"
                  :disabled="contextLocked"
                  @update:model-value="setThreadContext('harness', $event)"
                />
              </div>
              <div class="cp-compose">
                <SlashComposer
                  :agent="agent"
                  :placeholder="`Message ${agent.name}`"
                  :disabled="hub.chat.sending"
                  @send="send"
                />
              </div>
              <p class="cp-foot">
                <kbd>/</kbd> commands <span aria-hidden="true">·</span>
                <kbd>tab</kbd> complete <span aria-hidden="true">·</span>
                <kbd>enter</kbd> send
              </p>
            </div>
          </div>
        </section>

        <section v-else class="cpanel cpanel-empty">
          <div class="empty-note">
            <b>No thread open.</b>
            <span>Start one to talk to an entity on this machine through its harness.</span>
            <button class="btn btn-ink" type="button" :disabled="!hub.agents.length" @click="startThread">
              New thread
            </button>
          </div>
        </section>
      </div>
    </div>

    <NewThreadDialog :open="newOpen" :defaults="ctx" @close="newOpen = false" @created="onCreated" />
    <TranscriptDialog
      :open="transcriptOpen"
      :thread="thread"
      :live="live"
      @close="transcriptOpen = false"
    />
  </div>
</template>
