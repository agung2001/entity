<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { call } from '@/composables/localBridge'
import { useDialogDismiss } from '@/composables/useDialog'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import { hub, slashMenu } from '@/stores/hub'
import { loadRemoteSkills, loadSkillNames, workspaces } from '@/stores/workspaces'

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
  attachments: { type: Array, default: () => [] },
})
const emit = defineEmits(['send', 'stop', 'update:attachments'])

const draft = ref('')
const menu = ref([])
const active = ref(0)
const input = ref(null)
const fileInput = ref(null)
const folderInput = ref(null)
const attachMenu = ref(false)
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
const MENTION_KINDS = computed(() => [
  { name: '@file:', desc: 'A local file for this turn only', kind: 'attachment-file' },
  ...(props.machine === 'local'
    ? [{ name: '@mcp:', desc: 'A workspace MCP server for this turn', kind: 'attachment-mcp' }]
    : []),
  { name: '@orca:', desc: 'A path from an Orca project — project:file' },
  { name: '@artifact:', desc: 'A file on this workspace’s artifact shelf' },
  { name: '@maka:', desc: 'A note in a Maka vault — vault:query' },
  { name: '@youtrack:', desc: 'An issue — project:query' },
])

/** `@` right before the caret, with the partial word typed after it. */
function mentionTrigger() {
  const before = draft.value.slice(0, typeof input.value?.selectionStart === 'number' ? input.value.selectionStart : draft.value.length)
  const match = before.match(/(^|[\s(\[])@([A-Za-z0-9._-]*)$/)
  return match ? { start: before.length - match[2].length - 1, query: match[2] } : null
}

function mentionMenu(query) {
  const q = String(query || '').toLowerCase()
  const items = []
  for (const kind of MENTION_KINDS.value) {
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

const KIND_NAMES = computed(() => new Set(MENTION_KINDS.value.map((kind) => kind.name.slice(1, -1))))
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
  if (!KIND_NAMES.value.has(kind)) return null
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

  if (kind === 'file') {
    menu.value = []
    searchState.value = { key, more: false, error: '' }
    searching.value = false
    return
  }
  if (kind === 'mcp') {
    const needle = fields.join(':').toLowerCase()
    const names = (workspaces.mcp?.names || []).filter((name) =>
      String(name).toLowerCase().includes(needle),
    )
    menu.value = names.map((name) => ({
      name: `@mcp:${name} `,
      desc: 'Workspace MCP server · this turn only',
      kind: 'result',
    }))
    searchState.value = { key, more: false, error: '' }
    searching.value = false
    return
  }

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
/* A single slash follows the thread's machine; a double slash asks for the
   local library explicitly. */
const machineInfo = computed(() => workspaces.skillNamesByMachine.local || null)
const remoteInfo = computed(() => workspaces.remoteSkills[props.machine] || null)

/* The menu is the only feedback the composer has, so an empty list still needs
   one line: a machine whose libraries cannot be read, a failed scan, or a
   machine that simply has no skills. */
const note = computed(() => {
  if (props.disabled) return ''
  if (menu.value.length || searching.value) return ''
  if (menuMode.value === 'mention-search') {
    if (searchKind === 'file') return 'Type a path after @file: — a space finishes it.'
    if (searchKind === 'mcp') return 'No MCP server by that name in this workspace.'
    return searchState.value.error || 'No match yet — keep typing, or Esc and send it as written.'
  }
  if (!draft.value.startsWith('/')) return ''
  const localPrefix = draft.value.startsWith('//')
  if (props.machine !== 'local' && !localPrefix) {
    const remote = remoteInfo.value
    if (!remote) return scanning.value ? `Reading skills on ${props.machine}…` : ''
    if (remote.error) return remote.error
    if (!remote.items?.length) return `No skills installed on ${props.machine}.`
    return ''
  }
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

function addAttachment(entry) {
  const key = `${entry.kind}:${entry.value || entry.name || ''}`
  if (props.attachments.some((item) => `${item.kind}:${item.value || item.name || ''}` === key)) return
  emit('update:attachments', [...props.attachments, entry])
}

function removeAttachment(index) {
  emit('update:attachments', props.attachments.filter((_, at) => at !== index))
}

function attachmentLabel(entry) {
  if (entry.kind === 'mcp') return `MCP · ${entry.name || entry.value}`
  const value = String(entry.value || entry.path || entry.name || '')
  return `File · ${value.split(/[\\/]/).pop() || 'file'}`
}

/** Move complete `@file:` / `@mcp:` tokens below the prompt. */
function harvestAttachments(final = false) {
  const pattern = final
    ? /(^|[\s([])@(file|mcp):(?:"([^"]+)"|([^\s]+))(?=\s|$)/g
    : /(^|[\s([])@(file|mcp):(?:"([^"]+)"|([^\s]+))(?=\s)/g
  const matches = [...String(draft.value || '').matchAll(pattern)]
  if (!matches.length) return false
  let text = draft.value
  const next = [...props.attachments]
  const seen = new Set(next.map((entry) => `${entry.kind}:${entry.value || entry.name || ''}`))
  for (const match of [...matches].reverse()) {
    const value = String(match[3] || match[4] || '').trim()
    if (!value || (match[2] === 'mcp' && props.machine !== 'local')) continue
    const start = match.index + match[1].length
    const end = match.index + match[0].length
    text = `${text.slice(0, start)}${text.slice(end)}`
    const key = `${match[2]}:${value}`
    if (!seen.has(key)) {
      seen.add(key)
      next.push({ kind: match[2], value, name: value })
    }
  }
  draft.value = text.replace(/[ \t]{2,}/g, ' ').trim()
  if (next.length !== props.attachments.length) emit('update:attachments', next)
  return true
}

async function scanNames() {
  const cached = workspaces.skillNamesByMachine.local
  if (cached && !cached.error) return
  scanning.value = true
  try {
    await loadSkillNames({ machine: 'local', force: Boolean(cached?.error) })
  } finally {
    scanning.value = false
  }
}

function refresh() {
  if (props.disabled) return
  harvestAttachments(false)

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
  const localPrefix = draft.value.startsWith('//')
  const remote = props.machine !== 'local' && !localPrefix
  menu.value = slashMenu(
    draft.value,
    props.agent,
    props.machine,
    workspaces.remoteSkills[props.machine]?.items || [],
    localPrefix,
  )
  if (active.value > menu.value.length - 1) active.value = 0
  if (remote) {
    if (!workspaces.remoteSkills[props.machine]) loadRemoteSkills(props.machine).catch(() => {})
    return
  }
  /* The names-only scan is the expensive half of the menu; it starts the first
     time a `/` is typed for a machine, never on mount, and never repeats per
     keystroke. The full library is only read when the Skills page asks for it. */
  if (draft.value.startsWith('/') && !requested.has('local')) {
    requested.add('local')
    const cached = workspaces.skillNamesByMachine.local
    if (cached && !cached.error) return
    scanNames()
  }
}

/* A skill created in another surface (or by the agent during a turn) replaces
   `hub.skills`; an open `/` menu should pick it up without a reload. */
watch(
  () => hub.skills,
  () => {
    if (draft.value.startsWith('/')) refresh()
  },
)

/* the scan is async: when it lands, fill in the draft on screen */
watch(
  () => [workspaces.skillNamesByMachine.local, workspaces.remoteSkills[props.machine], props.machine],
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
  harvestAttachments(true)
  const text = draft.value.trim()
  if (!text && !props.attachments.length) return
  emit('send', text || 'Use the attached resources.')
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
  harvestAttachments(false)
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

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let at = 0; at < bytes.length; at += chunk) {
    binary += String.fromCharCode(...bytes.subarray(at, at + chunk))
  }
  return btoa(binary)
}

async function addFiles(fileList) {
  const files = [...(fileList || [])]
  if (!files.length) return
  for (const file of files) {
    if (file.size > 25 * 1024 * 1024) continue
    let data = ''
    try {
      data = toBase64(await file.arrayBuffer())
    } catch {
      continue
    }
    const name = file.webkitRelativePath || file.name || 'file'
    addAttachment({ kind: 'file', name, data })
  }
}

function entryFile(entry, prefix) {
  return new Promise((resolve) => {
    entry.file(
      (file) => {
        resolve({
          name: prefix ? `${prefix}/${file.name}` : file.name,
          size: file.size,
          arrayBuffer: () => file.arrayBuffer(),
        })
      },
      () => resolve(null),
    )
  })
}

async function readDirectory(entry, prefix, out) {
  const reader = entry.createReader()
  while (out.length < 1000) {
    const batch = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])))
    if (!batch.length) break
    for (const child of batch) {
      if (out.length >= 1000) break
      if (child.isFile) {
        const file = await entryFile(child, prefix)
        if (file) out.push(file)
      } else if (child.isDirectory) {
        await readDirectory(child, prefix ? `${prefix}/${child.name}` : child.name, out)
      }
    }
  }
}

async function addDrop(dataTransfer) {
  const items = [...(dataTransfer?.items || [])]
  const files = []
  for (const item of items) {
    if (files.length >= 1000) break
    const entry = item.webkitGetAsEntry?.()
    if (entry?.isFile) {
      const file = await entryFile(entry, '')
      if (file) files.push(file)
    } else if (entry?.isDirectory) {
      await readDirectory(entry, entry.name, files)
    }
  }
  if (files.length) await addFiles(files)
  else await addFiles(dataTransfer?.files)
}

function onFileInput(event) {
  const files = event.target?.files
  addFiles(files)
  if (event.target) event.target.value = ''
}

function openFiles() {
  attachMenu.value = false
  fileInput.value?.click()
}

function openFolder() {
  attachMenu.value = false
  folderInput.value?.click()
}

function onDocumentClick(event) {
  if (!attachMenu.value) return
  if (!event.target?.closest?.('.attach-picker')) attachMenu.value = false
}

useDialogDismiss({
  active: () => attachMenu.value,
  close: () => (attachMenu.value = false),
})

onMounted(() => document.addEventListener('click', onDocumentClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocumentClick))

function insertToken(token) {
  const space = draft.value && !/\s$/.test(draft.value) ? ' ' : ''
  draft.value = `${draft.value}${space}${token}`
  closeMenu()
  nextTick(() => {
    input.value?.focus()
    grow()
  })
}

function focus() {
  nextTick(() => input.value?.focus())
}

defineExpose({ focus, addFiles, addDrop })
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
        <span class="slash-send">
          <span class="attach-picker">
          <button
            class="attach-btn"
            type="button"
            title="Attach file or folder"
            aria-label="Attach file or folder"
            aria-haspopup="menu"
            :aria-expanded="attachMenu ? 'true' : 'false'"
            :disabled="disabled"
            @click.stop="attachMenu = !attachMenu"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M6.2 8.8l4.6-4.6a2.1 2.1 0 013 3l-5.6 5.6a3.4 3.4 0 01-4.8-4.8l5.2-5.2" />
            </svg>
          </button>
          <span v-if="attachMenu" class="attach-menu" role="menu">
            <button type="button" role="menuitem" @click="openFiles">Attach files…</button>
            <button type="button" role="menuitem" @click="openFolder">Attach folder…</button>
          </span>
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
          :disabled="disabled || (!draft.trim() && !attachments.length)"
          :title="`Send message (${sendShortcut})`"
          aria-label="Send message"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M8 13V3M4 7l4-4 4 4" />
          </svg>
        </button>
        </span>
      </div>
    </form>

    <div v-if="attachments.length" class="attach-chips attach-chips--dock">
      <span
        v-for="(entry, index) in attachments"
        :key="`${entry.kind}:${entry.value || entry.name}`"
        class="attach-chip"
      >
        {{ attachmentLabel(entry) }}
        <button type="button" :aria-label="`Remove ${attachmentLabel(entry)}`" @click="removeAttachment(index)">×</button>
      </span>
    </div>

    <input
      ref="fileInput"
      class="attach-file-input"
      type="file"
      multiple
      @change="onFileInput"
    />
    <input
      ref="folderInput"
      class="attach-file-input"
      type="file"
      webkitdirectory
      directory
      multiple
      @change="onFileInput"
    />
  </div>
</template>

<style scoped>
.slash-send {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
.attach-file-input {
  display: none;
}
.attach-picker {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.attach-menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  z-index: 40;
  min-width: 154px;
  padding: 3px;
  background: var(--bg);
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  box-shadow: 0 10px 24px -10px rgba(10, 10, 10, 0.28);
}
.attach-menu button {
  display: block;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--ink-2);
  font-family: var(--font-body);
  font-size: 11px;
  text-align: left;
  cursor: pointer;
}
.attach-menu button:hover {
  background: var(--surface);
  color: var(--fg);
}
.attach-btn {
  display: inline-grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--surface);
  color: var(--ink-2);
  cursor: pointer;
}
.attach-btn:hover:not(:disabled) {
  color: var(--fg);
  background: var(--surface);
  border-color: var(--border);
}
.attach-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.attach-btn svg {
  width: 14px;
  height: 14px;
}
.attach-chips--dock {
  padding: 6px 2px 0;
}
.attach-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.attach-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 4px 2px 6px;
  font-family: var(--mono);
  font-size: 9.5px;
  color: var(--muted);
}
.attach-chip button {
  border: 0;
  background: transparent;
  color: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
}
</style>
