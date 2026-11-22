<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { call } from '@/composables/localBridge'
import { useDialogDismiss } from '@/composables/useDialog'
import { copyText } from '@/lib/clipboard'
import { commandLine, definitionOf, transportOf } from '@/lib/mcp'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import { hub, toast } from '@/stores/hub'
import { readPaste } from '@/lib/mcp-paste'
import { setMcpEnabled, workspaces, writeMcp } from '@/stores/workspaces'

/**
 * One MCP server, as a page — the same shell as the entity detail page
 * (`entp-*` is the shared detail layout, not an entity-only style).
 *
 * One column answers what the server can do (`Tools`); the rail answers what it
 * is and where it lives — each fact is a way in, and every other server on this
 * machine is a link out. There is no `Environment` section: an MCP server is a
 * command or a URL, and Entity does not hand it a `process.env` of its own.
 *
 * Per-entity reach is not drawn here: a server in `mcp.json` is offered to every
 * entity, and an `mcp:` line is an override an entity's author typed, not
 * something this page hands out.
 */
const route = useRoute()
const router = useRouter()

const name = computed(() => String(route.params.name || ''))
const poolServers = computed(() => workspaces.mcp?.servers || {})
const poolDisabled = computed(() => workspaces.mcp?.disabled || {})

/* This server's shipped mention contract, if the catalog knows it. The roster and
   this page render the same block from the same table, so they cannot disagree. */
const work = ref(null)
const inPool = computed(
  () => Boolean(poolServers.value[name.value]) || Boolean(poolDisabled.value[name.value]),
)
const enabled = computed(() => Boolean(poolServers.value[name.value]))
const poolEntry = computed(() => poolServers.value[name.value] || poolDisabled.value[name.value] || null)
/* Set when sync parked it: the definition points at the machine that shared
   it, so enabling it here would offer a server that cannot answer. */
const parkedReason = computed(() =>
  enabled.value ? '' : String(poolDisabled.value[name.value]?.__unavailable || ''),
)

/* Every harness config on this machine, read once per visit. The rail lists
   what this returns and nothing else — a path or a label is never guessed. */
const globalGroups = ref([])
const globalLoading = ref(false)
/* The first harness copy of this name: the definition `Attach` copies in, and
   what a server the workspace does not own is drawn from. */
const globalRow = ref(null)

const definition = computed(() => poolEntry.value || globalRow.value?.definition || null)
const transport = computed(() => (definition.value ? transportOf(definition.value) : 'unknown'))
const command = computed(() => (definition.value ? commandLine(definition.value) : ''))

const tools = ref({ loading: false, error: '', list: [], readAt: '' })
/* `readAt` is the server's own answer to "when", so a chip can say
   `probed 2 min ago` from the same read that produced its tool list. */
const query = ref('')
const searchEl = ref(null)
const kind = ref('all')
const searchKey = shortcutLabel('inventory-search')
/* ── reading a paste ─────────────────────────────────────────────────
 * The reader itself lives in `src/lib/mcp-paste.js`: pure, no Electron and no
 * DOM, so the connector add sheet reads a paste with the same code the wizard
 * does. One parser, two doors. */
/* ── the connect wizard: two steps, one box ─────────────────────────
 * A definition is a shape *and* a credential, and the rail had a field for
 * neither. So the modal asks the only question a non-technical person can
 * answer — paste whatever the docs page gave you — and then reads it. Step one
 * is a message box. Step two writes it, asks the server, and says what came
 * back. Nothing is written until step two runs.
 */
const editing = ref(false)
/** `paste` → `test`. */
const stage = ref('paste')
/** What the person pasted. Never parsed until they press Next. */
const pasted = ref('')
const saving = ref(false)
const confirming = ref(false)
/** The last round trip: `{ at, ok, stale, error, tools }`. */
const receipt = ref(null)
/** What the reader made of the paste: `{ servers, envelope, dropped, error }`. */
const reading = ref(null)
/** The AI pass, when the deterministic reader could not parse the paste. */
const fixing = ref(false)
/** What the model answered: `{ definition, dropped, harness }`, or an error. */
const fixed = ref(null)
/** The exact text the model produced. The watcher below must not treat its own
 *  output as a new paste — it fires after the assignment, so a naive clear
 *  wipes the very banner it was about to show. */
const modelText = ref('')
const fixError = ref('')
/** When this page last wrote. `mcp.tools` caches for minutes, so a probe that
 *  answers with an older `readAt` never saw what we just saved — and saying
 *  `ready` off it is the exact lie this flow exists to avoid. */
const savedAt = ref(0)

/* ── one state per server, derived ───────────────────────────────────
 * The row is a chip, not a JSON blob, and the state is read off three facts
 * this page already has: the park reason the sync wrote, whether a credential
 * in the copy is still the sync's redaction, and what the last probe answered.
 * `parked` outranks `needs a token`: a loopback definition parked here fails
 * for a reason no token can fix, and a chip that says `needs: Authorization`
 * on that row is a lie.
 *
 * The two placeholders are not the same thing. `***` is the *sync's* redaction,
 * written into a definition that travelled, so it is proof the secret never
 * arrived. `•••` is what a *read* returns, and it means a value is stored and
 * will survive a write-back — a working server, and never an amber chip.
 */
const SYNC_REDACTED = '***'
const isSyncedTemplate = (value) => String(value ?? '') === SYNC_REDACTED

/** Every stored credential, so the state can tell a template from a real copy. */
const credentials = computed(() => {
  const found = []
  const copy = definition.value || {}
  for (const field of ['headers', 'env']) {
    const map = copy[field]
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue
    for (const [key, value] of Object.entries(map)) {
      found.push({ field, key, value: String(value ?? '') })
    }
  }
  return found
})

/** A credential arrived as `***`: the shape synced, the secret did not. */
const templateCopy = computed(() => credentials.value.some((entry) => isSyncedTemplate(entry.value)))

/** The header that carries a credential, if the definition names one. */
const TOKEN_HEADER = /^(authorization|proxy-authorization|api[-_]?key|x-api[-_]?key|x-auth[-_]?token|token|access[-_]?token|bearer)$/i
const tokenKey = computed(
  () =>
    credentials.value.find((entry) => entry.field === 'headers' && TOKEN_HEADER.test(entry.key))?.key || '',
)
/** Still the sync's redaction: the shape arrived and the secret did not. */
const tokenMissing = computed(() => Boolean(tokenKey.value) && templateCopy.value)

/**
 * Did this verdict come from before the write?
 *
 * `mcp.tools` caches a successful `tools/list` per workspace + name for five
 * minutes and the call table has no `force`, so the probe after a save can hand
 * back the answer from *before* it — and calling that `connected` is the lie
 * this whole flow exists to prevent. A cached `readAt` older than our write is
 * not evidence about the definition we just saved, so the step says `not
 * re-asked`.
 *
 * A failure is never stale: `mcp-tools` only remembers successes, so an error
 * means the server really was asked and really refused.
 */
function probeIsStale() {
  if (tools.value.error) return false
  const readAt = Date.parse(String(tools.value.readAt || ''))
  if (!savedAt.value) return false
  if (!readAt) return true
  return readAt < savedAt.value - 1000
}

const probeStatus = computed(() => {
  const message = String(tools.value.error || '')
  const match = message.match(/\b(\d{3})\b/)
  return match ? match[1] : message ? 'error' : ''
})

/** "just now" / "2 min ago" — a chip that says `ready` from an old read is a small lie. */
function agoLabel(iso) {
  const at = Date.parse(String(iso || ''))
  if (!at) return 'not probed'
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 45) return 'probed just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `probed ${minutes} min ago`
  return `probed ${Math.round(minutes / 60)} h ago`
}

const probedLabel = computed(() => {
  if (tools.value.loading) return 'asking…'
  if (tools.value.error) return 'the last probe failed'
  return agoLabel(tools.value.readAt)
})

const state = computed(() => {
  if (!inPool.value) {
    return globalRow.value
      ? {
          id: 'attachable',
          label: 'not attached',
          note: `${globalRow.value.harnessLabel} declares it`,
          tone: 'mute',
          why: `This machine's ${globalRow.value.harnessLabel} config declares this server, but this workspace has not attached it. Attaching copies that definition in verbatim; tokens differ.`,
        }
      : {
          id: 'missing',
          label: 'not attached',
          note: 'no definition',
          tone: 'mute',
          why: 'No harness on this machine declares this server and this workspace has not attached it.',
        }
  }
  if (parkedReason.value) {
    return {
      id: 'parked',
      label: 'parked',
      note: 'other machine',
      tone: 'mute',
      why: `Parked because ${parkedReason.value}. Enable it only if this machine really does run it — the pin then keeps the next sync from parking it again, and no token can fix it.`,
    }
  }
  if (!enabled.value) {
    return {
      id: 'parked',
      label: 'parked',
      note: 'by you',
      tone: 'mute',
      why: 'Parked keeps the definition and takes it out of every turn.',
    }
  }
  if (tools.value.loading) {
    return { id: 'probing', label: 'asking…', note: '', tone: 'mute', why: '' }
  }
  if (templateCopy.value && !tools.value.list.length) {
    return {
      id: 'needs-token',
      label: 'needs a token',
      note: tools.value.error ? probeStatus.value : 'template',
      tone: 'warn',
      why: `A credential in this copy is ${SYNC_REDACTED}: the definition synced from another machine with the secret replaced, so the shape arrived and the value did not. ${
        tools.value.error ? `The server said: ${tools.value.error}` : 'Paste the token once, below, and the row turns ready.'
      }`,
    }
  }
  if (tools.value.error) {
    return {
      id: 'not-answering',
      label: 'not answering',
      note: probeStatus.value,
      tone: 'bad',
      why: tools.value.error,
    }
  }
  if (tools.value.list.length) {
    return {
      id: 'ready',
      label: 'ready',
      note: `${tools.value.list.length} tools`,
      tone: 'ok',
      why: '',
    }
  }
  return {
    id: 'no-tools',
    label: 'ready',
    note: 'no tools',
    tone: 'mute',
    why: 'The server answered but reported no tools. A server that needs a token before it lists them looks exactly like this.',
  }
})

/* One sibling probe, then stop: a 404 at `/mcp` very often means `/sse`. It is
   offered as a button and never run automatically — a probe never loops. */
const sibling = computed(() => {
  if (probeStatus.value !== '404') return null
  const url = String(definition.value?.url || '')
  if (/\/mcp\/?$/.test(url)) return { label: '/sse', url: url.replace(/\/mcp(\/?)$/, '/sse$1') }
  if (/\/sse\/?$/.test(url)) return { label: '/mcp', url: url.replace(/\/sse(\/?)$/, '/mcp$1') }
  return null
})

/* One save, one probe, and the steps stay on screen. The probe reads the stored
   definition, so "test an unsaved draft" is not a reachable state. */
const steps = ref([])

/**
 * `write` means this call can change something over there.
 *
 * ponytail: it is read off the verb the tool name leads with — the page has no
 * other signal. When a server sends `annotations.readOnlyHint` (MCP) or
 * `x-mcp-group`, read those instead and delete both derivations below.
 */
const WRITE_VERBS = new Set([
  'add', 'assign', 'attach', 'change', 'close', 'create', 'delete', 'detach', 'edit', 'link',
  'log', 'manage', 'merge', 'move', 'patch', 'post', 'publish', 'put', 'remove', 'rename',
  'replace', 'run', 'set', 'submit', 'update', 'write',
])

/* `issues` → `issue`, so a name that says `get_issue` and one that says
   `search_issues` count as the same group. ponytail: this is spelling, not
   grammar — `statuses` → `statuse`. Real group metadata replaces it. */
const singular = (word) =>
  word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word

/** The name as words, camelCase included, leading verb first. */
function wordsOf(toolName) {
  return String(toolName || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/**
 * One row per tool, from what the server reported and nothing else.
 *
 * The group tag is the server's own vocabulary, derived: the first noun after
 * the leading verb that more than one tool name in this list also carries, or
 * the verb itself when nothing is shared.
 */
const toolRows = computed(() => {
  const list = tools.value.list || []
  const words = list.map((tool) => wordsOf(tool.name))
  const shared = new Map()
  for (const tokens of words) {
    for (const noun of new Set(tokens.slice(1).map(singular))) {
      shared.set(noun, (shared.get(noun) || 0) + 1)
    }
  }
  return list.map((tool, index) => {
    const tokens = words[index]
    const noun = tokens.slice(1).map(singular).find((word) => (shared.get(word) || 0) > 1)
    return {
      name: tool.name,
      about: String(tool.description || ''),
      index: String(index + 1).padStart(2, '0'),
      group: noun || tokens[0] || '',
      write: WRITE_VERBS.has(tokens[0] || ''),
    }
  })
})

const counts = computed(() => {
  const write = toolRows.value.filter((row) => row.write).length
  return { all: toolRows.value.length, write, read: toolRows.value.length - write }
})

/** Name and description: what a person remembers about a tool is one or the other. */
const searchedTools = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return toolRows.value
  return toolRows.value.filter((row) => `${row.name} ${row.about}`.toLowerCase().includes(needle))
})

/* The filters count what the search left, so each label is the number of rows
   that clicking it shows; the section head keeps the server's own totals. */
const kindFilters = computed(() => {
  const write = searchedTools.value.filter((row) => row.write).length
  return [
    { id: 'all', label: 'All', count: searchedTools.value.length },
    { id: 'read', label: 'Read', count: searchedTools.value.length - write },
    { id: 'write', label: 'Write', count: write },
  ]
})

const visibleTools = computed(() =>
  kind.value === 'all'
    ? searchedTools.value
    : searchedTools.value.filter((row) => (row.write ? 'write' : 'read') === kind.value),
)

const toolsHead = computed(() => {
  if (tools.value.loading) return 'asking…'
  const { all, read, write } = counts.value
  if (!all) return 'none reported'
  return `${all} from the server · ${read} read · ${write} write`
})

/* Why the section has no rows — silence used to be the answer, and it reads
   exactly like a server that exposes nothing. */
const toolsNote = computed(() => {
  if (tools.value.loading || tools.value.error || toolRows.value.length) return ''
  if (!definition.value) {
    return globalLoading.value
      ? 'Still looking for a definition of this server on this machine.'
      : 'No definition to read: no harness here declares this server, so there is nothing to ask for a tool list.'
  }
  return 'This server reported no tools. An HTTP server that needs a token will answer empty when the token is missing.'
})

const noMatchNote = computed(() =>
  query.value.trim()
    ? 'No tool matches that. The list is whatever the server reported — refresh to re-ask it.'
    : `This server has no ${kind.value} tools.`,
)

/**
 * Where this name lives, and what else lives beside it.
 *
 * The rail is a directory, not a count: every other MCP server this machine
 * knows is a link to its own page, grouped by the file that declares it, so
 * this page can be navigated *through* instead of always via the inventory.
 * Nothing here is invented — the pool names come from `workspaces.mcp`, the
 * harness names from `mcp.globals`, and only a name that came back is listed.
 */
const here = computed(() => {
  const rows = []
  if (inPool.value) {
    rows.push({ id: 'workspace', label: 'this workspace', path: workspaces.mcp?.path || 'mcp.json' })
  }
  for (const group of globalGroups.value) {
    if (!(group.servers || []).some((server) => server.name === name.value)) continue
    rows.push({ id: group.harness, label: group.label, path: group.files?.[0]?.path || '' })
  }
  return rows
})

async function loadGlobal() {
  globalLoading.value = true
  try {
    const data = await call('mcp.globals')
    globalGroups.value = data?.groups || []
    globalRow.value = null
    for (const group of globalGroups.value) {
      const hit = (group.servers || []).find((server) => server.name === name.value)
      if (!hit) continue
      globalRow.value = { ...hit, harnessLabel: group.label, definition: definitionOf(hit) }
      break
    }
  } catch {
    /* A read that failed draws no places: never guess a path. */
    globalGroups.value = []
    globalRow.value = null
  } finally {
    globalLoading.value = false
  }
}

async function loadTools(force = false) {
  if (!definition.value) {
    tools.value = { loading: false, error: '', list: [], readAt: '' }
    return
  }
  tools.value = {
    loading: true,
    error: '',
    readAt: tools.value.readAt || '',
    list: force ? [] : tools.value.list,
  }
  try {
    const data = await call('mcp.tools', { workspace: hub.workspace, name: name.value })
    tools.value = {
      loading: false,
      error: '',
      readAt: data?.readAt || new Date().toISOString(),
      list: data?.tools || [],
    }
  } catch (error) {
    tools.value = {
      loading: false,
      error: error?.message || 'The server did not answer.',
      readAt: tools.value.readAt || '',
      list: [],
    }
  }
}

function focusSearch() {
  const field = searchEl.value
  if (!(field instanceof HTMLInputElement)) return
  field.focus()
  field.select()
}

/* The catalog's list-search combo focuses the tool search — but only when the
   caret is not already in a field, so typing a path or a command still types. */
function onKey(event) {
  if (!matchesShortcut('inventory-search', event)) return
  event.preventDefault()
  focusSearch()
}

/* The definition as stored, `__*` bookkeeping included: `__pinned` and
 * `__unavailable` are what keeps a parked row explainable, so a save must
 * write them back or editing a synced template would silently unpark it. */
function cleanCopy() {
  return JSON.parse(JSON.stringify(definition.value || {}))
}

/* The stored definition, as text, is what the box opens on: "connect" and
   "change" are the same box, and seeing what is there now — remote and all —
   is how a person knows what they are about to replace. A paste overwrites it. */
const storedText = computed(() => {
  if (!definition.value) return ''
  const copy = {}
  for (const key of ['url', 'command', 'args', 'headers', 'env', 'type']) {
    if (definition.value[key] !== undefined) copy[key] = definition.value[key]
  }
  /* Values arrive masked (`•••` from a read, `***` from a sync) and are written
     back as they came — `preserveSecrets` treats both as "keep what is there",
     so the box never needs a real secret in it to be saved again. */
  return JSON.stringify(copy, null, 2)
})

/** The credential in the definition about to be written, as far as the box says. */
const pendingSecret = computed(() => {
  const definition = reading.value?.servers?.[0]?.definition || {}
  const headers = definition.headers && typeof definition.headers === 'object' ? definition.headers : {}
  const key = Object.keys(headers).find((entry) => TOKEN_HEADER.test(entry)) || ''
  if (!key) return { label: definition.url ? 'none' : 'not needed', tone: 'ok' }
  const value = String(headers[key] ?? '')
  if (value === SYNC_REDACTED) return { label: `${key}: still redacted`, tone: 'warn' }
  if (value) return { label: `${key}: a value`, tone: 'ok' }
  return { label: `${key}: empty`, tone: 'warn' }
})

/** The box still holds exactly what is stored: the person has not pasted yet. */
const unchanged = computed(() => Boolean(storedText.value) && pasted.value === storedText.value)

function startEdit() {
  pasted.value = storedText.value
  modelText.value = ''
  reading.value = null
  receipt.value = null
  savedAt.value = 0
  stage.value = 'paste'
  editing.value = true
}

/** Closing resets the wizard: reopening it must not resume a half-typed paste. */
function closeWizard() {
  if (saving.value) return
  editing.value = false
  reading.value = null
  receipt.value = null
}

useDialogDismiss({
  active: () => editing.value,
  close: closeWizard,
  guard: () => saving.value,
})

/** Two steps, and the second one is the only one that writes. */
const stages = [
  { id: 'paste', label: 'Definition' },
  { id: 'test', label: 'Save & test' },
]

const stageIndex = computed(() => stages.findIndex((entry) => entry.id === stage.value))

function goStage(id) {
  if (saving.value) return
  if (!stages.some((entry) => entry.id === id)) return
  stage.value = id
}

/* Reading is local and cheap, so it runs on every keystroke: the chips under the
   box are feedback ("it saw a wrapper, one server, two keys it will drop"), not
   a result you only get after pressing Next. */
watch(pasted, (value) => {
  reading.value = value.trim() ? readPaste(value) : null
  /* A different paste is a different answer: never carry a fix across. The
     model's own output is not a new paste, so it keeps its banner. */
  if (value === modelText.value) return
  fixed.value = null
  fixError.value = ''
})

/**
 * Step one → step two.
 *
 * The deterministic reader runs first and usually wins: a docs-page block, a
 * bare definition, a TOML table and a URL all parse without spending a turn.
 * When it cannot, the machine's own model reads the paste instead — that is the
 * whole point of the box, a person should not have to fix the format by hand.
 * Either way nothing is written until step two.
 */
async function readAndContinue() {
  if (!pasted.value.trim() || fixing.value) return
  const local = readPaste(pasted.value)
  reading.value = local
  fixed.value = null
  fixError.value = ''
  if (!local.error) {
    goStage('test')
    return
  }

  fixing.value = true
  try {
    const data = await call('mcp.interpret', { text: pasted.value })
    const definition = cleanWhitelist(data.definition)
    const answer = { definition, dropped: data.dropped || [], harness: data.harness || '' }
    /* The model's answer replaces the paste, so step two — and the page's own
       "what it will write" summary — show the same definition it will store.
       The watcher on `pasted` clears `fixed`, so it is set after the write. */
    const written = JSON.stringify(definition, null, 2)
    modelText.value = written
    pasted.value = written
    reading.value = readPaste(written)
    fixed.value = answer
    goStage('test')
  } catch (error) {
    fixError.value = error?.message || 'The paste could not be read.'
  } finally {
    fixing.value = false
  }
}

/** The same whitelist the local reader applies, so a model cannot widen it. */
function cleanWhitelist(definition) {
  const out = {}
  const source = definition && typeof definition === 'object' ? definition : {}
  for (const key of ['url', 'command', 'args', 'headers', 'env', 'type']) {
    if (source[key] === undefined) continue
    out[key] = source[key]
  }
  return out
}

/**
 * Write, then ask the server. One click, one round trip: `writeMcp` first, then
 * `mcp.tools`, which reads `headers` from the file it just wrote. There is no
 * "test an unsaved draft" — the probe would be reading a file that does not
 * exist yet. A failure keeps the definition saved, because a rejected token is
 * a state, not a reason to throw the shape away.
 */
async function save() {
  if (saving.value) return
  const found = reading.value?.servers?.[0]
  if (!found) {
    goStage('paste')
    return
  }
  saving.value = true
  receipt.value = null
  steps.value = [{ id: 'save', state: 'wait', what: 'writing the definition', note: '' }]
  const started = Date.now()
  try {
    const wasEnabled = enabled.value
    await writeMcp({ ...poolServers.value, [name.value]: found.definition })
    savedAt.value = Date.now()
    /* writing always lands in the enabled pile; put a parked server back */
    if (!wasEnabled) await setMcpEnabled(name.value, false)
    steps.value = [
      { id: 'save', state: 'ok', what: 'saved to mcp.json', note: `${Date.now() - started} ms` },
    ]
    const probeAt = Date.now()
    await loadTools(true)
    const failed = Boolean(tools.value.error)
    const stale = probeIsStale()
    steps.value = [
      ...steps.value,
      {
        id: 'probe',
        state: stale ? 'wait' : failed ? 'bad' : 'ok',
        what: stale
          ? 'the tool list is cached from before this save — not re-asked'
          : failed
            ? `initialize → ${tools.value.error}`
            : `tools/list → ${tools.value.list.length} ${tools.value.list.length === 1 ? 'tool' : 'tools'}`,
        note: stale ? agoLabel(tools.value.readAt) : `${Date.now() - probeAt} ms`,
      },
    ]
    receipt.value = {
      at: Date.now(),
      ok: !failed && !stale,
      stale,
      error: stale ? '' : tools.value.error,
      tools: stale ? 0 : tools.value.list.length,
    }
  } catch (error) {
    steps.value = [{ id: 'save', state: 'bad', what: 'not saved', note: `${Date.now() - started} ms` }]
    receipt.value = { at: Date.now(), ok: false, stale: false, error: error?.message || 'The server could not be saved.', tools: 0 }
  } finally {
    saving.value = false
  }
}

/** The one retry a 404 gets: the sibling endpoint, written once, probed once. */
async function trySibling() {
  if (!sibling.value || saving.value) return
  /* Read the target once: writing it makes `sibling` recompute to null, and a
     label read after the write would be reading a button that no longer exists. */
  const { url } = sibling.value
  saving.value = true
  steps.value = [{ id: 'save', state: 'wait', what: `writing ${url}`, note: '' }]
  try {
    const copy = cleanCopy()
    copy.url = url
    await writeMcp({ ...poolServers.value, [name.value]: copy })
    savedAt.value = Date.now()
    const probeAt = Date.now()
    await loadTools(true)
    const failed = Boolean(tools.value.error)
    const stale = probeIsStale()
    steps.value = [
      { id: 'save', state: 'ok', what: `saved as ${url}`, note: '' },
      {
        id: 'probe',
        state: stale ? 'wait' : failed ? 'bad' : 'ok',
        what: stale
          ? 'the tool list is cached from before this save — not re-asked'
          : failed
            ? `initialize → ${tools.value.error}`
            : `tools/list → ${tools.value.list.length} tools`,
        note: stale ? agoLabel(tools.value.readAt) : `${Date.now() - probeAt} ms`,
      },
    ]
    receipt.value = { at: Date.now(), ok: !failed && !stale, stale, error: stale ? '' : tools.value.error, tools: stale ? 0 : tools.value.list.length }
  } catch (error) {
    steps.value = [{ id: 'save', state: 'bad', what: 'not saved', note: '' }]
    receipt.value = { at: Date.now(), ok: false, stale: false, error: error?.message || '', tools: 0 }
  } finally {
    saving.value = false
  }
}

/* Attach copies another file's definition in verbatim, so it asks twice like
   Detach: the first click arms the button, the second one copies. The two verbs
   never render together, so they share the one flag and the one disarm. */
function confirmAttach() {
  if (!confirming.value) {
    confirming.value = true
    return
  }
  confirming.value = false
  attach()
}

async function attach() {
  if (!globalRow.value?.definition) {
    toast('That server has neither a command nor a URL.')
    return
  }
  try {
    await writeMcp({ ...poolServers.value, [name.value]: globalRow.value.definition })
    toast(`${name.value} attached to this workspace`)
    await loadTools(true)
  } catch (error) {
    toast(error?.message || `${name.value} could not be attached.`)
  }
}

async function toggleEnabled() {
  const next = !enabled.value
  try {
    await setMcpEnabled(name.value, next)
    toast(`${name.value} ${next ? 'enabled' : 'parked'}`)
  } catch (error) {
    toast(error?.message || 'The server could not be toggled.')
  }
}

async function remove() {
  if (!confirming.value) {
    confirming.value = true
    return
  }
  const servers = { ...poolServers.value }
  const disabled = { ...poolDisabled.value }
  delete servers[name.value]
  delete disabled[name.value]
  try {
    await writeMcp(servers, { disabled })
    router.push({ name: 'mcp', params: { workspace: route.params.workspace } })
  } catch (error) {
    toast(error?.message || `${name.value} could not be removed.`)
  }
}

async function copyJson() {
  if (!definition.value) return
  const copied = await copyText(JSON.stringify(definition.value, null, 2))
  toast(copied ? 'definition copied' : 'The clipboard is not available.')
}

function back() {
  router.push({ name: 'mcp', params: { workspace: route.params.workspace } })
}

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  await loadGlobal()
  await loadTools()
  try {
    work.value = await call('connector.work', { id: name.value })
  } catch {
    work.value = null
  }
  /* `?edit=1` is how the Connectors add sheet hands over: it creates the row,
     then lands here with the wizard open, so the definition and its credential
     are entered by the one surface that owns them. A URL is the hand-off because
     the sheet and this page are different routes. */
  if (String(route.query.edit || '') === '1') startEdit()
})

onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

watch(name, async () => {
  editing.value = false
  confirming.value = false
  globalRow.value = null
  steps.value = []
  reading.value = null
  receipt.value = null
  await loadGlobal()
  await loadTools()
})
</script>

<template>
  <div class="view detail-view">
    <div class="entp-bar">
      <button class="back" type="button" @click="back">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7.5 2.5L4 6l3.5 3.5" /></svg>
        MCP
      </button>
      <span class="entp-crumb">{{ name }}</span>
      <span class="spacer"></span>
      <div class="entp-actions">
        <button class="btn btn-sm" type="button" :disabled="!definition" @click="copyJson">
          Copy definition
        </button>
      </div>
    </div>

    <template v-if="definition">
      <header class="entp-idhead">
        <div class="mcpp-mark" :data-t="transport" aria-hidden="true">
          <svg v-if="transport === 'http'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3c2.6 2.5 4 5.6 4 9s-1.4 6.5-4 9c-2.6-2.5-4-5.6-4-9s1.4-6.5 4-9z" />
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="4" width="18" height="6" rx="1.6" />
            <rect x="3" y="14" width="18" height="6" rx="1.6" />
            <path d="M7 7h.01M7 17h.01" stroke-linecap="round" />
          </svg>
        </div>
        <div class="entp-title">
          <p class="eyebrow">MCP · {{ hub.workspaceLabel || hub.workspace }}</p>
          <h1>{{ name }}</h1>
          <code class="mcpp-cmd" :title="command">{{ command }}</code>
          <div class="entp-chips">
            <span class="mcpp-chip" :data-tone="state.tone" :title="state.why">
              <i aria-hidden="true"></i>{{ state.label }}
              <span v-if="state.note" class="mcpp-chip-note">{{ state.note }}</span>
            </span>
            <button
              v-if="inPool"
              class="mcpp-chip mcpp-chip-btn"
              type="button"
              :title="
                enabled
                  ? 'Park keeps the definition and takes it out of every turn'
                  : 'Enable puts it back into every turn'
              "
              @click="toggleEnabled"
            >{{ enabled ? 'park' : 'enable' }}</button>
            <span class="entp-chip">{{ transport === 'http' ? 'remote · http' : 'local · stdio' }}</span>
            <span class="entp-chip">every entity</span>
          </div>
          <p v-if="state.why" class="mcpp-note" :data-bad="state.tone === 'bad' ? '1' : null">
            {{ state.why }}
          </p>
        </div>
      </header>

      <div class="entp-grid">
        <div class="entp-main">
          <section class="entp-sec">
            <div class="entp-sec-head">
              <h2>Tools</h2>
              <span class="n">{{ toolsHead }}</span>
              <span class="mcpp-probed">{{ probedLabel }}</span>
              <button class="r" type="button" :disabled="tools.loading" @click="loadTools(true)">
                Refresh
              </button>
            </div>

            <div v-if="steps.length" class="mcpp-steps" aria-label="What the last save and probe did">
              <div v-for="step in steps" :key="step.id" :data-s="step.state">
                <i aria-hidden="true">{{ step.state === 'ok' ? '✓' : step.state === 'bad' ? '✕' : '·' }}</i>
                <span>{{ step.what }}</span>
                <em>{{ step.note }}</em>
              </div>
            </div>

            <p v-if="tools.error" class="mcpp-note" data-bad="1">
              {{ tools.error }}
              <button v-if="sibling" class="mcpp-inline" type="button" :disabled="saving" @click="trySibling">
                Try {{ sibling.label }} instead
              </button>
            </p>
            <template v-else>
              <div class="skbar">
                <label class="sksearch mcpp-tool-search">
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                    aria-hidden="true"
                  >
                    <circle cx="7" cy="7" r="4.3" />
                    <path d="M10.3 10.3L14 14" />
                  </svg>
                  <input
                    ref="searchEl"
                    v-model="query"
                    type="search"
                    :placeholder="`Search ${toolRows.length} tools — name, or what it does`"
                    aria-label="Search this server's tools by name or description"
                    spellcheck="false"
                  />
                  <kbd class="sksearch-key search-kbd" aria-hidden="true">{{ searchKey }}</kbd>
                </label>
                <div class="mcpp-seg" role="group" aria-label="Filter tools by kind">
                  <button
                    v-for="filter in kindFilters"
                    :key="filter.id"
                    type="button"
                    :aria-pressed="kind === filter.id ? 'true' : 'false'"
                    @click="kind = filter.id"
                  >
                    {{ filter.label }} <span>{{ filter.count }}</span>
                  </button>
                </div>
              </div>

              <ul v-if="visibleTools.length" class="mcp-tool-list">
                <li v-for="tool in visibleTools" :key="tool.name">
                  <span class="ix">{{ tool.index }}</span>
                  <b :title="tool.name">{{ tool.name }}</b>
                  <span class="about">{{ tool.about || 'no description from the server' }}</span>
                  <span class="grp" :title="tool.group">{{ tool.group }}</span>
                  <span class="kind" :data-w="tool.write ? '1' : '0'">{{ tool.write ? 'write' : 'read' }}</span>
                </li>
              </ul>
              <p v-else-if="toolRows.length && !tools.loading" class="mcpp-note">{{ noMatchNote }}</p>
              <p v-else-if="toolsNote" class="mcpp-note">{{ toolsNote }}</p>
            </template>
          </section>

        </div>

        <aside class="entp-rail mcpp-rail">
          <!-- Every fact is a way in: a row that can be changed is a button, and
               it opens the same wizard the whole page is about. A fact that is
               only a fact (transport, the probe) says so by not being one. -->
          <p class="entp-rail-h">
            This server<button class="mcpp-fact-go" type="button" @click="startEdit">
              {{ tokenMissing ? 'Connect' : 'Change' }}
            </button>
          </p>
          <!-- A `<button>` cannot hold `<dt>`/`<dd>`, so a changeable row is the
               same `role="button"` pattern the MCP inventory rows use: a real
               tab stop with Enter and Space, and no invalid nesting. -->
          <dl class="entp-facts mcpp-facts">
            <div
              class="mcpp-fact"
              role="button"
              tabindex="0"
              title="Connect or change this server"
              @click="startEdit"
              @keydown.enter="startEdit"
              @keydown.space.prevent="startEdit"
            >
              <dt>Status</dt>
              <dd :data-tone="state.tone">{{ state.label }}<template v-if="state.note"> · {{ state.note }}</template></dd>
            </div>
            <div>
              <dt>Transport</dt>
              <dd>{{ transport === 'http' ? 'remote · http' : 'local · stdio' }}</dd>
            </div>
            <div
              class="mcpp-fact"
              role="button"
              tabindex="0"
              :title="`${transport === 'http' ? definition.url : definition.command} — connect or change`"
              @click="startEdit"
              @keydown.enter="startEdit"
              @keydown.space.prevent="startEdit"
            >
              <dt>{{ definition.url ? 'URL' : 'Command' }}</dt>
              <dd class="mono">{{ definition.url || definition.command }}</dd>
            </div>
            <div
              class="mcpp-fact"
              role="button"
              tabindex="0"
              title="Connect or change this server"
              @click="startEdit"
              @keydown.enter="startEdit"
              @keydown.space.prevent="startEdit"
            >
              <dt>Token</dt>
              <dd class="mono" :data-tone="tokenMissing ? 'warn' : 'ok'">
                {{ tokenKey || 'none' }}
              </dd>
            </div>
            <div
              class="mcpp-fact"
              role="button"
              tabindex="0"
              title="Ask the server again"
              @click="loadTools(true)"
              @keydown.enter="loadTools(true)"
              @keydown.space.prevent="loadTools(true)"
            >
              <dt>Tools</dt>
              <dd>{{ tools.list.length }}<template v-if="tools.list.length"> · {{ probedLabel }}</template></dd>
            </div>
          </dl>

          <p class="mcpp-note">
            Defined in {{ here.length }} {{ here.length === 1 ? 'place' : 'places' }}:
            <template v-for="(place, index) in here" :key="place.id">
              <template v-if="index">, </template><b>{{ place.label }}</b>
            </template>.
          </p>

          <p v-if="work" class="entp-rail-h">In the chat</p>
          <div v-if="work" class="mcpp-work">
            <p>
              <code class="mono">{{ work.mention }}</code>
              resolves <strong>{{ work.resolves }}</strong>.
            </p>
            <p class="mcpp-work-syntax"><code class="mono">{{ work.syntax }}</code></p>
            <ul>
              <li v-for="example in work.examples" :key="example">
                <code class="mono">{{ example }}</code>
              </li>
            </ul>
            <p class="mcpp-work-returns">{{ work.returns }}.</p>
            <p class="mcpp-work-needs">
              <template v-if="work.needs">Needs {{ work.needs }}.</template>
              Resolved by Entity's <code class="mono">{{ work.resolver }}</code> resolver.
            </p>
          </div>

          <p class="entp-rail-h">Manage</p>
          <div class="entp-rail-actions">
            <button type="button" :disabled="!definition" @click="copyJson">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                <rect x="3.4" y="3.4" width="9.2" height="10.2" rx="1.6" />
                <path d="M6 3.4V2.6h4v.8M5.8 7.2h4.4M5.8 9.8h3.2" />
              </svg>
              <span class="nm">Copy definition</span>
              <span class="hint">JSON</span>
            </button>

            <button
              v-if="!inPool"
              class="tall"
              type="button"
              :disabled="!globalRow?.definition"
              :title="
                globalRow?.definition
                  ? 'Copy the harness definition in verbatim and attach it to this workspace'
                  : 'No harness on this machine declares this server — there is nothing to copy in'
              "
              :aria-label="
                confirming
                  ? 'Click again to copy that definition in and attach this server to the workspace'
                  : 'Attach — copy the definition a harness config already declares into this workspace'
              "
              @click="confirmAttach"
              @blur="confirming = false"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                <path d="M8 2.8v5.6M5.6 6L8 8.4 10.4 6M3 11.2v1.6a1 1 0 001 1h8a1 1 0 001-1v-1.6" />
              </svg>
              <span class="row2">
                <span class="nm">Attach</span>
                <i>
                  find other instance — {{ globalRow?.harnessLabel || 'a harness' }} defines
                  this too; copied in verbatim, tokens differ
                </i>
              </span>
              <span class="hint">{{ confirming ? 'click again' : `${here.length} found` }}</span>
            </button>
            <template v-else>
              <div class="sep" aria-hidden="true"></div>
              <button
                type="button"
                data-danger="1"
                :aria-label="
                  confirming
                    ? 'Click again to detach this server from the workspace, for every entity'
                    : 'Detach this server from the workspace, for every entity'
                "
                @click="remove"
                @blur="confirming = false"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                  <path d="M3.2 4.6h9.6M6.2 4.6V3.2h3.6v1.4M4.6 4.6l.6 8.4h5.6l.6-8.4" />
                </svg>
                <span class="nm">Detach</span>
                <span class="hint">{{ confirming ? 'click again' : 'click twice' }}</span>
              </button>
            </template>
          </div>
        </aside>
      </div>
    </template>

    <section v-else class="cpanel cpanel-empty">
      <div class="empty-note">
        <b>{{ globalLoading ? 'Looking for that server…' : 'No MCP server called that.' }}</b>
        <span>
          It is not attached to this workspace, and no harness on this machine declares it.
          Add it on the MCP page.
        </span>
        <button class="btn btn-sm" type="button" @click="back">Back to MCP</button>
      </div>
    </section>

    <!-- The connect wizard. `Edit` used to open a textarea in the rail; a
         definition is a shape *and* a credential, and the rail had no field for
         the credential. One modal, three stages, and nothing written until
         Save — a failed probe keeps what was saved and says why. -->
    <!-- The connect modal: one box, two steps.
         Step one is a message box — paste whatever the docs page gave you, in
         any shape — because that is the only thing a person who did not write
         the definition can actually supply. Step two reads it, writes it, asks
         the server, and says what came back. Nothing is written until then. -->
    <Teleport to="body">
      <div class="scrim" :data-open="editing ? '1' : '0'" @click="closeWizard"></div>
      <div
        class="modal mcpp-wiz"
        :data-open="editing ? '1' : '0'"
        role="dialog"
        aria-modal="true"
        aria-label="Connect this MCP server"
      >
        <div class="mo-head">
          <h2>{{ stage === 'paste' ? 'Connect a server' : name }}</h2>
          <p v-if="stage === 'paste'">
            {{ unchanged
              ? 'What this server is right now. Replace it, or save it again.'
              : "Paste what the server's docs page gives you — a JSON block, a TOML table, or just the URL." }}
          </p>
          <p v-else>
            {{ saving || receipt
              ? 'Entity wrote it and asked the server. This is what came back.'
              : 'About to write this and ask the server whether it answers.' }}
          </p>
          <button class="x mo-x" aria-label="Close" @click="closeWizard">
            <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5">
              <path d="M2 2l8 8M10 2l-8 8" />
            </svg>
          </button>
        </div>

        <nav class="mcpp-wiz-tabs" role="tablist" aria-label="Connect steps">
          <button
            v-for="(entry, index) in stages"
            :key="entry.id"
            class="mcpp-wiz-tab"
            type="button"
            role="tab"
            :aria-selected="stage === entry.id ? 'true' : 'false'"
            :disabled="saving"
            @click="goStage(entry.id)"
          >
            <em>{{ index + 1 }}</em>{{ entry.label }}
          </button>
        </nav>

        <div class="mo-body">
          <!-- 1 · the box -->
          <section v-if="stage === 'paste'" class="mcpp-wiz-stage">
            <label class="lbl" for="wiz-paste">
              {{ storedText ? 'Stored definition — or paste a new one' : 'Paste anything from the docs page' }}
            </label>
            <textarea
              id="wiz-paste"
              v-model="pasted"
              class="mcpp-wiz-paste mono"
              rows="10"
              spellcheck="false"
              autocomplete="off"
              :placeholder="`${'{\n'}  &quot;mcpServers&quot;: { … }\n}\n\nor just:\nhttps://mcp.example.com/mcp`"
              aria-label="Paste the server definition, a URL, or a TOML block"
            ></textarea>

            <!-- What the reader made of it, before anything is written: the
                 shape it saw, how many servers, and every key it will drop. -->
            <div v-if="reading" class="mcpp-wiz-flags">
              <span v-if="reading.error" class="mcpp-chip" data-tone="bad">
                <i aria-hidden="true"></i>not understood
              </span>
              <template v-else>
                <span class="mcpp-chip" data-tone="ok">
                  <i aria-hidden="true"></i>{{ reading.envelope === 'bare' ? 'definition' : reading.envelope }}
                </span>
                <span class="mcpp-chip" data-tone="mute">
                  <i aria-hidden="true"></i>{{ reading.servers.length }}
                  {{ reading.servers.length === 1 ? 'server' : 'servers' }}
                </span>
                <span v-if="reading.dropped.length" class="mcpp-chip" data-tone="warn">
                  <i aria-hidden="true"></i>{{ reading.dropped.length }} keys not MCP — dropped
                </span>
              </template>
            </div>
            <!-- The local reader could not parse it: say so, and say who will.
                 This is the moment the box stops being a text field and becomes
                 a reader — the person does not have to fix the format. -->
            <p v-if="reading?.error && !fixing && !fixed" class="mcpp-wiz-note" data-ai="1">
              Entity's own reader cannot parse that as it stands. Press
              <b>Next</b> and the local model will read it and fix the format.
            </p>
            <p v-if="fixing" class="mcpp-wiz-note" data-ai="1">
              Asking the local model to read the paste…
            </p>
            <p v-if="fixError" class="acct-error" role="alert">{{ fixError }}</p>
            <ul v-else-if="reading && reading.dropped.length" class="mcpp-wiz-dropped">
              <li v-for="key in reading.dropped" :key="key">
                <b>{{ key }}</b><span>not a key Entity can run</span>
              </li>
            </ul>
            <!-- Untouched: this is the server as it stands, not a paste yet. -->
            <p v-else-if="unchanged" class="mcpp-wiz-note">
              This is what {{ name }} is right now. Paste a block from the docs page over
              it to replace it, or press <b>Next</b> to save it as it stands.
            </p>
            <p v-else-if="reading" class="mcpp-wiz-note">
              Read. Nothing was sent anywhere and nothing is saved yet.
            </p>
            <p v-else class="mcpp-wiz-note">
              Entity keeps only what it can run: the URL, the command, the arguments,
              the headers and the env names. Everything else in the block is dropped.
            </p>
          </section>

          <!-- 2 · the round trip -->
          <section v-else class="mcpp-wiz-stage">
            <div v-if="saving" class="mcpp-wiz-verdict">
              <span class="mcpp-chip" data-tone="mute"><i aria-hidden="true"></i>asking the server…</span>
            </div>
            <div v-else-if="receipt" class="mcpp-wiz-verdict">
              <span class="mcpp-chip" :data-tone="receipt.ok ? 'ok' : receipt.stale ? 'mute' : 'bad'">
                <i aria-hidden="true"></i>{{ receipt.ok ? 'connected' : receipt.stale ? 'not re-asked' : 'not answering' }}
                <span v-if="receipt.ok" class="mcpp-chip-note">
                  {{ receipt.tools }} {{ receipt.tools === 1 ? 'tool' : 'tools' }}
                </span>
              </span>
              <span class="mcpp-wiz-when">{{ receipt.ok ? 'the server answered' : 'the definition is saved' }}</span>
            </div>

            <ul v-if="steps.length" class="steps mcpp-wiz-steps" aria-label="What the save and probe did">
              <li v-for="step in steps" :key="step.id" :data-s="step.state">
                <span class="ic" aria-hidden="true">{{ step.state === 'ok' ? '✓' : step.state === 'bad' ? '✕' : '·' }}</span>
                <span>{{ step.what }}</span>
                <span class="t">{{ step.note }}</span>
              </li>
            </ul>

            <p v-if="receipt && !receipt.ok && receipt.error" class="mcpp-wiz-err">{{ receipt.error }}</p>

            <p v-if="receipt?.stale" class="mcpp-wiz-note">
              The definition was written, but the tool list this page holds is cached from
              before that write — the call table has no way to force a re-read. The chip on
              the row is the honest state; <b>Refresh</b> asks again once the cache expires.
            </p>
            <p v-else-if="receipt && !receipt.ok" class="mcpp-wiz-note">
              The definition stays saved. Paste a fresh block or a new token on the first
              step and try again — the row keeps saying what it really is until it connects.
            </p>
            <div v-else-if="receipt?.ok && toolRows.length" class="mcpp-wiz-tools">
              <span v-for="row in toolRows.slice(0, 8)" :key="row.name" class="mcpp-wiz-tool">{{ row.name }}</span>
              <span v-if="toolRows.length > 8" class="mcpp-wiz-tool">+{{ toolRows.length - 8 }}</span>
            </div>

            <button v-if="sibling" class="mcpp-inline" type="button" :disabled="saving" @click="trySibling">
              Try {{ sibling.label }} instead
            </button>

            <!-- Before the first save there is no verdict to report, and an empty
                 stage reads as a broken one. Say what is about to happen, with
                 the definition it is about to happen to. -->
            <template v-if="!saving && !receipt">
              <div v-if="fixed" class="mcpp-wiz-fixed" data-ai="1">
                <b>{{ fixed.harness }} read the paste</b>
                <span>
                  The format was fixed on this machine and the definition below is what
                  will be written. Nothing has been sent to the server yet.
                </span>
                <ul v-if="fixed.dropped.length">
                  <li v-for="key in fixed.dropped" :key="key">{{ key }} — dropped</li>
                </ul>
              </div>

              <dl class="mcpp-wiz-sum">
                <div>
                  <dt>{{ reading?.servers?.[0]?.definition.url ? 'Endpoint' : 'Command' }}</dt>
                  <dd class="mono">
                    {{ reading?.servers?.[0]?.definition.url
                      || [reading?.servers?.[0]?.definition.command, ...(reading?.servers?.[0]?.definition.args || [])].filter(Boolean).join(' ') }}
                  </dd>
                </div>
                <div>
                  <dt>Token</dt>
                  <dd class="mono" :data-tone="pendingSecret.tone">{{ pendingSecret.label }}</dd>
                </div>
                <div>
                  <dt>Written to</dt>
                  <dd class="mono">{{ workspaces.mcp?.path || 'mcp.json' }}</dd>
                </div>
              </dl>

              <ul class="mcpp-wiz-plan">
                <li><span class="ic" aria-hidden="true">1</span><span>Write the definition to this workspace — nothing is written until you press the button.</span></li>
                <li><span class="ic" aria-hidden="true">2</span><span>Open the server and ask for its tool list. One round trip, and the answer is what the row will say.</span></li>
              </ul>

              <p v-if="pendingSecret.tone === 'warn'" class="mcpp-wiz-note">
                A <code>{{ SYNC_REDACTED }}</code> token cannot be checked from here: it is a
                sync's redaction, so the probe would just report a 401. Paste a real one on
                the first step, or save anyway and fix it later.
              </p>
              <p v-else class="mcpp-wiz-note">
                The definition is written first and the probe reads the file it just wrote,
                so what is tested here is exactly what a turn will run.
              </p>
            </template>
          </section>
        </div>

        <div class="mo-foot mcpp-wiz-foot">
          <button
            v-if="stage !== 'paste'"
            class="btn btn-sm btn-ghost"
            type="button"
            :disabled="saving"
            @click="goStage('paste')"
          >← Paste again</button>
          <span class="spacer"></span>
          <button class="btn btn-sm" type="button" :disabled="saving" @click="closeWizard">
            {{ receipt?.ok ? 'Done' : 'Cancel' }}
          </button>
          <button
            v-if="stage === 'paste'"
            class="btn btn-ink btn-sm"
            type="button"
            :disabled="saving || fixing || !pasted.trim()"
            @click="readAndContinue"
          >{{ fixing ? 'Reading…' : reading?.error ? 'Read it with the model →' : 'Next · save & test →' }}</button>
          <button
            v-else
            class="btn btn-ink btn-sm"
            type="button"
            :disabled="saving || !reading?.servers?.length"
            @click="save"
          >{{ saving ? 'Testing…' : receipt ? 'Save & test again' : 'Save & test' }}</button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<!-- This page's own additions to the shared `.mcpp-*` vocabulary live here, not
     in `directory.css`: the state chip, the save-and-probe ladder, the token
     box. Everything else it paints — the shell, `.mcpp-chip`, `.mcpp-seg`,
     `.codebox`, `.editbox` — is the MCP surface's, shared with the inventory. -->
<style scoped>
/* The one derived state per server. Four tones, one dot each: a green dot is a
   server that answered, an amber one is a copy whose secret did not arrive, a
   red one is a server that refused, and a muted one is not being asked at all.
   The note rides in the same chip, lowercase, so the row reads as a sentence. */
.mcpp-chip[data-tone='ok'] i {
  background: var(--ok);
}
.mcpp-chip[data-tone='warn'] i {
  background: var(--accent);
}
.mcpp-chip[data-tone='bad'] i {
  background: var(--danger);
}
.mcpp-chip-note {
  margin-left: 1px;
  letter-spacing: 0;
  text-transform: none;
  color: var(--muted);
}
.entp-facts dd[data-tone='ok'] {
  color: var(--ok-ink);
}
.entp-facts dd[data-tone='warn'] {
  color: var(--accent-ink);
}
.entp-facts dd[data-tone='bad'] {
  color: var(--danger);
}

/* The save-and-probe ladder: one line per step, the note on the right. It is
   a receipt, not a log — it holds the last click and nothing before it. */
.mcpp-steps {
  margin-bottom: 12px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--r);
  background: var(--bg);
  font-family: var(--mono);
  font-size: var(--fs-meta);
}
.mcpp-steps > div {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 10px;
  border-top: 1px solid var(--border);
  color: var(--ink-2);
}
.mcpp-steps > div:first-child {
  border-top: 0;
}
.mcpp-steps i {
  flex: none;
  width: 9px;
  font-style: normal;
  color: var(--muted);
}
.mcpp-steps span {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.mcpp-steps em {
  flex: none;
  font-style: normal;
  color: var(--muted);
}
.mcpp-steps > div[data-s='ok'] i {
  color: var(--ok-ink);
}
.mcpp-steps > div[data-s='bad'] {
  color: var(--danger);
}
.mcpp-steps > div[data-s='bad'] i {
  color: var(--danger);
}

/* Whose clock the tool list is on. The read is cached in the main process, so a
   chip that says `ready` from an hour-old answer has to say so. */
.mcpp-probed {
  font-family: var(--mono);
  font-size: var(--fs-micro);
  color: var(--muted);
}

/* A failure carries the one thing a person can do about it, not a paragraph. */
.mcpp-inline {
  margin-left: 6px;
  padding: 0;
  border: 0;
  border-bottom: 1px dotted currentColor;
  background: none;
  font: inherit;
  color: var(--danger);
  cursor: pointer;
}

/* The token box. The key came from the definition (or is the one header a sync
   cannot resolve); the value is the only thing this form asks for. */
.mcpp-token {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
}
.mcpp-token-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.mcpp-token-row .acct-input {
  flex: 1 1 200px;
  min-width: 0;
  height: 32px;
  font-family: var(--mono);
  font-size: var(--fs-meta);
}
.mcpp-token-row .mcpp-seg {
  flex: 0 0 auto;
}
.mcpp-token code {
  font-family: var(--mono);
  font-size: var(--fs-micro);
}

/* ── the connect wizard ────────────────────────────────────────────
   Three stages in one modal. The tabs are the mockup's `1 · Token`,
   `2 · Definition`, `3 · Save & test`: a copy that carries a redaction opens on
   the first, a healthy one on the second, and the third only ever appears with
   a receipt. Width is the mockup's specimen card, not the narrow dialog. */
.mcpp-wiz {
  width: min(720px, 94vw);
  max-height: min(88vh, 720px);
}
.mcpp-wiz-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--border);
  overflow: auto;
}
.mcpp-wiz-tab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 26px;
  padding: 0 9px 0 5px;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  background: none;
  font-size: var(--fs-secondary);
  color: var(--muted);
  white-space: nowrap;
  cursor: pointer;
}
.mcpp-wiz-tab em {
  display: grid;
  place-items: center;
  width: 15px;
  height: 15px;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--surface-2);
  font-family: var(--mono);
  font-size: var(--fs-micro);
  font-style: normal;
  color: var(--muted);
}
.mcpp-wiz-tab:hover:not([disabled]) {
  background: var(--surface);
}
.mcpp-wiz-tab[aria-selected='true'] {
  border-color: var(--ink);
  background: var(--ink);
  color: var(--bg);
}
.mcpp-wiz-tab[aria-selected='true'] em {
  border-color: color-mix(in oklab, var(--bg) 45%, var(--ink));
  background: transparent;
  color: var(--bg);
}
.mcpp-wiz-tab[disabled] {
  cursor: not-allowed;
  opacity: 0.6;
}
.mcpp-wiz-stage {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.mcpp-wiz-verdict {
  display: flex;
  align-items: center;
  gap: 9px;
}
.mcpp-wiz-when {
  font-family: var(--mono);
  font-size: var(--fs-micro);
  letter-spacing: 0.04em;
  color: var(--muted);
}
.mcpp-wiz-steps {
  list-style: none;
  padding: 0;
  display: grid;
  gap: 2px;
  margin: 0;
}
.mcpp-wiz-steps li {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 0;
  font-size: var(--fs-secondary);
  color: var(--ink-2);
}
.mcpp-wiz-steps .ic {
  flex: none;
  display: grid;
  place-items: center;
  width: 15px;
  height: 15px;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  background: var(--bg);
  font-size: var(--fs-micro);
  color: var(--muted);
}
.mcpp-wiz-steps li[data-s='ok'] .ic {
  border-color: color-mix(in oklab, var(--ok) 34%, var(--border));
  background: color-mix(in oklab, var(--ok) 12%, var(--bg));
  color: var(--ok-ink);
}
.mcpp-wiz-steps li[data-s='bad'] .ic {
  border-color: color-mix(in oklab, var(--danger) 34%, var(--border));
  background: var(--danger-soft);
  color: var(--danger);
}
.mcpp-wiz-steps li[data-s='wait'] .ic {
  border-style: dashed;
}
.mcpp-wiz-steps li[data-s='bad'] span:not(.ic):not(.t) {
  color: var(--danger);
}
.mcpp-wiz-steps .t {
  margin-left: auto;
  font-family: var(--mono);
  font-size: var(--fs-micro);
  color: var(--muted);
}
.mcpp-wiz-err {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid color-mix(in oklab, var(--danger) 28%, var(--border));
  border-radius: var(--r);
  background: var(--danger-soft);
  font-family: var(--mono);
  font-size: var(--fs-meta);
  line-height: 1.6;
  color: var(--danger);
  overflow-wrap: anywhere;
}
.mcpp-wiz-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.mcpp-wiz-tool {
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: var(--r-xs);
  background: var(--surface);
  font-family: var(--mono);
  font-size: var(--fs-micro);
  color: var(--ink-2);
}
/* The box itself: a real textarea, monospace, sized like the paste it holds. */
.mcpp-wiz-paste {
  width: 100%;
  min-height: 190px;
  padding: 11px 13px;
  border: 1px solid var(--border-strong);
  border-radius: var(--r);
  background: var(--bg);
  font-family: var(--mono);
  font-size: var(--fs-secondary);
  line-height: 1.65;
  color: var(--ink);
  resize: vertical;
  tab-size: 2;
}
.mcpp-wiz-paste::placeholder {
  color: var(--muted);
}
.mcpp-wiz-paste:focus {
  outline: none;
  border-color: var(--ink);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

/* What the reader saw, before anything is written. */
.mcpp-wiz-flags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.mcpp-wiz-dropped {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 5px;
  font-family: var(--mono);
  font-size: var(--fs-micro);
}
.mcpp-wiz-dropped li {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.mcpp-wiz-dropped b {
  font-family: var(--font-body);
  font-size: var(--fs-secondary);
  font-weight: 600;
  color: var(--ink-2);
}
.mcpp-wiz-dropped span {
  margin-left: auto;
  color: var(--muted);
}

.mcpp-wiz-note {
  margin: 0;
  max-width: 66ch;
  font-size: var(--fs-label);
  line-height: 1.55;
  color: var(--muted);
}
.mcpp-wiz-note code {
  padding: 1px 4px;
  border: 1px solid var(--border);
  border-radius: var(--r-xs);
  background: var(--surface);
  font-family: var(--mono);
  font-size: var(--fs-micro);
}

.mcpp-wiz-foot .spacer {
  flex: 1;
}

/* What the second step is about to do, before it does it: a summary of the
   definition and a two-line plan. Without it the stage was blank until the
   first save, which reads as a broken panel rather than a pending one. */
.mcpp-wiz-sum {
  margin: 0;
  display: grid;
  gap: 0;
  font-size: var(--fs-secondary);
}
.mcpp-wiz-sum > div {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 7px 0;
  border-bottom: 1px dotted var(--border);
}
.mcpp-wiz-sum > div:last-child {
  border-bottom: 0;
}
.mcpp-wiz-sum dt {
  width: 84px;
  flex: none;
  padding-top: 2px;
  font-family: var(--mono);
  font-size: var(--fs-micro);
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--muted);
}
.mcpp-wiz-sum dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--ink);
}
.mcpp-wiz-sum dd.mono {
  font-family: var(--mono);
  font-size: var(--fs-secondary);
}
.mcpp-wiz-sum dd[data-tone='ok'] {
  color: var(--ok-ink);
}
.mcpp-wiz-sum dd[data-tone='warn'] {
  color: var(--accent-ink);
}
.mcpp-wiz-plan {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 7px;
}
.mcpp-wiz-plan li {
  display: flex;
  gap: 9px;
  font-size: var(--fs-secondary);
  line-height: 1.5;
  color: var(--ink-2);
}
/* The model's pass is stated, not hidden: which CLI read it, what it dropped,
   and that nothing has been sent yet. */
.mcpp-wiz-note[data-ai='1'] {
  padding: 8px 11px;
  border: 1px dashed color-mix(in oklab, var(--accent) 40%, var(--border));
  border-radius: var(--r);
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.mcpp-wiz-fixed {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid color-mix(in oklab, var(--accent) 34%, var(--border));
  border-radius: var(--r);
  background: var(--accent-soft);
}
.mcpp-wiz-fixed b {
  font-family: var(--mono);
  font-size: var(--fs-micro);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--accent-ink);
}
.mcpp-wiz-fixed span {
  font-size: var(--fs-label);
  line-height: 1.5;
  color: var(--accent-ink);
}
.mcpp-wiz-fixed ul {
  list-style: none;
  margin: 2px 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  font-family: var(--mono);
  font-size: var(--fs-micro);
  color: var(--accent-ink);
}
.mcpp-wiz-plan .ic {
  flex: none;
  display: grid;
  place-items: center;
  width: 15px;
  height: 15px;
  margin-top: 1px;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  font-family: var(--mono);
  font-size: var(--fs-micro);
  color: var(--muted);
}

/* ── the rail, as a way in ────────────────────────────────────────
   Every fact that can be changed is a button, and the whole panel is the way
   into the server. The point of the rail is to leave the page, not to count
   things on it.

   The rows are `div`s carrying `role="button"`: `<button>` may not hold a
   `<dt>`/`<dd>` pair, and the inventory rows already use this pattern. */
.mcpp-facts {
  gap: 0;
}
.mcpp-fact,
.mcpp-facts > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 10px 13px;
  border: 0;
  border-top: 1px solid var(--border);
  background: none;
  font: inherit;
  text-align: left;
}
.mcpp-facts > div:first-child {
  border-top: 0;
}
.mcpp-fact {
  cursor: pointer;
  transition: background 0.13s ease, color 0.13s ease;
}
.mcpp-fact:hover {
  background: var(--surface-2);
}
.mcpp-fact:hover dt {
  color: var(--ink-2);
}
/* A role="button" div has no keyboard affordance of its own. */
.mcpp-fact:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: -2px;
}
.mcpp-fact dt,
.mcpp-facts dt {
  flex: none;
  font-family: var(--mono);
  font-size: var(--fs-micro);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}
.mcpp-fact dd,
.mcpp-facts dd {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
  font-size: var(--fs-label);
  color: var(--ink-2);
}
.mcpp-fact dd.mono,
.mcpp-facts dd.mono {
  font-family: var(--mono);
  font-size: var(--fs-meta);
}
.mcpp-fact dd[data-tone='ok'] {
  color: var(--ok-ink);
}
.mcpp-fact dd[data-tone='warn'] {
  color: var(--accent-ink);
}
.mcpp-fact dd[data-tone='bad'] {
  color: var(--danger);
}
/* The one verb the whole panel is about, beside its own heading. */
.mcpp-fact-go {
  margin-left: auto;
  padding: 0;
  border: 0;
  border-bottom: 1px dotted var(--border-strong);
  background: none;
  font-family: var(--mono);
  font-size: var(--fs-micro);
  letter-spacing: 0.04em;
  text-transform: none;
  color: var(--ink-2);
  cursor: pointer;
}
.mcpp-fact-go:hover {
  border-bottom-style: solid;
  color: var(--ink);
}

</style>
