<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
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
const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
const sendShortcut = isMac ? '⌘↵' : 'Ctrl+↵'
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

/* A textarea that grows with the draft, then scrolls at a sane ceiling. The
   border belongs to the dock, not to this field, so there is only one box. */
function grow() {
  const el = input.value
  if (!el) return
  el.style.height = 'auto'
  const next = Math.min(el.scrollHeight, 108)
  el.style.height = `${next}px`
  el.style.overflowY = el.scrollHeight > 108 ? 'auto' : 'hidden'
}

watch(draft, () => nextTick(grow))
onMounted(() => nextTick(grow))

function submit() {
  if (props.disabled) return
  const text = draft.value.trim()
  if (!text) return
  emit('send', text)
  draft.value = ''
  closeMenu()
  nextTick(() => {
    grow()
    input.value?.focus()
  })
}

function pick(cmd) {
  if (!cmd) return
  draft.value = cmd.name + ' '
  closeMenu()
  input.value?.focus()
}

function onKey(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault()
    submit()
    return
  }
  /* Shift+Enter is always a newline, including while the command menu is up. */
  if (e.key === 'Enter' && e.shiftKey) return
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
      <textarea
        ref="input"
        v-model="draft"
        class="slash-input"
        rows="1"
        :placeholder="placeholder"
        autocomplete="off"
        spellcheck="false"
        aria-label="Message"
        :disabled="disabled"
        @input="refresh"
        @keydown="onKey"
        @blur="onBlur"
      ></textarea>
      <div class="slash-actions">
        <span class="slash-hint"><kbd>{{ sendShortcut }}</kbd> to send</span>
        <button
          class="go"
          type="submit"
          :disabled="disabled || !draft.trim()"
          :title="disabled ? 'Sending…' : `Send message (${sendShortcut})`"
          :aria-label="disabled ? 'Sending message' : 'Send message'"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M8 13V3M4 7l4-4 4 4" />
          </svg>
        </button>
      </div>
    </form>
  </div>
</template>
