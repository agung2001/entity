<script setup>
import { computed, watch } from 'vue'
import EntityMark from '@/components/EntityMark.vue'
import MessageList from '@/components/MessageList.vue'
import PickMenu from '@/components/PickMenu.vue'
import SlashComposer from '@/components/SlashComposer.vue'
import { HARNESSES } from '@/data/mock'
import {
  activeThread,
  agentById,
  buildChat,
  chatSend,
  harnessById,
  hub,
  machineById,
  newThread,
  selectThread,
  setChatFilter,
  setThreadContext,
  snippet,
  threadContext,
  threadCounts,
  visibleThreads,
} from '@/stores/hub'

/**
 * A dedicated surface: the thread on the right, every thread you have run on
 * the left, filterable by the three things a run is made of — entity, machine,
 * harness. Replies come from the same engine the overview console uses.
 */
buildChat()
watch(
  () => hub.workspace,
  () => buildChat(),
)

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

const historyNote = computed(() => {
  if (filtering.value) return `${visible.value.length} of ${hub.chat.sessions.length}`
  const n = hub.chat.sessions.length
  return `${n} ${n === 1 ? 'thread' : 'threads'}`
})

const statLabel = computed(
  () =>
    `This thread: ${counts.value.q} ${counts.value.q === 1 ? 'query' : 'queries'} sent, ` +
    `${counts.value.r} ${counts.value.r === 1 ? 'response' : 'responses'} received`,
)

const lastAsked = (t) => {
  const asked = [...t.msgs].reverse().find((m) => m.who === 'me')
  return snippet((asked || t.msgs[t.msgs.length - 1])?.text || '')
}

const threadQueries = (t) => t.msgs.filter((m) => m.who === 'me').length
</script>

<template>
  <div class="view view--chat">
    <div class="cpage">
      <header class="cbar">
        <h1>Chat</h1>
        <p class="sub">Every thread you have run, on the machine and harness it ran on.</p>
        <div class="right">
          <button class="btn btn-ink" :disabled="!hub.agents.length" @click="newThread()">
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
              :options="filterOptions.machine()"
              :model-value="hub.chat.filters.machine"
              @update:model-value="setChatFilter('machine', $event)"
            />
            <PickMenu
              head="Harness"
              all-label="All harnesses"
              include-all
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
                @click="selectThread(t.id)"
              >
                <EntityMark mini :entity="t.entity" />
                <span>
                  <span class="hl">
                    <b>{{ agentById(t.entity)?.name }}</b>
                    <time>{{ t.when }}</time>
                  </span>
                  <span class="hs">{{ lastAsked(t) }}</span>
                  <span class="hm">
                    {{ machineById(t.machine)?.label }} · {{ harnessById(t.harness).label
                    }}{{ threadQueries(t) ? '' : ' · new' }}
                  </span>
                </span>
              </button>
            </template>
            <div v-else class="hempty">
              <b>No thread matches</b>Nothing has run with this combination yet. Clear a filter,
              or start a new thread.
            </div>
          </div>
        </aside>

        <section v-if="!hub.agents.length" class="cpanel cpanel-empty">
          <div class="empty-note">
            <b>No entity in this workspace yet.</b>
            <span>A thread is a conversation with one entity's file. Create an entity first.</span>
            <router-link to="/entities">Go to entities</router-link>
          </div>
        </section>

        <section v-else-if="thread" class="cpanel">
          <header class="cp-head">
            <EntityMark :entity="agent.name" />
            <div class="cp-id">
              <h2>{{ agent.name }}</h2>
              <p>{{ machineById(ctx.machine)?.label }} · {{ harnessById(ctx.harness).label }}</p>
            </div>
            <span class="ask-stat" :aria-label="statLabel">
              <span class="u"><b>{{ counts.q }}</b> queries</span>
              <span class="vs" aria-hidden="true"></span>
              <span class="u"><b>{{ counts.r }}</b> responses</span>
            </span>
          </header>

          <MessageList
            :messages="thread.msgs"
            :chips="chips"
            list-class="c-thread"
            @chip="chatSend"
          />

          <div class="cp-compose">
            <SlashComposer :agent="agent" :placeholder="`Message ${agent.name}`" @send="chatSend" />
          </div>

          <div class="cp-picks" role="group" aria-label="Thread context">
            <PickMenu
              head="Entity"
              :options="contextOptions.entity()"
              :model-value="ctx.entity"
              :count="agent.skills.length"
              @update:model-value="setThreadContext('entity', $event)"
            />
            <PickMenu
              head="Machine"
              :options="contextOptions.machine()"
              :model-value="ctx.machine"
              @update:model-value="setThreadContext('machine', $event)"
            />
            <PickMenu
              head="Harness"
              :options="contextOptions.harness()"
              :model-value="ctx.harness"
              @update:model-value="setThreadContext('harness', $event)"
            />
          </div>

          <p class="cp-foot">
            <kbd>/</kbd> commands <span aria-hidden="true">·</span>
            <kbd>tab</kbd> complete <span aria-hidden="true">·</span>
            <kbd>enter</kbd> send
          </p>
        </section>
      </div>
    </div>
  </div>
</template>
