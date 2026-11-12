<script setup>
import { computed, onMounted, watch } from 'vue'
import MessageList from '@/components/MessageList.vue'
import SlashComposer from '@/components/SlashComposer.vue'
import {
  activeThread,
  askAgent,
  askSession,
  chatSend,
  createThread,
  ensureChats,
  hub,
  openThread,
  threadCounts,
} from '@/stores/hub'

/**
 * The overview console is a window onto the same persisted threads the Chat
 * page uses. It never invents a reply: the first message creates a real thread
 * and the harness answers it.
 */
const chips = ['Where do you run?', 'What do you carry?', 'Show ENTITY.md']

const agent = computed(() => askAgent())
const session = computed(() => askSession())

const thread = computed(() => {
  const active = activeThread()
  const s = session.value
  if (!active) return null
  return active.entity === s.entity &&
    active.machine === s.machine &&
    active.harness === s.harness
    ? active
    : null
})

const messages = computed(() => thread.value?.messages || [])
const counts = computed(() => threadCounts(thread.value))

const statLabel = computed(
  () =>
    `This thread: ${counts.value.q} ${counts.value.q === 1 ? 'query' : 'queries'} sent, ` +
    `${counts.value.r} ${counts.value.r === 1 ? 'response' : 'responses'} received`,
)

async function hydrate() {
  await ensureChats()
  const s = session.value
  const summary = hub.chat.summaries.find(
    (item) =>
      item.entity === s.entity && item.machine === s.machine && item.harness === s.harness,
  )
  if (!summary) return
  try {
    await openThread(summary.id)
  } catch {
    /* the console simply starts empty */
  }
}

onMounted(hydrate)
watch(() => hub.workspace, hydrate)

async function send(text) {
  if (!agent.value) return
  try {
    if (!thread.value) await createThread(session.value)
    await chatSend(text)
  } catch (error) {
    hub.chat.error = error?.message || 'The message could not be sent.'
  }
}
</script>

<template>
  <section v-if="!agent" class="ask ask-empty">
    <div class="ask-head">
      <p class="eyebrow">Console</p>
    </div>
    <p class="empty-note">
      <b>No entity in this workspace yet.</b>
      <span>Create one on the Entities page and the console will read its file.</span>
      <router-link to="/entities">Go to entities</router-link>
    </p>
  </section>

  <section v-else class="ask">
    <div class="ask-head">
      <p class="eyebrow">Talk to {{ agent.name }}</p>
      <span class="ask-stat" :aria-label="statLabel">
        <span class="u"><b>{{ counts.q }}</b> queries</span>
        <span class="vs" aria-hidden="true"></span>
        <span class="u"><b>{{ counts.r }}</b> responses</span>
      </span>
    </div>

    <MessageList :messages="messages" :chips="chips" list-class="ask-thread" @chip="send" />

    <div class="ask-compose">
      <SlashComposer :agent="agent" :disabled="hub.chat.sending" @send="send" />
    </div>

    <p class="ask-foot">
      <kbd>/</kbd> commands <span aria-hidden="true">·</span>
      <kbd>tab</kbd> complete <span aria-hidden="true">·</span>
      <kbd>enter</kbd> send
    </p>
  </section>
</template>
