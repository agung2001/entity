<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { slashMenu } from '@/stores/hub'
import { loadSkillNames, workspaces } from '@/stores/workspaces'

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
  focusShortcut: { type: String, default: '' },
})
const emit = defineEmits(['send'])

const draft = ref('')
const menu = ref([])
const active = ref(0)
const input = ref(null)
const scanning = ref(false)
const expanded = ref(false)
const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
const sendShortcut = isMac ? '⌘↵' : 'Ctrl+↵'
/* one library read per composer mount, even if the scan fails */
let libraryAsked = false

const open = computed(() => menu.value.length > 0)
const shown = computed(() => (expanded.value ? menu.value : menu.value.slice(0, 5)))

function toggleExpanded() {
  expanded.value = !expanded.value
  active.value = 0
}

async function scanNames() {
  if (workspaces.library || workspaces.skillNames) return
  scanning.value = true
  try {
    await loadSkillNames()
  } finally {
    scanning.value = false
  }
}

function refresh() {
  if (props.disabled) return
  expanded.value = false
  menu.value = slashMenu(draft.value, props.agent)
  if (active.value > menu.value.length - 1) active.value = 0
  /* The names-only scan is the expensive half of the menu; it starts the first
     time a `/` is typed, never on mount, and never repeats per keystroke. The
     full library is only read when the Skills page asks for it. */
  if (draft.value.startsWith('/') && !libraryAsked) {
    libraryAsked = true
    if (workspaces.library) return
    if (workspaces.skillNames) {
      if (!workspaces.skillNames.error) return
    }
    scanNames()
  }
}

/* both scans are async: when either lands, fill in the draft on screen */
watch(
  () => [workspaces.library, workspaces.skillNames],
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
        ? Math.min(shown.value.length - 1, active.value + 1)
        : Math.max(0, active.value - 1)
  } else if (e.key === 'Tab') {
    e.preventDefault()
    pick(shown.value[active.value])
  } else if (e.key === 'Enter') {
    const item = shown.value[active.value]
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

function focus() {
  nextTick(() => input.value?.focus())
}

defineExpose({ focus })
</script>

<template>
  <div class="slash-compose">
    <div class="ask-cmdbox" :data-open="open ? '1' : '0'" role="listbox" aria-label="Slash commands">
      <div v-if="scanning" class="ask-cmd-loading" role="status">
        <span class="model-spin" aria-hidden="true"></span>
        Scanning skill libraries…
      </div>
      <button
        v-for="(c, i) in shown"
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
      <button
        v-if="menu.length > 5"
        class="ask-cmd-more"
        type="button"
        @mousedown.prevent
        @click="toggleExpanded"
      >
        {{ expanded ? 'Show top 5 results' : `Show all ${menu.length} results` }}
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
        :title="focusShortcut ? `Message (${focusShortcut} to focus)` : 'Message'"
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
          data-sfx="off"
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
