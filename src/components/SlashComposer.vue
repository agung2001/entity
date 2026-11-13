<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { call } from '@/composables/localBridge'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import { hub, slashMenu } from '@/stores/hub'
import { loadSkillNames, workspaces } from '@/stores/workspaces'

/**
 * The composer, with one menu above it for two triggers.
 *
 *   `/`  a skill: `/workspace:<name>`, `/<harness>:<name>`, or a bare `/<name>`
 *   `@`  a mention: an entity (that entity runs the job), an Orca project file,
 *        an artifact, a Maka note, a YouTrack issue
 *
 * Picking inserts text and nothing else. Resolution happens in the backend when
 * the message is sent, so typing never starts a process or a network call.
 */
const props = defineProps({
  agent: { type: Object, required: true },
  placeholder: { type: String, default: 'Ask anything — / for a skill, @ to mention' },
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
const sendShortcut = shortcutLabel('send')
/* one library read per machine per composer mount, even if the scan fails */
const requested = new Set()

const open = computed(() => menu.value.length > 0)
const menuMode = ref('slash')
const mentionSources = ref(null)
let mentionAsked = false

/* The four typed mentions. A bare `@name` is an entity, so entities are listed
   from the workspace rather than from this table. */
const MENTION_KINDS = [
  { name: '@orca:', desc: 'A path from an Orca project — project:file' },
  { name: '@artifact:', desc: 'A file on this workspace’s artifact shelf' },
  { name: '@maka:', desc: 'A note in a Maka vault — vault:query' },
  { name: '@youtrack:', desc: 'An issue — project:query' },
]

/** `@` right before the caret, with the partial word typed after it. */
function mentionTrigger() {
  const before = draft.value.slice(0, typeof input.value?.selectionStart === 'number' ? input.value.selectionStart : draft.value.length)
  const match = before.match(/(^|[\s(\[])@([A-Za-z0-9._-]*)$/)
  return match ? { start: before.length - match[2].length - 1, query: match[2] } : null
}

function mentionMenu(query) {
  const q = String(query || '').toLowerCase()
  const items = []
  for (const kind of MENTION_KINDS) {
    if (kind.name.slice(1).toLowerCase().includes(q)) items.push({ ...kind, kind: 'mention' })
  }
  for (const agent of hub.agents || []) {
    if (!String(agent.name || '').toLowerCase().includes(q)) continue
    items.push({
      name: `@${agent.name}`,
      desc: `Entity · ${agent.harnessLabel || agent.harness || 'harness'}`,
      kind: 'entity',
    })
  }
  for (const project of mentionSources.value?.orca || []) {
    if (!String(project.name || '').toLowerCase().includes(q)) continue
    items.push({ name: `@orca:${project.name}`, desc: `Orca · ${project.path}`, kind: 'orca' })
  }
  return items.slice(0, 8)
}

/** One RPC per composer mount, only once an `@` is actually typed. */
async function loadMentionSources() {
  if (mentionAsked) return
  mentionAsked = true
  try {
    mentionSources.value = await call('mention.sources')
  } catch {
    mentionSources.value = { orca: [] }
  }
}

/* ── live results while a typed mention is being written ──────────── */

const KIND_NAMES = new Set(MENTION_KINDS.map((kind) => kind.name.slice(1, -1)))
const PAGE = 10
const searching = ref(false)
const loadingMore = ref(false)
const searchState = ref({ key: '', more: false, error: '' })
/* how many rows the menu paints; "Show more" either appends a fetched page or
   raises this, depending on whether the source has more to give */
const visible = ref(PAGE)
let searchTimer = null
let searchSeq = 0
let searchKind = ''
let searchFields = []

/** `@kind:fields` under the caret, still on one word — the live-search trigger. */
function typedMention() {
  const caret =
    typeof input.value?.selectionStart === 'number'
      ? input.value.selectionStart
      : draft.value.length
  const before = draft.value.slice(0, caret)
  const match = before.match(/(^|[\s(\[])@([A-Za-z0-9._-]+):([^\s]*)$/)
  if (!match) return null
  const kind = match[2].toLowerCase()
  if (!KIND_NAMES.has(kind)) return null
  return { kind, fields: match[3] === '' ? [''] : match[3].split(':') }
}

function toMenuItems(items) {
  return (items || []).map((item) => ({
    name: item.insert,
    desc: item.label,
    title: item.detail || '',
    kind: 'result',
  }))
}

function stopSearch() {
  clearTimeout(searchTimer)
  searchTimer = null
  searching.value = false
  loadingMore.value = false
  searchSeq += 1
  searchState.value = { key: '', more: false, error: '' }
}

/* Debounced, and stale answers are dropped: typing fast must never paint the
   results of a query two keystrokes ago. */
function scheduleSearch(kind, fields) {
  const key = `${kind}:${fields.join(':')}`
  searchKind = kind
  searchFields = fields
  if (searchState.value.key === key) return

  clearTimeout(searchTimer)
  const seq = ++searchSeq
  searching.value = true
  visible.value = PAGE
  searchTimer = setTimeout(async () => {
    try {
      const data = await call('mention.search', {
        workspace: hub.workspace,
        kind,
        fields,
        limit: PAGE,
        offset: 0,
      })
      if (seq !== searchSeq) return
      searchState.value = { key, more: Boolean(data?.more), error: '' }
      menu.value = toMenuItems(data?.items)
    } catch (error) {
      if (seq !== searchSeq) return
      searchState.value = { key, more: false, error: String(error?.message || error) }
      menu.value = []
    } finally {
      if (seq === searchSeq) searching.value = false
    }
  }, 180)
}

/** Fetch the next page from the source, or reveal rows already in hand. */
async function loadMore() {
  if (loadingMore.value || searching.value) return
  if (menuMode.value === 'mention-search' && searchState.value.more) {
    loadingMore.value = true
    const seq = searchSeq
    try {
      const data = await call('mention.search', {
        workspace: hub.workspace,
        kind: searchKind,
        fields: searchFields,
        limit: PAGE,
        offset: menu.value.length,
      })
      if (seq !== searchSeq) return
      menu.value = [...menu.value, ...toMenuItems(data?.items)]
      searchState.value = { ...searchState.value, more: Boolean(data?.more) }
      visible.value = menu.value.length
    } catch (error) {
      if (seq === searchSeq) searchState.value = { ...searchState.value, error: String(error?.message || error), more: false }
    } finally {
      if (seq === searchSeq) loadingMore.value = false
    }
    return
  }
  visible.value += PAGE
}
const shown = computed(() => menu.value.slice(0, visible.value))
const hasMore = computed(
  () =>
    menu.value.length > visible.value ||
    (menuMode.value === 'mention-search' && searchState.value.more),
)
const machineInfo = computed(() => workspaces.skillNamesByMachine[props.machine] || null)

/* The menu is the only feedback the composer has, so an empty list still needs
   one line: a machine whose libraries cannot be read, a failed scan, or a
   machine that simply has no skills. */
const note = computed(() => {
  if (props.disabled) return ''
  if (menu.value.length || searching.value) return ''
  if (menuMode.value === 'mention-search') {
    return searchState.value.error || 'No match yet — keep typing, or Esc and send it as written.'
  }
  if (!draft.value.startsWith('/')) return ''
  const info = machineInfo.value
  if (!info) return ''
  if (info.note) return info.note
  if (info.error) return info.error
  if (!info.items?.length) {
    return 'No skills on this machine yet — attach one in Workspace → Skills.'
  }
  return ''
})
const boxOpen = computed(() => open.value || Boolean(note.value) || scanning.value || searching.value)

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

  const typed = typedMention()
  if (typed) {
    menuMode.value = 'mention-search'
    scheduleSearch(typed.kind, typed.fields)
    if (active.value > menu.value.length - 1) active.value = 0
    return
  }
  stopSearch()

  const at = mentionTrigger()
  if (at) {
    menuMode.value = 'mention'
    menu.value = mentionMenu(at.query)
    if (active.value > menu.value.length - 1) active.value = 0
    loadMentionSources()
    return
  }

  menuMode.value = 'slash'
  visible.value = PAGE
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
  const partial = before.match(/(^|\s)[/@][^\s]*$/) || before.match(/(^|\s)@$/)
  const start = partial ? before.length - partial[0].trimStart().length : caret
  const insert = cmd.name.endsWith(':') ? cmd.name : `${cmd.name} `
  const next = `${text.slice(0, start)}${insert}${text.slice(caret)}`
  draft.value = next
  closeMenu()
  nextTick(() => {
    const at = start + insert.length
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
  if (matchesShortcut('send', e)) {
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
    stopSearch()
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
      :aria-label="menuMode === 'mention' ? 'Mentions' : 'Skills'"
    >
      <div v-if="scanning || searching" class="ask-cmd-loading" role="status">
        <span class="model-spin" aria-hidden="true"></span>
        {{ searching ? 'Searching…' : 'Scanning skill libraries…' }}
      </div>
      <p v-if="note" class="ask-cmd-note" role="status">{{ note }}</p>
      <button
        v-for="(c, i) in shown"
        :key="c.name"
        class="ask-cmd"
        type="button"
        role="option"
        :title="c.title || undefined"
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
        v-if="hasMore"
        class="ask-cmd-more"
        type="button"
        :disabled="loadingMore"
        @mousedown.prevent
        @click="loadMore"
      >
        {{ loadingMore ? 'Loading…' : `Show ${PAGE} more` }}
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
