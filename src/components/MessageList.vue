<script setup>
import { nextTick, ref, watch } from 'vue'

/**
 * The thread surface. It scrolls itself to the newest message whenever the
 * conversation grows; chips are offered only before the first question.
 */
const props = defineProps({
  messages: { type: Array, default: () => [] },
  chips: { type: Array, default: () => [] },
  listClass: { type: String, default: 'ask-thread' },
})
const emit = defineEmits(['chip'])

const box = ref(null)

function toBottom() {
  nextTick(() => {
    if (box.value) box.value.scrollTop = box.value.scrollHeight
  })
}

watch(() => props.messages.length, toBottom, { immediate: true })
</script>

<template>
  <div
    ref="box"
    :class="listClass"
    role="log"
    aria-live="polite"
    aria-label="Conversation with entity"
  >
    <template v-for="(m, i) in messages" :key="i">
      <div v-if="m.who === 'sys'" class="ask-sys">{{ m.text }}</div>
      <div v-else class="msg" :data-who="m.who">{{ m.text }}</div>
    </template>

    <div v-if="chips.length && !messages.some((m) => m.who === 'me')" class="chips">
      <button v-for="q in chips" :key="q" class="pick" type="button" @click="emit('chip', q)">
        {{ q }}
      </button>
    </div>
  </div>
</template>
