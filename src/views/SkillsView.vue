<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import PixelBackdrop from '@/components/PixelBackdrop.vue'
import SkillCopyDialog from '@/components/SkillCopyDialog.vue'
import VoxelMark from '@/components/VoxelMark.vue'
import { COLORS } from '@/composables/entityMark'
import { useDialogDismiss } from '@/composables/useDialog'
import { call } from '@/composables/localBridge'
import { copyText } from '@/lib/clipboard'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import { hub, toast } from '@/stores/hub'
import {
  attachSkill,
  detachSkill,
  loadLibrary,
  workspaces,
} from '@/stores/workspaces'

const props = defineProps({
  /* Rendered inside Workspace → Skills; the hero is the page head either way. */
  embedded: { type: Boolean, default: false },
})

/**
 * One page, two scopes — workspace first.
 *
 * `workspace` is intent: the skills this workspace owns (real copies). It is drawn
 * as a dense table, because a roster is an inventory and a card grid gives a
 * two-line description the height of a card.
 *
 * `harness libraries` is discovery: every skill each harness on this machine
 * already carries, read from `~/.pi`, `~/.claude`, `~/.codex`, … Scanning all of
 * them walks six directory trees, so it is paid for only when that scope is
 * opened, and the result is cached for the session.
 */
const tab = ref('workspace')
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

/* lazy: nothing is scanned until the library scope is actually shown, and a
   half-armed row is dropped when the scope changes under it */
watch(tab, (value) => {
  confirming.value = ''
  closeMenu()
  if (value === 'library' && !workspaces.library) loadLibrary()
})

const library = computed(() => workspaces.library)
const items = computed(() => workspaces.skills)

const attachedNames = computed(
  () => new Set(items.value.map((item) => item.name.toLowerCase())),
)

const filters = computed(() => [
  { id: 'all', label: 'All', count: library.value?.count || 0 },
  ...(library.value?.harnesses || [])
    .filter((entry) => entry.count > 0)
    .map((entry) => ({ id: entry.id, label: entry.label, count: entry.count })),
])

const visibleLibrary = computed(() => {
  const all = library.value?.items || []
  if (harness.value === 'all') return all
  return all.filter((item) => item.harness === harness.value)
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
const shelf = computed(() => (tab.value === 'library' ? visibleLibrary.value : items.value))

/**
 * Search over everything the row can show, not just the name: a person hunting a
 * skill often remembers what it does ("youTrack", "vault") rather than its folder.
 */
const rows = computed(() => {
  const needle = query.value.trim().toLowerCase()
  const list = shelf.value.map((item) => ({ ...item, sig: sigil(item.name) }))
  if (!needle) return list
  return list.filter((item) =>
    [item.name, item.description, item.path, item.size, item.harnessLabel]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(needle),
  )
})

const scopeTotal = computed(() =>
  tab.value === 'library' ? library.value?.count || 0 : items.value.length,
)

/* a name that is not a slash token would resolve to nothing, so it gets no call
   sign at all — the typeahead in the composer accepts nothing else */
const isCallable = (name) => /^[A-Za-z0-9._-]+$/.test(String(name || ''))
const callSign = (name) => `/workspace:${name}`

const missing = computed(() => items.value.filter((item) => item.missing).length)

/* the library total, once the lazy scan has answered — 0 is a real answer
   ("this machine has no libraries") and is told apart from "not scanned" */
const libraryTotal = computed(() => {
  if (!library.value || library.value.error) return 0
  return library.value.count || 0
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

/* how many copies of one name live in the harness libraries: `general-video` is
   in three and `cua-driver` in two, and three identical rows cannot say which
   `Attach` is which */
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
  if (item.description) return item.description
  return tab.value === 'library'
    ? 'Its SKILL.md frontmatter carries no description.'
    : 'Attached skill. Its frontmatter has no description.'
}

const footerNote = computed(
  () =>
    `${items.value.length} ${items.value.length === 1 ? 'skill' : 'skills'} · ${bytes(totalBytes.value)}`,
)

const skeleton = computed(() =>
  tab.value === 'workspace' ? loading.value : !library.value,
)

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
            placeholder="Search name, description or path…"
            :aria-label="
              tab === 'library'
                ? 'Search skills in the harness libraries on this machine'
                : 'Search skills in this workspace'
            "
            spellcheck="false"
          />
          <kbd class="sksearch-key search-kbd" aria-hidden="true">{{ searchKey }}</kbd>
        </label>

        <div class="sk-seg" role="group" aria-label="Skill scope">
          <button
            type="button"
            :aria-pressed="tab === 'workspace' ? 'true' : 'false'"
            @click="tab = 'workspace'"
          >
            Workspace <span>{{ items.length }}</span>
          </button>
          <button
            type="button"
            :aria-pressed="tab === 'library' ? 'true' : 'false'"
            @click="tab = 'library'"
          >
            Harness libraries
            <span v-if="libraryTotal">{{ libraryTotal }}</span>
          </button>
        </div>

        <span class="skbar-where">{{ rows.length }} of {{ scopeTotal }}</span>
      </div>

      <!-- the real grid while the read is in flight, so nothing jumps when it
           answers: a skeleton row is the same height as a one-line row -->
      <div
        v-if="skeleton"
        class="skt"
        role="table"
        aria-busy="true"
        :aria-label="tab === 'library' ? 'Skills in the harness libraries on this machine' : 'Skills attached to this workspace'"
      >
        <div class="row head" role="row">
          <span class="k1" role="columnheader">Skill</span>
          <span class="k2" role="columnheader">Files</span>
          <span class="k3" role="columnheader">{{ tab === 'library' ? 'Version · age' : 'Updated' }}</span>
          <span class="acts-head k4" role="columnheader">
            {{ tab === 'library' ? 'Actions' : 'Call · actions' }}
          </span>
        </div>
        <div v-for="n in 3" :key="n" class="row" role="row" aria-hidden="true">
          <div class="nm k1" role="cell">
            <span class="sig-tile sk"></span>
            <span class="sk" :style="{ display: 'block', width: `${64 - n * 6}px`, height: '11px' }"></span>
          </div>
          <!-- one description line, exactly: 1.4em of --fs-secondary, so the
               skeleton row measures the same 69px as a real one-line row -->
          <p class="d k1" role="cell">
            <span class="sk" :style="{ display: 'block', height: '1.4em', width: `${72 - n * 8}%` }"></span>
          </p>
          <span class="files k2" role="cell">
            <span class="sk" style="display: inline-block; height: 10px; width: 52px"></span>
          </span>
          <span class="upd k3" role="cell">
            <span class="sk" style="display: inline-block; height: 10px; width: 38px"></span>
          </span>
          <div class="acts k4" role="cell">
            <span class="sk" style="height: 26px; width: 132px"></span>
            <span class="sk" style="height: 26px; width: 26px"></span>
          </div>
        </div>
      </div>

      <template v-else-if="tab === 'workspace'">
        <div v-if="loadError" class="empty-note err" role="alert">
          <b>Could not read {{ hub.workspacePath }}/skills.</b>
          <span class="mono">{{ loadError }}</span>
          <div class="empty-actions">
            <button class="btn btn-sm" type="button" @click="refresh">Try again</button>
          </div>
        </div>

        <div v-else-if="!items.length" class="empty-note">
          <b>No skills in this workspace yet.</b>
          <span>
            Attaching a skill copies it into this workspace, so a backup or another
            machine takes it along.
          </span>
          <div class="empty-actions">
            <button class="btn btn-sm" type="button" @click="tab = 'library'">
              Open the harness libraries
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
              <span class="k2" role="columnheader">Files</span>
              <span class="k3" role="columnheader">Updated</span>
              <span class="acts-head k4" role="columnheader">Call · actions</span>
            </div>

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
                <router-link
                  class="nm-t"
                  :title="item.name"
                  :to="{ name: 'skill', params: { workspace: hub.workspace, name: item.name } }"
                >
                  {{ item.name }}
                </router-link>
              </div>

              <p class="d k1" role="cell" :title="item.description || ''">
                {{ descriptionOf(item) }}
              </p>

              <span class="files k2" role="cell">
                {{ item.missing ? '—' : `${item.files || 0} · ${item.size || '—'}` }}
              </span>
              <span class="upd k3" role="cell">
                {{ item.missing ? '—' : when(item.updatedAt) }}
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

          <p class="skfoot">
            <span class="mono">{{ hub.workspacePath }}/skills</span>
            <span>{{ footerNote }}</span>
          </p>
        </template>
      </template>

      <template v-else>
        <div v-if="library.error" class="empty-note err" role="alert">
          <b>{{ library.error }}</b>
          <span>The harness libraries on this machine could not be read.</span>
          <div class="empty-actions">
            <button class="btn btn-sm" type="button" @click="loadLibrary({ force: true })">
              Try again
            </button>
          </div>
        </div>

        <template v-else>
          <div class="lib-bar">
            <div class="hints" role="group" aria-label="Filter by harness">
              <button
                v-for="f in filters"
                :key="f.id"
                class="hint"
                type="button"
                :aria-pressed="harness === f.id ? 'true' : 'false'"
                @click="harness = f.id"
              >
                <HarnessIcon :name="f.id" />
                {{ f.label }} <span class="hint-n">{{ f.count }}</span>
              </button>
            </div>
          </div>

          <div
            v-if="rows.length"
            class="skt lib-t"
            role="table"
            aria-label="Skills in the harness libraries on this machine"
           
          >
            <div class="row head" role="row">
              <span class="k1" role="columnheader">Skill</span>
              <span class="k2" role="columnheader">Files</span>
              <span class="k3" role="columnheader">Version · age</span>
              <span class="acts-head k4" role="columnheader">Actions</span>
            </div>

            <div
              v-for="item in rows"
              :key="item.id || item.name"
              class="row lib"
              :class="{ on: isAttached(item) }"
              role="row"
              tabindex="0"
            >
              <div class="nm k1" role="cell">
                <!-- on a harness shelf the question is "which harness carries
                     this", so the row wears that harness's own mark -->
                <span class="sig-tile" :title="item.harnessLabel">
                  <HarnessIcon :name="item.harness" :size="14" />
                </span>
                <span class="nm-stack">
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
                    <!-- three identical `general-video` rows cannot say which
                         Attach is which; the badge names the copies -->
                    <span
                      v-if="copies(item.name) > 1"
                      class="dupe"
                      :title="`${copies(item.name)} copies of this skill on this machine`"
                    >
                      {{ copies(item.name) }} copies
                    </span>
                  </span>
                  <span class="path" :title="item.path">{{ item.path }}</span>
                </span>
              </div>

              <p class="d k1" role="cell" :title="item.description || ''">
                {{ descriptionOf(item) }}
              </p>

              <span class="files k2" role="cell">{{ item.files || 0 }} · {{ item.size || '—' }}</span>
              <span class="upd k3" role="cell">{{ item.version || when(item.updatedAt) }}</span>

              <div class="acts k4" role="cell">
                <button
                  v-if="!isAttached(item)"
                  class="btn btn-sm"
                  type="button"
                  :disabled="busy === busyKey(item)"
                  :title="`Attach ${item.name} to this workspace`"
                  :aria-label="`Attach ${item.name} to this workspace`"
                  @click="attach(item)"
                >
                  {{ busy === busyKey(item) ? 'Attaching…' : 'Attach' }}
                </button>
                <span v-else class="on-badge"><i></i>attached</span>
              </div>
            </div>
          </div>

          <div v-else class="empty-note">
            <b>No skills in this harness library.</b>
            <span v-if="harness !== 'all'">Switch to All, or add a skill directory for it.</span>
            <span v-else>No harness skill directories were found on this machine.</span>
          </div>
        </template>
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
  </div>
</template>
