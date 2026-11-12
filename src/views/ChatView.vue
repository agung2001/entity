<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import EntityMark from '@/components/EntityMark.vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import MachineIcon from '@/components/MachineIcon.vue'
import MessageList from '@/components/MessageList.vue'
import NewThreadDialog from '@/components/NewThreadDialog.vue'
import PickMenu from '@/components/PickMenu.vue'
import SlashComposer from '@/components/SlashComposer.vue'
import TranscriptDialog from '@/components/TranscriptDialog.vue'
import { hasDesktopBridge, onRunEvent } from '@/composables/localBridge'
import { markFor, moodGlyph } from '@/composables/entityMark'
import { loadArtifacts } from '@/stores/artifacts'
import { HARNESSES } from '@/data/mock'
import {
  activeThread,
  agentById,
  chatSend,
  ensureChats,
  harnessById,
  hub,
  machineById,
  selectThread,
  setThreadContext,
  snippet,
  threadContext,
  threadCounts,
  threadStarted,
  toast,
} from '@/stores/hub'

/**
 * The chat surface reads its threads from `<workspace>/chats`. History is a
 * collapsible rail: title, pin and delete are per-thread, and search narrows by
 * title/entity/preview. The composer floats over the transcript.
 */
const route = useRoute()
const router = useRouter()
const newOpen = ref(false)
const transcriptOpen = ref(false)
const helpOpen = ref(false)
const live = ref(null)
const focusMessage = ref(-1)
let offEvent = null

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
const isDesktop = hasDesktopBridge()
/* Browser chrome owns several Cmd/Ctrl+Shift combinations. In a browser use
   Option/Alt+Shift instead, while the packaged app keeps the native-looking
   shortcut. Both are accepted by the handler. */
const transcriptShortcut = isDesktop
  ? isMac
    ? '⌘⇧E'
    : 'Ctrl+Shift+E'
  : isMac
    ? '⌥⇧E'
    : 'Alt+Shift+E'
const sendShortcut = isMac ? '⌘↵' : 'Ctrl+↵'

const chips = ['Where do you run?', 'What do you carry?', 'Show ENTITY.md']

const contextOptions = {
  entity: () =>
    hub.agents.map((a) => ({
      id: a.id,
      label: a.name,
      glyph: moodGlyph(markFor(hub.workspace, a.id, a.mark).mood),
    })),
  machine: () => hub.machines.map((m) => ({ id: m.id, label: m.label, meta: m.thisMachine ? 'local' : 'remote' })),
  harness: () => HARNESSES.map((h) => ({ id: h.id, label: h.label })),
}

const thread = computed(() => activeThread())
const ctx = computed(() => threadContext())
const agent = computed(() => agentById(ctx.value.entity) || hub.agents[0])
const counts = computed(() => threadCounts(thread.value))
const contextLocked = computed(() => threadStarted(thread.value))

const messages = computed(() => {
  const t = thread.value
  if (!t) return []
  if (!hub.chat.sending || hub.chat.active !== t.id) return t.messages
  return [
    ...t.messages,
    { who: 'sys', text: `Waiting for ${agent.value?.name || 'the entity'}…`, pending: true },
  ]
})

const shareUrlFor = (index) =>
  router.resolve({
    name: 'chat',
    query: { ...route.query, thread: hub.chat.active, msg: String(index) },
  }).href

function readMessageFocus() {
  const raw = typeof route.query.msg === 'string' ? Number(route.query.msg) : NaN
  focusMessage.value = Number.isInteger(raw) && raw >= 0 ? raw : -1
}

watch(
  () => route.query.msg,
  () => readMessageFocus(),
  { immediate: true },
)

const threadTitle = computed(() => {
  const t = thread.value
  if (!t) return 'New thread'
  if (t.title) return t.title
  const asked = (t.messages || []).find((message) => message.who === 'me')
  return asked ? snippet(asked.text) : `Thread with ${agent.value?.name || 'entity'}`
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

function startThread() {
  if (!hub.agents.length) return
  newOpen.value = true
}

function onChatKey(event) {
  if (event.key === 'Escape' && helpOpen.value) {
    helpOpen.value = false
    return
  }
  const key = event.key.toLowerCase()
  const shiftPrimary = (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey
  const alternate = event.altKey && event.shiftKey && !event.metaKey && !event.ctrlKey

  if ((shiftPrimary || alternate) && (key === 'e' || event.code === 'KeyE') && canTranscript.value) {
    event.preventDefault()
    event.stopPropagation()
    transcriptOpen.value = true
  }
}

async function pickThread(id) {
  try {
    await selectThread(id)
    return true
  } catch {
    await ensureChats()
    return false
  }
}

/** The newest conversation by activity, not the first pinned row. */
function newestThreadId() {
  const rows = [...hub.chat.summaries].sort((a, b) =>
    String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
  )
  return rows[0]?.id || ''
}

/** Refresh the history and open its newest thread when the URL has none. */
async function openInitialThread(wanted = '') {
  await ensureChats()
  if (wanted && (await pickThread(wanted))) return
  if (hub.chat.active) return
  const latest = newestThreadId()
  if (latest) await pickThread(latest)
}

async function retryFailed(message) {
  const list = thread.value?.messages || []
  const at = list.findIndex((entry) => entry === message || (message.id && entry.id === message.id))
  const question = [...list.slice(0, at >= 0 ? at : list.length)]
    .reverse()
    .find((entry) => entry.who === 'me')
  if (!question) {
    toast('No question to retry.')
    return
  }
  await chatSend(question.text, { retry: true })
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

/* The topbar's New thread sends us here with ?new=1. Opening the dialog is
   local state, so consume the flag before the address bar keeps showing it. */
function consumeNewQuery() {
  if (route.query.new !== '1') return
  startThread()
  const query = { ...route.query }
  delete query.new
  router.replace({ name: 'chat', query })
}

onMounted(async () => {
  offEvent = onRunEvent(onLiveEvent)
  window.addEventListener('keydown', onChatKey, true)
  const wanted = typeof route.query.thread === 'string' ? route.query.thread : ''
  await openInitialThread(wanted)
  consumeNewQuery()
})

onBeforeUnmount(() => {
  offEvent?.()
  offEvent = null
  window.removeEventListener('keydown', onChatKey, true)
})

watch(
  () => hub.workspace,
  async () => {
    live.value = null
    transcriptOpen.value = false
    await openInitialThread()
  },
)

/* /chat is a place, so the address bar names the thread. A shared link opens
   that thread; opening the bare page adopts the newest one and replaces the
   URL so it is shareable without a second click. */
watch(
  () => hub.chat.active,
  (id, previous) => {
    if (!id) return
    const current = typeof route.query.thread === 'string' ? route.query.thread : ''
    if (current === id) return
    const query = { ...route.query, thread: id }
    if (previous && previous !== id) delete query.msg
    router.replace({ name: 'chat', query })
  },
)

watch(
  () => route.query.new,
  () => consumeNewQuery(),
)

watch(
  () => route.query.thread,
  async (id) => {
    if (typeof id !== 'string' || !id) return
    if (await pickThread(id)) return
    /* A dead link falls back to what is open, or the newest thread. */
    const fallback = hub.chat.active || newestThreadId()
    if (fallback && fallback !== id) {
      router.replace({ name: 'chat', query: { ...route.query, thread: fallback } })
    }
  },
)

watch(
  () => hub.chat.active,
  () => {
    live.value = null
    transcriptOpen.value = false
    helpOpen.value = false
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
        <h1>Chat</h1>
        <p class="sub">Every thread in this workspace, pinned to the entity, machine and harness it started on.</p>
      </header>

      <div class="cbody">
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
              <h2>{{ threadTitle }}</h2>
              <p>
                <router-link
                  class="cp-entity"
                  :to="{ name: 'entity', params: { name: agent.name } }"
                  :title="`Open ${agent.name}`"
                >{{ agent.name }}</router-link>
                <span aria-hidden="true">·</span>
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
            :thread-id="hub.chat.active"
            :focus-index="focusMessage"
            :share-url="shareUrlFor"
            list-class="c-thread"
            @chip="send"
            @retry="retryFailed"
          />

          <div class="cp-dockwrap">
            <div class="cp-dock">
              <div class="cp-picks" role="group" aria-label="Thread context">
                <PickMenu
                  head="Entity"
                  icons="entity"
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
                <button
                  class="compose-help"
                  type="button"
                  title="Composer help"
                  aria-label="Composer help"
                  aria-haspopup="dialog"
                  :aria-expanded="helpOpen ? 'true' : 'false'"
                  @click="helpOpen = true"
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                    <circle cx="8" cy="8" r="6" />
                    <path d="M6.2 6.1a1.9 1.9 0 113.2 1.4c-.6.5-1.4.8-1.4 1.8" stroke-linecap="round" />
                    <circle cx="8" cy="11.5" r="0.7" fill="currentColor" stroke="none" />
                  </svg>
                </button>
              </div>
              <div class="cp-compose">
                <SlashComposer
                  :agent="agent"
                  :placeholder="`Message ${agent.name}`"
                  :disabled="hub.chat.sending"
                  @send="send"
                />
              </div>
            </div>
          </div>
        </section>

        <section v-else class="cpanel cpanel-empty">
          <div class="empty-note">
            <b>No thread open.</b>
            <span>Start one to talk to an entity on this machine through its harness.</span>
            <router-link
              class="empty-link"
              :to="{ name: 'chat', query: { ...route.query, new: '1' } }"
            >New thread</router-link>
          </div>
        </section>
      </div>
    </div>

    <Teleport to="body">
      <div class="scrim" :data-open="helpOpen ? '1' : '0'" @click="helpOpen = false"></div>
      <div
        class="modal modal-narrow composer-help"
        :data-open="helpOpen ? '1' : '0'"
        role="dialog"
        aria-modal="true"
        aria-label="Composer help"
      >
        <div class="mo-head">
          <h2>Composer help</h2>
          <p>Type a message, or use these keys in the chat composer.</p>
          <button class="x mo-x" aria-label="Close" @click="helpOpen = false">
            <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5">
              <path d="M2 2l8 8M10 2l-8 8" />
            </svg>
          </button>
        </div>
        <div class="mo-body">
          <dl class="help-list">
            <div>
              <dt><kbd>/</kbd></dt>
              <dd><b>Skills and commands</b><span>Open the menu, then pick a skill or built-in command.</span></dd>
            </div>
            <div>
              <dt><kbd>↑</kbd><kbd>↓</kbd></dt>
              <dd><b>Move through the menu</b><span>Choose the command you want.</span></dd>
            </div>
            <div>
              <dt><kbd>tab</kbd></dt>
              <dd><b>Complete</b><span>Insert the highlighted command.</span></dd>
            </div>
            <div>
              <dt><kbd>{{ sendShortcut }}</kbd></dt>
              <dd><b>Send</b><span>Send the message to the entity.</span></dd>
            </div>
            <div>
              <dt><kbd>enter</kbd></dt>
              <dd><b>New line</b><span>Enter adds a line; Shift+Enter does the same.</span></dd>
            </div>
            <div>
              <dt><kbd>esc</kbd></dt>
              <dd><b>Close the menu</b><span>Stay in the composer without choosing anything.</span></dd>
            </div>
          </dl>
        </div>
        <div class="mo-foot">
          <button class="btn" type="button" @click="helpOpen = false">Got it</button>
        </div>
      </div>
    </Teleport>

    <NewThreadDialog :open="newOpen" :defaults="ctx" @close="newOpen = false" @created="onCreated" />
    <TranscriptDialog
      :open="transcriptOpen"
      :thread="thread"
      :live="live"
      @close="transcriptOpen = false"
    />
  </div>
</template>
