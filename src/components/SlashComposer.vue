<script setup>
import { computed, ref, watch } from 'vue'
import { slashMenu } from '@/stores/hub'
import { loadLibrary, workspaces } from '@/stores/workspaces'

/**
 * The composer, with the `/` menu above it. Commands are the four harness
 * built-ins plus the skills this entity can reach — a workspace skill as
 * `/workspace:<name>`, a harness library skill as `/<harness>:<name>`. Picking
 * one inserts the reference; the backend turns it into a path.
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
/* one library read per composer mount, even if the scan fails */
let libraryAsked = false

const open = computed(() => menu.value.length > 0)

function refresh() {
  if (props.disabled) return
  menu.value = slashMenu(draft.value, props.agent)
  if (active.value > menu.value.length - 1) active.value = 0
  /* the harness libraries are the expensive half of the menu; they are read the
     first time a `/` is typed, not when the page mounts. A failed scan gets one
     retry — repeating it on every keystroke would spawn a scan per character. */
  if (draft.value.startsWith('/') && !libraryAsked) {
    libraryAsked = true
    if (!workspaces.library) loadLibrary()
    else if (workspaces.library.error) loadLibrary({ force: true })
  }
}

/* the scan is async: when it lands, fill in the menu for the draft on screen */
watch(
  () => workspaces.library,
  () => {
    if (draft.value.startsWith('/')) refresh()
  },
)

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
        <span class="k">{{ c.kind || 'command' }}</span>
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
