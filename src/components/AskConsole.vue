<script setup>
import { computed } from 'vue'
import MessageList from '@/components/MessageList.vue'
import SlashComposer from '@/components/SlashComposer.vue'
import { askAgent, askCounts, askKey, askSend, askThread, hub } from '@/stores/hub'

/**
 * The overview console. It does not configure a run — it joins the session you
 * already initiated, and keeps that session's own thread. Nothing here can
 * retarget an existing conversation, so an earlier turn never changes meaning.
 */
askThread()
askCounts()

const agent = computed(() => askAgent())
const thread = computed(() => hub.ask.threads[askKey()] || [])
const counts = computed(() => hub.ask.counts[askKey()] || { sent: 0, got: 0 })
const chips = ['Where do you run?', 'What do you carry?', 'Show ENTITY.md']

const statLabel = computed(
  () =>
    `This thread: ${counts.value.sent} ${counts.value.sent === 1 ? 'query' : 'queries'} sent, ` +
    `${counts.value.got} ${counts.value.got === 1 ? 'response' : 'responses'} received`,
)

function send(text) {
  askSend(text)
}
</script>

<template>
  <section class="ask">
    <div class="ask-head">
      <p class="eyebrow">Talk to {{ agent.name }}</p>
      <span class="ask-stat" :aria-label="statLabel">
        <span class="u"><b>{{ counts.sent }}</b> queries</span>
        <span class="vs" aria-hidden="true"></span>
        <span class="u"><b>{{ counts.got }}</b> responses</span>
      </span>
    </div>

    <MessageList :messages="thread" :chips="chips" list-class="ask-thread" @chip="send" />

    <div class="ask-compose">
      <SlashComposer :agent="agent" @send="send" />
    </div>

    <p class="ask-foot">
      <kbd>/</kbd> commands <span aria-hidden="true">·</span>
      <kbd>tab</kbd> complete <span aria-hidden="true">·</span>
      <kbd>enter</kbd> send
    </p>
  </section>
</template>
