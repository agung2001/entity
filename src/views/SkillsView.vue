<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import HarnessIcon from '@/components/HarnessIcon.vue'
import PixelBackdrop from '@/components/PixelBackdrop.vue'
import SkillCopyDialog from '@/components/SkillCopyDialog.vue'
import SkillInstallDialog from '@/components/SkillInstallDialog.vue'
import VoxelMark from '@/components/VoxelMark.vue'
import { COLORS } from '@/composables/entityMark'
import { useDialogDismiss } from '@/composables/useDialog'
import { call } from '@/composables/localBridge'
import { copyText } from '@/lib/clipboard'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import { BOARDS, boards, loadBoard, readStamp, retryInMinutes } from '@/lib/skillsh'
import { hub, toast } from '@/stores/hub'
import {
  attachSkill,
  detachSkill,
  loadHashedLibrary,
  loadLibrary,
  workspaces,
} from '@/stores/workspaces'

const props = defineProps({
  /* Rendered inside Workspace → Skills; the hero is the page head either way. */
  embedded: { type: Boolean, default: false },
})

/**
 * One page, three sources — and only one of them is expensive.
 *
 * `workspace` is intent: the skills this workspace owns (real copies). `local` is
 * what is already on this machine, grouped by name because `hyperframes-core` is
 * not seven skills, it is one skill in seven folders. `libraries` is the network:
 * three boards skills.sh publishes, read only after the tab is opened, so opening
 * Skills costs one directory read and nothing else.
 *
 * The tab is the URL's (`?scope=local`), so a link lands on the tab it names and
 * a reload keeps it — the same rule Workspace → Artifacts follows for its shelf.
 */
const route = useRoute()
const router = useRouter()
const SCOPES = ['workspace', 'local', 'libraries']
const scope = ref(SCOPES.includes(String(route.query.scope)) ? String(route.query.scope) : 'workspace')
const harness = ref('all')
const busy = ref('')
/* roster state: the query, the directory read, and the row that is mid-action */
const query = ref('')
const searchEl = ref(null)
const loading = ref(!workspaces.loaded)
const loadError = ref('')
const confirming = ref('')
const copying = ref('')
const searchKey = shortcutLabel('inventory-search')

/**
 * The tab is a place, not a setting: `?tab=skills&scope=local` keeps it.
 * `router.replace`, because walking the tabs is not walking the history.
 */
function setScope(next) {
  if (!SCOPES.includes(next) || next === scope.value) return
  scope.value = next
  const query = { ...route.query, tab: 'skills' }
  if (next === 'workspace') delete query.scope
  else query.scope = next
  router.replace({ name: 'workspace', params: { workspace: route.params.workspace }, query })
}

/* A link, a reload and Back all reach this page through the URL. */
watch(
  () => route.query.scope,
  (value) => {
    const next = SCOPES.includes(String(value)) ? String(value) : 'workspace'
    if (next !== scope.value) scope.value = next
  },
)

/*
 * `Libraries` is the only tab that costs a network read, so it owns the lazy
 * read too: All time is the page — it carries lifetime installs, which is what
 * Trending's comparison column needs — and Trending and Hot are read only when
 * that sub-tab is opened. One fetch per board per open, and nothing at all for
 * the other two tabs.
 */
const sub = ref('all')
const BOARD_IDS = BOARDS.map((board) => board.id)

const boardRows = computed(() => boards.rows[sub.value] || [])

/** `1,527,932` — the same grouping the app prints for every other count. */
const count = (value) => Number(value || 0).toLocaleString('en-US')

/** The lifetime count behind a Trending row, and what share of it moved. */
function lifetimeOf(row) {
  const lifetime = boards.lifetime[String(row.name || '').toLowerCase()]
  if (!Number.isFinite(lifetime) || lifetime <= 0) return ''
  const share = Math.round((row.installs / lifetime) * 1000) / 10
  return `${count(lifetime)} · ${share}%`
}

/** `+0.3%` from the last two weeks; '' when the board carries no history. */
function weeklyDelta(row) {
  const weeks = row.weeklyInstalls || []
  if (weeks.length < 2) return ''
  const last = weeks[weeks.length - 1]
  const before = weeks[weeks.length - 2]
  if (!before) return ''
  const percent = ((last - before) / before) * 100
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%`
}

/**
 * `weeklyInstalls` as an SVG polyline in a 56 × 15 box — the sparkline the
 * mock-up draws beside the install count.
 *
 * The page already ships this series; the Skills Manager app parses it and
 * throws it away, which is why its rows rank a board with no visible reason.
 * Eight points, scaled to the box with a 1px inset so the stroke is not clipped,
 * and a flat series draws a flat line rather than dividing by zero.
 */
function sparkPoints(row) {
  const weeks = (row.weeklyInstalls || []).filter((n) => Number.isFinite(n))
  if (weeks.length < 2) return ''
  const max = Math.max(...weeks)
  const min = Math.min(...weeks)
  const span = max - min || 1
  const step = 56 / (weeks.length - 1)
  return weeks
    .map((value, index) => `${(index * step).toFixed(1)},${(14 - ((value - min) / span) * 12).toFixed(1)}`)
    .join(' ')
}

/** The sparkline's tone follows its own last-week change, same as its label. */
const sparkTrend = (row) => (weeklyDelta(row).startsWith('-') ? 'down' : 'up')

/** A sub-tab switch is one page read, and only for the board it names. */
function setSub(next) {
  if (!BOARD_IDS.includes(next) || next === sub.value) return
  sub.value = next
  loadBoard(next)
}

/* Both strips are `role=tablist`: arrows move, Enter/Space is the button's own
   click. One helper per strip, so the two cannot disagree about wrapping. */
function step(list, current, delta) {
  const at = list.indexOf(current)
  if (at < 0) return list[0]
  return list[(at + delta + list.length) % list.length]
}
const stepScope = (delta) => setScope(step(SCOPES, scope.value, delta))
const stepSub = (delta) => setSub(step(BOARD_IDS, sub.value, delta))

const SCOPE_TABS = [
  { id: 'workspace', label: 'In this workspace' },
  { id: 'local', label: 'Local' },
  { id: 'libraries', label: 'Libraries' },
]

/** The count after each tab label: folders here, names there, rows on a board. */
function scopeCount(id) {
  if (id === 'local') return workspaces.hashedLibrary ? localRows.value.length : '…'
  if (id === 'libraries') return boardRows.value.length || '…'
  return items.value.length
}

const searchPlaceholder = computed(() => {
  if (scope.value === 'local') return `Search ${localRows.value.length} skills on this machine…`
  if (scope.value === 'libraries') return 'Search skills.sh · 2 characters or more…'
  return 'Search name, description or path…'
})

const searchLabel = computed(() => {
  if (scope.value === 'local') return 'Search skills in the harness folders on this machine'
  if (scope.value === 'libraries') return 'Search skills.sh'
  return 'Search skills in this workspace'
})

/* One column per board, and it says which number it ranks: All time is lifetime
   installs, Trending is a recent window, Hot is today against yesterday. */
const boardHead = computed(() => {
  if (sub.value === 'trending') return 'Recent window'
  if (sub.value === 'hot') return 'Installs today'
  /* the number is lifetime, the line beside it is the shipped eight-week series:
     one label that names both, or the header claims the wrong one */
  return 'Installs · 8-week trend'
})

const boardCompareHead = computed(() => {
  if (sub.value === 'trending') return 'Lifetime · how much of it'
  if (sub.value === 'hot') return 'Yesterday · change'
  return 'Last week'
})

function boardCompare(row) {
  if (sub.value === 'trending') return lifetimeOf(row) || '—'
  if (sub.value === 'hot') {
    const change = row.change >= 0 ? `+${row.change}` : String(row.change)
    return `${count(row.installsYesterday)} · ${change}`
  }
  const weeks = row.weeklyInstalls || []
  return weeks.length ? count(weeks[weeks.length - 1]) : '—'
}

const originLabel = computed(() => {
  if (scope.value === 'libraries') {
    return boards.readAt[sub.value] ? `skills.sh · read ${readStamp(boards.readAt[sub.value])}` : 'skills.sh · not read yet'
  }
  if (scope.value === 'local') {
    return `${realFolders.value} of ${localFolders.value} folders are real · ${localRows.value.length} names`
  }
  return 'read from disk · no network'
})

const localFolders = computed(() => (library.value?.items || []).length)

/* how many of those folders are real rather than a link into one: the number a
   write must respect, and the one the Local footnote is about */
const realFolders = computed(
  () => (library.value?.items || []).filter((item) => !item.link).length,
)

const sortnote = computed(() => {
  if (scope.value === 'libraries') {
    if (boards.error) {
      const cachedAt = boards.savedAt ? readStamp(boards.savedAt) : ''
      const retry = retryInMinutes()
      return `${boards.error} ${cachedAt ? `The last good read (${cachedAt}) is still shown.` : 'No read has landed on this machine yet.'} In this workspace and Local are unaffected — they read the disk.${retry ? ` retry in ${retry} min.` : ''}`
    }
    if (!boards.readAt[sub.value]) return 'Nothing has been read yet.'
    return `${count(boardRows.value.length)} rows · read ${readStamp(boards.readAt[sub.value])} · at most one fetch per open`
  }
  if (scope.value === 'local') {
    return `${library.value?.count || 0} folders · ${realFolders.value} real · ${localRows.value.length} names. One row is one name, whatever carries it.`
  }
  return `${hub.workspacePath}/skills · ${items.value.length} folders · ${bytes(totalBytes.value)} · no network request was made to draw this tab`
})

/* lazy, and only the tab that was asked for: `local` reads the folders with a
   hash per folder (one walk + 79 digests), `libraries` reads the network. The
   workspace tab reads nothing new — `loadScope` already did.

   `immediate`, because a link can land straight on `?scope=libraries`. The
   half-armed row and the open row menu are dropped by the second watcher below,
   which runs after those refs exist. */
watch(
  scope,
  (value) => {
    harness.value = 'all'
    if (value === 'local' && !workspaces.hashedLibrary) loadHashedLibrary()
    if (value === 'libraries') loadBoard(sub.value)
  },
  { immediate: true },
)

/* The hero's meter needs one number and no digests: on any tab, the plain scan
   is what tells a person how much of the machine this workspace has adopted. */
if (!workspaces.library) loadLibrary()

const library = computed(() => workspaces.hashedLibrary || workspaces.library)
const items = computed(() => workspaces.skills)

const attachedNames = computed(
  () => new Set(items.value.map((item) => item.name.toLowerCase())),
)
/* name → this workspace's copy, so a row can compare its own hash with a
   harness folder's without a second read */
const attachedByName = computed(() => {
  const map = new Map()
  for (const item of items.value) map.set(item.name.toLowerCase(), item)
  return map
})

/*
 * `Local` is grouped by **name**, because `hyperframes-core` is not seven skills —
 * it is one skill in seven harness folders. One row per name, with the folders
 * that carry it, the real one first so the row's marks read left to right.
 */
const localRows = computed(() => {
  const byName = new Map()
  for (const item of library.value?.items || []) {
    const key = String(item.name || '').toLowerCase()
    const row = byName.get(key) || { name: item.name, folders: [] }
    row.folders.push(item)
    byName.set(key, row)
  }
  return [...byName.values()]
    .map((row) => {
      const folders = [...row.folders].sort(
        (a, b) => Number(a.link) - Number(b.link) || a.harness.localeCompare(b.harness),
      )
      const real = folders.filter((item) => !item.link)
      const lead = real[0] || folders[0]
      return {
        ...lead,
        name: row.name,
        folders,
        real: real.length,
        bytes: real.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0),
        size: real[0]?.size || lead.size,
        updatedAt: real.reduce(
          (newest, item) => (!newest || String(item.updatedAt) > newest ? item.updatedAt : newest),
          '',
        ),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
})

const filters = computed(() => [
  { id: 'all', label: 'Any harness', count: localRows.value.length },
  ...(library.value?.harnesses || []).map((entry) => ({
    id: entry.id,
    label: entry.label,
    count: library.value?.items?.filter(
      (item) => item.harness === entry.id && !(harness.value !== 'all' && harness.value !== entry.id),
    ).length || 0,
    /* a harness with no folder at all is its own state: not a zero count */
    installed: (entry.roots || []).some((root) => root.exists),
  })),
])

const filteredLocal = computed(() => {
  if (harness.value === 'all') return localRows.value
  return localRows.value.filter((row) =>
    row.folders.some((item) => item.harness === harness.value),
  )
})

/* ── the sigil ──────────────────────────────────────────────────────────────
   A 3 × 3 field, mirrored about the centre column, centre always lit: five
   independent decisions, so 32 silhouettes. FNV-1a over the name picks the
   silhouette and one of the entity palette's six hues, which makes 192
   identities out of nothing stored — the same name lands on the same badge on
   every machine, and a rename is honestly a different skill. */
const SIGIL_CELLS = [
  [0, 0],
  [0, 1],
  [1, 0],
  [2, 0],
  [2, 1],
]

function fnv(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function sigil(name) {
  const hash = fnv(String(name || ''))
  const shape = hash & 31
  const cells = [[1, 1]]
  SIGIL_CELLS.forEach(([y, x], index) => {
    if (!(shape & (1 << index))) return
    cells.push([x, y])
    if (x !== 1) cells.push([2 - x, y])
  })
  return { hue: COLORS[(hash >>> 13) % COLORS.length].hex, cells }
}

/* one badge per row, computed once per filter pass rather than per render */
const shelf = computed(() => {
  if (scope.value === 'local') return filteredLocal.value
  if (scope.value === 'libraries') return boardRows.value
  return items.value
})

/**
 * Search over everything the row can show, not just the name: a person hunting a
 * skill often remembers what it does ("youTrack", "vault") rather than its folder.
 */
const rows = computed(() => {
  const needle = query.value.trim().toLowerCase()
  const list = shelf.value.map((item) => ({ ...item, sig: sigil(item.name) }))
  if (!needle) return list
  return list.filter((item) =>
    [item.name, item.description, item.path, item.size, item.harnessLabel, item.source]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(needle),
  )
})

const scopeTotal = computed(() => {
  if (scope.value === 'local') return filteredLocal.value.length
  if (scope.value === 'libraries') return boardRows.value.length
  return items.value.length
})

/* a name that is not a slash token would resolve to nothing, so it gets no call
   sign at all — the typeahead in the composer accepts nothing else */
const isCallable = (name) => /^[A-Za-z0-9._-]+$/.test(String(name || ''))
const callSign = (name) => `/workspace:${name}`

const missing = computed(() => items.value.filter((item) => item.missing).length)

/*
 * The library total, once a scan has answered — 0 is a real answer ("this
 * machine has no libraries") and is told apart from "not scanned".
 *
 * It reads the hashed scan when the Local tab has paid for it and falls back to
 * the plain one, so the meter is never `9 / —` on a page where the folders are
 * already known. The visible tab is what triggers a read; the hero never does.
 */
const libraryTotal = computed(() => {
  const scan = workspaces.hashedLibrary || workspaces.library
  if (!scan || scan.error) return 0
  return scan.count || 0
})

const percent = computed(() => {
  const total = libraryTotal.value
  if (!total) return 0
  return Math.min(100, Math.round((items.value.length / total) * 1000) / 10)
})

const attachedLabel = computed(() => `${items.value.length} attached`)
const machineLabel = computed(() => `${libraryTotal.value} on this machine`)
const entitiesLabel = computed(() => {
  const count = hub.agents.length
  return count === 1 ? '1 entity can call them' : `${count} entities can call them`
})

/* how many folders one name lives in: `general-video` is in six and `cua-driver`
   in two, and three identical rows cannot say which `Attach` is which */
const copiesByName = computed(() => {
  const counts = new Map()
  for (const item of library.value?.items || []) {
    const key = String(item.name || '').toLowerCase()
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return counts
})

const copies = (name) => copiesByName.value.get(String(name || '').toLowerCase()) || 1

const isAttached = (item) => attachedNames.value.has(item.name.toLowerCase())
const busyKey = (item) => `${item.harness}:${item.name}`

/**
 * Does the copy in this workspace differ from the library's?
 *
 * Answers with the workspace copy when the bytes moved on, `null` when they are
 * the same or when either hash is missing. A same-size edit changes the hash only
 * when the bytes change, which is the whole point of hashing both sides.
 */
function drifted(item) {
  const here = attachedByName.value.get(String(item.name || '').toLowerCase())
  if (!here || here.missing) return null
  if (!here.sha256 || !item.sha256) return null
  return here.sha256 === item.sha256 ? null : here
}

const shortHash = (value) => String(value || '').slice(0, 8)

const when = (iso) => {
  if (!iso) return 'unknown'
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return 'unknown'
  const days = Math.floor((Date.now() - then) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days}d ago`
}

function bytes(value) {
  const size = Number(value)
  if (!Number.isFinite(size) || size <= 0) return '0 B'
  if (size < 1024) return `${size} B`
  const kb = size / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  const mb = kb / 1024
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

const totalBytes = computed(() =>
  items.value.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0),
)

/* A missing entry is not a broken copy of a skill: the folder is still attached
   and it points at nothing, so the sentence says exactly that. */
const descriptionOf = (item) => {
  if (item.missing) {
    return 'Its entry file is gone. The folder is still attached, so the workspace now points at nothing.'
  }
  if (scope.value === 'libraries') {
    return item.source ? `@${item.source}` : 'Its skills.sh entry names no source repository.'
  }
  if (item.description) return item.description
  return scope.value === 'local'
    ? 'Its SKILL.md frontmatter carries no description.'
    : 'Attached skill. Its frontmatter has no description.'
}

const footerNote = computed(
  () =>
    `${items.value.length} ${items.value.length === 1 ? 'skill' : 'skills'} · ${bytes(totalBytes.value)}`,
)

const skeleton = computed(() => {
  if (scope.value === 'local') return !library.value
  if (scope.value === 'libraries') return boards.loading === sub || (!boardRows.value.length && !boards.error)
  return loading.value
})

/* The skeleton is the real grid at the real row height, so nothing jumps when
   the read answers; its two middle labels are the ones the finished table has. */
const skeletonHead = computed(() => {
  if (scope.value === 'libraries') return [boardHead.value, boardCompareHead.value]
  if (scope.value === 'local') return ['Harness folders', 'Size · updated']
  return ['Hash', 'Size · updated']
})

const skeletonLabel = computed(() => {
  if (scope.value === 'libraries') return 'Reading skills.sh'
  if (scope.value === 'local') return 'Reading the skill folders on this machine'
  return 'Skills attached to this workspace'
})

/**
 * The roster reads its own directory.
 *
 * The workspace scope loader also fills `workspaces.skills`, but it swallows a
 * failed read: an unreadable `skills/` then reached this page as `0 skills`, which
 * looks exactly like a workspace nobody has attached anything to. One readdir is
 * cheap next to that lie, and it makes `Try again` mean something.
 */
async function refresh() {
  loadError.value = ''
  loading.value = !items.value.length
  try {
    workspaces.skills = await call('workspace.skills', { id: workspaces.active })
  } catch (problem) {
    loadError.value = problem?.message || 'The skill directory could not be read.'
  } finally {
    loading.value = false
  }
}

function focusSearch() {
  const field = searchEl.value
  if (!(field instanceof HTMLInputElement)) return
  field.focus()
  field.select()
}

/* The list-search key focuses this roster's search. It carries a modifier, so
   it cannot collide with a `/` a person is typing. */
function onKey(event) {
  if (!matchesShortcut('inventory-search', event)) return
  event.preventDefault()
  focusSearch()
}

/* ── the call sign: the row's one verb ────────────────────────────────────────
   `copyText` reports the route it took, so the label can say `Copied` and the
   title can say which one happened. A silent fallback is a lie about what the
   clipboard did. */
const copied = ref('')
const copiedRoute = ref('')
const copiedVia = ref('')
let copyTimer = 0

function refTitle(item) {
  if (copiedRoute.value === item.name) {
    return copiedVia.value === 'clipboard'
      ? 'Copied with the clipboard API'
      : 'Copied as a selection'
  }
  return `Copy ${callSign(item.name)}`
}

async function copyRef(item) {
  const sign = callSign(item.name)
  const route = await copyText(sign)
  if (!route) {
    toast(`Could not copy ${sign}`)
    return
  }
  copied.value = item.name
  copiedRoute.value = item.name
  copiedVia.value = route
  toast(`Copied ${sign}`)
  clearTimeout(copyTimer)
  copyTimer = setTimeout(() => {
    copied.value = ''
  }, 1400)
}

/* ── the row menu: copy-to-another-workspace and detach, where the question
   "copy where" already lives ──────────────────────────────────────────────── */
const menuItem = ref(null)
const menuPos = ref({})
const menuEl = ref(null)
let menuOpener = null

async function openRowMenu(event, item) {
  event.stopPropagation()
  if (menuItem.value?.name === item.name) {
    closeMenu()
    return
  }
  confirming.value = ''
  const opener = event.currentTarget
  menuOpener = opener
  const rect = opener.getBoundingClientRect()
  const width = 236
  const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
  menuPos.value = { left: `${Math.round(left)}px`, top: `${Math.round(rect.bottom + 6)}px` }
  menuItem.value = item
  /* DESIGN.md: the menu measures itself instead of assuming a height — a
     two-item menu is not the same box as a five-item one */
  await nextTick()
  const height = menuEl.value?.offsetHeight || 0
  const below = window.innerHeight - rect.bottom - 6 - 8
  if (height > below && rect.top - 14 > below) {
    menuPos.value = { left: menuPos.value.left, top: `${Math.round(rect.top - 6 - height)}px` }
  }
}

function closeMenu() {
  if (!menuItem.value) return
  menuItem.value = null
  confirming.value = ''
  menuPos.value = {}
  const opener = menuOpener
  menuOpener = null
  if (opener instanceof HTMLElement) opener.focus()
}

/* Esc is the one stack; a click anywhere else, a scroll of the roster or a
   window resize closes this popover the same way it closes the rail's. */
useDialogDismiss({
  active: () => Boolean(menuItem.value),
  close: () => closeMenu(),
})

function onDocumentClick(event) {
  if (!menuItem.value) return
  const target = event.target
  if (target instanceof Element && target.closest('.sk-menu, .sk-row-menu')) return
  closeMenu()
}

function cancelConfirm() {
  confirming.value = ''
}

/* A scope switch under an open row menu closes it: the menu's items act on the
   roster that opened it, which is no longer the roster on screen. */
watch(scope, () => {
  confirming.value = ''
  closeMenu()
})

/** The copy sheet needs a skill and a workspace to read it from. */
function openCopy(item) {
  closeMenu()
  if (!item || item.missing) return
  copying.value = item.name
}

/** Detach asks twice, in the menu: the first click arms it, the second removes. */
async function detach(item) {
  const name = item.name
  if (busy.value) return
  if (confirming.value !== name) {
    confirming.value = name
    return
  }
  confirming.value = ''
  busy.value = `detach:${name}`
  try {
    /* the store re-reads the directory, so a query that no longer matches
       simply stops matching — no second read here */
    await detachSkill(name)
    closeMenu()
  } catch (problem) {
    toast(problem?.message || 'Could not detach that skill')
  } finally {
    busy.value = ''
  }
}

async function attach(item) {
  const key = busyKey(item)
  if (busy.value) return
  busy.value = key
  try {
    await attachSkill({ name: item.name, harness: item.harness })
  } catch (error) {
    toast(error?.message || 'Could not attach that skill')
  } finally {
    busy.value = ''
  }
}

/* ── the Install sheet ────────────────────────────────────────────────────────
   One sheet for a Local row and a Libraries row: "where does this go?" is the
   same question from either side, and `Install` is the only filled control on
   this page. */
const installing = ref(null)

function openInstall(item, from) {
  if (!item) return
  installing.value = { item, from }
}

/* A row opens the sheet on click and on Enter/Space; the button inside the row
   stays the one keyboard stop, so there is no second activation path. */
function onRowKey(event, item, from) {
  if (event.key !== 'Enter' && event.key !== ' ') return
  if (event.target instanceof Element && event.target.closest('button, a')) return
  event.preventDefault()
  openInstall(item, from)
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', closeMenu)
  document.addEventListener('click', onDocumentClick)
  refresh()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', closeMenu)
  document.removeEventListener('click', onDocumentClick)
  clearTimeout(copyTimer)
})
</script>

<template>
  <div :class="props.embedded ? 'ws-embed' : 'view'">
    <div class="sk-shelf">
      <section class="sk-hero">
        <PixelBackdrop variant="hero" :count="18" />
        <div class="sk-hero-in">
          <header class="sk-hero-id">
            <!-- The cabinet's own ornament: the specimen sheet's energy blade,
                 drawn the way `entityMark.js` draws a mark — square cells on an
                 integer grid, one flat fill per light angle, no path and no
                 request. It takes the mark's slot at the top-left of the hero, so
                 the page opens the way the entity profile it mirrors does. -->
            <span class="sk-crest" aria-hidden="true">
              <VoxelMark shape="blade" />
            </span>
            <div class="sk-hero-text">
              <p class="eyebrow">
                Skills <span class="sep">·</span> {{ hub.workspaceLabel || hub.workspace }}
              </p>
              <h1 class="sk-h1">Skills</h1>
              <p class="sk-lede">
                Every skill this workspace carries — copied in from a harness library, so a
                backup or another machine takes it along. Call one by typing
                <code>/workspace:&lt;name&gt;</code> in any conversation.
              </p>
              <div class="sk-chips">
                <span class="sk-chip">{{ attachedLabel }}</span>
                <!-- nothing is scanned on first paint: a zero would claim this
                     machine has no libraries -->
                <span v-if="libraryTotal" class="sk-chip">{{ machineLabel }}</span>
                <span class="sk-chip">{{ entitiesLabel }}</span>
                <span class="sk-chip" :data-ok="missing ? '0' : '1'">
                  {{ missing ? `${missing} missing` : 'none missing' }}
                </span>
              </div>
            </div>
          </header>

          <!-- The collection meter is always drawn. Only its *total* waits for
               the lazy scan (seven directory trees), so the block keeps its
               shape from first paint and the number arrives without a jump. A
               total of 0 was never the intent — it claimed the machine had no
               libraries — so it shows an em dash until the read answers. -->
          <aside
            class="sk-meter"
            :aria-label="
              libraryTotal
                ? `${items.length} of ${libraryTotal} skills on this machine are attached to this workspace`
                : `${items.length} skills attached to this workspace; the libraries are not scanned yet`
            "
          >
            <div class="sk-lv">
              <span>CALL</span>
              <b>/</b>
            </div>
            <div class="sk-meter-main">
              <div class="sk-meter-head">
                <span>Collection</span>
                <b>{{ items.length }} / {{ libraryTotal || '—' }}</b>
              </div>
              <div
                class="sk-track"
                role="progressbar"
                aria-valuemin="0"
                :aria-valuemax="libraryTotal || 100"
                :aria-valuenow="libraryTotal ? items.length : 0"
                :aria-valuetext="
                  libraryTotal
                    ? `${items.length} of ${libraryTotal} skills attached`
                    : 'the harness libraries are not scanned yet'
                "
              >
                <i :style="{ width: `${percent}%` }"></i>
              </div>
              <div class="sk-meter-foot">
                <span>{{ items.length }} adopted</span>
                <span v-if="libraryTotal">
                  {{ Math.max(0, libraryTotal - items.length) }} still in the libraries
                </span>
                <span v-else>reading the libraries…</span>
              </div>
            </div>
          </aside>
        </div>
      </section>

      <!--
        Three tabs, one strip. `In this workspace` is intent, `Local` is what the
        machine already has, `Libraries` is the only one that costs a network read
        — which is why it is a tab and not a board bolted onto the others.
      -->
      <div class="sk-tabs skscopes" role="tablist" aria-label="Skill scope">
        <button
          v-for="entry in SCOPE_TABS"
          :key="entry.id"
          role="tab"
          type="button"
          :aria-selected="scope === entry.id ? 'true' : 'false'"
          :tabindex="scope === entry.id ? 0 : -1"
          @click="setScope(entry.id)"
          @keydown.left.prevent="stepScope(-1)"
          @keydown.right.prevent="stepScope(1)"
        >
          {{ entry.label }} <span class="n">{{ scopeCount(entry.id) }}</span>
        </button>
        <span class="where">{{ originLabel }}</span>
      </div>

      <!-- the search field alone: the tab strip above already carries the count,
           and a second `600 of 600` beside it is a number nobody can act on -->
      <div class="skbar">
        <label class="sksearch">
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
            :placeholder="searchPlaceholder"
            :aria-label="searchLabel"
            spellcheck="false"
          />
          <kbd class="sksearch-key search-kbd" aria-hidden="true">{{ searchKey }}</kbd>
        </label>
      </div>

      <!-- Only Local has per-harness folders to narrow by; the other two tabs
           are one row per name already. A harness with no folder is its own
           state, not a zero: it is disabled and says so. -->
      <div v-if="scope === 'local' && library" class="filters" role="group" aria-label="Harness">
        <button
          v-for="f in filters"
          :key="f.id"
          class="hint"
          type="button"
          :aria-pressed="harness === f.id ? 'true' : 'false'"
          :disabled="f.installed === false"
          :title="f.installed === false ? `${f.label} has no skill folder on this machine` : ''"
          @click="harness = f.id"
        >
          <!-- the mock-up draws no mark on the leading chip: it is not a harness -->
          <HarnessIcon v-if="f.id !== 'all'" :name="f.id" />
          {{ f.label }} <span class="hint-n">{{ f.installed === false ? 'not installed' : f.count }}</span>
        </button>
      </div>

      <!-- Only Libraries has three boards; they are the three pages skills.sh
           publishes, never a fourth invented name. -->
      <div v-if="scope === 'libraries'" class="subtabs" role="tablist" aria-label="skills.sh board">
        <button
          v-for="entry in BOARDS"
          :key="entry.id"
          role="tab"
          type="button"
          :aria-selected="sub === entry.id ? 'true' : 'false'"
          :tabindex="sub === entry.id ? 0 : -1"
          @click="setSub(entry.id)"
          @keydown.left.prevent="stepSub(-1)"
          @keydown.right.prevent="stepSub(1)"
        >
          {{ entry.label }}
        </button>
        <span class="where">{{ originLabel }}</span>
      </div>

      <!-- the real grid while the read is in flight, so nothing jumps when it
           answers: a skeleton row is the same height as a one-line row -->
      <div
        v-if="skeleton"
        class="skt"
        role="table"
        aria-busy="true"
        :aria-label="skeletonLabel"
      >
        <div class="row head" role="row">
          <span class="k1" role="columnheader">Skill</span>
          <span class="k2" role="columnheader">{{ skeletonHead[0] }}</span>
          <span class="k3" role="columnheader">{{ skeletonHead[1] }}</span>
          <span class="acts-head k4" role="columnheader">Action</span>
        </div>
        <div v-for="n in 3" :key="n" class="row" role="row" aria-hidden="true">
          <div class="nm k1" role="cell">
            <span class="sig-tile sk"></span>
            <span class="nn">
              <span class="sk" :style="{ display: 'block', width: `${64 - n * 6}px`, height: '11px' }"></span>
              <!-- one description line, exactly, so the skeleton row measures
                   the same as a real one -->
              <span class="sk" :style="{ display: 'block', height: '1.4em', marginTop: '1px', width: `${72 - n * 8}%` }"></span>
            </span>
          </div>
          <span class="ev k2" role="cell">
            <span class="sk" style="display: inline-block; height: 10px; width: 52px"></span>
          </span>
          <span class="ev k3" role="cell">
            <span class="sk" style="display: inline-block; height: 10px; width: 38px"></span>
          </span>
          <div class="acts k4" role="cell">
            <span class="sk" style="height: 26px; width: 132px"></span>
            <span class="sk" style="height: 26px; width: 26px"></span>
          </div>
        </div>
      </div>

      <template v-else-if="scope === 'workspace'">
        <div v-if="loadError" class="empty-note err" role="alert">
          <b>Could not read {{ hub.workspacePath }}/skills.</b>
          <span class="mono">{{ loadError }}</span>
          <div class="empty-actions">
            <button class="btn btn-sm" type="button" @click="refresh">Try again</button>
          </div>
        </div>

        <div v-else-if="!items.length" class="empty-note">
          <b>No skills in {{ hub.workspace || 'this workspace' }} yet.</b>
          <span>
            Local has {{ localRows.length }} names this machine already reads. One click copies a
            folder here, so a backup or another machine takes it along.
          </span>
          <div class="empty-actions">
            <button class="btn btn-sm" type="button" @click="setScope('local')">Open Local</button>
            <button class="btn btn-sm" type="button" @click="setScope('libraries')">
              Browse Libraries
            </button>
          </div>
        </div>

        <div v-else-if="!rows.length" class="empty-note">
          <b>No skill matches “{{ query.trim() }}”.</b>
          <span>
            {{ items.length }} {{ items.length === 1 ? 'skill is' : 'skills are' }} attached here.
            Search covers name, description, path and size.
          </span>
          <div class="empty-actions">
            <button class="btn btn-sm" type="button" @click="query = ''">Clear the search</button>
          </div>
        </div>

        <template v-else>
          <div class="skt" role="table" aria-label="Skills attached to this workspace">
            <div class="row head" role="row">
              <span class="k1" role="columnheader">Skill</span>
              <span class="k2" role="columnheader">Hash</span>
              <span class="k3" role="columnheader">Size · updated</span>
              <span class="acts-head k4" role="columnheader">Action</span>
            </div>

            <!--
              `div[role=row]` with a real `<button>` inside it, never a `<button>`
              wrapping one: the browser reparents the inner button and the roster
              collapses into 33 unrelated links.
            -->
            <div
              v-for="item in rows"
              :key="item.name"
              class="row"
              :class="{ miss: item.missing }"
              role="row"
              tabindex="0"
            >
              <div class="nm k1" role="cell">
                <span class="sig-tile">
                  <svg
                    class="sig"
                    viewBox="0 0 3 3"
                    shape-rendering="crispEdges"
                    :style="{ '--sg': item.sig.hue }"
                    aria-hidden="true"
                  >
                    <g fill="currentColor">
                      <rect
                        v-for="(cell, index) in item.sig.cells"
                        :key="index"
                        :x="cell[0]"
                        :y="cell[1]"
                        width="1"
                        height="1"
                      />
                    </g>
                  </svg>
                </span>
                <span class="nn">
                  <span class="nm-line">
                    <router-link
                      class="nm-t"
                      :title="item.name"
                      :to="{ name: 'skill', params: { workspace: hub.workspace, name: item.name } }"
                    >
                      {{ item.name }}
                    </router-link>
                    <span v-if="drifted(item)" class="tg" data-t="drift">differs elsewhere</span>
                  </span>
                  <span class="d" :title="item.description || ''">{{ descriptionOf(item) }}</span>
                </span>
              </div>

              <span class="ev k2" role="cell" :title="item.sha256 || 'no hash yet'">
                {{ item.sha256 ? shortHash(item.sha256) : '—' }}
              </span>
              <span class="ev k3" role="cell">
                {{ item.missing ? '—' : `${item.size || '—'} · ${when(item.updatedAt)}` }}
              </span>

              <div class="acts k4" role="cell">
                <!-- a missing entry has nothing to copy: the reference would
                     resolve to nothing, so it is not offered -->
                <button
                  v-if="!item.missing && isCallable(item.name)"
                  class="ref"
                  :class="{ 'is-copied': copied === item.name }"
                  type="button"
                  :title="refTitle(item)"
                  :aria-label="`Copy the call sign ${callSign(item.name)}`"
                  @click="copyRef(item)"
                >
                  <span class="ref-t">
                    <span class="rf">{{ copied === item.name ? 'Copied' : callSign(item.name) }}</span>
                    <span class="rs">{{ copied === item.name ? 'Copied' : `/${item.name}` }}</span>
                  </span>
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                    <rect x="2.2" y="2.2" width="8.4" height="8.4" rx="1.6" />
                    <path d="M5.6 13.8h7.1a1 1 0 0 0 1-1V5.6" />
                  </svg>
                </button>
                <span v-else-if="item.missing" class="miss-chip">missing file</span>

                <button
                  class="btn-icon sk-row-menu"
                  type="button"
                  :aria-expanded="menuItem?.name === item.name ? 'true' : 'false'"
                  aria-haspopup="menu"
                  :title="`More actions for ${item.name}`"
                  :aria-label="`More actions for ${item.name}`"
                  @click="openRowMenu($event, item)"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <circle cx="3.4" cy="8" r="1.3" />
                    <circle cx="8" cy="8" r="1.3" />
                    <circle cx="12.6" cy="8" r="1.3" />
                  </svg>
                </button>
              </div>
            </div>
          </div>

          <p class="sortnote">{{ sortnote }}</p>
        </template>
      </template>

      <!--
        Local: one row per **name**, because `hyperframes-core` is not seven skills
        — it is one skill in seven harness folders. The marks say which apps carry
        it; `N folders · M real` says how much of it is a real folder and how much
        is a link, which is the number a write must respect.
      -->
      <template v-else-if="scope === 'local'">
        <div v-if="library?.error" class="empty-note err" role="alert">
          <b>{{ library.error }}</b>
          <span>The skill folders on this machine could not be read.</span>
          <div class="empty-actions">
            <button class="btn btn-sm" type="button" @click="loadHashedLibrary({ force: true })">
              Try again
            </button>
          </div>
        </div>

        <div v-else-if="!rows.length && query.trim()" class="empty-note">
          <b>No skill matches “{{ query.trim() }}”.</b>
          <span>
            {{ localRows.length }} {{ localRows.length === 1 ? 'name is' : 'names are' }} on this
            machine. Search covers name, description and path.
          </span>
          <div class="empty-actions">
            <button class="btn btn-sm" type="button" @click="query = ''">Clear the search</button>
          </div>
        </div>

        <div v-else-if="!rows.length" class="empty-note">
          <b>No skills in the harness folders.</b>
          <span v-if="harness !== 'all'">Switch to Any harness, or add a skill folder for it.</span>
          <span v-else>No harness skill directory was found on this machine.</span>
        </div>

        <template v-else>
          <div class="skt" role="table" aria-label="Skills in the harness folders on this machine">
            <div class="row head" role="row">
              <span class="k1" role="columnheader">Skill</span>
              <span class="k2" role="columnheader">Harness folders</span>
              <span class="k3" role="columnheader">Size · updated</span>
              <span class="acts-head k4" role="columnheader">Action</span>
            </div>

            <div
              v-for="item in rows"
              :key="item.name"
              class="row"
              role="row"
              tabindex="0"
              @click="openInstall(item, 'local')"
              @keydown="onRowKey($event, item, 'local')"
            >
              <div class="nm k1" role="cell">
                <!-- every Local row is a harness folder, so its badge is that
                     harness's own mark, not a name-hashed sigil -->
                <span class="sig-tile" :title="item.harnessLabel">
                  <HarnessIcon :name="item.harness" :size="13" />
                </span>
                <span class="nn">
                  <span class="nm-line">
                    <router-link
                      class="nm-t"
                      :title="item.name"
                      :to="{
                        name: 'skill',
                        params: { workspace: hub.workspace, name: item.name },
                        query: { harness: item.harness },
                      }"
                    >
                      {{ item.name }}
                    </router-link>
                    <span v-if="isAttached(item)" class="tg" data-t="here">in this workspace</span>
                    <span
                      v-else-if="drifted(item)"
                      class="tg"
                      data-t="drift"
                      :title="`this workspace has ${shortHash(drifted(item).sha256)}; the library has ${shortHash(item.sha256)}`"
                    >
                      differs elsewhere
                    </span>
                  </span>
                  <span class="d" :title="item.description || ''">{{ descriptionOf(item) }}</span>
                </span>
              </div>

              <!-- the marks are the whole point of the grouping: one row, every
                   app that carries this name -->
              <span class="marks k2" role="cell">
                <HarnessIcon
                  v-for="mark in item.folders.slice(0, 4)"
                  :key="mark.harness"
                  :name="mark.harness"
                  :title="`${mark.harnessLabel}${mark.link ? ' · a link' : ''}`"
                />
                <span v-if="item.folders.length > 4" class="more">
                  +{{ item.folders.length - 4 }}
                </span>
              </span>

              <span class="ev k3" role="cell">
                <b>{{ item.folders.length }} {{ item.folders.length === 1 ? 'folder' : 'folders' }} · {{ item.real }} real</b>
                <span>{{ item.size || '—' }} · {{ when(item.updatedAt) }}</span>
              </span>

              <div class="acts k4" role="cell">
                <!-- a workspace copy that drifted is never replaced blind from a
                     list: the row offers the skill's own page, where both hashes
                     are visible -->
                <router-link
                  v-if="drifted(item)"
                  class="btn btn-sm"
                  :to="{ name: 'skill', params: { workspace: hub.workspace, name: item.name } }"
                  @click.stop
                >
                  Open
                </router-link>
                <button
                  v-else-if="!isAttached(item)"
                  class="btn btn-sm"
                  type="button"
                  :disabled="busy === busyKey(item)"
                  :title="`Install ${item.name} into a workspace`"
                  :aria-label="`Install ${item.name} into a workspace`"
                  @click.stop="openInstall(item, 'local')"
                >
                  Install…
                </button>
                <span v-else class="on-badge"><i></i>Installed</span>
              </div>
            </div>
          </div>

          <p class="sortnote">{{ sortnote }}</p>
        </template>
      </template>

      <!--
        Libraries: the one tab that touches the network, and only after it is
        opened. The last good read stays on screen when the read fails, stamped,
        with the moment a retry is allowed — never an empty page and never a
        spinner over nothing.
      -->
      <template v-else>
        <div v-if="boards.error" class="empty-note err" role="alert">
          <b>skills.sh did not answer.</b>
          <span>
            Nothing was lost: the last read is kept and still shown, stamped with its date.
            <b>In this workspace</b> and <b>Local</b> are unaffected — they read the disk.
          </span>
          <span v-if="boards.savedAt" class="mono">
            last good read · {{ readStamp(boards.savedAt) }}
            <template v-if="retryInMinutes()"> · retry in {{ retryInMinutes() }} min</template>
          </span>
          <div class="empty-actions">
            <button
              class="btn btn-sm"
              type="button"
              :disabled="Boolean(boards.loading)"
              @click="loadBoard(sub, { force: true })"
            >
              {{ boards.loading ? 'Reading…' : 'Try again' }}
            </button>
          </div>
        </div>

        <div v-else-if="!rows.length && !skeleton" class="empty-note">
          <b>No rows on this board yet.</b>
          <span>
            {{ boards.readAt[sub] ? 'The read landed, but it carried no names this build could read.' : 'Nothing has been read from skills.sh in this window.' }}
          </span>
        </div>

        <div
          v-else-if="rows.length"
          class="skt lib-t"
          role="table"
          :aria-label="`skills.sh ${sub}`"
        >
          <div class="row head" role="row">
            <span class="k1" role="columnheader">Skill</span>
            <span class="k2" role="columnheader">{{ boardHead }}</span>
            <span class="k3" role="columnheader">{{ boardCompareHead }}</span>
            <span class="acts-head k4" role="columnheader">Action</span>
          </div>

          <div
            v-for="(item, index) in rows"
            :key="item.name"
            class="row"
            role="row"
            tabindex="0"
            @click="openInstall(item, 'libraries')"
            @keydown="onRowKey($event, item, 'libraries')"
          >
            <span class="nm k1" role="cell">
              <span class="rank">{{ index + 1 }}</span>
              <span class="sig-tile">
                <svg
                  class="sig"
                  viewBox="0 0 3 3"
                  shape-rendering="crispEdges"
                  :style="{ '--sg': item.sig.hue }"
                  aria-hidden="true"
                >
                  <g fill="currentColor">
                    <rect
                      v-for="(cell, cellIndex) in item.sig.cells"
                      :key="cellIndex"
                      :x="cell[0]"
                      :y="cell[1]"
                      width="1"
                      height="1"
                    />
                  </g>
                </svg>
              </span>
              <span class="nn">
                <span class="nm-line">
                  <!-- the name is the link, the row is not: the skill page is
                       where a person decides, and it carries the Install button -->
                  <router-link
                    class="nm-t"
                    :title="`Open ${item.name}`"
                    :to="{
                      name: 'skill',
                      params: { workspace: hub.workspace, name: item.name },
                      query: { board: sub },
                    }"
                    @click.stop
                  >
                    {{ item.name }}
                  </router-link>
                  <span v-if="isAttached(item)" class="tg" data-t="here">on this machine</span>
                  <span v-if="item.isOfficial" class="tg">official</span>
                </span>
                <span class="d" :title="item.source">{{ descriptionOf(item) }}</span>
              </span>
            </span>

            <span class="ev k2" role="cell">
              <span class="inst">
                <!-- the series the page already carries, drawn: a board that ranks
                     by a number shows the number's own shape -->
                <svg
                  v-if="sparkPoints(item)"
                  class="spark"
                  viewBox="0 0 56 15"
                  :data-trend="sparkTrend(item)"
                  aria-hidden="true"
                >
                  <polyline
                    :points="sparkPoints(item)"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linejoin="round"
                    stroke-linecap="round"
                  />
                </svg>
                <span class="iv">
                  <b>{{ count(item.installs) }}</b>
                  <span
                    v-if="weeklyDelta(item)"
                    class="ids"
                    :data-up="weeklyDelta(item).startsWith('+') ? '1' : '-1'"
                  >
                    {{ weeklyDelta(item) }}
                  </span>
                </span>
              </span>
            </span>

            <span class="ev k3" role="cell">
              <b>{{ boardCompare(item) }}</b>
            </span>

            <div class="acts k4" role="cell">
              <span v-if="isAttached(item)" class="on-badge"><i></i>Installed</span>
              <button
                v-else
                class="btn btn-sm"
                type="button"
                :title="`Install ${item.name}`"
                :aria-label="`Install ${item.name}`"
                @click.stop="openInstall(item, 'libraries')"
              >
                Install…
              </button>
            </div>
          </div>
        </div>

        <p class="sortnote">{{ sortnote }}</p>
      </template>

      <Teleport to="body">
        <div
          v-if="menuItem"
          ref="menuEl"
          class="sk-menu"
          role="menu"
          :aria-label="`Actions for ${menuItem.name}`"
          :style="menuPos"
          @click.stop
        >
          <button
            role="menuitem"
            type="button"
            :disabled="Boolean(menuItem.missing)"
            :title="
              menuItem.missing
                ? 'A missing skill has no files to copy'
                : `Copy ${menuItem.name} into another workspace`
            "
            @click="openCopy(menuItem)"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
              <rect x="2.2" y="2.2" width="8.4" height="8.4" rx="1.6" />
              <path d="M5.6 13.8h7.1a1 1 0 0 0 1-1V5.6" />
            </svg>
            Copy to another workspace…
          </button>
          <button
            role="menuitem"
            type="button"
            class="danger"
            :class="{ confirming: confirming === menuItem.name }"
            :disabled="busy === `detach:${menuItem.name}`"
            :title="
              confirming === menuItem.name
                ? 'Click again to remove it here'
                : `Detach ${menuItem.name} from this workspace`
            "
            :aria-label="
              confirming === menuItem.name
                ? `Confirm detaching ${menuItem.name} from this workspace`
                : `Detach ${menuItem.name} from this workspace`
            "
            @click="detach(menuItem)"
            @blur="cancelConfirm"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
              <path d="M3.2 4.4h9.6M6.1 4.4V2.8h3.8v1.6M4.4 4.4l.6 8.8h6l.6-8.8" />
            </svg>
            {{
              confirming === menuItem.name
                ? 'Click again to detach'
                : 'Detach from workspace'
            }}
          </button>
        </div>
      </Teleport>
    </div>

    <SkillCopyDialog
      v-if="copying"
      :name="copying"
      :source="hub.workspace"
      @close="copying = ''"
    />

    <!-- one sheet for Local and Libraries: the row says where, the sheet ticks
         which workspace, and `Install` is the page's only filled control -->
    <SkillInstallDialog
      v-if="installing"
      :item="installing.item"
      :from="installing.from"
      @close="installing = null"
      @installed="installing = null"
    />
  </div>
</template>
