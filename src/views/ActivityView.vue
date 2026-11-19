<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import EntityMark from '@/components/EntityMark.vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import MachineIcon from '@/components/MachineIcon.vue'
import PixelBackdrop from '@/components/PixelBackdrop.vue'
import { call } from '@/composables/localBridge'
import { matchesQuery } from '@/composables/search'
import {
  ago,
  ensureChats,
  harnessById,
  hub,
  machineById,
  snippet,
  toast,
} from '@/stores/hub'
import { harnesses, loadHarnesses } from '@/stores/harnesses'

/**
 * Two readings of the same history.
 *
 * `Journal` is this workspace's own thread files — the conversations Entity
 * started. `Sessions` is the harness's own session store, one tab per CLI, so a
 * conversation can be picked up in a terminal where the harness left off. Only
 * sessions whose cwd belongs to an entity in this workspace are shown.
 *
 * Above both is the workspace's own cabinet: the same hero the entity profile
 * opens with, given the workspace's numbers. It is a reduce over the journal
 * already in memory, so it costs no extra IPC.
 */
const props = defineProps({
  /* Rendered inside Workspace → Activity; the parent owns the page head and
     padding so the tab reads as part of that page. */
  embedded: { type: Boolean, default: false },
})

const router = useRouter()
const active = ref('journal')
const cache = reactive({})
const journalQuery = ref('')
const sessionQuery = ref('')
const sessionLimit = ref(50)
/* '' is `all`; any other value is one entity name. */
const castFilter = ref('all')
const sortDesc = ref(true)
const SESSION_COUNTS_KEY = 'entity.sessions.counts'
/* Last known count per harness, so opening the page can paint the tab numbers
   without re-scanning four stores. Clicking a tab still refreshes its number. */
const sessionCounts = reactive({})
/* a workspace switch invalidates a scan that is still in flight */
let generation = 0

function readCountStores() {
  try {
    const raw = JSON.parse(localStorage.getItem(SESSION_COUNTS_KEY) || '{}')
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

function readSessionCounts(workspace = hub.workspace) {
  for (const key of Object.keys(sessionCounts)) delete sessionCounts[key]
  if (!workspace) return
  const bucket = readCountStores()[workspace] || {}
  for (const [harness, entry] of Object.entries(bucket)) {
    if (Number.isFinite(entry?.count)) sessionCounts[harness] = entry.count
  }
}

function saveSessionCount(harness, count) {
  if (!hub.workspace) return
  sessionCounts[harness] = count
  const stores = readCountStores()
  stores[hub.workspace] = {
    ...(stores[hub.workspace] || {}),
    [harness]: { count, at: new Date().toISOString() },
  }
  try {
    localStorage.setItem(SESSION_COUNTS_KEY, JSON.stringify(stores))
  } catch {
    /* session-only counts are still useful */
  }
}

onMounted(async () => {
  readSessionCounts()
  loadHarnesses().catch(() => {})
  await ensureChats()
})

const rows = computed(() => hub.chat.summaries || [])
const machineLabel = (id) => machineById(id)?.label || id

/* ── the cabinet's numbers ──────────────────────────────────────────────
   `queries + replies`, never `queries` alone: `who === 'me'` and
   `who === 'agent'` are the two halves of a turn and `sys` is neither. */
const threadTurns = (thread) => (thread.queries || 0) + (thread.replies || 0)
const turnCount = computed(() => rows.value.reduce((sum, thread) => sum + threadTurns(thread), 0))
const experience = computed(() => rows.value.length * 20 + turnCount.value * 10)
const level = computed(() => Math.floor(experience.value / 100) + 1)
const levelXp = computed(() => experience.value % 100)
const levelLabel = computed(() => String(level.value).padStart(2, '0'))

const distinctOf = (key) => new Set(rows.value.map((row) => row[key]).filter(Boolean)).size
const harnessCount = computed(() => distinctOf('harness'))
const machineCount = computed(() => distinctOf('machine'))

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

const locale = () => navigator.language || undefined
const dayKey = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
/* `Thu 19 Nov` / `6 Nov`: the parts are asked for separately because a locale's
   single date pattern puts the month first in one place and the day first in
   another, and the header's shape is the design's, not the locale's. */
const shortDay = (date) =>
  `${date.toLocaleDateString(locale(), { day: 'numeric' })} ${date.toLocaleDateString(locale(), { month: 'short' })}`
const longDay = (date) =>
  `${date.toLocaleDateString(locale(), { weekday: 'short' })} ${shortDay(date)}`

const DAYS = 14
/* Fourteen local days ending today. A quiet morning must not read as seven
   empty buckets, so the streak starts at yesterday when today has no turns. */
const buckets = computed(() => {
  const today = new Date()
  const list = []
  const byKey = new Map()
  for (let back = DAYS - 1; back >= 0; back -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back)
    const bucket = { key: dayKey(date), date, turns: 0 }
    byKey.set(bucket.key, bucket)
    list.push(bucket)
  }
  for (const row of rows.value) {
    const at = new Date(row.updatedAt)
    if (!Number.isFinite(at.getTime())) continue
    const bucket = byKey.get(dayKey(at))
    if (bucket) bucket.turns += threadTurns(row)
  }
  return list
})

const peak = computed(() => buckets.value.reduce((max, bucket) => Math.max(max, bucket.turns), 0))

/**
 * Height is turns ÷ peak; the *bucket* is the day's rank among the distinct
 * non-zero values, not its ratio. At this workspace's shape one day holds a
 * third of the history, and a linear scale collapses a 20-turn day onto the
 * same step as a 2-turn day.
 */
const pulse = computed(() => {
  const distinct = [...new Set(buckets.value.map((bucket) => bucket.turns).filter(Boolean))].sort(
    (a, b) => a - b,
  )
  const rankOf = new Map(distinct.map((value, index) => [value, index]))
  const today = dayKey(new Date())
  return buckets.value.map((bucket) => {
    const rank = rankOf.get(bucket.turns)
    const d =
      bucket.turns === 0
        ? 0
        : distinct.length === 1
          ? 4
          : 1 + Math.floor((rank / (distinct.length - 1)) * 3.99)
    return {
      key: bucket.key,
      turns: bucket.turns,
      d,
      height: bucket.turns === 0 ? 0 : Math.max(3, Math.round((bucket.turns / peak.value) * 44)),
      peak: bucket.turns > 0 && bucket.turns === peak.value,
      today: bucket.key === today,
    }
  })
})

const streak = computed(() => {
  const list = buckets.value
  let index = list.length - 1
  if (index >= 0 && list[index].turns === 0) index -= 1
  let count = 0
  while (index >= 0 && list[index].turns > 0) {
    count += 1
    index -= 1
  }
  return count
})

const ticks = computed(() => {
  const list = buckets.value
  if (!list.length) return []
  return [shortDay(list[0].date), shortDay(list[Math.floor(list.length / 2)].date), 'today']
})

const pulseLabel = computed(() => {
  const spoken = pulse.value
    .filter((bar) => bar.turns > 0)
    .map((bar) => `${shortDay(new Date(`${bar.key}T12:00:00`))}: ${plural(bar.turns, 'turn', 'turns')}`)
  return spoken.length
    ? `Turns per day for the last 14 days. ${spoken.join(', ')}.`
    : 'Turns per day for the last 14 days: no turns yet.'
})

const cast = computed(() => {
  const counts = new Map()
  for (const row of rows.value) counts.set(row.entity, (counts.get(row.entity) || 0) + 1)
  return [...counts.entries()]
    .map(([entity, count]) => ({ entity, count }))
    .sort((a, b) => b.count - a.count || a.entity.localeCompare(b.entity))
})

const filteredJournal = computed(() => {
  const q = journalQuery.value
  const entity = castFilter.value
  return rows.value.filter(
    (thread) =>
      (entity === 'all' || thread.entity === entity) &&
      matchesQuery(
        [
          thread.title,
          thread.entity,
          thread.preview,
          thread.id,
          thread.harness,
          thread.machine,
          machineLabel(thread.machine),
          snippet(thread.preview),
        ].join(' '),
        q,
      ),
  )
})

const sortedJournal = computed(() => {
  const list = [...filteredJournal.value]
  return list.sort((a, b) => {
    const cmp = String(a.updatedAt || '').localeCompare(String(b.updatedAt || ''))
    return sortDesc.value ? -cmp : cmp
  })
})

/* Every day is a header, not a date column: a flat table of 56 rows has no
   shape, four day groups do. `turns` is the same pair the hero counts. */
const dayGroups = computed(() => {
  const groups = []
  let current = null
  for (const thread of sortedJournal.value) {
    const at = new Date(thread.updatedAt)
    const valid = Number.isFinite(at.getTime())
    const key = valid ? dayKey(at) : 'undated'
    if (!current || current.key !== key) {
      current = { key, date: valid ? at : null, rows: [], turns: 0 }
      groups.push(current)
    }
    current.rows.push(thread)
    current.turns += threadTurns(thread)
  }
  return groups.map((group) => ({ ...group, label: dayLabel(group.date) }))
})

function dayLabel(date) {
  if (!date) return 'Undated'
  const today = new Date()
  const key = dayKey(date)
  if (key === dayKey(today)) return `Today · ${longDay(date)}`
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (key === dayKey(yesterday)) return `Yesterday · ${longDay(date)}`
  return longDay(date)
}

const filtering = computed(
  () => Boolean(journalQuery.value) || castFilter.value !== 'all',
)

/* The cleaned preview, not the transcript: 160 characters is the row's ceiling
   and `thread.title` is what a person typed as a title. */
function rowTitle(thread) {
  if (thread.title) return thread.title
  const preview = String(thread.preview || '')
    .replace(/\s+/g, ' ')
    .trim()
  return preview ? preview.slice(0, 160) : 'New thread'
}

function toggleCast(entity) {
  castFilter.value = castFilter.value === entity ? 'all' : entity
}

function startFirstChat() {
  router.push({ name: 'chat', params: { workspace: hub.workspace }, query: { new: '1' } })
}

const labelOf = (harness) =>
  harnesses.items.find((entry) => entry.id === harness)?.label || harness

/* Where each harness keeps its own store on this machine. The scan owns the
   read; this is what the note names when the read fails, so a person can go
   look. */
const STORE_PATHS = {
  claude: '~/.claude/projects',
  codex: '~/.codex/sessions',
  gemini: '~/.gemini/tmp',
  opencode: '~/.local/share/opencode',
  pi: '~/.pi/agent/sessions',
}

const state = computed(() => cache[active.value] || {
  loading: false,
  loaded: false,
  error: '',
  items: [],
  note: '',
  count: 0,
})

const titleOf = (session) =>
  session.title || session.preview || `Session ${String(session.id).slice(0, 8)}`

const filteredSessions = computed(() => {
  const q = sessionQuery.value
  return state.value.items.filter((session) =>
    matchesQuery(
      [
        session.title,
        session.preview,
        session.id,
        session.dir,
        session.harnessLabel,
        ...(session.entities || []),
      ].join(' '),
      q,
    ),
  )
})

const shownSessions = computed(() =>
  filteredSessions.value.slice(0, sessionLimit.value),
)

function openThread(id) {
  router.push({ name: 'chat', params: { workspace: hub.workspace }, query: { thread: id } })
}

async function load(harness, force = false) {
  if (!harness || harness === 'journal') return
  if (!force && cache[harness]?.loaded) return
  const forGeneration = generation
  cache[harness] = { loading: true, loaded: false, error: '', items: [], note: '', count: 0 }
  try {
    const data = await call('sessions.list', { workspace: hub.workspace, harness })
    if (forGeneration !== generation) return
    const count = data?.count || 0
    cache[harness] = {
      loading: false,
      loaded: true,
      error: '',
      items: data?.items || [],
      note: data?.note || '',
      count,
    }
    saveSessionCount(harness, count)
  } catch (error) {
    if (forGeneration !== generation) return
    cache[harness] = {
      loading: false,
      loaded: false,
      error: error?.message || `Could not read ${labelOf(harness)} sessions.`,
      items: [],
      note: '',
      count: 0,
    }
  }
}

watch(active, (harness) => {
  sessionQuery.value = ''
  sessionLimit.value = 50
  if (harness !== 'journal') load(harness)
})

watch(sessionQuery, () => {
  sessionLimit.value = 50
})

watch(
  () => hub.workspace,
  () => {
    generation += 1
    journalQuery.value = ''
    sessionQuery.value = ''
    sessionLimit.value = 50
    castFilter.value = 'all'
    for (const key of Object.keys(cache)) delete cache[key]
    readSessionCounts()
    if (active.value !== 'journal') load(active.value)
  },
)

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the selection copy */
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    return copied
  } catch {
    return false
  }
}

async function copyResume(session) {
  const copied = await copyText(session.resumeCommand)
  toast(
    copied
      ? `${session.harnessLabel} resume command copied`
      : 'The resume command could not be copied.',
  )
}
</script>

<template>
  <div :class="props.embedded ? 'ws-activity' : 'view'">
    <!-- The hero is the page head: one `<h1>` per document, and the rail owns
         the section title. No `.page-head` here, embedded or not. -->
    <section class="act-hero">
      <PixelBackdrop variant="hero" :count="18" />
      <div class="act-hero-in">
        <div class="act-id">
          <p class="eyebrow">Activity · {{ hub.workspaceLabel || hub.workspace }}</p>
          <h1>The workspace's own history</h1>
          <p class="desc">
            Every conversation this workspace started, and the harness sessions it can still pick
            up in a terminal.
          </p>
          <div class="act-chips">
            <span class="act-chip"><b>{{ hub.agents.length }}</b> {{ hub.agents.length === 1 ? 'entity' : 'entities' }}</span>
            <span class="act-chip">
              <b>{{ rows.length }}</b> {{ rows.length === 1 ? 'conversation' : 'conversations' }}
            </span>
            <span class="act-chip"><b>{{ turnCount }}</b> {{ turnCount === 1 ? 'turn' : 'turns' }}</span>
            <span class="act-chip"><b>{{ harnessCount }}</b> {{ harnessCount === 1 ? 'harness' : 'harnesses' }}</span>
            <span class="act-chip"><b>{{ machineCount }}</b> {{ machineCount === 1 ? 'machine' : 'machines' }}</span>
          </div>
        </div>

        <aside
          class="act-lv"
          title="Every conversation and every turn earns experience."
          :aria-label="`Level ${level}, ${levelXp} of 100 experience. ${plural(rows.length, 'conversation', 'conversations')} and ${plural(turnCount, 'turn', 'turns')}.`"
        >
          <div class="act-lv-box">
            <span>LV</span>
            <b>{{ levelLabel }}</b>
          </div>
          <div class="act-lv-main">
            <div class="act-lv-head">
              <span>Workspace XP</span>
              <b>{{ levelXp }} / 100 XP</b>
            </div>
            <div
              class="act-track"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="levelXp"
              :aria-valuetext="`${levelXp} of 100 XP to level ${level + 1}`"
            >
              <i :style="{ width: `${levelXp}%` }"></i>
            </div>
            <div class="act-lv-foot">
              <span>{{ plural(rows.length, 'conversation', 'conversations') }}</span>
              <span>{{ plural(turnCount, 'turn', 'turns') }}</span>
            </div>
          </div>
        </aside>
      </div>

      <div class="act-pulse">
        <div class="act-pulse-head">
          <p class="eyebrow">Last 14 days</p>
          <p class="facts">
            <span><b>{{ turnCount }}</b> {{ turnCount === 1 ? 'turn' : 'turns' }}</span>
            <span>peak <b>{{ peak }}</b></span>
            <span v-if="streak">streak <b>{{ streak }}</b> {{ streak === 1 ? 'day' : 'days' }}</span>
          </p>
        </div>
        <div class="act-bars" role="img" :aria-label="pulseLabel">
          <span
            v-for="bar in pulse"
            :key="bar.key"
            class="act-bar"
            :data-d="bar.d"
            :data-peak="bar.peak ? '1' : undefined"
            :data-today="bar.today ? '1' : undefined"
          >
            <i :style="{ height: `${bar.height}px` }"></i>
            <em v-if="bar.turns" aria-hidden="true">{{ bar.turns }}</em>
          </span>
        </div>
        <div class="act-ticks">
          <span v-for="tick in ticks" :key="tick">{{ tick }}</span>
        </div>
      </div>

      <div class="act-cast" role="group" aria-label="Filter the journal by entity">
        <span class="lbl">Cast</span>
        <button
          class="act-fchip"
          type="button"
          :aria-pressed="castFilter === 'all' ? 'true' : 'false'"
          @click="castFilter = 'all'"
        >
          all<span class="n">{{ rows.length }}</span>
        </button>
        <button
          v-for="entry in cast"
          :key="entry.entity"
          class="act-fchip"
          type="button"
          :aria-pressed="castFilter === entry.entity ? 'true' : 'false'"
          @click="toggleCast(entry.entity)"
        >
          <EntityMark mini :entity="entry.entity" />
          {{ entry.entity }}<span class="n">{{ entry.count }}</span>
        </button>
      </div>
    </section>

    <div class="sk-tabs" role="tablist" aria-label="Activity scope">
      <button
        role="tab"
        :aria-selected="active === 'journal' ? 'true' : 'false'"
        @click="active = 'journal'"
      >
        <EntityMark mini animate />
        Journal <span class="n">{{ rows.length }}</span>
      </button>
      <button
        v-for="harness in harnesses.items"
        :key="harness.id"
        role="tab"
        :aria-selected="active === harness.id ? 'true' : 'false'"
        @click="active = harness.id"
      >
        <HarnessIcon :name="harness.id" :size="13" />
        {{ harness.label }}
        <span
          v-if="cache[harness.id]?.loaded || sessionCounts[harness.id] !== undefined"
          class="n"
        >{{ cache[harness.id]?.loaded ? cache[harness.id].count : sessionCounts[harness.id] }}</span>
      </button>
    </div>

    <template v-if="active === 'journal'">
      <div class="act-tool">
        <label class="act-search">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <circle cx="7" cy="7" r="4.6" />
            <path d="M10.5 10.5L14 14" />
          </svg>
          <input
            v-model="journalQuery"
            type="text"
            placeholder="Search the journal by title, entity, or context"
            autocomplete="off"
            spellcheck="false"
            aria-label="Search the journal"
            @keydown.escape="journalQuery = ''"
          />
          <button
            v-if="journalQuery"
            class="act-clear"
            type="button"
            aria-label="Clear journal search"
            @click="journalQuery = ''"
          >
            ×
          </button>
        </label>
        <span class="act-count">
          <b>{{ filteredJournal.length }}</b>
          <template v-if="filtering"> of {{ rows.length }} conversations</template>
          <template v-else> {{ rows.length === 1 ? 'conversation' : 'conversations' }}</template>
        </span>
        <button class="btn btn-sm" type="button" @click="sortDesc = !sortDesc">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <path d="M2.4 4.6h11.2M2.4 8h8M2.4 11.4h5" />
          </svg>
          {{ sortDesc ? 'Newest first' : 'Oldest first' }}
        </button>
      </div>

      <div v-if="hub.chat.loading && !rows.length" class="tbl" aria-hidden="true">
        <div v-for="n in 3" :key="n" class="act-sk-row">
          <span class="act-sk-b"></span>
          <span class="act-sk-b wide"></span>
          <span class="act-sk-b"></span>
          <span class="act-sk-b"></span>
        </div>
      </div>

      <div v-else-if="!rows.length" class="empty-note">
        <b>No conversations yet.</b>
        <span>A thread appears here the first time an entity is asked to work in this workspace.</span>
        <div class="empty-actions">
          <button class="btn btn-primary" type="button" @click="startFirstChat">
            Start the first chat
          </button>
        </div>
      </div>

      <div v-else-if="journalQuery && !filteredJournal.length" class="empty-note">
        <b>No conversations match “{{ journalQuery }}”.</b>
        <span>Try an entity name, a title, a harness, or part of the preview.</span>
        <div class="empty-actions">
          <button class="btn btn-sm" type="button" @click="journalQuery = ''">Clear search</button>
        </div>
      </div>

      <div v-else-if="!filteredJournal.length" class="empty-note">
        <b>No conversations from {{ castFilter }} in this workspace.</b>
        <span>Press all to read the whole journal again.</span>
        <div class="empty-actions">
          <button class="btn btn-sm" type="button" @click="castFilter = 'all'">All entities</button>
        </div>
      </div>

      <div v-else class="tbl">
        <template v-for="group in dayGroups" :key="group.key">
          <div class="jr-day">
            {{ group.label }}
            <span>
              {{ plural(group.rows.length, 'thread', 'threads') }} ·
              {{ plural(group.turns, 'turn', 'turns') }}
            </span>
          </div>
          <div
            v-for="thread in group.rows"
            :key="thread.id"
            class="jr"
            role="button"
            tabindex="0"
            @click="openThread(thread.id)"
            @keydown.enter="openThread(thread.id)"
            @keydown.space.prevent="openThread(thread.id)"
          >
            <time>{{ ago(thread.updatedAt) }}</time>
            <span class="jr-ent">
              <EntityMark mini animate :entity="thread.entity" />
              <span class="nm">{{ thread.entity }}</span>
            </span>
            <span class="jr-act">
              <b>{{ rowTitle(thread) }}</b>
              <span v-if="thread.queries" class="q">
                · {{ thread.queries }} {{ thread.queries === 1 ? 'query' : 'queries' }}
              </span>
            </span>
            <span class="jr-ctx">
              <MachineIcon :size="10" />{{ machineLabel(thread.machine) }}
              <span class="pip" aria-hidden="true"></span>
              <HarnessIcon :name="thread.harness" :size="10" />{{ harnessById(thread.harness).label }}
            </span>
            <svg class="jr-go" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
              <path d="M6 3.4 10.6 8 6 12.6" />
            </svg>
          </div>
        </template>
      </div>
    </template>

    <template v-else>
      <div class="act-tool">
        <span class="act-count">
          {{ plural(state.items.length || state.count, 'session', 'sessions') }} from
          {{ labelOf(active) }}
        </span>
        <button
          class="btn btn-sm"
          type="button"
          :disabled="state.loading"
          @click="load(active, true)"
        >
          {{ state.loading ? 'Reading…' : 'Refresh' }}
        </button>
      </div>

      <div v-if="state.loading" class="tbl" aria-hidden="true">
        <div v-for="n in 3" :key="n" class="act-sk-row">
          <span class="act-sk-b"></span>
          <span class="act-sk-b wide"></span>
          <span class="act-sk-b"></span>
          <span class="act-sk-b"></span>
        </div>
      </div>

      <div v-else-if="state.error" class="empty-note err">
        <b>{{ labelOf(active) }} sessions could not be read.</b>
        <span>
          <span class="mono">{{ STORE_PATHS[active] || active }}</span> is not readable from this
          machine: {{ state.error }} The journal above is unaffected.
        </span>
        <div class="empty-actions">
          <button class="btn btn-sm" type="button" @click="load(active, true)">Try again</button>
        </div>
      </div>

      <div v-else-if="!state.items.length" class="empty-note">
        <b>No {{ labelOf(active) }} sessions found.</b>
        <span>
          {{ state.note || 'Start a session in one of this workspace’s entity directories, then refresh.' }}
        </span>
      </div>

      <template v-else>
        <div class="act-tool">
          <label class="act-search">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
              <circle cx="7" cy="7" r="4.6" />
              <path d="M10.5 10.5L14 14" />
            </svg>
            <input
              v-model="sessionQuery"
              type="text"
              placeholder="Search sessions by title, ID, entity or path"
              autocomplete="off"
              spellcheck="false"
              aria-label="Search sessions"
              @keydown.escape="sessionQuery = ''"
            />
            <button
              v-if="sessionQuery"
              class="act-clear"
              type="button"
              aria-label="Clear session search"
              @click="sessionQuery = ''"
            >
              ×
            </button>
          </label>
        </div>

        <div v-if="!filteredSessions.length" class="empty-note">
          <b>No sessions match “{{ sessionQuery }}”.</b>
          <span>Try a session ID, an entity name, or a directory.</span>
        </div>

        <template v-else>
          <div class="tbl">
            <div class="sess-row sess-th">
              <span>Time</span><span>Session</span><span class="sess-id">Session ID</span
              ><span class="rt">Resume</span>
            </div>
            <div v-for="session in shownSessions" :key="session.id" class="sess-row">
              <time>{{ ago(session.updatedAt) }}</time>
              <span class="sess-main">
                <b>{{ titleOf(session) }}</b>
                <span class="sess-meta">
                  <template v-if="session.entities.length">
                    {{ session.entities.join(', ') }} <span aria-hidden="true">·</span>
                  </template>
                  <span class="mono">{{ session.dir }}</span>
                </span>
              </span>
              <span class="sess-id mono" :title="session.id">{{ session.id }}</span>
              <span class="sess-actions">
                <button
                  class="btn btn-sm"
                  type="button"
                  :title="session.resumeCommand"
                  @click="copyResume(session)"
                >
                  Copy resume
                </button>
              </span>
            </div>
          </div>
          <div class="session-foot">
            <span class="mnote">
              {{ plural(shownSessions.length, 'session', 'sessions') }} of
              {{ plural(filteredSessions.length, 'session', 'sessions') }}
              <template v-if="state.count > state.items.length">
                · newest {{ state.items.length }} of {{ state.count }}
              </template>
            </span>
            <button
              v-if="shownSessions.length < filteredSessions.length"
              class="btn btn-sm"
              type="button"
              @click="sessionLimit += 50"
            >
              Load more
            </button>
          </div>
          <p v-if="state.note" class="mnote">{{ state.note }}</p>
        </template>
      </template>
    </template>
  </div>
</template>
