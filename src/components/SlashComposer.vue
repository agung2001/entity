<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { call } from '@/composables/localBridge'
import { useDialogDismiss } from '@/composables/useDialog'
import IntegrationMark from '@/components/IntegrationMark.vue'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import { hub, slashMenu } from '@/stores/hub'
import { loadRemoteSkills, loadSkillNames, workspaces } from '@/stores/workspaces'

/**
 * The composer, with one menu above it for two triggers.
 *
 *   `/`  a skill: `/workspace:<name>`, `/<harness>:<name>`, or a bare `/<name>`
 *   `@`  a mention: an entity (that entity runs the job), an Orca project file,
 *        an artifact, a Maka note, a YouTrack issue, a GitHub repository
 *
 * Picking inserts text and nothing else. Resolution happens in the backend when
 * the message is sent, so typing never starts a process or a network call.
 */
const props = defineProps({
  agent: { type: Object, required: true },
  placeholder: { type: String, default: 'Ask anything — / for a skill, @ to mention' },
  /* the thread's machine: only this machine's skill libraries can be read */
  machine: { type: String, default: 'local' },
  /* optional working directory: project skills and @file paths start here */
  baseDir: { type: String, default: '' },
  /* a thread answers one turn at a time; the composer waits for it */
  disabled: { type: Boolean, default: false },
  sending: { type: Boolean, default: false },
  stopping: { type: Boolean, default: false },
  focusShortcut: { type: String, default: '' },
  terminalShortcut: { type: String, default: '' },
  attachments: { type: Array, default: () => [] },
  /* The text still sitting in this thread's box. The store owns it, because a
     draft belongs to a thread and this component only exists for the one on
     screen — switching threads would otherwise take the words with it. */
  draft: { type: String, default: '' },
})
const emit = defineEmits(['send', 'stop', 'enhance', 'update:attachments', 'update:draft'])

/* Local while you type (the caret, the menu and the growth all need it now);
   the store is told on every change and answers on every thread switch. */
const draft = ref(String(props.draft || ''))

watch(
  () => props.draft,
  (value) => {
    const next = String(value || '')
    if (next === draft.value) return
    draft.value = next
    /* A different thread's text: the `/` or `@` menu belonged to the box we
       just left, so it must not stay open over the wrong conversation. */
    settle()
    nextTick(grow)
  },
  { immediate: true },
)

watch(draft, (value) => {
  if (String(props.draft || '') === value) return
  emit('update:draft', value)
})
const menu = ref([])
const active = ref(0)
const input = ref(null)
const fileInput = ref(null)
const folderInput = ref(null)
const attachMenu = ref(false)
const scanning = ref(false)
const projectSkills = ref([])
const projectScanned = ref('')
let projectPending = false
const sendShortcut = shortcutLabel('send')
const enhanceShortcut = shortcutLabel('enhance-prompt')
/* a keyboard-only feature is unreachable on touch, so the hint is a button */
const canEnhance = computed(() => Boolean(draft.value.trim()) && !props.sending)
/* one library read per machine per composer mount, even if the scan fails */
const requested = new Set()

const open = computed(() => menu.value.length > 0)
const menuMode = ref('slash')
const mentionSources = ref(null)
let mentionAsked = false

/* The typed mentions. A bare `@name` is an entity, so entities are listed from
   the workspace rather than from this table. A kind whose integration is off in
   Account → Integrations is not offered at all: this list is the `@` menu, which
   is the only place the switch promises to change. Resolving is untouched — a
   token typed out in full still works, because off is an offer, not a refusal. */
const MENTION_KINDS = computed(() => {
  const on = mentionSources.value?.integrations || {}
  const gated = (kind) => on[kind] !== false
  /* The connector catalogue owns the service kinds: it is the same table the
     Connectors page renders, so a mention offered here is a mention that
     resolves. A connector with no shipped resolver contributes no entry — which
     is why a custom connector is not offered as `@id:`. */
  const services = (mentionSources.value?.kinds || [])
    .filter((entry) => gated(entry.id))
    .map((entry) => ({ name: entry.name, desc: entry.desc, kind: 'mention' }))
  return [
    {
      name: '@file:',
      desc: props.baseDir ? 'A file under the base directory' : 'A local file for this turn only',
      kind: 'attachment-file',
    },
    ...(props.machine === 'local'
      ? [
          { name: '@mcp:', desc: 'A workspace MCP server for this turn', kind: 'attachment-mcp' },
          /* A custom connector has no resolver, so there is no query syntax — but
             it can still be attached as context, which is the honest form. */
          { name: '@connector:', desc: 'A custom connector, as context for this turn', kind: 'attachment-connector' },
        ]
      : []),
    ...services,
    { name: '@thread:', desc: 'Another conversation in this workspace' },
  ]
})

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
  /* An Orca project row is an `@orca:` token, so it follows the same switch as
     the row above. `mention.sources` itself is untouched: a project name is a
     read, and the list it answers is the one the Harnesses-style pages show. */
  const projects = mentionSources.value?.integrations?.orca === false ? [] : mentionSources.value?.orca || []
  for (const project of projects) {
    if (!String(project.name || '').toLowerCase().includes(q)) continue
    items.push({ name: `@orca:${project.name}`, desc: `Orca · ${project.path}`, kind: 'orca' })
  }
  return items.slice(0, 8)
}

/** One RPC per composer mount, only once an `@` is actually typed. It is also
    what tells the menu which integrations are on: until it lands nothing gated
    is offered, which is the safe direction — a token must never flash into the
    menu and then vanish. */
async function loadMentionSources() {
  if (mentionAsked) return
  mentionAsked = true
  try {
    mentionSources.value = await call('mention.sources', { workspace: hub.workspace })
  } catch {
    mentionSources.value = { orca: [], integrations: {} }
  }
  /* The first `@` paints before this lands, so the menu is rebuilt once with the
     switches known: a gated kind must not stay offered just because the answer
     was one keystroke late. */
  const at = mentionTrigger()
  if (at && menuMode.value === 'mention') {
    menu.value = mentionMenu(at.query)
    if (active.value > menu.value.length - 1) active.value = 0
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
/* How many colon-separated fields a kind reads as separate values, with the rest
   of the colon run belonging to the last one. `@gmail:all:from:stripe` is two:
   the scope (`all`) and the query (`from:stripe`). Absent = every field separate,
   which is right for `@file:` and `@thread:`. */
const FIELD_GROUPS = { gmail: 2, drive: 2, youtube: 2, x: 2 }
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
  /* The fields are colon-separated, but a mention kind may treat a *run* of them
     as one value: `@gmail:work:from:stripe` is a scope and a Gmail query that
     itself holds a colon. `fieldGroups` says how many leading fields are single
     (`2` = scope, then the rest is one query), so the menu searches
     `from:stripe` instead of `from` and `stripe` separately. */
  const parts = match[3] === '' ? [''] : match[3].split(':')
  const groups = FIELD_GROUPS[kind]
  const fields =
    !groups || parts.length <= groups ? parts : [...parts.slice(0, groups - 1), parts.slice(groups - 1).join(':')]
  return { kind, fields }
}

function toMenuItems(items, kind = '') {
  return (items || []).map((item) => ({
    name: item.insert,
    desc: item.label,
    title: item.detail || '',
    kind: 'result',
    /* Only a **result row** becomes a chip, and only when it names a real object.
       The scope-completion rows (`@drive:avery:`) carry no id: they are a
       step on the way to one, so they insert text like every other prefix. Without
       this check, Tab on a completion row created an empty chip. */
    accountKind: ACCOUNT_KINDS[kind] && item.id ? kind : '',
    id: item.id || '',
    url: item.url || '',
    account: item.account || '',
    detail: item.detail || '',
    /* The row's readable label — a filename, a subject, a video title. `name` is
       the *insert token*, so a chip built from it showed `@drive:…:id:…` instead of
       the file. The label is already in hand from the very query that produced this
       row, so it is cached with the chip and no extra request is made. */
    label: item.label || '',
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

  /* Without a base directory there is nothing to list; the note asks for a
     path. With one, the menu is a real file picker for that folder. */
  if (kind === 'file' && !props.baseDir) {
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
        dir: props.baseDir || '',
      })
      if (seq !== searchSeq) return
      searchState.value = { key, more: Boolean(data?.more), error: '' }
      menu.value = toMenuItems(data?.items, kind)
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
        dir: props.baseDir || '',
      })
      if (seq !== searchSeq) return
      menu.value = [...menu.value, ...toMenuItems(data?.items, searchKind)]
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
    if (searchKind === 'file') {
      if (!props.baseDir) return 'Type a path after @file: — a space finishes it.'
      return `No match under ${props.baseDir} — keep typing or pick one below.`
    }
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

/* The account-bearing connectors: a picked message/file/post is an attachment
   whose `value` is the provider's own id, so the resolver does a direct read and
   the chip can show — and link to — the real thing. */
const ACCOUNT_KINDS = { gmail: 'Gmail', drive: 'Drive', youtube: 'YouTube', x: 'X' }
/* The chip's `kind` is the mention head (`drive`), but the brand mark's slug is the
   connector id (`google-drive`). One map, so a Drive chip wears the Drive mark
   instead of falling through to the generic terminal glyph. */
const ACCOUNT_MARKS = { gmail: 'gmail', drive: 'google-drive', youtube: 'youtube', x: 'x' }
const markOf = (entry) => ACCOUNT_MARKS[String(entry?.kind || '')] || String(entry?.kind || '')

function attachmentLabel(entry) {
  if (AccountKinds(entry)) return `${ACCOUNT_KINDS[entry.kind]} · ${accountName(entry)}`
  if (entry.kind === 'mcp') return `MCP · ${entry.name || entry.value}`
  if (entry.kind === 'connector') return `Connector · ${entry.name || entry.value}`
  const value = String(entry.value || entry.path || entry.name || '')
  return `File · ${value.split(/[\\/]/).pop() || 'file'}`
}

/** Is this chip a picked connector object (message, file, video, post)? */
const AccountKinds = (entry) => Boolean(ACCOUNT_KINDS[String(entry?.kind || '')])

/** What a person calls this object — a filename, a subject, a title. The id is the
 *  identity, never the name; it is shown in the dialog where it belongs. */
const accountName = (entry) =>
  String(entry?.label || entry?.name || entry?.value || '').split(' — ')[0].trim() || String(entry?.value || '')

/* What the dialog shows about a picked object. Everything here was already in hand
   when the row was picked — the label, the account, the detail line and the link
   all came back from the same query — so opening the dialog costs no request. */
const attachmentFacts = computed(() => {
  const entry = attachmentOpen.value
  if (!entry) return []
  const facts = []
  /* The detail line is `<account> · <type> · <date>` from the resolver; the account
     is already in the subtitle, so it is dropped here rather than repeated. */
  const parts = String(entry.detail || '')
    .split(' · ')
    .map((part) => part.trim())
    .filter((part) => part && part !== entry.account)
  if (parts.length === 1) facts.push({ k: 'detail', v: parts[0] })
  else if (parts.length > 1) {
    facts.push({ k: 'type', v: parts[0] })
    facts.push({ k: 'modified', v: parts.slice(1).join(' · ') })
  }
  return facts
})

/* The detail dialog for a picked object. `Esc` is registered with the app's one
   handler, never a local keydown (`DESIGN.md`). */
const attachmentOpen = ref(null)
const openAttachment = (entry) => {
  attachmentOpen.value = entry
}
const closeAttachment = () => {
  attachmentOpen.value = null
}
useDialogDismiss({ active: () => Boolean(attachmentOpen.value), close: closeAttachment })

/** Move complete `@file:` / `@mcp:` / `@connector:` tokens below the prompt. */
function harvestAttachments(final = false) {
  const pattern = final
    ? /(^|[\s([])@(file|mcp|connector):(?:"([^"]+)"|([^\s]+))(?=\s|$)/g
    : /(^|[\s([])@(file|mcp|connector):(?:"([^"]+)"|([^\s]+))(?=\s)/g
  const matches = [...String(draft.value || '').matchAll(pattern)]
  if (!matches.length) return false
  let text = draft.value
  const next = [...props.attachments]
  const seen = new Set(next.map((entry) => `${entry.kind}:${entry.value || entry.name || ''}`))
  for (const match of [...matches].reverse()) {
    const value = String(match[3] || match[4] || '').trim()
    if (!value) continue
    if ((match[2] === 'mcp' || match[2] === 'connector') && props.machine !== 'local') continue
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

/* Project skills live in the base directory, not in this machine's libraries:
   `.claude/skills`, `.agents/skills` and the rest. One scan per directory. */
async function scanProject() {
  if (!props.baseDir || props.machine !== 'local') {
    projectSkills.value = []
    projectScanned.value = ''
    return
  }
  if (projectScanned.value === props.baseDir || projectPending) return
  projectPending = true
  try {
    const data = await call('skills.scanDir', { dir: props.baseDir })
    if (data?.dir === props.baseDir) {
      projectSkills.value = data.items || []
      projectScanned.value = data.dir
    }
  } catch {
    projectSkills.value = []
  } finally {
    projectPending = false
  }
}

watch(
  () => props.baseDir,
  () => {
    projectSkills.value = []
    projectScanned.value = ''
    if (draft.value.startsWith('/')) refresh()
  },
)

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
    projectSkills.value,
  )
  if (active.value > menu.value.length - 1) active.value = 0
  if (draft.value.startsWith('/') && props.baseDir && props.machine === 'local') {
    if (projectScanned.value !== props.baseDir) {
      scanProject().then(() => {
        if (draft.value.startsWith('/')) refresh()
      })
    }
  }
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

/* A pick, a token insert or a send ends the menu outright: the rows, the
   spinner and any note left over from the query that produced them all go, so
   no "No match yet" line can outlive the search it belonged to. */
function settle() {
  closeMenu()
  stopSearch()
  menuMode.value = 'slash'
  searchKind = ''
}

/* A textarea that grows with the draft, then scrolls at a sane ceiling. The
   border belongs to the dock, not to this field, so there is only one box.
   The ceiling is read from CSS (`.slash-input { max-height }`) instead of being
   repeated here: a number written twice drifts, and a draft that stops growing
   at five lines is the bug that produced this comment. */
function grow() {
  const el = input.value
  if (!el) return
  el.style.height = 'auto'
  const ceiling = Number.parseFloat(getComputedStyle(el).maxHeight) || 108
  const next = Math.min(el.scrollHeight, ceiling)
  el.style.height = `${next}px`
  el.style.overflowY = el.scrollHeight > ceiling ? 'auto' : 'hidden'
}

watch(draft, () => nextTick(grow))
/* The ceiling is viewport-relative, so a resized window changes how much room a
   long draft gets. Without this the box keeps the height it had at mount. */
function regrow() {
  nextTick(grow)
}
onMounted(() => {
  nextTick(grow)
  window.addEventListener('resize', regrow)
})
onBeforeUnmount(() => window.removeEventListener('resize', regrow))

function submit() {
  if (props.disabled) return
  harvestAttachments(true)
  const text = draft.value.trim()
  if (!text && !props.attachments.length) return
  emit('send', text || 'Use the attached resources.')
  draft.value = ''
  settle()
  nextTick(() => {
    grow()
    input.value?.focus()
  })
}

function pick(cmd) {
  if (!cmd) return
  /* An account-bearing result is a *thing*, not a search: it becomes a chip whose
     value is the provider id. That keeps the prompt clean, makes the mention one
     direct read instead of a search, and gives the chip a real link to open. */
  if (cmd.accountKind && cmd.id) {
    addAttachment({
      kind: cmd.accountKind,
      /* `value` is the identity the turn reads; `label` is what a person sees. */
      value: cmd.id,
      label: cmd.label || cmd.id,
      detail: cmd.detail || '',
      url: cmd.url || '',
      account: cmd.account || '',
    })
    /* The partial token the person typed is no longer needed: the chip carries it. */
    const el2 = input.value
    const textNow = draft.value
    const caretNow = typeof el2?.selectionStart === 'number' ? el2.selectionStart : textNow.length
    const beforeNow = textNow.slice(0, caretNow)
    const partialNow = beforeNow.match(/(^|\s)[/@][^\s]*$/)
    if (partialNow) {
      const startNow = beforeNow.length - partialNow[0].trimStart().length
      draft.value = `${textNow.slice(0, startNow)}${textNow.slice(caretNow)}`.trim()
    }
    settle()
    nextTick(() => {
      el2?.focus()
      grow()
    })
    return
  }
  const el = input.value
  const text = draft.value
  const caret = typeof el?.selectionStart === 'number' ? el.selectionStart : text.length
  /* replace the partial token under the caret instead of appending, so a
     reference picked mid-draft lands where it was being typed */
  const before = text.slice(0, caret)
  const partial = before.match(/(^|\s)[/@][^\s]*$/) || before.match(/(^|\s)@$/)
  const start = partial ? before.length - partial[0].trimStart().length : caret
  /* A row that ends in `:` is a *prefix* being completed (`@gmail:avery:`),
     so the caret goes right after the colon with no space — otherwise the space
     closes the menu and the person has to retype the token they just picked. */
  const insert = cmd.name.endsWith(':') ? cmd.name : `${cmd.name} `
  const next = `${text.slice(0, start)}${insert}${text.slice(caret)}`
  draft.value = next
  harvestAttachments(false)
  settle()
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
  /* Escape closes the box whatever it holds — rows, the spinner, or only the
     note — so it has to be handled before the rows guard below. */
  if (e.key === 'Escape' && boxOpen.value) {
    e.preventDefault()
    settle()
    return
  }
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
  settle()
  nextTick(() => {
    input.value?.focus()
    grow()
  })
}

function focus() {
  nextTick(() => input.value?.focus())
}

function restore(text) {
  draft.value = String(text || '')
  nextTick(() => {
    grow()
    input.value?.focus()
    const end = draft.value.length
    input.value?.setSelectionRange(end, end)
  })
}

defineExpose({ focus, addFiles, addDrop, restore })
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
        <!-- The badge is what marks a bookmark: the description says the same
             thing for every workspace skill, so the indicator cannot be text. -->
        <span v-if="c.preferred" class="pref" title="This entity starts from this skill">Starts here</span>
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
          <template v-if="terminalShortcut && !sending">
            <span class="slash-hint-sep" aria-hidden="true">·</span>
            <span class="slash-hint-term"><kbd>{{ terminalShortcut }}</kbd> terminal</span>
          </template>
          <button
            v-if="canEnhance"
            class="slash-enh"
            type="button"
            :title="`Enhance this prompt (${enhanceShortcut})`"
            aria-label="Enhance this prompt"
            aria-haspopup="dialog"
            @click="emit('enhance')"
          >
            <kbd>{{ enhanceShortcut }}</kbd> enhance
          </button>
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
        :data-account="AccountKinds(entry) ? '1' : '0'"
      >
        <!-- A picked message/file/post is a link to a detail dialog: the value is
             the provider's id, so the dialog is the only way to see what it is. -->
        <button
          v-if="AccountKinds(entry)"
          class="attach-chip-open"
          type="button"
          :title="`${attachmentLabel(entry)} — view details`"
          :aria-label="`What is ${attachmentLabel(entry)}`"
          @click="openAttachment(entry)"
        >
          <span class="attach-chip-mark" aria-hidden="true">
            <IntegrationMark :name="markOf(entry)" :size="15" />
          </span>
          <span class="attach-chip-name" :title="accountName(entry)">{{ accountName(entry) }}</span>
          <span v-if="entry.account" class="attach-chip-acct">{{ String(entry.account).split('@')[0] }}</span>
        </button>
        <template v-else>{{ attachmentLabel(entry) }}</template>
        <button class="attach-chip-x" type="button" :aria-label="`Remove ${attachmentLabel(entry)}`" @click="removeAttachment(index)">×</button>
      </span>
    </div>

    <Teleport to="body">
      <div v-if="attachmentOpen" class="cxn-scrim" @click.self="closeAttachment">
        <div class="cxn-dialog" role="dialog" aria-labelledby="attach-dialog-h">
          <!-- The object first, in the shape a person knows: its mark, its name, and
               what kind of thing it is. The id is the last row, not the headline. -->
          <div class="attach-detail-head">
            <span class="attach-detail-mark" aria-hidden="true">
              <IntegrationMark :name="markOf(attachmentOpen)" :size="22" />
            </span>
            <div class="attach-detail-id">
              <h2 id="attach-dialog-h">{{ accountName(attachmentOpen) }}</h2>
              <p class="sub">
                {{ ACCOUNT_KINDS[attachmentOpen.kind] }}
                <template v-if="attachmentOpen.account">
                  · {{ attachmentOpen.account }}
                </template>
              </p>
            </div>
          </div>

          <dl v-if="attachmentFacts.length" class="cxn-facts">
            <template v-for="fact in attachmentFacts" :key="fact.k">
              <dt>{{ fact.k }}</dt>
              <dd :title="fact.v">{{ fact.v }}</dd>
            </template>
          </dl>

          <details class="attach-detail-technical">
            <summary>Identifier</summary>
            <p>
              <code class="mono">{{ attachmentOpen.value }}</code>
            </p>
            <p class="acct-note">
              The mention names this one exact object, so the turn reads it directly
              instead of searching for words.
            </p>
          </details>

          <div class="cxn-acts">
            <a
              v-if="attachmentOpen.url"
              class="btn btn-sm btn-primary"
              :href="attachmentOpen.url"
              target="_blank"
              rel="noreferrer noopener"
            >
              Open in {{ ACCOUNT_KINDS[attachmentOpen.kind] }}
            </a>
            <span class="spacer"></span>
            <button class="btn btn-sm" type="button" @click="closeAttachment">Close</button>
          </div>
        </div>
      </div>
    </Teleport>

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
/* the enhancement capsule: dashed, so it reads as "extra" rather than
   another send. A hint row is micro type on both ends, except the button. */
.slash-enh {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: 2px;
  padding: 2px 6px 2px 3px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-xs);
  background: none;
  color: var(--ink-2);
  font-family: var(--mono);
  font-size: var(--fs-micro);
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: border-color 0.14s ease, color 0.14s ease;
}
.slash-enh:hover {
  border-style: solid;
  border-color: var(--muted);
  color: var(--ink);
}
.slash-enh kbd {
  background: var(--bg);
}
@media (max-width: 360px) {
  .slash-hint {
    flex-wrap: wrap;
  }
}
@media (prefers-reduced-motion: reduce) {
  .slash-enh {
    transition: none;
  }
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
/* ── the picked-object dialog ────────────────────────────────────────────
   The object leads: its mark, its name, then what can be said about it. The id is
   folded away, because it is the thing a person only sometimes wants. */
.attach-detail-head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.attach-detail-mark {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: var(--r-sm);
  background: var(--surface-2);
}
.attach-detail-mark svg {
  display: block;
}
.attach-detail-id {
  min-width: 0;
}
.attach-detail-id h2 {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.attach-detail-technical {
  font-size: var(--fs-secondary);
  color: var(--muted);
}
.attach-detail-technical summary {
  cursor: pointer;
  color: var(--ink-2);
}
.attach-detail-technical p {
  margin: 6px 0 0;
  overflow-wrap: anywhere;
}

/* The shelf sits *inside* the composer card, under the textarea, so it reads as
   part of what you are writing rather than a separate strip. */
.attach-chips--dock {
  padding: 0 2px 4px;
  margin-top: -2px;
}
.attach-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
/* A chip is the composer's own furniture: the app's body type at the label size,
   the dock's corner step, and a surface that reads as filled rather than tinted.
   The earlier 9.5px mono in accent-soft was a code-token look pasted onto a
   writing surface — it belonged to the transcript, not to this box. */
.attach-chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  min-height: 22px;
  padding: 0 2px 0 7px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface);
  font-family: var(--font-body);
  font-size: var(--fs-label);
  line-height: 1;
  color: var(--muted);
}
/* A picked connector object is a thing you can inspect, so it wears the ink of
   body copy and an icon slot, not a link underline inside a chip. */
.attach-chip[data-account='1'] {
  color: var(--ink-2);
  background: var(--surface);
  border-color: var(--border);
}
.attach-chip[data-account='1']:hover {
  border-color: var(--border-strong);
  background: var(--bg);
}
.attach-chip-open {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.attach-chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 34ch;
}
/* The account is the thing that tells two same-named files apart, so it is the
   one part allowed to shrink before the name does. */
.attach-chip-mark {
  display: grid;
  place-items: center;
  width: 15px;
  height: 15px;
  flex: none;
}
.attach-chip-mark svg {
  display: block;
  width: 15px;
  height: 15px;
}
.attach-chip-acct {
  font-family: var(--mono);
  font-size: var(--fs-micro);
  color: var(--muted);
  white-space: nowrap;
}
.attach-chip button {
  border: 0;
  background: transparent;
  color: inherit;
  font-size: var(--fs-small);
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
}
/* The remove glyph is the chip's only destructive verb, so it stays quiet until
   the chip is hovered — and it never becomes the thing you click by accident. */
.attach-chip .attach-chip-x {
  color: var(--muted);
  opacity: 0.55;
}
.attach-chip:hover .attach-chip-x,
.attach-chip .attach-chip-x:focus-visible {
  opacity: 1;
}
</style>
