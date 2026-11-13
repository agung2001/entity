<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ChatHarnessDialog from '@/components/ChatHarnessDialog.vue'
import ChatMcpDialog from '@/components/ChatMcpDialog.vue'
import EntityMark from '@/components/EntityMark.vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import MessageList from '@/components/MessageList.vue'
import NewThreadDialog from '@/components/NewThreadDialog.vue'
import PickMenu from '@/components/PickMenu.vue'
import PixelBackdrop from '@/components/PixelBackdrop.vue'
import SlashComposer from '@/components/SlashComposer.vue'
import TimelineDialog from '@/components/TimelineDialog.vue'
import { onRunEvent } from '@/composables/localBridge'
import { colorById, markFor, playReaction } from '@/composables/entityMark'
import { useDialogDismiss } from '@/composables/useDialog'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import { playSfx } from '@/lib/sfx'
import { loadArtifacts } from '@/stores/artifacts'
import {
  activeThread,
  agentById,
  cancelChat,
  chatSend,
  ensureChats,
  harnessById,
  hub,
  machineById,
  renameThread,
  selectThread,
  setThreadContext,
  snippet,
  threadContext,
  threadCounts,
  threadStarted,
  toast,
} from '@/stores/hub'
import { workspaces } from '@/stores/workspaces'

/**
 * The chat surface reads its threads from `<workspace>/chats`. History is a
 * collapsible rail: title, pin and delete are per-thread, and search narrows by
 * title/entity/preview. The composer floats over the transcript.
 */
const route = useRoute()
const router = useRouter()
const newOpen = ref(false)
const timelineOpen = ref(false)
const helpOpen = ref(false)
const helpTab = ref('keys')
const harnessOpen = ref(false)
const mcpOpen = ref(false)
const composer = ref(null)
const live = ref(null)
const focusMessage = ref(-1)
const titleEditing = ref(false)
const titleDraft = ref('')
const titleInput = ref(null)
let offEvent = null

/* Every combo comes from the catalog in `src/lib/shortcuts.js`, which also
   renders the guide in the top bar. */
const timelineShortcut = shortcutLabel('timeline')
const sendShortcut = shortcutLabel('send')
const focusShortcut = shortcutLabel('focus')

/* The composer help belongs to this page; the harness, MCP, new-thread and
   timeline dialogs register their own Escape entry. */
useDialogDismiss({ active: () => helpOpen.value, close: () => (helpOpen.value = false) })

const chips = ['Where do you run?', 'What do you carry?', 'Show ENTITY.md']

const contextOptions = {
  machine: () => hub.machines.map((m) => ({ id: m.id, label: m.label, meta: m.thisMachine ? 'local' : 'remote' })),
}

const thread = computed(() => activeThread())
const ctx = computed(() => threadContext())
const agent = computed(() => agentById(ctx.value.entity) || hub.agents[0])
const agentColor = computed(() => {
  if (!agent.value) return ''
  const mark = markFor(hub.workspace, agent.value.name, agent.value.mark || null)
  return colorById(mark.color, mark.custom).hex
})
const counts = computed(() => threadCounts(thread.value))
const contextLocked = computed(() => threadStarted(thread.value))
const mcpCount = computed(() => Object.keys(workspaces.mcp?.servers || {}).length)

const lastMessageAt = computed(() => {
  const list = thread.value?.messages || []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.at) return list[index].at
  }
  return thread.value?.updatedAt || ''
})

const lastMessageWhen = computed(() => {
  const stamp = lastMessageAt.value
  if (!stamp) return 'No messages yet'
  const when = new Date(stamp)
  if (!Number.isFinite(when.getTime())) return 'No messages yet'
  return when.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: when.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
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

const shareUrlFor = (index) =>
  router.resolve({
    name: 'chat',
    params: { workspace: route.params.workspace },
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

function startTitleEdit() {
  if (!thread.value) return
  titleDraft.value = thread.value.title || threadTitle.value
  titleEditing.value = true
  nextTick(() => {
    titleInput.value?.focus()
    titleInput.value?.select()
  })
}

function cancelTitleEdit() {
  titleEditing.value = false
  titleDraft.value = ''
}

async function saveTitle() {
  if (!titleEditing.value || !thread.value) return
  const id = thread.value.id
  const next = titleDraft.value.trim()
  titleEditing.value = false
  if (next === String(thread.value.title || '').trim()) {
    titleDraft.value = ''
    return
  }
  try {
    await renameThread(id, next)
    toast(next ? 'Thread title saved' : 'Thread title cleared')
  } catch (error) {
    toast(error?.message || 'The title could not be saved.')
  } finally {
    titleDraft.value = ''
  }
}

function onTitleKey(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    cancelTitleEdit()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    saveTitle()
  }
}

function onTitleTitleKey(event) {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  startTitleEdit()
}

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

const canTimeline = computed(() => Boolean(live.value || latestTrace.value))

function startThread() {
  if (!hub.agents.length) return
  newOpen.value = true
}

function onChatKey(event) {
  if (matchesShortcut('focus', event)) {
    if (newOpen.value || timelineOpen.value || helpOpen.value || harnessOpen.value || mcpOpen.value) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    composer.value?.focus()
    return
  }

  if (matchesShortcut('timeline', event) && canTimeline.value) {
    event.preventDefault()
    event.stopPropagation()
    timelineOpen.value = true
  }
}

function openHarness() {
  helpOpen.value = false
  mcpOpen.value = false
  harnessOpen.value = true
}

function openMcp() {
  helpOpen.value = false
  harnessOpen.value = false
  mcpOpen.value = true
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
  playSfx('success')
  playReaction(hub.workspace, created?.entity)
  newOpen.value = false
  if (created?.id && route.query.thread !== created.id) {
    router.replace({ name: 'chat', params: { workspace: route.params.workspace }, query: { thread: created.id } })
  }
}

async function stopTurn() {
  playSfx('stop')
  playReaction(hub.workspace, thread.value?.entity)
  await cancelChat()
}

async function send(text) {
  playSfx('send')
  playReaction(hub.workspace, thread.value?.entity)
  try {
    await chatSend(text)
  } catch (error) {
    playSfx('error')
    playReaction(hub.workspace, thread.value?.entity)
    throw error
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
    playSfx(message?.error ? 'error' : 'receive')
    playReaction(hub.workspace, event.entity || thread.value?.entity)
    /* an entity may have written a document or screenshot during the turn */
    loadArtifacts().catch(() => {})
  }
}

/* The rail's + and the new-thread shortcut send us here with ?new=1. Opening
   the dialog is local state, so consume the flag before the address bar keeps
   showing it. */
function consumeNewQuery() {
  if (route.query.new !== '1') return
  startThread()
  const query = { ...route.query }
  delete query.new
  router.replace({ name: 'chat', params: { workspace: route.params.workspace }, query })
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
    timelineOpen.value = false
    harnessOpen.value = false
    mcpOpen.value = false
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
    router.replace({ name: 'chat', params: { workspace: route.params.workspace }, query })
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
    /* Clicking a row already opened it; the URL is only catching up. */
    if (id === hub.chat.active) return
    if (await pickThread(id)) return
    /* A dead link falls back to what is open, or the newest thread. */
    const fallback = hub.chat.active || newestThreadId()
    if (fallback && fallback !== id) {
      router.replace({ name: 'chat', params: { workspace: route.params.workspace }, query: { ...route.query, thread: fallback } })
    }
  },
)

watch(
  () => hub.chat.active,
  () => {
    live.value = null
    timelineOpen.value = false
    helpOpen.value = false
    harnessOpen.value = false
    mcpOpen.value = false
    titleEditing.value = false
    titleDraft.value = ''
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
      <div class="cbody">
        <section v-if="!hub.agents.length" class="cpanel cpanel-empty">
          <div class="empty-note">
            <b>No entity in this workspace yet.</b>
            <span>A thread is a real conversation with one entity's file. Create an entity first.</span>
            <button class="empty-link" type="button" @click="hub.rail.entities = true">Go to entities</button>
          </div>
        </section>

        <section v-else-if="thread" class="cpanel">
          <PixelBackdrop
            variant="chat"
            :color="agentColor"
            :active="hub.chat.sending"
            :count="10"
          />
          <header class="cp-head">
            <router-link
              class="cp-mark-link"
              :to="{ name: 'entity', params: { workspace: hub.workspace, name: agent.name } }"
              :aria-label="`Open ${agent.name}`"
              :title="`Open ${agent.name}`"
            >
              <EntityMark :entity="agent.name" />
            </router-link>
            <div class="cp-id">
              <form v-if="titleEditing" class="cp-title-form" @submit.prevent="saveTitle">
                <input
                  ref="titleInput"
                  v-model="titleDraft"
                  class="cp-title-input"
                  type="text"
                  maxlength="120"
                  aria-label="Thread title"
                  @keydown="onTitleKey"
                  @blur="saveTitle"
                />
              </form>
              <h2
                v-else
                class="cp-title"
                role="button"
                tabindex="0"
                title="Rename thread"
                @click="startTitleEdit"
                @keydown="onTitleTitleKey"
              >
                {{ threadTitle }}
                <svg class="cp-title-pencil" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                  <path d="M3 11.7l.5-2.6 6.7-6.7 2.4 2.4-6.7 6.7zM9.4 3.2l2.4 2.4" />
                </svg>
              </h2>
              <p class="cp-id-meta">
                <span>Last message</span>
                <time v-if="lastMessageAt" :datetime="lastMessageAt">{{ lastMessageWhen }}</time>
                <span v-else>{{ lastMessageWhen }}</span>
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
                :disabled="!canTimeline"
                :aria-expanded="timelineOpen ? 'true' : 'false'"
                :title="`View execution timeline (${timelineShortcut})`"
                :aria-label="`View execution timeline (${timelineShortcut})`"
                @click="timelineOpen = true"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
                  <path d="M3 2.5h10v11H3z" />
                  <path d="M5.2 5.5h5.6M5.2 8h5.6M5.2 10.5h3.4" />
                </svg>
                <span>Timeline</span>
                <kbd class="trace-kbd">{{ timelineShortcut }}</kbd>
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
                  head="Machine"
                  icons="machine"
                  :options="contextOptions.machine()"
                  :model-value="ctx.machine"
                  :disabled="contextLocked"
                  @update:model-value="setThreadContext('machine', $event)"
                />
                <button
                  class="pickbtn cp-ctx-btn"
                  type="button"
                  aria-haspopup="dialog"
                  :aria-expanded="harnessOpen ? 'true' : 'false'"
                  :title="`${harnessById(ctx.harness).label}${ctx.model ? ` · ${ctx.model}` : ''}`"
                  @click="openHarness"
                >
                  <HarnessIcon :name="ctx.harness" :size="12" />
                  <span class="nm">{{ harnessById(ctx.harness).label }}</span>
                  <svg class="ch" viewBox="0 0 10 10" aria-hidden="true">
                    <path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4" />
                  </svg>
                </button>
                <button
                  class="pickbtn cp-ctx-btn"
                  type="button"
                  aria-haspopup="dialog"
                  :aria-expanded="mcpOpen ? 'true' : 'false'"
                  title="Workspace MCP servers"
                  @click="openMcp"
                >
                  <span class="nm">MCP</span>
                  <span class="ct">{{ mcpCount }}</span>
                  <svg class="ch" viewBox="0 0 10 10" aria-hidden="true">
                    <path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4" />
                  </svg>
                </button>
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
                  ref="composer"
                  :agent="agent"
                  :machine="ctx.machine || 'local'"
                  :placeholder="`Message ${agent.name} — / skills · @ mentions`"
                  :focus-shortcut="focusShortcut"
                  :disabled="hub.chat.sending"
                  :sending="hub.chat.sending"
                  :stopping="hub.chat.stopping"
                  @send="send"
                  @stop="stopTurn"
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
              :to="{ name: 'chat', params: { workspace: route.params.workspace }, query: { ...route.query, new: '1' } }"
            >New thread</router-link>
          </div>
        </section>
      </div>
    </div>

    <Teleport to="body">
      <div class="scrim" :data-open="helpOpen ? '1' : '0'" @click="helpOpen = false"></div>
      <div
        class="modal composer-help"
        :data-open="helpOpen ? '1' : '0'"
        role="dialog"
        aria-modal="true"
        aria-label="Composer help"
      >
        <div class="mo-head">
          <h2>Composer help</h2>
          <p>Everything the message box understands: keys, mentions and skills.</p>
          <button class="x mo-x" aria-label="Close" @click="helpOpen = false">
            <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5">
              <path d="M2 2l8 8M10 2l-8 8" />
            </svg>
          </button>
        </div>

        <div class="help-tabs" role="tablist" aria-label="Help sections">
          <button
            v-for="tab in [
              { id: 'keys', label: 'Keys' },
              { id: 'mentions', label: 'Mentions' },
              { id: 'skills', label: 'Skills' },
            ]"
            :key="tab.id"
            class="help-tab"
            type="button"
            role="tab"
            :aria-selected="helpTab === tab.id ? 'true' : 'false'"
            :data-on="helpTab === tab.id ? '1' : '0'"
            @click="helpTab = tab.id"
          >
            {{ tab.label }}
          </button>
        </div>

        <div class="mo-body">
          <div v-if="helpTab === 'keys'">
          <dl class="help-list">
            <div>
              <dt><kbd>/</kbd></dt>
              <dd><b>Skills</b><span>Open the menu, then pick a skill from any harness on this machine.</span></dd>
            </div>
            <div>
              <dt><kbd>@</kbd></dt>
              <dd><b>Mentions</b><span>Another entity, an Orca file, an artifact, a Maka note, a YouTrack issue.</span></dd>
            </div>
            <div>
              <dt><kbd>↑</kbd><kbd>↓</kbd></dt>
              <dd><b>Move through the menu</b><span>Choose the item you want.</span></dd>
            </div>
            <div>
              <dt><kbd>tab</kbd></dt>
              <dd><b>Complete</b><span>Insert the highlighted item.</span></dd>
            </div>
            <div>
              <dt><kbd>{{ focusShortcut }}</kbd></dt>
              <dd><b>Focus message</b><span>Jump back into the composer from anywhere in chat.</span></dd>
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
          <p class="help-note">
            The menu shows ten at a time. <b>Show 10 more</b> fetches the next page of a mention
            search, or reveals more of a skill library. App-wide keys — palette, rail, theme,
            new conversation — are in the keyboard guide, behind <kbd>?</kbd> in the top bar.
          </p>
          </div>

          <div v-else-if="helpTab === 'mentions'" class="help-mentions">
            <p class="help-lede">
              A mention owns the text after it, up to the next <code class="mono">@</code>. A name that
              does not exist stops the message; a search that finds nothing only adds a note.
            </p>
            <div v-for="row in [
              { token: '@py-agent fix the build', what: 'That entity runs the job first, and its answer is injected into this turn. At most two per message.' },
              { token: '@orca:One:src/app.ts', what: 'A path inside an Orca project. The project is one word; the file after the second colon is optional — omit it for the project root.' },
              { token: '@artifact:login shot', what: 'A file on this workspace’s artifact shelf, matched by name.' },
              { token: '@maka:one:plan', what: 'A note found through the Maka MCP server — vault, then what to search for.' },
              { token: '@youtrack:AC:login bug', what: 'Issues found through the YouTrack MCP server, scoped to the project key you name. The rows show the project and the issue title.' },
            ]" :key="row.token" class="help-mention">
              <code class="mono">{{ row.token }}</code>
              <span>{{ row.what }}</span>
            </div>
            <p class="help-note">
              Results appear while you type a mention on one word — <code class="mono">@youtrack:AC:log</code>
              lists issues to pick from, <code class="mono">@maka:</code> lists vaults. A space ends the live
              search, and the rest of the sentence becomes the query. The project or vault right after
              the colon is always one word — <code class="mono">@orca:maka tell me about it</code> is the
              maka project plus a sentence. Resolution happens once, when you send: your text stays as
              typed, the resolved items are added above it for the entity, and listed under the answer
              afterwards.
            </p>
          </div>

          <div v-else class="help-mentions">
            <p class="help-lede">
              A skill is a file the harness opens. Start the message with one of these and the app turns
              it into an absolute path on this machine.
            </p>
            <div v-for="row in [
              { token: '/workspace:<name>', what: 'A skill attached to this workspace.' },
              { token: '/<harness>:<name>', what: 'A skill in that harness’s own library — e.g. /claude:pdf-ocr.' },
              { token: '/<name>', what: 'Any library on this machine, when exactly one has that name.' },
            ]" :key="row.token" class="help-mention">
              <code class="mono">{{ row.token }}</code>
              <span>{{ row.what }}</span>
            </div>
            <p class="help-note">
              Type <code class="mono">/</code> to see what is available. A name this app owns that does
              not resolve is an error, so a typo never becomes an answer without the skill.
            </p>
          </div>
        </div>
        <div class="mo-foot">
          <button class="btn" type="button" @click="helpOpen = false">Got it</button>
        </div>
      </div>
    </Teleport>

    <ChatHarnessDialog
      :open="harnessOpen"
      :harness="ctx.harness"
      :model="ctx.model"
      @close="harnessOpen = false"
    />
    <ChatMcpDialog :open="mcpOpen" @close="mcpOpen = false" />
    <NewThreadDialog :open="newOpen" :defaults="ctx" @close="newOpen = false" @created="onCreated" />
    <TimelineDialog
      :open="timelineOpen"
      :thread="thread"
      :live="live"
      @close="timelineOpen = false"
    />
  </div>
</template>
