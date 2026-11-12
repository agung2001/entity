<script setup>
import { computed, ref } from 'vue'
import { slashMenu } from '@/stores/hub'

/**
 * The composer, with the `/` menu above it. Commands are the four harness
 * built-ins plus the skills this agent carries; picking one inserts the
 * command and leaves the arguments to you.
 */
const props = defineProps({
  agent: { type: Object, required: true },
  placeholder: { type: String, default: 'Ask anything, or type / for a skill' },
  /* a thread answers one turn at a time; the composer waits for it */
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['send'])

const draft = ref('')
const menu = ref([])
const active = ref(0)
const input = ref(null)

const open = computed(() => menu.value.length > 0)

function refresh() {
  if (props.disabled) return
  menu.value = slashMenu(draft.value, props.agent)
  if (active.value > menu.value.length - 1) active.value = 0
}

function closeMenu() {
  menu.value = []
}

function submit() {
  if (props.disabled) return
  const text = draft.value.trim()
  if (!text) return
  emit('send', text)
  draft.value = ''
  closeMenu()
  input.value?.focus()
}

function pick(cmd) {
  if (!cmd) return
  draft.value = cmd.name + ' '
  closeMenu()
  input.value?.focus()
}

function onKey(e) {
  if (!open.value) return
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    active.value =
      e.key === 'ArrowDown'
        ? Math.min(menu.value.length - 1, active.value + 1)
        : Math.max(0, active.value - 1)
  } else if (e.key === 'Tab') {
    e.preventDefault()
    pick(menu.value[active.value])
  } else if (e.key === 'Enter') {
    const item = menu.value[active.value]
    if (item && draft.value.trim() !== item.name) {
      e.preventDefault()
      pick(item)
    }
  } else if (e.key === 'Escape') {
    closeMenu()
  }
}

/* a short delay so a click on a menu row lands before the menu closes */
function onBlur() {
  setTimeout(closeMenu, 120)
}
</script>

<template>
  <div class="slash-compose">
    <div class="ask-cmdbox" :data-open="open ? '1' : '0'" role="listbox" aria-label="Slash commands">
      <button
        v-for="(c, i) in menu"
        :key="c.name"
        class="ask-cmd"
        type="button"
        role="option"
        :aria-selected="i === active ? 'true' : 'false'"
        :data-on="i === active ? '1' : '0'"
        @mousedown.prevent
        @click="pick(c)"
      >
        <span class="name">{{ c.name }}</span>
        <span class="desc">{{ c.desc }}</span>
        <span class="k">{{ c.skill ? 'skill' : 'command' }}</span>
      </button>
    </div>

    <form class="slash-form" @submit.prevent="submit">
      <label class="prompt">
        <span>›</span>
        <input
          ref="input"
          v-model="draft"
          :placeholder="placeholder"
          autocomplete="off"
          spellcheck="false"
          aria-label="Message"
          :disabled="disabled"
          @input="refresh"
          @keydown="onKey"
          @blur="onBlur"
        />
      </label>
      <button class="go" type="submit" :disabled="disabled">
        {{ disabled ? 'Working…' : 'Send' }}
      </button>
    </form>
  </div>
</template>
