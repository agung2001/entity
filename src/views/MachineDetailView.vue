<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import HarnessIcon from '@/components/HarnessIcon.vue'
import PixelBackdrop from '@/components/PixelBackdrop.vue'
import VoxelMark from '@/components/VoxelMark.vue'
import { call } from '@/composables/localBridge'
import { isEditable } from '@/lib/dom'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import { fleet, loadFleet, probeHost, probeState } from '@/stores/fleet'
import { harnesses, loadHarnesses } from '@/stores/harnesses'
import { hub, toast } from '@/stores/hub'
import { forgetMachineFacts, machineFactsFor, workspaces } from '@/stores/workspaces'

/**
 * One host, drawn as the third detail page: the same shell as an entity, a
 * five-section report on what a single read-only pass found, and a roster of
 * the harnesses that pass could see with their models one click away.
 *
 * The page answers three questions without a scroll — can this host run agents,
 * with what, and how stale is that answer — and it never draws a section it did
 * not read: a field the probe could not fill leaves its group `null` and the
 * panel becomes the dashed honesty note. An empty cron table would read as "no
 * cron jobs", which is a different sentence.
 */
const route = useRoute()
const router = useRouter()
const busy = ref('')
const query = ref('')
const section = ref('overview')
const searchEl = ref(null)
const tablistEl = ref(null)
const searchKey = shortcutLabel('inventory-search')

const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'cron', label: 'Cron' },
  { id: 'docker', label: 'Docker' },
  { id: 'skills', label: 'Skills' },
  { id: 'orca', label: 'Orca' },
]
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const EMPTY_REPORT = {
  version: 1,
  overview: null,
  cron: null,
  docker: null,
  skills: null,
  orca: null,
  errors: {},
}
/* A section's own honesty note: what *this* probe does not collect, in the same
   voice as the page. Never advice, never a bare "unavailable". */
const SECTION_GAP = {
  overview:
    'The scan reads five sections in one pass. A field the probe could not read leaves its line out rather than showing a zero.',
  cron: 'Cron reads schedules and command lines only. Exit codes and last-run times are not collected, so a failing entry looks the same as a healthy one.',
  docker: 'This page reads Docker; it never restarts or stops a container.',
  skills:
    'Skills on a host belong to that host. Attaching one from here would change it, so this page only reads them.',
  orca: 'Orca belongs to the Orca app on this machine, which owns the SSH tunnel. If that app stops, this section is the first to go; the other four still read over ssh.',
}

onMounted(() => {
  loadFleet()
  loadHarnesses()
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const alias = computed(() => String(route.params.id || ''))
const isLocal = computed(() => alias.value === 'local')
const host = computed(
  () =>
    fleet.hosts.find(
      (entry) =>
        entry.alias === alias.value ||
        entry.id === alias.value ||
        entry.aliases?.includes(alias.value),
    ) || null,
)
const facts = computed(() => machineFactsFor(alias.value))
const label = computed(
  () =>
    (isLocal.value
      ? String(fleet.hostname || 'local').replace(/\.local$/i, '')
      : host.value?.label) || alias.value,
)
const spec = computed(() => (isLocal.value ? fleet.hostname || 'localhost' : host.value?.spec || ''))
const identity = computed(() => host.value?.identityFile || '')
const missing = computed(() => !isLocal.value && !host.value)
const probe = computed(() => probeState(alias.value))
const heroColor = 'var(--accent)'

const stateName = computed(() => {
  if (isLocal.value) return facts.value ? 'ok' : 'idle'
  if (missing.value) return 'sleep'
  if (probe.value.state === 'ok' || probe.value.state === 'fail' || probe.value.state === 'testing') {
    return probe.value.state
  }
  return facts.value ? 'ok' : 'idle'
})
const stateLabel = computed(() => {
  if (isLocal.value) return facts.value ? 'scanned' : 'online'
  if (missing.value) return 'missing'
  if (probe.value.state === 'ok') return 'scanned'
  if (probe.value.state === 'fail') return 'unreachable'
  if (probe.value.state === 'testing') return 'testing'
  return facts.value ? 'scanned earlier' : 'not tested'
})

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`
const stamp = (date) =>
  `${String(date.getDate()).padStart(2, '0')} ${MONTHS[date.getMonth()]} ${date.getFullYear()}, ` +
  `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
const gib = (kb) => (Number(kb) / 1024 / 1024).toFixed(1)
const share = (part, whole) =>
  Number(whole) > 0 ? Math.round((Number(part) / Number(whole)) * 100) : 0
const slice = (list, limit) => (Array.isArray(list) ? list.slice(0, limit) : [])

const scannedAt = computed(() => {
  const at = facts.value?.checkedAt
  if (!at) return ''
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? '' : stamp(date)
})
const readAt = computed(() => scannedAt.value || 'not read')
const took = computed(() => {
  const ms = Number(facts.value?.durationMs || 0)
  return ms > 0 ? `${(ms / 1000).toFixed(1)} s` : ''
})
/* The tile shows the age; the absolute stamp rides underneath it, because a page
   that says "today" about a stored timestamp is guessing. */
const age = computed(() => {
  const at = Date.parse(facts.value?.checkedAt || '')
  if (Number.isNaN(at)) return ''
  const hours = (Date.now() - at) / 3_600_000
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} m`
  if (hours < 48) return `${Math.round(hours)} h`
  return `${Math.round(hours / 24)} d`
})
const modelCount = computed(
  () => (facts.value?.harnesses || []).reduce((sum, entry) => sum + entry.models.length, 0),
)
const foundHarnesses = computed(() => facts.value?.harnesses || [])
const foundCount = computed(() => foundHarnesses.value.length)
const reportingCount = computed(() => foundHarnesses.value.filter((entry) => entry.models.length).length)

/* The eight CLIs this app knows about come from the harness store rather than a
   literal: "3 of 8 known" has to survive a ninth harness being added. */
const knownHarnesses = computed(() => harnesses.items || [])
const knownTotal = computed(() => knownHarnesses.value.length)
const missingKnown = computed(() => {
  const found = new Set(foundHarnesses.value.map((entry) => entry.id))
  return knownHarnesses.value.filter((entry) => !found.has(entry.id)).map((entry) => entry.label)
})
const foundIds = computed(() => foundHarnesses.value.map((entry) => entry.id).join(' · '))

const report = computed(() => facts.value?.report || EMPTY_REPORT)
const tab = (id, label, count, extra = {}) => ({ id, label, count, ...extra })
const tabs = computed(() => {
  const open = report.value.orca ? report.value.orca.anomalies.length : 0
  return {
    overview: tab('overview', 'Overview', null),
    cron: tab('cron', 'Cron', report.value.cron ? report.value.cron.entries.length : 0),
    docker: tab(
      'docker',
      'Docker',
      report.value.docker ? report.value.docker.containers.length : 0,
    ),
    skills: tab('skills', 'Skills', report.value.skills ? report.value.skills.total : 0),
    /* One badges its Orca tab the same way: open anomalies are a warning the
       member should see before opening the section, not a failure. */
    orca: tab('orca', 'Orca', open, { warn: open > 0 }),
  }
})
const selected = (id) => (section.value === id ? 'true' : 'false')
const tabStop = (id) => (section.value === id ? 0 : -1)

/* ── the overview panel ─────────────────────────────────────────────────── */
const disks = computed(() => report.value.overview?.disks || [])
const fullest = computed(() =>
  disks.value.reduce(
    (worst, row) => ((row.usePct ?? 0) > (worst?.usePct ?? -1) ? row : worst),
    null,
  ),
)
const memUsed = computed(() => {
  const overview = report.value.overview
  if (!overview || !overview.memTotalKb) return null
  return Math.max(0, overview.memTotalKb - (overview.memAvailKb || 0))
})
const memPercent = computed(() =>
  memUsed.value === null ? 0 : share(memUsed.value, report.value.overview.memTotalKb),
)
const swapUsed = computed(() => {
  const overview = report.value.overview
  if (!overview || !overview.swapTotalKb) return null
  return Math.max(0, overview.swapTotalKb - (overview.swapFreeKb || 0))
})
const swapPercent = computed(() =>
  swapUsed.value === null ? 0 : share(swapUsed.value, report.value.overview.swapTotalKb),
)
const uptimeText = computed(() => {
  const seconds = Number(report.value.overview?.uptimeSec || 0)
  if (!seconds) return ''
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  return days ? `${days} d ${hours} h` : `${hours} h ${Math.floor((seconds % 3_600) / 60)} m`
})

/* ── the cron panel ─────────────────────────────────────────────────────── */
const CRON_SHORTHAND = {
  '@yearly': 'yearly',
  '@annually': 'yearly',
  '@monthly': 'monthly',
  '@weekly': 'weekly',
  '@daily': 'daily',
  '@midnight': 'daily',
  '@hourly': 'hourly',
  '@reboot': 'at boot',
}

/* The expression alone is not readable at a glance and a sentence alone hides
   what was written, so a cron row carries both. Only the plain shapes are
   translated: a list of days is shown as written rather than guessed at. */
function cadence(schedule) {
  const text = String(schedule || '').trim()
  if (CRON_SHORTHAND[text]) return CRON_SHORTHAND[text]
  const parts = text.split(/\s+/)
  if (parts.length !== 5) return ''
  const [minute, hour, day, month, weekday] = parts
  if (minute.startsWith('*/')) return `every ${minute.slice(2)} m`
  if (/^\d+$/.test(minute) && hour.startsWith('*/')) return `every ${hour.slice(2)} h`
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    const at = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
    if (weekday !== '*') return `weekly, ${at}`
    if (day !== '*' && month === '*') return `monthly, day ${day}, ${at}`
    if (day === '*' && month === '*') return `daily, ${at}`
    return at
  }
  return ''
}

const cronEntries = computed(() => report.value.cron?.entries || [])
const cronTimers = computed(() => report.value.cron?.timers || [])
const cronBars = computed(() => {
  const counts = new Map()
  for (const entry of cronEntries.value) {
    const rhythm = cadence(entry.schedule) || entry.schedule
    counts.set(rhythm, (counts.get(rhythm) || 0) + 1)
  }
  const list = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  const most = list[0]?.[1] || 1
  return list.map(([label, count]) => ({ label, count, width: `${Math.round((count / most) * 100)}%` }))
})

/* ── the docker panel ───────────────────────────────────────────────────── */
const containers = computed(() => report.value.docker?.containers || [])
const containerSplit = computed(() => {
  const tally = { running: 0, paused: 0, stopped: 0 }
  for (const entry of containers.value) {
    const state = String(entry.state || '').toLowerCase()
    if (state === 'running') tally.running += 1
    else if (state === 'paused') tally.paused += 1
    else tally.stopped += 1
  }
  return tally
})
const containerTotal = computed(() => containers.value.length)

/* ── the skills panel ───────────────────────────────────────────────────── */
const skillRoots = computed(() => report.value.skills?.roots || [])
const skillGroups = computed(() =>
  skillRoots.value.map((root) => {
    const items = (report.value.skills?.items || []).filter((item) => item.root === root.path)
    return {
      path: root.path,
      skills: root.count,
      described: items.filter((item) => item.described).length,
    }
  }),
)
const undescribed = computed(() => (report.value.skills?.items || []).filter((item) => !item.described))
const skillBars = computed(() => [...skillGroups.value].sort((a, b) => b.skills - a.skills).slice(0, 5))
/* A skill root is an absolute path on someone else's host. The column shows the
   home-relative tail so four roots fit; the full path stays in `title`. */
const rootName = (path) => String(path || '').replace(/^\/(Users|home)\/[^/]+/, '~')

/* A docker reference is `host:port/repo:tag`; the tag is what follows the last
   colon, but only when that colon is to the right of the last slash. */
const tagOf = (ref) => {
  const text = String(ref || '')
  const at = text.lastIndexOf(':')
  return at > text.lastIndexOf('/') ? text.slice(at + 1) : '—'
}
const repoOf = (ref) => {
  const text = String(ref || '')
  const at = text.lastIndexOf(':')
  return at > text.lastIndexOf('/') ? text.slice(0, at) : text
}

/* ── the orca panel ─────────────────────────────────────────────────────── */
const worktrees = computed(() => report.value.orca?.rows || [])
const anomalies = computed(() => report.value.orca?.anomalies || [])
const terminals = computed(() => report.value.orca?.terminals || [])

/* One search box for both axes: a person may remember a harness, a binary path
   or a model id, and should not have to scan hundreds of ids to find it. */
const matchingModels = (entry) => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return entry.models || []
  const harnessText = [entry.id, entry.label, entry.path, entry.default]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  if (harnessText.includes(needle)) return entry.models || []
  return (entry.models || []).filter((model) => model.toLowerCase().includes(needle))
}

const matchesHarness = (entry) => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return true
  const harnessText = [entry.id, entry.label, entry.path, entry.default]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return (
    harnessText.includes(needle) ||
    (entry.models || []).some((model) => model.toLowerCase().includes(needle))
  )
}

const filteredHarnesses = computed(() => foundHarnesses.value.filter(matchesHarness))
const visibleModelCount = computed(() =>
  filteredHarnesses.value.reduce((sum, entry) => sum + matchingModels(entry).length, 0),
)

const railFacts = computed(() =>
  [
    { label: 'Host', value: alias.value, mono: true },
    { label: 'Address', value: isLocal.value ? 'this machine' : spec.value, mono: true },
    {
      label: 'Source',
      value: isLocal.value ? 'the local process' : host.value?.source || fleet.displayPath,
      mono: true,
    },
    { label: 'Identity', value: identity.value, mono: true },
    { label: 'Jump', value: host.value?.proxyJump || '', mono: true },
    { label: 'Aliases', value: (host.value?.aliases || []).join(', '), mono: true },
    {
      label: 'Host name',
      value: facts.value?.hostname || (isLocal.value ? fleet.hostname : ''),
      mono: true,
    },
    {
      label: 'Platform',
      value: [facts.value?.platform, facts.value?.arch].filter(Boolean).join(' '),
      mono: true,
    },
    {
      label: 'Last test',
      value: probe.value.ms ? `${probe.value.ms} ms · ${probe.value.message}` : '',
      mono: false,
    },
  ].filter((row) => String(row.value || '').trim()),
)

const sourceLabel = (entry) => {
  if (entry.source === 'cli') return 'listed by the CLI'
  if (entry.source === 'config') return 'configured default only'
  if (!entry.models?.length) return 'no models reported'
  return 'not in PATH'
}

async function scan() {
  if (busy.value || missing.value) return
  busy.value = 'scan'
  try {
    await probeHost(isLocal.value ? { alias: 'local' } : host.value)
    const next = probeState(alias.value)
    if (next.state === 'ok') toast(`${alias.value} scanned`)
    else toast(next.message || `${alias.value} could not be scanned`)
  } finally {
    busy.value = ''
  }
}

async function forget() {
  if (busy.value) return
  busy.value = 'forget'
  try {
    await forgetMachineFacts(alias.value)
  } catch (error) {
    toast(error?.message || 'Could not remove those facts')
  } finally {
    busy.value = ''
  }
}

/* `Reload` re-reads the ssh config and this workspace's stored snapshot. It is
   not a scan: nothing here touches a host. */
async function reload() {
  if (busy.value) return
  busy.value = 'reload'
  try {
    await loadFleet()
    workspaces.facts = await call('workspace.machineFacts', { id: workspaces.active })
  } catch (error) {
    toast(error?.message || 'Could not reread this workspace')
  } finally {
    busy.value = ''
  }
}

async function copyAlias() {
  try {
    await navigator.clipboard.writeText(alias.value)
    toast('Alias copied')
  } catch {
    toast('Could not copy the alias')
  }
}

/* The renderer never sends a path: the main process knows where ~/.ssh/config
   is and reveals that file. In a browser build the call rejects into a toast. */
async function revealConfig() {
  try {
    await call('fleet.reveal')
  } catch (error) {
    toast(error?.message || `Could not reveal ${fleet.displayPath}`)
  }
}

function focusSearch() {
  const field = searchEl.value
  if (!(field instanceof HTMLInputElement)) return
  field.focus()
  field.select()
}

/* The list-search key carries a modifier, so it cannot collide with a `/`
   someone is typing — but a nested handler still has to leave a field alone, or
   the caret jumps out mid-address. */
function onKey(event) {
  if (!matchesShortcut('inventory-search', event)) return
  if (isEditable(event.target)) return
  event.preventDefault()
  focusSearch()
}

/* Arrow keys select, because the panel below swaps rather than navigates: a
   manual-activation tablist would make the member press Enter twice per
   section. Focus follows selection. */
function tabKey(event) {
  const index = SECTIONS.findIndex((entry) => entry.id === section.value)
  if (index < 0) return
  let next = null
  if (event.key === 'ArrowRight') next = (index + 1) % SECTIONS.length
  else if (event.key === 'ArrowLeft') next = (index - 1 + SECTIONS.length) % SECTIONS.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = SECTIONS.length - 1
  else return
  event.preventDefault()
  section.value = SECTIONS[next].id
  nextTick(() => tablistEl.value?.querySelectorAll('[role="tab"]')[next]?.focus())
}
</script>

<template>
  <div class="view detail-view">
    <div class="entp-bar">
      <button
        class="back"
        type="button"
        @click="router.push({ name: 'machines', params: { workspace: hub.workspace } })"
      >
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6">
          <path d="M7.5 2.5L4 6l3.5 3.5" />
        </svg>
        Machines
      </button>
      <span class="entp-crumb">{{ alias }}</span>
      <span class="spacer"></span>
      <div class="entp-actions">
        <button class="btn" type="button" :disabled="Boolean(busy) || missing" @click="reload">
          {{ busy === 'reload' ? 'Reading…' : 'Reload' }}
        </button>
        <button class="btn btn-ink" type="button" :disabled="Boolean(busy) || missing" @click="scan">
          {{ busy === 'scan' ? 'Testing…' : 'Test & scan' }}
        </button>
        <button v-if="facts" class="btn" type="button" :disabled="Boolean(busy)" @click="forget">
          Forget facts
        </button>
      </div>
    </div>

    <section class="entp-hero" :style="{ '--hero': heroColor }" aria-labelledby="m-title">
      <PixelBackdrop variant="hero" :color="heroColor" :count="18" />
      <div class="entp-hero-inner">
        <header class="entp-idhead">
          <span class="hero-mark" aria-hidden="true"><VoxelMark shape="station" /></span>
          <div class="entp-title">
            <p class="eyebrow">Machine · {{ hub.workspaceLabel || hub.workspace }}</p>
            <h1 id="m-title">{{ label }}</h1>
            <p class="entp-desc">
              {{
                isLocal
                  ? 'This machine. Harnesses are read from its PATH; nothing is sent anywhere.'
                  : `An ssh host from ${fleet.displayPath}. Read by an explicit test, kept in this copy of the workspace.`
              }}
            </p>
            <div class="entp-chips">
              <span class="state" :data-s="stateName"><i></i>{{ stateLabel }}</span>
              <span v-if="facts?.platform" class="entp-chip">
                {{ facts.platform }} · {{ facts.arch }}
              </span>
              <span v-if="facts" class="entp-chip">
                {{ plural(foundCount, 'harness', 'harnesses') }}
              </span>
              <span v-if="modelCount" class="entp-chip">
                {{ plural(modelCount, 'model', 'models') }}
              </span>
              <span v-if="facts" class="entp-chip">read {{ readAt }}</span>
            </div>
          </div>
        </header>

        <aside
          class="entp-xp"
          title="Known harnesses this host reports."
          :aria-label="`Inventory: ${foundCount} of ${knownTotal} known harnesses reported, ${modelCount} models.`"
        >
          <div class="entp-lv"><span>INV</span><b>{{ facts ? foundCount : '—' }}</b></div>
          <div class="entp-xp-main">
            <div class="entp-xp-head">
              <span>Harnesses found</span>
              <b>{{ facts ? `${foundCount} / ${knownTotal} known` : '—' }}</b>
            </div>
            <div
              v-if="facts && knownTotal"
              class="entp-xp-track"
              role="progressbar"
              aria-valuemin="0"
              :aria-valuemax="knownTotal"
              :aria-valuenow="foundCount"
              :aria-valuetext="`${foundCount} of ${knownTotal} known harnesses reported`"
            >
              <i :style="{ width: `${share(foundCount, knownTotal)}%` }"></i>
            </div>
            <div class="entp-xp-foot">
              <span>{{ plural(modelCount, 'model', 'models') }}</span>
              <span>{{ took ? `scan took ${took}` : 'not scanned here' }}</span>
            </div>
          </div>
        </aside>
      </div>
    </section>

    <div v-if="missing" class="empty-note">
      <b>{{ fleet.error || `${alias} is not in ${fleet.displayPath}.` }}</b>
      <span>The facts this workspace kept are still here; the host block is gone.</span>
      <router-link :to="{ name: 'machines', params: { workspace: hub.workspace } }">
        Back to the fleet
      </router-link>
      <button v-if="facts" class="btn" type="button" :disabled="Boolean(busy)" @click="forget">
        Forget facts
      </button>
    </div>

    <div v-else-if="!fleet.loaded && !fleet.error" class="empty-note"><b>Reading the fleet…</b></div>

    <div v-else class="entp-grid">
      <div class="entp-main">
        <section class="entp-sec">
          <div class="entp-sec-head">
            <h2>Report</h2>
            <span class="n">
              5 sections · 1 pass<template v-if="took"> · {{ took }}</template>
              <template v-if="facts"> · read {{ readAt }}</template>
            </span>
          </div>

          <dl class="rep-grid">
            <div class="rep">
              <dt>Harnesses</dt>
              <dd>{{ foundCount }} <u>of {{ knownTotal }} known</u></dd>
              <span class="sub" :title="foundIds || 'none reported'">
                {{ foundIds || 'none reported' }}
              </span>
            </div>
            <div class="rep">
              <dt>Models</dt>
              <dd>{{ modelCount }} <u>reported</u></dd>
              <span class="sub">
                {{ plural(reportingCount, 'harness listed', 'harnesses listed') }} a model
              </span>
            </div>
            <div class="rep">
              <dt>Last read</dt>
              <dd>{{ age || '—' }} <u v-if="age">ago</u></dd>
              <span class="sub">{{ scannedAt || 'no pass yet' }}</span>
            </div>
            <div class="rep">
              <dt>Took</dt>
              <dd>{{ took ? took.replace(' s', '') : '—' }} <u v-if="took">s</u></dd>
              <span class="sub">{{ isLocal ? 'local, one pass' : 'ssh, one pass' }}</span>
            </div>
          </dl>

          <div
            ref="tablistEl"
            class="rpt-tabs"
            role="tablist"
            aria-label="Host report sections"
            @keydown="tabKey"
          >
            <button
              id="rep-tab-overview"
              type="button"
              role="tab"
              :aria-selected="selected('overview')"
              :tabindex="tabStop('overview')"
              aria-controls="rep-panel"
              @click="section = 'overview'"
            >
              Overview
            </button>
            <button
              id="rep-tab-cron"
              type="button"
              role="tab"
              :aria-selected="selected('cron')"
              :tabindex="tabStop('cron')"
              aria-controls="rep-panel"
              @click="section = 'cron'"
            >
              Cron <b>{{ tabs.cron.count }}</b>
            </button>
            <button
              id="rep-tab-docker"
              type="button"
              role="tab"
              :aria-selected="selected('docker')"
              :tabindex="tabStop('docker')"
              aria-controls="rep-panel"
              @click="section = 'docker'"
            >
              Docker <b>{{ tabs.docker.count }}</b>
            </button>
            <button
              id="rep-tab-skills"
              type="button"
              role="tab"
              :aria-selected="selected('skills')"
              :tabindex="tabStop('skills')"
              aria-controls="rep-panel"
              @click="section = 'skills'"
            >
              Skills <b>{{ tabs.skills.count }}</b>
            </button>
            <button
              id="rep-tab-orca"
              type="button"
              role="tab"
              :aria-selected="selected('orca')"
              :tabindex="tabStop('orca')"
              aria-controls="rep-panel"
              @click="section = 'orca'"
            >
              Orca <b :data-s="tabs.orca.warn ? 'warn' : null">{{ tabs.orca.count }}</b>
            </button>
          </div>

          <div id="rep-panel" role="tabpanel" :aria-labelledby="`rep-tab-${section}`">
            <!-- ── overview ─────────────────────────────────────────────── -->
            <template v-if="section === 'overview'">
              <template v-if="report.overview">
                <dl class="rep-grid">
                  <div class="rep">
                    <dt>Uptime</dt>
                    <dd>{{ uptimeText || '—' }}</dd>
                    <span class="sub">
                      {{
                        report.overview.bootedAt
                          ? `since ${report.overview.bootedAt}`
                          : 'boot time not read'
                      }}
                    </span>
                  </div>
                  <div class="rep">
                    <dt>Load · 1 m</dt>
                    <dd>{{ report.overview.load1 ?? '—' }}</dd>
                    <span class="sub">
                      5 m {{ report.overview.load5 ?? '—' }} · 15 m
                      {{ report.overview.load15 ?? '—' }} ·
                      {{ plural(report.overview.cores ?? 0, 'core', 'cores') }}
                    </span>
                  </div>
                  <div class="rep">
                    <dt>Memory</dt>
                    <dd>{{ memPercent }} <u>%</u></dd>
                    <span class="sub">
                      {{
                        memUsed === null
                          ? 'not read'
                          : `${gib(memUsed)} of ${gib(report.overview.memTotalKb)} GiB used`
                      }}
                    </span>
                  </div>
                  <div class="rep">
                    <dt>Fullest disk</dt>
                    <dd
                      :class="{ use: (fullest?.usePct ?? 0) >= 80 }"
                      :data-tone="(fullest?.usePct ?? 0) >= 80 ? 'warn' : null"
                    >
                      {{ fullest?.usePct ?? '—' }} <u>%</u>
                    </dd>
                    <span class="sub">
                      {{
                        fullest
                          ? `${fullest.mount} · ${fullest.used} of ${fullest.size}`
                          : 'no mount read'
                      }}
                    </span>
                  </div>
                </dl>

                <div class="rpt-cols">
                  <div class="rcard">
                    <h3>Memory and swap <b>{{ report.overview.os || 'host' }}</b></h3>
                    <div class="mtr-row">
                      <b>RAM</b>
                      <span
                        class="mtr"
                        :data-tone="memPercent >= 90 ? 'full' : null"
                        role="img"
                        :aria-label="`${gib(memUsed || 0)} of ${gib(report.overview.memTotalKb)} GiB used, ${memPercent} percent`"
                      ><i :style="{ width: `${memPercent}%` }"></i></span>
                      <span class="v">
                        {{ gib(memUsed || 0) }} / {{ gib(report.overview.memTotalKb) }} GiB
                      </span>
                    </div>
                    <div class="mtr-row">
                      <b>Swap</b>
                      <span
                        class="mtr"
                        role="img"
                        :aria-label="`${gib(swapUsed || 0)} of ${gib(report.overview.swapTotalKb || 0)} GiB used, ${swapPercent} percent`"
                      ><i :style="{ width: `${swapPercent}%` }"></i></span>
                      <span class="v">
                        {{ gib(swapUsed || 0) }} / {{ gib(report.overview.swapTotalKb || 0) }} GiB
                      </span>
                    </div>
                    <div v-if="fullest" class="mtr-row">
                      <b :title="fullest.mount">{{ fullest.mount }}</b>
                      <span
                        class="mtr"
                        :data-tone="(fullest.usePct ?? 0) >= 80 ? 'warn' : null"
                        role="img"
                        :aria-label="`${fullest.used} of ${fullest.size} used, ${fullest.usePct} percent`"
                      ><i :style="{ width: `${fullest.usePct ?? 0}%` }"></i></span>
                      <span class="v">{{ fullest.used }} / {{ fullest.size }}</span>
                    </div>
                    <p class="rnote">
                      {{ report.overview.kernel || 'kernel not read' }} ·
                      {{ report.overview.cpu || 'CPU not read' }} · clock
                      {{ report.overview.clock || '—' }}
                    </p>
                  </div>
                  <div class="rcard">
                    <h3>Host <b>{{ took ? `probed once, ${took}` : 'probed once' }}</b></h3>
                    <dl class="minifacts">
                      <div>
                        <dt>Kernel</dt>
                        <dd :title="report.overview.kernel">{{ report.overview.kernel || '—' }}</dd>
                      </div>
                      <div><dt>Arch</dt><dd>{{ facts?.arch || '—' }}</dd></div>
                      <div>
                        <dt>CPU</dt>
                        <dd :title="report.overview.cpu">{{ report.overview.cpu || '—' }}</dd>
                      </div>
                      <div><dt>Cores</dt><dd>{{ report.overview.cores ?? '—' }}</dd></div>
                      <div><dt>Booted</dt><dd>{{ report.overview.bootedAt || '—' }}</dd></div>
                      <div><dt>Clock</dt><dd>{{ report.overview.clock || '—' }}</dd></div>
                      <div>
                        <dt>Host name</dt>
                        <dd :title="facts?.hostname">{{ facts?.hostname || '—' }}</dd>
                      </div>
                      <div><dt>OS</dt><dd :title="report.overview.os">{{ report.overview.os || '—' }}</dd></div>
                    </dl>
                  </div>
                </div>

                <div class="rtbl">
                  <div class="rtbl-cap">
                    <span>Disks</span><b>{{ plural(disks.length, 'mount', 'mounts') }} · df -h</b>
                  </div>
                  <div class="rtbl-scroll">
                    <div class="rtr rtr--head rt-disk">
                      <span>Mount</span><span>Fs</span><span class="r">Used</span>
                      <span class="r">Size</span><span class="r">Free</span><span class="r">%</span>
                    </div>
                    <div v-for="row in disks" :key="row.mount" class="rtr rt-disk">
                      <span :title="row.mount"><code>{{ row.mount }}</code></span>
                      <span :title="row.fs"><code>{{ row.fs }}</code></span>
                      <span class="r">{{ row.used }}</span>
                      <span class="r">{{ row.size }}</span>
                      <span class="r">{{ row.avail }}</span>
                      <span
                        class="r"
                        :class="{ use: (row.usePct ?? 0) >= 80 }"
                        :data-tone="(row.usePct ?? 0) >= 80 ? 'warn' : null"
                      >{{ row.usePct ?? '—' }}</span>
                    </div>
                  </div>
                </div>
              </template>
              <p v-else class="rpt-gap">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                  <circle cx="8" cy="8" r="6.2" /><path d="M8 7.2v4M8 4.9v.1" />
                </svg>
                <span>
                  <b>Overview was not read this pass.</b>
                  {{
                    report.errors.overview ||
                    'The uptime, load, memory and disk probes did not answer, so nothing is drawn here rather than drawing zeros.'
                  }}
                </span>
              </p>
              <p v-if="report.overview" class="rpt-gap">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                  <circle cx="8" cy="8" r="6.2" /><path d="M8 7.2v4M8 4.9v.1" />
                </svg>
                <span>{{ SECTION_GAP.overview }}</span>
              </p>
            </template>

            <!-- ── cron ─────────────────────────────────────────────────── -->
            <template v-else-if="section === 'cron'">
              <div v-if="report.cron" class="rcard">
                <h3>
                  Cron
                  <b>
                    {{ plural(cronEntries.length, 'entry', 'entries') }} ·
                    {{ plural(cronTimers.length, 'timer', 'timers') }} ·
                    {{ plural(report.cron.users, 'user', 'users') }} ·
                    {{ plural(report.cron.files, 'file', 'files') }}
                  </b>
                </h3>
                <ul v-if="cronBars.length" class="bars">
                  <li v-for="row in cronBars" :key="row.label">
                    <span :title="row.label">{{ row.label }}</span>
                    <span class="b"><i :style="{ width: row.width }"></i></span>
                    <b>{{ row.count }}</b>
                  </li>
                </ul>
                <div v-if="cronEntries.length" class="rtbl">
                  <div class="rtbl-scroll">
                    <div class="rtr rtr--head rt-cron">
                      <span>Schedule</span><span>User</span><span>Source</span><span>Command</span>
                    </div>
                    <div
                      v-for="(entry, index) in slice(cronEntries, 6)"
                      :key="`${entry.schedule}-${index}`"
                      class="rtr rt-cron"
                    >
                      <span :title="entry.schedule">
                        <code>{{ entry.schedule }}</code>
                        <template v-if="cadence(entry.schedule)">
                          <br /><span class="mnote">{{ cadence(entry.schedule) }}</span>
                        </template>
                      </span>
                      <span :title="entry.user"><code>{{ entry.user || '—' }}</code></span>
                      <span>
                        <span class="bdg" :data-s="entry.source === 'user' ? 'ok' : null">
                          {{ entry.source }}
                        </span>
                      </span>
                      <span :title="entry.command"><code>{{ entry.command }}</code></span>
                    </div>
                  </div>
                  <div v-if="cronEntries.length > 6" class="rtbl-foot">
                    Showing 6 of {{ cronEntries.length }} rows
                  </div>
                </div>
                <div v-if="cronTimers.length" class="rtbl">
                  <div class="rtbl-cap">
                    <span>Timers</span><b>systemd · {{ cronTimers.length }}</b>
                  </div>
                  <div class="rtbl-scroll">
                    <div class="rtr rtr--head rt-timer"><span>Unit</span><span>Next run</span></div>
                    <div v-for="timer in slice(cronTimers, 6)" :key="timer.unit" class="rtr rt-timer">
                      <span :title="timer.unit"><code>{{ timer.unit }}</code></span>
                      <span>{{ timer.next || '—' }}</span>
                    </div>
                  </div>
                  <div v-if="cronTimers.length > 6" class="rtbl-foot">
                    Showing 6 of {{ cronTimers.length }} rows
                  </div>
                </div>
                <p class="rpt-gap">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                    <circle cx="8" cy="8" r="6.2" /><path d="M8 7.2v4M8 4.9v.1" />
                  </svg>
                  <span>{{ SECTION_GAP.cron }}</span>
                </p>
              </div>
              <p v-else class="rpt-gap">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                  <circle cx="8" cy="8" r="6.2" /><path d="M8 7.2v4M8 4.9v.1" />
                </svg>
                <span>
                  <b>Cron was not read this pass.</b>
                  {{
                    report.errors.cron ||
                    'No crontab, no /etc/crontab and no systemd timers answered on this host.'
                  }}
                </span>
              </p>
            </template>

            <!-- ── docker ───────────────────────────────────────────────── -->
            <template v-else-if="section === 'docker'">
              <div v-if="report.docker" class="rcard">
                <h3>
                  Docker
                  <b>
                    {{ plural(containerTotal, 'container', 'containers') }} ·
                    {{ plural(report.docker.images.length, 'image', 'images') }}
                    <template v-if="report.docker.version"> · {{ report.docker.version }}</template>
                  </b>
                </h3>
                <div class="mtr-row">
                  <b>Of {{ containerTotal }}</b>
                  <span
                    class="segbar"
                    role="img"
                    :aria-label="`${containerSplit.running} running, ${containerSplit.paused} paused, ${containerSplit.stopped} stopped`"
                  >
                    <i
                      data-s="run"
                      :style="{ width: `${share(containerSplit.running, containerTotal || 1)}%` }"
                    ></i>
                    <i
                      data-s="pause"
                      :style="{ width: `${share(containerSplit.paused, containerTotal || 1)}%` }"
                    ></i>
                    <i
                      data-s="stop"
                      :style="{ width: `${share(containerSplit.stopped, containerTotal || 1)}%` }"
                    ></i>
                  </span>
                  <span class="v">
                    {{ containerSplit.running }} · {{ containerSplit.paused }} ·
                    {{ containerSplit.stopped }}
                  </span>
                </div>
                <p class="rnote">
                  <b>{{ plural(containerSplit.running, 'running', 'running') }}</b> ·
                  {{ containerSplit.paused }} paused · {{ containerSplit.stopped }} stopped ·
                  docker {{ report.docker.version || 'version not read' }}
                </p>
                <div v-if="containerTotal" class="rtbl">
                  <div class="rtbl-cap"><span>Containers</span><b>docker ps -a</b></div>
                  <div class="rtbl-scroll">
                    <div class="rtr rtr--head rt-docker">
                      <span>Name</span><span>Image</span><span>State</span>
                      <span>Ports · status</span><span>Uptime</span>
                    </div>
                    <div v-for="entry in slice(containers, 5)" :key="entry.name" class="rtr rt-docker">
                      <span :title="entry.name"><code>{{ entry.name }}</code></span>
                      <span :title="entry.image"><code>{{ entry.image }}</code></span>
                      <span>
                        <span
                          class="bdg"
                          :data-s="entry.state === 'running' ? 'ok' : entry.state === 'paused' ? 'warn' : null"
                        >{{ entry.state }}</span>
                      </span>
                      <span :title="entry.ports">{{ entry.ports || '—' }}</span>
                      <span :title="entry.uptime">{{ entry.uptime || '—' }}</span>
                    </div>
                  </div>
                  <div v-if="containerTotal > 5" class="rtbl-foot">
                    Showing 5 of {{ containerTotal }} rows
                  </div>
                </div>
                <div class="rpt-cols">
                  <div class="rtbl">
                    <div class="rtbl-cap">
                      <span>Images</span><b>{{ report.docker.images.length }} tagged locally</b>
                    </div>
                    <div class="rtbl-scroll">
                      <div class="rtr rtr--head rt-image">
                        <span>Repository</span><span class="r">Tag</span><span class="r">Size</span>
                      </div>
                      <div
                        v-for="entry in slice(report.docker.images, 5)"
                        :key="entry.ref"
                        class="rtr rt-image"
                      >
                        <span :title="entry.ref">
                          <code>{{ repoOf(entry.ref) }}</code>
                        </span>
                        <span class="r">{{ tagOf(entry.ref) }}</span>
                        <span class="r">{{ entry.size }}</span>
                      </div>
                    </div>
                  </div>
                  <div class="rtbl">
                    <div class="rtbl-cap"><span>Docker disk</span><b>docker system df</b></div>
                    <div class="rtbl-scroll">
                      <div class="rtr rtr--head rt-ddisk">
                        <span>Type</span><span class="r">Count</span><span class="r">Size</span>
                        <span class="r">Reclaimable</span>
                      </div>
                      <div v-for="entry in report.docker.disk" :key="entry.type" class="rtr rt-ddisk">
                        <span>{{ entry.type }}</span>
                        <span class="r">{{ entry.count ?? '—' }}</span>
                        <span class="r">{{ entry.size || '—' }}</span>
                        <span class="r">{{ entry.reclaimable || '—' }}</span>
                      </div>
                    </div>
                  </div>
                </div>
                <p class="rpt-gap">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                    <circle cx="8" cy="8" r="6.2" /><path d="M8 7.2v4M8 4.9v.1" />
                  </svg>
                  <span>{{ SECTION_GAP.docker }}</span>
                </p>
              </div>
              <p v-else class="rpt-gap">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                  <circle cx="8" cy="8" r="6.2" /><path d="M8 7.2v4M8 4.9v.1" />
                </svg>
                <span>
                  <b>Docker was not read this pass.</b>
                  {{
                    report.errors.docker ||
                    'No docker binary, or its daemon did not answer, so no container table is drawn.'
                  }}
                </span>
              </p>
            </template>

            <!-- ── skills ───────────────────────────────────────────────── -->
            <template v-else-if="section === 'skills'">
              <div v-if="report.skills" class="rcard">
                <h3>
                  Skills
                  <b>
                    {{ plural(report.skills.total, 'skill', 'skills') }} ·
                    {{ plural(report.skills.roots.length, 'root', 'roots') }}
                  </b>
                </h3>
                <dl class="minifacts">
                  <div><dt>Roots scanned</dt><dd>{{ report.skills.roots.length }}</dd></div>
                  <div><dt>Total skills</dt><dd>{{ report.skills.total }}</dd></div>
                  <div><dt>Profiles</dt><dd>{{ skillGroups.length }}</dd></div>
                  <div>
                    <dt>Described</dt>
                    <dd>{{ report.skills.described }} of {{ report.skills.total }}</dd>
                  </div>
                </dl>
                <div v-if="skillGroups.length" class="rtbl">
                  <div class="rtbl-scroll">
                    <div class="rtr rtr--head rt-skill">
                      <span>Group</span><span class="r">Skills</span><span>Described</span>
                    </div>
                    <div v-for="group in skillGroups" :key="group.path" class="rtr rt-skill">
                      <span :title="group.path"><code>{{ rootName(group.path) }}</code></span>
                      <span class="r">{{ group.skills }}</span>
                      <span :title="`${group.described} of ${group.skills} carry a description`">
                        {{ group.described }} of {{ group.skills }}
                      </span>
                    </div>
                  </div>
                </div>
                <div class="rpt-cols">
                  <div class="rtbl">
                    <div class="rtbl-cap">
                      <span>Largest group</span>
                      <b>{{ skillBars[0]?.skills || 0 }} of {{ report.skills.total }}</b>
                    </div>
                    <div class="rtbl-scroll">
                      <div class="rtr rtr--head rt-timer">
                        <span>Group</span><span class="r">Skills</span>
                      </div>
                      <div v-for="row in skillBars" :key="row.path" class="rtr rt-timer">
                        <span :title="row.path"><code>{{ rootName(row.path) }}</code></span>
                        <span class="r">{{ row.skills }}</span>
                      </div>
                    </div>
                  </div>
                  <div class="rtbl">
                    <div class="rtbl-cap">
                      <span>Undescribed</span>
                      <b>{{ plural(undescribed.length, 'skill', 'skills') }}</b>
                    </div>
                    <div class="rtbl-scroll">
                      <div class="rtr rtr--head rt-timer"><span>Skill</span><span>Group</span></div>
                      <div
                        v-for="item in slice(undescribed, 6)"
                        :key="`${item.root}/${item.name}`"
                        class="rtr rt-timer"
                      >
                        <span :title="item.name"><code>{{ item.name }}</code></span>
                        <span :title="item.root">{{ rootName(item.root) }}</span>
                      </div>
                      <div v-if="!undescribed.length" class="rtr rt-timer">
                        <span>Every skill on this host has a description.</span><span></span>
                      </div>
                    </div>
                    <div v-if="undescribed.length > 6" class="rtbl-foot">
                      Showing 6 of {{ undescribed.length }} rows
                    </div>
                  </div>
                </div>
                <p class="rpt-gap">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                    <circle cx="8" cy="8" r="6.2" /><path d="M8 7.2v4M8 4.9v.1" />
                  </svg>
                  <span>{{ SECTION_GAP.skills }}</span>
                </p>
              </div>
              <p v-else class="rpt-gap">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                  <circle cx="8" cy="8" r="6.2" /><path d="M8 7.2v4M8 4.9v.1" />
                </svg>
                <span>
                  <b>Skills were not read this pass.</b>
                  {{
                    report.errors.skills ||
                    'None of the skill roots this scan knows about exist on this host, so no library is drawn.'
                  }}
                </span>
              </p>
            </template>

            <!-- ── orca ─────────────────────────────────────────────────── -->
            <template v-else>
              <div v-if="report.orca" class="rcard">
                <h3>
                  Orca
                  <b>
                    {{ report.orca.reachable || 'not reachable' }}
                    <template v-if="report.orca.version"> · {{ report.orca.version }}</template>
                  </b>
                </h3>
                <dl class="minifacts">
                  <div><dt>Runtime</dt><dd>{{ report.orca.reachable || '—' }}</dd></div>
                  <div><dt>State</dt><dd>{{ report.orca.state || '—' }}</dd></div>
                  <div>
                    <dt>Connection</dt>
                    <dd :title="report.orca.connection">{{ report.orca.connection || '—' }}</dd>
                  </div>
                  <div>
                    <dt>Runtime id</dt>
                    <dd :title="report.orca.runtimeId">{{ report.orca.runtimeId || '—' }}</dd>
                  </div>
                  <div><dt>Worktrees</dt><dd>{{ report.orca.worktrees ?? '—' }}</dd></div>
                  <div><dt>Working agents</dt><dd>{{ report.orca.agents ?? '—' }}</dd></div>
                  <div>
                    <dt>Terminals</dt>
                    <dd>
                      {{ report.orca.terminalsConnected ?? '—' }} of
                      {{ report.orca.terminalsTotal ?? '—' }}
                    </dd>
                  </div>
                  <div><dt>Host memory</dt><dd>{{ report.orca.hostMemory ?? '—' }}</dd></div>
                </dl>

                <div v-if="worktrees.length" class="rtbl">
                  <div class="rtbl-cap">
                    <span>Worktrees</span><b>{{ worktrees.length }} of {{ worktrees.length }} rows</b>
                  </div>
                  <div class="rtbl-scroll">
                    <div class="rtr rtr--head rt-work">
                      <span>Worktree</span><span>Branch</span><span>State</span>
                    </div>
                    <div
                      v-for="row in slice(worktrees, 6)"
                      :key="`${row.path}-${row.branch}`"
                      class="rtr rt-work"
                    >
                      <span :title="row.path"><code>{{ row.path }}</code></span>
                      <span :title="row.branch"><code>{{ row.branch || '—' }}</code></span>
                      <span>
                        <span
                          class="bdg"
                          :data-s="['running', 'working', 'in-progress'].includes(row.state) ? 'ok' : row.state === 'detached' ? 'fail' : null"
                        >{{ row.state || 'unknown' }}</span>
                      </span>
                    </div>
                  </div>
                  <div v-if="worktrees.length > 6" class="rtbl-foot">
                    Showing 6 of {{ worktrees.length }} rows
                  </div>
                </div>

                <div v-if="anomalies.length" class="rtbl">
                  <div class="rtbl-cap">
                    <span>Anomalies</span><b>{{ plural(anomalies.length, 'found', 'found') }}</b>
                  </div>
                  <div class="rtbl-scroll">
                    <div class="rtr rtr--head rt-anom">
                      <span>Entity</span><span>Type</span><span>Detail</span>
                    </div>
                    <div
                      v-for="(row, index) in slice(anomalies, 6)"
                      :key="`${row.entity}-${index}`"
                      class="rtr rt-anom"
                    >
                      <span :title="row.entity"><code>{{ row.entity || '—' }}</code></span>
                      <span><span class="bdg" data-s="warn">{{ row.kind || 'anomaly' }}</span></span>
                      <span :title="row.detail">{{ row.detail || '—' }}</span>
                    </div>
                  </div>
                </div>

                <div v-if="terminals.length" class="rtbl">
                  <div class="rtbl-scroll">
                    <div class="rtr rtr--head rt-term">
                      <span>#</span><span>Title · agent</span><span>State</span><span>Last</span>
                    </div>
                    <div v-for="row in slice(terminals, 6)" :key="row.id" class="rtr rt-term">
                      <span><code>{{ row.id }}</code></span>
                      <span :title="row.worktree">{{ row.worktree || '—' }}</span>
                      <span>
                        <span
                          class="bdg"
                          :data-s="row.state === 'working' ? 'ok' : row.state === 'error' ? 'fail' : null"
                        >{{ row.state || 'unknown' }}</span>
                      </span>
                      <span>{{ row.last || '—' }}</span>
                    </div>
                  </div>
                  <div class="rtbl-foot">
                    {{ plural(terminals.length, 'terminal', 'terminals') }} · tunnel owned by the
                    Orca app on this machine
                  </div>
                </div>

                <p class="rpt-gap">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                    <circle cx="8" cy="8" r="6.2" /><path d="M8 7.2v4M8 4.9v.1" />
                  </svg>
                  <span>{{ SECTION_GAP.orca }}</span>
                </p>
              </div>
              <p v-else class="rpt-gap">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                  <circle cx="8" cy="8" r="6.2" /><path d="M8 7.2v4M8 4.9v.1" />
                </svg>
                <span>
                  <b>Orca was not read this pass.</b>
                  {{
                    report.errors.orca ||
                    'orca status did not answer, so no runtime, worktree or terminal table is drawn.'
                  }}
                </span>
              </p>
            </template>
          </div>
        </section>

        <section class="entp-sec">
          <div class="entp-sec-head">
            <h2>Harnesses</h2>
            <span class="n">
              {{ foundCount }} of {{ knownTotal }} known · {{ plural(modelCount, 'model', 'models') }}
            </span>
            <div class="entp-sec-actions">
              <button
                class="btn btn-sm"
                type="button"
                :disabled="Boolean(busy) || missing"
                @click="scan"
              >
                {{ busy === 'scan' ? 'Testing…' : 'Test & scan again' }}
              </button>
            </div>
          </div>

          <div v-if="foundCount" class="ibarbar">
            <label class="wsl-search">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                <circle cx="7" cy="7" r="4.6" /><path d="M10.4 10.4L14 14" />
              </svg>
              <input
                ref="searchEl"
                v-model="query"
                type="search"
                placeholder="Search harness, path or model…"
                aria-label="Search harnesses and models"
                autocomplete="off"
                spellcheck="false"
              />
              <span class="cnt" aria-live="polite">
                {{ filteredHarnesses.length }} / {{ foundCount }}
              </span>
              <kbd>{{ searchKey }}</kbd>
            </label>
            <span class="push"></span>
            <span class="mnote">one box, path and model</span>
          </div>

          <div v-if="filteredHarnesses.length" class="inv">
            <div class="inv-head">
              <span></span><span>Harness</span><span>Reported by</span>
              <span class="r">Models</span><span></span>
            </div>
            <details v-for="entry in filteredHarnesses" :key="entry.id" class="inv-row">
              <summary>
                <span class="hico"><HarnessIcon :name="entry.id" :size="14" /></span>
                <span class="hname">
                  <b>{{ entry.label }}</b>
                  <span class="p" :title="entry.path">{{ entry.path || 'path not reported' }}</span>
                </span>
                <span class="hsrc" :title="sourceLabel(entry)">{{ sourceLabel(entry) }}</span>
                <span class="hcnt" :data-none="matchingModels(entry).length ? null : '1'">
                  {{ matchingModels(entry).length }}
                </span>
                <span class="chev" aria-hidden="true">
                  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7">
                    <path d="M4.5 2l4 4-4 4" />
                  </svg>
                </span>
              </summary>
              <div class="drawer">
                <p v-if="entry.default" class="dflt">Default <code>{{ entry.default }}</code></p>
                <div v-if="matchingModels(entry).length" class="chips">
                  <code
                    v-for="model in matchingModels(entry)"
                    :key="model"
                    :data-d="model === entry.default ? '1' : null"
                    :title="model"
                  >{{ model }}</code>
                </div>
                <p v-else class="dflt">No model list reported by this CLI.</p>
              </div>
            </details>
          </div>

          <div v-else-if="foundCount" class="empty-note">
            <b>No harness or model matches “{{ query }}”.</b>
            <span>
              {{ plural(visibleModelCount, 'model', 'models') }} visible in
              {{ plural(foundCount, 'harness', 'harnesses') }}.
            </span>
            <button class="btn" type="button" @click="query = ''">Clear the search</button>
          </div>

          <div v-else-if="facts" class="empty-note">
            <b>No harness yet.</b>
            <span>
              None of the {{ knownTotal }} harnesses this app knows about are in this host's
              PATH, so there is nothing to list.
            </span>
            <button
              class="btn btn-ink"
              type="button"
              :disabled="Boolean(busy) || missing"
              @click="scan"
            >
              Test &amp; scan again
            </button>
          </div>

          <div v-else class="empty-note">
            <b>No inventory yet.</b>
            <span>
              Test the connection to read the installed harnesses and their models; the
              result is stored in this copy of the workspace.
            </span>
            <button
              class="btn btn-ink"
              type="button"
              :disabled="Boolean(busy) || missing"
              @click="scan"
            >
              Test &amp; scan
            </button>
          </div>

          <p v-if="facts && missingKnown.length" class="mnote">
            {{ plural(missingKnown.length, 'known harness was', 'known harnesses were') }} not
            found: {{ missingKnown.join(', ') }}.
          </p>
        </section>
      </div>

      <aside class="entp-rail">
        <p class="entp-rail-h">
          This host
          <span class="n">{{ isLocal ? 'this machine' : 'ssh · read-only' }}</span>
        </p>
        <dl class="entp-facts">
          <div v-for="row in railFacts" :key="row.label">
            <dt>{{ row.label }}</dt>
            <dd :class="{ mono: row.mono }" :title="String(row.value)">{{ row.value }}</dd>
          </div>
        </dl>
        <div class="entp-rail-actions">
          <button type="button" :disabled="Boolean(busy) || missing" @click="scan">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
              <path d="M8 2.6v6.2M5.4 6.2L8 8.8l2.6-2.6" /><path d="M2.8 11.4h10.4" />
            </svg>
            <span class="nm">{{ busy === 'scan' ? 'Testing…' : 'Test & scan' }}</span>
          </button>
          <button v-if="facts" class="tall" type="button" :disabled="Boolean(busy)" @click="forget">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
              <path d="M3.2 4.6h9.6M6.4 4.6V3.2h3.2v1.4M4.4 4.6l.7 8.2h5.8l.7-8.2" />
            </svg>
            <span class="row2">
              <span class="nm">Forget facts</span>
              <i>{{ plural(modelCount, 'model', 'models') }} · {{ readAt }}</i>
            </span>
          </button>
          <button type="button" @click="copyAlias">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
              <rect x="5.6" y="5.6" width="7.6" height="7.6" rx="1.3" />
              <path d="M10.4 5.6V4.4A1.4 1.4 0 009 3H4.4A1.4 1.4 0 003 4.4V9a1.4 1.4 0 001.4 1.4h1.2" />
            </svg>
            <span class="nm">Copy alias</span>
            <span class="hint" :title="alias">{{ alias }}</span>
          </button>
          <button v-if="!isLocal" class="tall" type="button" @click="revealConfig">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
              <path d="M1.8 4.2h4l1.4 1.6h7v6.6H1.8z" /><path d="M1.8 5.8v-2h4" />
            </svg>
            <span class="row2">
              <span class="nm">Reveal config</span>
              <i>{{ fleet.displayPath }}</i>
            </span>
          </button>
        </div>
        <p class="mnote">
          ssh reads your own <code class="mono">{{ fleet.displayPath }}</code> and agent. The
          workspace stores no key and no ssh config; this inventory belongs to this copy of the
          workspace and is not part of remote sync.
        </p>
      </aside>
    </div>
  </div>
</template>
