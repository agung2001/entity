<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import EntityMark from '@/components/EntityMark.vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import MachineIcon from '@/components/MachineIcon.vue'
import MessageList from '@/components/MessageList.vue'
import NewThreadDialog from '@/components/NewThreadDialog.vue'
import PickMenu from '@/components/PickMenu.vue'
import SlashComposer from '@/components/SlashComposer.vue'
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
  selectThread,
  setChatFilter,
  setThreadContext,
  snippet,
  threadContext,
  threadCounts,
  threadStarted,
  visibleThreads,
} from '@/stores/hub'

/**
 * The chat surface reads its threads from `<workspace>/chats`. The history on
 * the left is the file list; the panel on the right is one transcript. A send
 * is a real harness invocation — the backend keeps the transcript and passes it
 * to the next turn.
 */
const route = useRoute()
const router = useRouter()
const newOpen = ref(false)

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
const visible = computed(() => visibleThreads())
const filtering = computed(() => Object.values(hub.chat.filters).some((v) => v !== 'all'))
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

const historyNote = computed(() => {
  if (filtering.value) return `${visible.value.length} of ${hub.chat.summaries.length}`
  const n = hub.chat.summaries.length
  return `${n} ${n === 1 ? 'thread' : 'threads'}`
})

const statLabel = computed(
  () =>
    `This thread: ${counts.value.q} ${counts.value.q === 1 ? 'query' : 'queries'} sent, ` +
    `${counts.value.r} ${counts.value.r === 1 ? 'response' : 'responses'} received`,
)

const lastAsked = (summary) => snippet(summary.preview) || 'New thread'
const threadQueries = (summary) => summary.queries || 0
const threadWhen = (summary) => ago(summary.updatedAt)

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

function onCreated(thread) {
  newOpen.value = false
  if (thread?.id && route.query.thread !== thread.id) {
    router.replace({ name: 'chat', query: { thread: thread.id } })
  }
}

async function send(text) {
  await chatSend(text)
}

onMounted(async () => {
  await ensureChats()
  const wanted = typeof route.query.thread === 'string' ? route.query.thread : ''
  if (wanted) {
    await pickThread(wanted)
    return
  }
  if (!hub.chat.active && hub.chat.summaries.length) await pickThread(hub.chat.summaries[0].id)
})

watch(
  () => hub.workspace,
  async () => {
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
</script>

<template>
  <div class="view view--chat">
    <div class="cpage">
      <header class="cbar">
        <h1>Chat</h1>
        <p class="sub">Every thread in this workspace, pinned to the entity, machine and harness it started on.</p>
        <div class="right">
          <button class="btn btn-ink" :disabled="!hub.agents.length" @click="startThread">
            New thread
          </button>
        </div>
      </header>

      <div class="cbody">
        <aside class="chist">
          <div class="hhead">
            <h2>History</h2>
            <span class="n">{{ historyNote }}</span>
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
              <button
                v-for="t in visible"
                :key="t.id"
                class="hrow"
                type="button"
                :aria-current="t.id === hub.chat.active ? 'true' : 'false'"
                :data-on="t.id === hub.chat.active ? '1' : '0'"
                @click="pickThread(t.id)"
              >
                <EntityMark mini :entity="t.entity" />
                <span>
                  <span class="hl">
                    <b>{{ agentById(t.entity)?.name }}</b>
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
                </span>
              </button>
            </template>
            <div v-else class="hempty">
              <b>No thread matches</b>
              {{
                hub.chat.summaries.length
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
            <span class="ask-stat" :aria-label="statLabel">
              <span class="u"><b>{{ counts.q }}</b> queries</span>
              <span class="vs" aria-hidden="true"></span>
              <span class="u"><b>{{ counts.r }}</b> responses</span>
            </span>
          </header>

          <MessageList :messages="messages" :chips="chips" list-class="c-thread" @chip="send" />

          <div class="cp-compose">
            <SlashComposer
              :agent="agent"
              :placeholder="`Message ${agent.name}`"
              :disabled="hub.chat.sending"
              @send="send"
            />
          </div>

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
            <p class="cp-foot">
              <kbd>/</kbd> commands <span aria-hidden="true">·</span>
              <kbd>tab</kbd> complete <span aria-hidden="true">·</span>
              <kbd>enter</kbd> send
            </p>
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
  </div>
</template>
