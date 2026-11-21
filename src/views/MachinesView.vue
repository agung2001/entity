<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import UiIcon from '@/components/UiIcon.vue'
import VoxelMark from '@/components/VoxelMark.vue'
import { isEditable } from '@/lib/dom'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import { ago, hub, toast } from '@/stores/hub'
import { fleet, loadFleet, probeHost, probeState } from '@/stores/fleet'
import {
  artifactRetention,
  loadArtifactRetention,
  setArtifactRetention,
} from '@/stores/artifactRetention'
import { forgetMachineFacts, machineFactsFor, workspaces } from '@/stores/workspaces'

const props = defineProps({
  /* Rendered inside Workspace → Machines; the parent owns the page head and the
     tab strip, so this page renders from its hero down. */
  embedded: { type: Boolean, default: false },
})

/**
 * The fleet is every `Host` block in `~/.ssh/config`, plus the machine running
 * this process, plus the workspace's sync host while it is shared. Nothing is
 * attached to the workspace: a scan reads the host's harness/model inventory and
 * saves that snapshot here. No private key and no ssh config is copied.
 *
 * The page is an inventory, so it is drawn as one: a hero that states the fleet
 * once, a roster where each row answers for itself, and a rail that says what
 * the hero cannot. A failed scan explains itself in its own row — the toast is a
 * courtesy, not the record.
 */
onMounted(() => {
  loadFleet()
  loadArtifactRetention()
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const searchEl = ref(null)
const query = ref('')
const busy = ref('')
const searchKey = shortcutLabel('inventory-search')

const sweep = computed(() => artifactRetention.state)
const sweepExecutor = computed(() => sweep.value?.executor || null)
const sweepSaving = computed(() => artifactRetention.saving)
/* The executor is workspace configuration: an owner or admin changes it, and the
   change reaches every clone on the next sync. A member reads it. */
const canPickSweep = computed(() => ['owner', 'admin'].includes(String(hub.session?.role || 'owner')))
const sweepHere = computed(() => Boolean(sweepExecutor.value?.isThis))

const localHost = computed(() => ({
  alias: 'local',
  id: 'local',
  label: String(fleet.hostname || 'local').replace(/\.local$/i, ''),
  spec: fleet.hostname ? `${fleet.hostname} · local bridge` : 'localhost',
  source: 'local',
  thisMachine: true,
}))

/* The shared copy of this workspace is a machine too — the only one that can run
   a pass with no desktop open — so it gets a row like any other. It has no ssh
   host and nothing to scan, so the actions that belong to a host are absent
   rather than disabled: a button that cannot work is a question, not a control. */
const sweepHost = computed(() => ({
  alias: 'host',
  id: 'host',
  label: 'the sync host',
  spec: 'the shared copy of this workspace',
  source: 'sync',
  syncHost: true,
}))

/* `~/.ssh/config` also holds the aliases that are git remotes. They are in the
   file and they belong in the count — hiding them would be inventing a rule the
   file does not state — but they are not agent hosts, so the row says so. */
const isHostForAgents = (host) =>
  Boolean(host.thisMachine || host.syncHost || String(host.user || '').trim() === 'root' || !/^(github|gitlab|bitbucket)\./.test(String(host.hostName || '')))

const hosts = computed(() => {
  const seen = new Set()
  const list = [localHost.value, ...fleet.hosts].filter((host) => {
    const key = host.alias || host.id
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (sweepExecutor.value && sweepExecutor.value.kind !== 'local') list.push(sweepHost.value)
  return list
})

/* The sync host sits under `local`, not at the end of fifteen ssh rows: the two
   machines this app actually runs on belong together. */
const orderedHosts = computed(() => {
  const list = hosts.value
  const sync = list.find((host) => host.syncHost)
  if (!sync) return list
  const rest = list.filter((host) => !host.syncHost)
  return [...rest.slice(0, 1), sync, ...rest.slice(1)]
})

const filteredHosts = computed(() => {
  const needle = String(query.value || '').trim().toLowerCase()
  if (!needle) return orderedHosts.value
  return orderedHosts.value.filter((host) =>
    [host.alias, host.id, host.label, host.spec, host.hostName, host.user, host.source]
      .some((value) => String(value || '').toLowerCase().includes(needle)),
  )
})

const sshCount = computed(() => hosts.value.filter((host) => !host.thisMachine && !host.syncHost).length)
const syncCount = computed(() => hosts.value.filter((host) => host.syncHost).length)
const total = computed(() => hosts.value.length)

/* ── what a row says ────────────────────────────────────────────────────── */

const factFor = (alias) => machineFactsFor(alias)
const harnessCount = (alias) => factFor(alias)?.harnesses?.length || 0
const modelCount = (alias) =>
  (factFor(alias)?.harnesses || []).reduce((sum, entry) => sum + (entry.models?.length || 0), 0)
const when = (alias) => {
  const at = factFor(alias)?.checkedAt
  if (!at) return ''
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}
const probeMs = (alias) => {
  const probe = probeState(alias)
  return probe.state === 'ok' || probe.state === 'fail' ? `${probe.ms} ms` : ''
}
/* The one place the probe's own words are kept. A failure is ssh's message, not
   a translation of it, and it stays on the row so a later glance still knows. */
const probe = (alias) => probeState(alias)

const stateOf = (host) => {
  if (host.syncHost) return isSweeper(host) ? 'ok' : 'sleep'
  const probeStateHere = host.thisMachine ? 'idle' : probe(host.alias).state
  if (probeStateHere === 'testing') return 'testing'
  if (probeStateHere === 'fail') return 'fail'
  if (probeStateHere === 'ok') return 'ok'
  return factFor(host.alias) ? 'ok' : 'idle'
}
const stateWord = (host) => {
  if (host.syncHost) return isSweeper(host) ? 'sweeping' : 'available'
  if (!isHostForAgents(host)) return 'not a host'
  const state = stateOf(host)
  if (state === 'testing') return 'testing'
  if (state === 'fail') return 'unreachable'
  if (state === 'ok') return factFor(host.alias) ? 'scanned' : 'reachable'
  return 'not tested'
}

/* What the row found, or why it found nothing. The failure reason goes first
   because it is the answer to the question the row was opened with. */
const inventoryLine = (host) => {
  if (host.syncHost) return 'always on'
  const failed = probe(host.alias).state === 'fail'
  if (failed) return probe(host.alias).message || 'the scan could not run'
  if (!isHostForAgents(host)) return 'a git remote, not an agent host'
  if (host.thisMachine && !factFor(host.alias)) return 'this machine · not scanned yet'
  if (host.thisMachine && modelCount(host.alias)) {
    return `${plural(harnessCount(host.alias), 'harness', 'harnesses')} · ${plural(modelCount(host.alias), 'model', 'models')}`
  }
  if (host.thisMachine) return 'no inventory yet'
  if (factFor(host.alias)) {
    return `${plural(harnessCount(host.alias), 'harness', 'harnesses')} · ${plural(modelCount(host.alias), 'model', 'models')}`
  }
  return 'no inventory yet'
}

/* The second line: when it was read, and how long it took, or what a scan would
   do for a row that has never been read. */
const inventoryMeta = (host) => {
  if (host.syncHost) return isSweeper(host) ? 'runs the artifact pass here' : 'sweeps with no desktop open'
  const state = probe(host.alias)
  if (state.state === 'fail') {
    const kept = when(host.alias)
    return kept ? `kept from ${kept}` : 'never read here'
  }
  if (state.state === 'testing') return 'ssh is connecting…'
  if (!isHostForAgents(host)) return 'the sweep never runs on it'
  const at = when(host.alias)
  if (!at) return 'a scan stores it here'
  const ms = probeMs(host.alias)
  return ms ? `${at} · ${ms}` : at
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

/* ── the sweep ─────────────────────────────────────────────────────────── */

/** The two machines that can run a pass: this one, and the sync host. */
const sweepPickable = (host) => Boolean(host.thisMachine || host.syncHost)
/* Only `local` can be the executor *as this machine*: an ssh row is a run
   target, so it never carries the pass and must never read as if it did. */
const isSweeper = (host) =>
  host.syncHost ? sweepExecutor.value?.kind === 'host' : Boolean(host.thisMachine) && sweepHere.value
const sweepPlace = computed(
  () => sweepExecutor.value?.where || sweepExecutor.value?.label || 'no machine yet',
)

async function setSweep(kind) {
  if (!canPickSweep.value || sweepSaving.value) return
  const next = await setArtifactRetention({ executor: { kind } }, { label: kind })
  if (!next) return
  toast(
    kind === 'host'
      ? 'The sync host runs the sweep'
      : kind === 'machine'
        ? 'This machine runs the sweep'
        : "The owner's machine runs the sweep",
  )
}

/* ── reading a host ───────────────────────────────────────────────────── */

const scannedCount = computed(
  () => hosts.value.filter((host) => Boolean(machineFactsFor(host.alias))).length,
)
const untestedCount = computed(() => Math.max(0, total.value - scannedCount.value))
const scannedPercent = computed(() =>
  total.value ? Math.round((scannedCount.value / total.value) * 100) : 0,
)
const lastScan = computed(() => {
  const dates = hosts.value
    .map((host) => factFor(host.alias)?.checkedAt)
    .filter(Boolean)
    .sort()
  return dates.length ? ago(dates[dates.length - 1]) : 'never'
})

async function scan(host) {
  if (busy.value || !isHostForAgents(host)) return
  busy.value = `scan:${host.alias}`
  try {
    await probeHost(host)
    const result = probe(host.alias)
    /* The row is the record; the toast only says it finished, so it can carry no
       explanation and lose nothing. */
    toast(
      result.state === 'ok'
        ? `${host.alias} answered — its inventory is in the row`
        : `${host.alias} is unreachable — the reason is in its row`,
    )
  } finally {
    busy.value = ''
  }
}

async function forget(host) {
  if (busy.value) return
  busy.value = `forget:${host.alias}`
  try {
    await forgetMachineFacts(host.alias)
  } catch (error) {
    toast(error?.message || 'Could not remove those facts')
  } finally {
    busy.value = ''
  }
}

async function scanAll() {
  if (busy.value) return
  const rows = hosts.value.filter((host) => !host.syncHost && isHostForAgents(host))
  if (!rows.length) return
  /* One at a time: a fleet scanned in parallel is a fleet of half-open
     connections, and the rail's `Last scan` would only be the fastest of them. */
  for (const host of rows) {
    if (!busy.value) await scan(host)
  }
}

async function forgetAll() {
  if (busy.value) return
  const rows = hosts.value.filter((host) => factFor(host.alias) && !host.syncHost)
  if (!rows.length) return
  busy.value = 'forget:all'
  try {
    for (const host of rows) await forgetMachineFacts(host.alias)
  } catch (error) {
    toast(error?.message || 'Could not remove those facts')
  } finally {
    busy.value = ''
  }
}

function focusSearch() {
  const field = searchEl.value
  if (!(field instanceof HTMLInputElement)) return
  field.focus()
  field.select()
}

/* The list-search key focuses this roster. It carries a modifier, so it never
   collides with a `/` someone is typing — but a nested handler still has to
   leave a field alone, or the caret jumps out mid-address. */
function onKey(event) {
  if (!matchesShortcut('inventory-search', event)) return
  if (isEditable(event.target)) return
  event.preventDefault()
  focusSearch()
}

const machineLink = (host) => ({
  name: 'machine',
  params: { workspace: hub.workspace, id: host.alias },
})
const addressOf = (host) => host.hostName || host.spec || host.alias

/* Whether the rows are still being read. `fleet.loaded` is false until the first
   answer, so this is the only state that draws a skeleton. */
const gridStyle = computed(() =>
  fleetTracks.value ? { gridTemplateColumns: fleetTracks.value } : null,
)

const loading = computed(() => fleet.loading && !fleet.loaded)

/* ── column widths ────────────────────────────────────────────────────────
   A roster is a table, and a table's columns are the reader's business: the
   inventory is wide or narrow depending on the fleet, and the name track is the
   one that has to hold `build-box-west` and `build-box-east` apart.

   The drag handle is `AppRail`'s (`rail-resize`): pointer down, rAF-throttled
   move, `localStorage`, arrow-key nudge, double-click to reset. The difference
   is that a track's minimum is content-derived rather than a constant — the
   header's own label cannot be truncated — so `MIN` is a floor and the
   `minmax()` in CSS repeats it for the same reason. */
const FLEET_COLS_KEY = 'entity.machines.cols'
/* Four columns, the skills roster's grammar: one flexible track that eats the
   spare width, and three fixed ones. The station's tile lives inside the machine
   cell rather than in a track of its own — a 30px track and a 14px gutter is 44px
   of air spent before the name every row has to read. */
const FLEET_COLS = [
  { id: 'host', label: 'Machine', min: 220, max: 700, base: 400 },
  { id: 'state', label: 'State', min: 96, max: 240, base: 116 },
  { id: 'cap', label: 'Inventory', min: 150, max: 720, base: 260 },
  { id: 'fact', label: 'Actions', min: 124, max: 360, base: 148 },
]
const colWidths = ref(FLEET_COLS.map((col) => col.base))

function clampCol(index, width) {
  const col = FLEET_COLS[index]
  return Math.min(col.max, Math.max(col.min, Math.round(width)))
}

try {
  const stored = JSON.parse(localStorage.getItem(FLEET_COLS_KEY) || 'null')
  if (Array.isArray(stored) && stored.length === FLEET_COLS.length) {
    colWidths.value = stored.map((width, index) =>
      Number.isFinite(width) ? clampCol(index, width) : FLEET_COLS[index].base,
    )
  }
} catch {
  /* private mode, or a shape this build no longer writes: start from the base */
}

function storeCols() {
  try {
    localStorage.setItem(FLEET_COLS_KEY, JSON.stringify(colWidths.value))
  } catch {
    /* session-only */
  }
}

/* One template, so the desk and every row share it — `auto` and `max-content`
   resolve per element, which is what misaligns a header.

   It is applied through a bound style only while the five-column band is the
   one on screen. Under 460px a row is three lines in a single column, and an
   inline `grid-template-columns` outranks a container query every time: the
   handles would drag a template the layout is not using, and the row would
   scroll sideways inside its own box. */
const fleetTracks = computed(() =>
  narrow.value
    ? null
    : colWidths.value
        .map((width, index) => {
          /* Every track is `minmax(floor, ceiling)`, and the first one carries the
             flexible ceiling so it eats the spare width — the skills roster's
             shape. A drag moves a track's own bound, and on the flexible one that
             bound is its floor, so its handle is dragged with the usual
             left-is-narrower sense. */
          const floor = FLEET_COLS[index].min
          const ceiling = index === 0 ? '1fr' : `${width}px`
          return index === colWidths.value.length - 1
            ? `${width}px`
            : `minmax(${floor}px, ${ceiling})`
        })
        .join(' '),
)

/* the width the roster is drawn at: 460 is where the row stops being five cells
   (`machines-fleet.css` → the 460 breakpoint) */
const narrow = ref(false)
const shelfEl = ref(null)
const NARROW = 460
function readNarrow() {
  narrow.value = (shelfEl.value?.clientWidth || window.innerWidth) <= NARROW
}
onMounted(() => {
  readNarrow()
  window.addEventListener('resize', readNarrow)
})
onBeforeUnmount(() => window.removeEventListener('resize', readNarrow))

const resizing = ref(-1)
let dragStartX = 0
let dragStartWidth = 0
let dragWidth = 0
let dragFrame = 0

function startColResize(index, event) {
  if (event.button !== 0) return
  event.preventDefault()
  resizing.value = index
  dragStartX = event.clientX
  dragStartWidth = colWidths.value[index]
  dragWidth = dragStartWidth
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('pointermove', onColResizeMove)
  window.addEventListener('pointerup', stopColResize)
}

function onColResizeMove(event) {
  if (resizing.value < 0) return
  dragWidth = clampCol(resizing.value, dragStartWidth + event.clientX - dragStartX)
  if (dragFrame) return
  dragFrame = requestAnimationFrame(() => {
    dragFrame = 0
    if (resizing.value < 0) return
    colWidths.value = colWidths.value.map((width, index) =>
      index === resizing.value ? dragWidth : width,
    )
  })
}

function stopColResize() {
  if (dragFrame) cancelAnimationFrame(dragFrame)
  dragFrame = 0
  if (resizing.value < 0) return
  resizing.value = -1
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  window.removeEventListener('pointermove', onColResizeMove)
  window.removeEventListener('pointerup', stopColResize)
  storeCols()
}

/* the keyboard's share: a handle is a control, so arrows must move it too */
function nudgeCol(index, event) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  colWidths.value = colWidths.value.map((width, i) =>
    i === index ? clampCol(index, width + (event.key === 'ArrowRight' ? 12 : -12)) : width,
  )
  storeCols()
}

function resetCols() {
  colWidths.value = FLEET_COLS.map((col) => col.base)
  storeCols()
}

onBeforeUnmount(() => stopColResize())
</script>

<template>
  <!-- `.entp-bar` and `.mach-shelf` are **siblings**, and both are direct children
       of the parent's `.detail-view` — exactly the shape `EntityDetailView` has.
       `directory.css` gives every `.detail-view` child the reading measure and a
       `20px auto 0` margin, so wrapping the page in one element of its own turned
       the bar into one of those children: 20px of gap under the top bar, and a
       28px inset instead of a bar that runs the window's full width. -->
  <div class="entp-bar">
    <router-link
      class="back"
      :to="{ name: 'workspace', params: { workspace: hub.workspace }, query: { tab: 'machines' } }"
    >
      <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
        <path d="M7.5 2.5L4 6l3.5 3.5" />
      </svg>
      Settings
    </router-link>
    <span class="entp-crumb">Machines</span>
    <span class="spacer"></span>

    <!-- The page's three verbs. `Test every host` carries the host count because
         "every" is the question it answers; `Forget every fact` carries the
         scanned count for the same reason. -->
    <div class="entp-actions">
      <button
        class="btn btn-sm"
        type="button"
        :disabled="fleet.loading"
        title="Read ~/.ssh/config again"
        @click="loadFleet()"
      >
        <UiIcon name="refresh" />
        {{ fleet.loading ? 'Reading…' : 'Reload' }}
      </button>
      <button
        class="btn btn-sm"
        type="button"
        :disabled="Boolean(busy) || !sshCount || loading"
        :title="`Test every host in ${fleet.displayPath}`"
        @click="scanAll"
      >
        <UiIcon name="refresh-double" />
        {{ busy && !busy.startsWith('scan:') ? 'Working…' : 'Test every host' }}
        <kbd class="btn-kbd">{{ hosts.length - syncCount }}</kbd>
      </button>
      <button
        class="btn btn-sm"
        type="button"
        :disabled="Boolean(busy) || !scannedCount"
        :title="`Forget every fact this copy kept — ${scannedCount} of ${total}`"
        @click="forgetAll"
      >
        <UiIcon name="trash" />
        Forget every fact
        <kbd class="btn-kbd">{{ scannedCount || '0' }}</kbd>
      </button>
    </div>
  </div>

  <section class="mach-shelf" ref="shelfEl">
    <!-- ── the hero ────────────────────────────────────────────────────
         The entity page's cabinet, saying the fleet's one sentence. The mark slot
         holds the workspace's space station rather than a character: a fleet is a
         place, and this page is about where work can run.

         `--hero` is what the cabinet mixes its paper, its grid and its shadow
         from (`backdrops.css`). The entity page sets it from the character's
         mark; a fleet has no character, so it is the workspace accent. Without it
         every `color-mix(in oklab, var(--hero) …)` declaration is invalid and
         the hero falls back to `background: none` — a white rectangle. -->
    <section class="entp-hero" style="--hero: var(--accent)" aria-labelledby="machines-title">
      <div class="entp-hero-inner">
        <header class="entp-idhead">
          <span class="mach-mark" aria-hidden="true">
            <VoxelMark shape="station" />
          </span>
          <div class="entp-title">
            <p class="eyebrow">Workspace · {{ hub.workspaceLabel || hub.workspace }}</p>
            <h1 id="machines-title">Machines</h1>
            <p class="entp-desc">
              Every host in <code class="mono">{{ fleet.displayPath }}</code>, plus this
              machine — and the workspace's sync host while it is shared. Testing a host
              stores its harness and model inventory in this workspace. No private key or
              ssh config is copied.
            </p>
            <div class="entp-chips">
              <span class="entp-chip" :data-s="scannedCount ? 'ok' : null">
                {{ plural(scannedCount, 'scanned', 'scanned') }}
              </span>
              <span class="entp-chip">{{ plural(sshCount, 'ssh host', 'ssh hosts') }}</span>
              <span v-if="syncCount" class="entp-chip">
                {{ plural(syncCount, 'sync host', 'sync hosts') }}
              </span>
              <span v-if="factFor('local')" class="entp-chip">
                {{ plural(harnessCount('local'), 'harness', 'harnesses') }} on local
              </span>
            </div>
          </div>
        </header>

        <!-- The fleet counter takes the level card's slot. Two clocks, like the
             entity page: the total on the left, and how much of it has an
             inventory on the right. It is drawn from first paint — only the
             *scanned* half waits for a read, because a zero before the read would
             claim nothing has ever been scanned. -->
        <aside
          class="entp-xp"
          :aria-label="`${total} machines, ${scannedCount} scanned, ${untestedCount} untested`"
        >
          <div class="entp-lv">
            <span>FLEET</span>
            <b>{{ total }}</b>
          </div>
          <div class="entp-xp-main">
            <div class="entp-xp-head">
              <span>Inventoried</span>
              <b>{{ scannedCount }} / {{ total }}</b>
            </div>
            <div
              class="entp-xp-track"
              role="progressbar"
              aria-valuemin="0"
              :aria-valuemax="total || 1"
              :aria-valuenow="scannedCount"
              :aria-valuetext="`${scannedCount} of ${total} machines have an inventory`"
            >
              <i :style="{ width: `${scannedPercent}%` }"></i>
            </div>
            <div class="entp-xp-foot">
              <span>{{ plural(scannedCount, 'scanned', 'scanned') }}</span>
              <span>{{ plural(untestedCount, 'untested', 'untested') }}</span>
            </div>
          </div>
        </aside>
      </div>
    </section>

    <!-- ── the fleet at a glance ──────────────────────────────────────
         This was the entity page's reading rail: a 306px column that took a third
         of the band from the roster and repeated what the hero and the rows
         already said. It is a row now, above the table, so the roster can use the
         whole measure — same `entp-facts` grammar, laid horizontally. -->
    <section class="mach-strip" aria-label="This fleet">
      <dl class="mach-facts">
        <div>
          <dt>Local</dt>
          <dd class="mono" :title="fleet.hostname">{{ localHost.label }}</dd>
        </div>
        <div>
          <dt>Config</dt>
          <dd class="mono" :title="fleet.configPath || fleet.displayPath">
            {{ fleet.displayPath }}
          </dd>
        </div>
        <div>
          <dt>Hosts</dt>
          <dd>
            {{ plural(sshCount, 'ssh', 'ssh') }} · {{ plural(1, 'local', 'local') }}<template
              v-if="syncCount"
            > · {{ plural(syncCount, 'sync', 'sync') }}</template>
          </dd>
        </div>
        <div>
          <dt>Scanned</dt>
          <dd>{{ scannedCount }} of {{ total }}</dd>
        </div>
        <div>
          <dt>Sweep runs on</dt>
          <dd :title="sweepPlace">{{ sweepPlace }}</dd>
        </div>
        <div>
          <dt>Last scan</dt>
          <dd>{{ lastScan }}</dd>
        </div>
      </dl>
    </section>

    <section class="entp-sec">
      <!-- No section head. "The fleet · 16 of 16" sat between the facts row and
           the field, saying what the hero, the counter and the facts row have
           already said three times, and charging a heading's worth of gap for it.
           The count is in the hero's counter; the roster needs no title. -->
      <!-- The roster's one search field, at the band's full width: it is the
           page's only filter. -->
      <div class="mbar">
        <label class="wsl-search">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <circle cx="7" cy="7" r="4.6" />
            <path d="M10.4 10.4L14 14" />
          </svg>
          <input
            id="inventory-search"
            ref="searchEl"
            v-model="query"
            type="search"
            placeholder="Search machines"
            aria-label="Search machines"
            autocomplete="off"
            spellcheck="false"
          />
          <kbd class="search-kbd" aria-hidden="true">{{ searchKey }}</kbd>
        </label>
      </div>

      <!-- Nobody has claimed the sweep. The line names the rule, not the bug: the
           first machine an owner opens the app on takes it. -->
      <div
        v-if="sweepExecutor && sweepExecutor.kind !== 'local' && !sweepExecutor.claimed"
        class="role-line"
        role="status"
      >
        <span class="role-badge">sweep</span>
        <span>
          No machine runs the artifact sweep yet. The first machine the workspace owner
          opens Entity on takes it — or pick it in a row below.
        </span>
      </div>

      <!-- ── the roster: one bounded scroll area ───────────────────────
           Precedence is explicit, and it is the only place the states disagree:
           error > empty > no-results > the rows. -->
      <div v-if="loading" class="mftable">
        <div class="mftable-scroll">
          <div class="mfhead" aria-hidden="true">
            <span></span><span>Machine</span><span>State</span>
            <span>Inventory</span><span>Actions</span>
          </div>
          <div
            v-for="n in 3"
            :key="n"
            class="mrow"
            :style="gridStyle"
          >
            <span class="mvslot"><span class="mskel btn"></span></span>
            <span class="mfhost">
              <b><span class="mskel nm"></span></b>
              <span class="mskel addr"></span>
            </span>
            <span class="mskel dot"></span>
            <span class="mfcap">
              <span class="mskel line"></span>
              <span class="mskel line short"></span>
            </span>
            <span class="mfact"><span class="mskel btn"></span></span>
          </div>
        </div>
      </div>

      <div v-else-if="fleet.error" class="empty-note err">
        <b>The ssh config could not be read.</b>
        <span class="mono">{{ fleet.error }}</span>
        <button class="btn btn-sm" type="button" @click="loadFleet()">Try again</button>
      </div>

      <div v-else-if="!fleet.exists" class="empty-note">
        <b>No Host blocks in {{ fleet.displayPath }} yet.</b>
        <span>Local still works; add a host there and reload to test a remote machine.</span>
        <button class="btn btn-sm" type="button" @click="loadFleet()">
          Reload {{ fleet.displayPath }}
        </button>
      </div>

      <div v-else-if="query && !filteredHosts.length" class="empty-note">
        <b>No machine matches “{{ query.trim() }}”.</b>
        <button class="btn btn-sm" type="button" @click="query = ''">
          Clear the search
        </button>
      </div>

      <div v-else class="mftable" role="table" aria-label="The machines in this fleet">
        <div class="mftable-scroll">
          <!-- The desk carries the resize handles, because it is the only row
               that is always fully visible (the data rows scroll under it). A
               handle is a real `<button>`: it takes focus, arrows nudge it 12px
               and a double-click puts every column back. -->
          <div class="mfhead" role="row" :style="gridStyle">
            <template v-for="(col, index) in FLEET_COLS" :key="col.id">
              <span
                role="columnheader"
                :class="`c${index}`"
                :title="`${col.label} — drag the edge to resize`"
              >{{ col.label }}</span>
              <!-- The handle is pinned to the column's own cell, because a grid
                   puts every child in flow: two `position: absolute` handles
                   without an offset both resolve against the desk and land on top
                   of each other, which is how the first drag moved Actions
                   instead of Machine. -->
              <span class="col-grip-cell" :class="`g${index}`" aria-hidden="true">
                <button
                  class="col-grip"
                  type="button"
                  :aria-label="`Resize the ${col.label} column`"
                  :title="`Drag to resize ${col.label} · double-click to reset every column`"
                  :aria-valuemin="col.min"
                  :aria-valuemax="col.max"
                  :aria-valuenow="colWidths[index]"
                  role="separator"
                  aria-orientation="vertical"
                  :data-resizing="resizing === index ? '1' : null"
                  @pointerdown="startColResize(index, $event)"
                  @keydown="nudgeCol(index, $event)"
                  @dblclick="resetCols"
                ></button>
              </span>
            </template>
          </div>

          <!-- A row is always exactly five children, in this order: the station's
               tile, the host, its state, its inventory and its actions. The grid
               depends on that order, so a row never reflows. -->
          <div
            v-for="host in filteredHosts"
            :key="host.alias"
            class="mrow"
            :data-probe="stateOf(host)"
            :data-host="isHostForAgents(host) ? '1' : '0'"
            :aria-current="host.thisMachine ? 'true' : null"
            :style="gridStyle"
            role="row"
          >
            <span class="mfhost" role="cell">
              <!-- the station's tile rides inside this cell, the way a skill's
                   sigil rides inside `.skt .nm` — one track for the name and its
                   glyph, not two -->
              <span
                class="mvslot"
                :data-kind="host.syncHost ? 'sync' : host.thisMachine ? undefined : 'ssh'"
                aria-hidden="true"
              >
                <VoxelMark shape="station" />
              </span>
              <span class="mfhost-text">
              <!-- `DESIGN.md` → "The name is the link, the row is not." The name
                   is what a person aims at, so the name is what goes; the row
                   wraps buttons, so it cannot be an anchor itself. A host that is
                   not a run target (a git remote) keeps the same layout and simply
                   has no name to click. -->
              <b>
                <router-link
                  v-if="isHostForAgents(host)"
                  class="nm"
                  :to="machineLink(host)"
                  :title="`Open ${host.alias}`"
                >
                  {{ host.label }}</router-link>
                <span v-else class="nm">{{ host.label }}</span>
                <span v-if="host.thisMachine" class="tag">this machine</span>
                <span v-else-if="host.syncHost" class="tag">sync host</span>
                <span v-else class="tag">ssh</span>
                <span v-if="!isHostForAgents(host)" class="tag">git</span>
              </b>
                <!-- The address says where the link goes; it is not a second one. -->
                <span class="addr">
                  {{ addressOf(host) }}
                  <template v-if="host.user"> · {{ host.user }}</template>
                  <template v-if="host.port"> · port {{ host.port }}</template>
                </span>
              </span>
            </span>

            <span class="state" :data-s="stateOf(host)" role="cell">
              <i></i>{{ stateWord(host) }}
            </span>

            <!-- The reason a row is red lives here. That was the defect in the
                 gallery: the answer arrived as a toast and then was gone. -->
            <span class="mfcap" role="cell">
              <span
                class="l1"
                :data-fail="probe(host.alias).state === 'fail' ? '1' : null"
                :title="inventoryLine(host)"
              >{{ inventoryLine(host) }}</span>
              <span class="l2" :title="inventoryMeta(host)">{{ inventoryMeta(host) }}</span>
            </span>

            <span class="mfact" role="cell">
              <!-- The sweep control exists on the two machines that can run a pass,
                   and reads as a word on the rest. A member sees the same words, so
                   nothing fails after a click. -->
              <template v-if="sweepPickable(host)">
                <button
                  v-if="canPickSweep"
                  class="btn btn-sm"
                  type="button"
                  :aria-pressed="isSweeper(host) ? 'true' : 'false'"
                  :disabled="sweepSaving || isSweeper(host)"
                  :title="
                    isSweeper(host)
                      ? 'This machine runs the artifact sweep'
                      : 'Run the artifact archive and delete passes on this machine'
                  "
                  @click="setSweep(host.syncHost ? 'host' : 'machine')"
                >
                  {{
                    sweepSaving ? 'Saving…' : isSweeper(host) ? 'Sweeping here' : 'Sweep here'
                  }}
                </button>
                <span
                  v-else
                  class="owner-word"
                  :title="
                    isSweeper(host)
                      ? 'Chosen by the workspace owner'
                      : 'Only a workspace owner or admin can move the sweep'
                  "
                >
                  {{ isSweeper(host) ? 'sweeping here' : 'owner decides' }}
                </span>
              </template>

              <template v-if="!host.syncHost">
                <!-- this machine is the one row a person opens constantly, so it
                     keeps the word; an ssh row is one of fourteen and gets the same
                     action as an arrow -->
                <router-link
                  v-if="isHostForAgents(host) && host.thisMachine"
                  class="btn btn-sm"
                  :to="machineLink(host)"
                  :title="`Open ${host.alias}`"
                >Open</router-link>
                <router-link
                  v-else-if="isHostForAgents(host)"
                  class="ibtn"
                  :to="machineLink(host)"
                  :title="`Open ${host.alias}`"
                  :aria-label="`Open ${host.alias}`"
                >
                  <UiIcon name="nav-arrow-right" size="14" />
                </router-link>
                <span v-else class="owner-word">owner decides</span>

                <!-- An ssh row carries three actions, because scanning it costs a
                     connection and forgetting it is how you undo that. This machine
                     needs neither: `local` is always available, and a re-scan
                     replaces its facts. -->
                <template v-if="isHostForAgents(host) && !host.thisMachine">
                  <button
                    v-if="!factFor(host.alias) || probe(host.alias).state === 'fail'"
                    class="btn btn-sm"
                    type="button"
                    :disabled="Boolean(busy)"
                    :title="`Test and scan ${host.alias}`"
                    @click="scan(host)"
                  >
                    {{ busy === `scan:${host.alias}` ? 'Scanning…' : 'Test & scan' }}
                  </button>
                  <button
                    v-else
                    class="ibtn"
                    type="button"
                    :disabled="Boolean(busy)"
                    :title="`Test and scan ${host.alias}`"
                    :aria-label="`Test and scan ${host.alias}`"
                    @click="scan(host)"
                  >
                    <UiIcon name="scanning" size="14" />
                  </button>
                  <button
                    v-if="factFor(host.alias)"
                    class="ibtn"
                    type="button"
                    :disabled="Boolean(busy)"
                    :title="`Forget the facts kept about ${host.alias}`"
                    :aria-label="`Forget the facts kept about ${host.alias}`"
                    @click="forget(host)"
                  >
                    <UiIcon name="trash" size="14" />
                  </button>
                </template>
              </template>
            </span>
          </div>
        </div>
      </div>
    </section>
  </section>
</template>
