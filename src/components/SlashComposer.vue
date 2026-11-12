<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { slashMenu } from '@/stores/hub'
import { loadSkillNames, workspaces } from '@/stores/workspaces'

/**
 * The composer, with the `/` menu above it. The menu is a skill picker: the
 * workspace's skills as `/workspace:<name>`, every harness library as
 * `/<harness>:<name>`, and a bare `/` finds a name when exactly one library has
 * it. Picking one inserts the reference; the backend turns it into a path on the
 * machine this thread is pinned to.
 */
const props = defineProps({
  agent: { type: Object, required: true },
  placeholder: { type: String, default: 'Ask anything, or type / for a skill' },
  /* the thread's machine: only this machine's skill libraries can be read */
  machine: { type: String, default: 'local' },
  /* a thread answers one turn at a time; the composer waits for it */
  disabled: { type: Boolean, default: false },
  sending: { type: Boolean, default: false },
  stopping: { type: Boolean, default: false },
  focusShortcut: { type: String, default: '' },
})
const emit = defineEmits(['send', 'stop'])

const draft = ref('')
const menu = ref([])
const active = ref(0)
const input = ref(null)
const scanning = ref(false)
const expanded = ref(false)
const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
const sendShortcut = isMac ? '⌘↵' : 'Ctrl+↵'
/* one library read per machine per composer mount, even if the scan fails */
const requested = new Set()

const open = computed(() => menu.value.length > 0)
const shown = computed(() => (expanded.value ? menu.value : menu.value.slice(0, 5)))
const machineInfo = computed(() => workspaces.skillNamesByMachine[props.machine] || null)

/* The menu is the only feedback the composer has, so an empty list still needs
   one line: a machine whose libraries cannot be read, a failed scan, or a
   machine that simply has no skills. */
const note = computed(() => {
  if (props.disabled) return ''
  if (!draft.value.startsWith('/') || menu.value.length) return ''
  const info = machineInfo.value
  if (!info) return ''
  if (info.note) return info.note
  if (info.error) return info.error
  if (!info.items?.length) {
    return 'No skills on this machine yet — attach one in Workspace → Skills.'
  }
  return ''
})
const boxOpen = computed(() => open.value || Boolean(note.value) || scanning.value)

function toggleExpanded() {
  expanded.value = !expanded.value
  active.value = 0
}

async function scanNames() {
  const cached = workspaces.skillNamesByMachine[props.machine]
  if (cached && !cached.error) return
  scanning.value = true
  try {
    await loadSkillNames({ machine: props.machine, force: Boolean(cached?.error) })
  } finally {
    scanning.value = false
  }
}

function refresh() {
  if (props.disabled) return
  expanded.value = false
  menu.value = slashMenu(draft.value, props.agent, props.machine)
  if (active.value > menu.value.length - 1) active.value = 0
  /* The names-only scan is the expensive half of the menu; it starts the first
     time a `/` is typed for a machine, never on mount, and never repeats per
     keystroke. The full library is only read when the Skills page asks for it. */
  if (draft.value.startsWith('/') && !requested.has(props.machine)) {
    requested.add(props.machine)
    const cached = workspaces.skillNamesByMachine[props.machine]
    if (cached && !cached.error) return
    scanNames()
  }
}

/* the scan is async: when it lands, fill in the draft on screen */
watch(
  () => [workspaces.skillNamesByMachine[props.machine], props.machine],
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
  const el = input.value
  const text = draft.value
  const caret = typeof el?.selectionStart === 'number' ? el.selectionStart : text.length
  /* replace the partial token under the caret instead of appending, so a
     reference picked mid-draft lands where it was being typed */
  const before = text.slice(0, caret)
  const partial = before.match(/(^|\s)\/[^\s]*$/)
  const start = partial ? before.length - partial[0].trimStart().length : caret
  const next = `${text.slice(0, start)}${cmd.name} ${text.slice(caret)}`
  draft.value = next
  closeMenu()
  nextTick(() => {
    const at = start + cmd.name.length + 1
    el?.focus()
    try {
      el?.setSelectionRange(at, at)
    } catch {
      /* a detached input; the draft is still correct */
    }
    grow()
  })
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
    <div
      class="ask-cmdbox"
      :data-open="boxOpen ? '1' : '0'"
      :role="open ? 'listbox' : null"
      aria-label="Skills"
    >
      <div v-if="scanning" class="ask-cmd-loading" role="status">
        <span class="model-spin" aria-hidden="true"></span>
        Scanning skill libraries…
      </div>
      <p v-if="note" class="ask-cmd-note" role="status">{{ note }}</p>
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
        <span class="k">{{ c.kind }}</span>
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
        <span class="slash-hint">
          <template v-if="sending">Working…</template>
          <template v-else><kbd>{{ sendShortcut }}</kbd> to send</template>
        </span>
        <button
          v-if="sending"
          class="go go-stop"
          type="button"
          data-sfx="off"
          :disabled="stopping"
          :title="stopping ? 'Stopping…' : 'Stop agent'"
          :aria-label="stopping ? 'Stopping agent' : 'Stop agent'"
          @click="emit('stop')"
        >
          <span v-if="stopping" class="model-spin" aria-hidden="true"></span>
          <svg v-else viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.2" />
          </svg>
        </button>
        <button
          v-else
          class="go"
          type="submit"
          data-sfx="off"
          :disabled="disabled || !draft.trim()"
          :title="`Send message (${sendShortcut})`"
          aria-label="Send message"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M8 13V3M4 7l4-4 4 4" />
          </svg>
        </button>
      </div>
    </form>
  </div>
</template>
