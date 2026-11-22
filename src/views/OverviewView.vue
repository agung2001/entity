<script setup>
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import EntityMark from '@/components/EntityMark.vue'
import MachineIcon from '@/components/MachineIcon.vue'
import VoxelMark from '@/components/VoxelMark.vue'
import OverviewHeatmap from '@/components/OverviewHeatmap.vue'
import PixelBackdrop from '@/components/PixelBackdrop.vue'
import { colorById } from '@/composables/entityMark'
import { emptyHeatColor, formatTokens, formatUsd, heatColors } from '@/lib/chart-math'
import { shortcutLabel } from '@/lib/shortcuts'
import { themeMode } from '@/lib/theme'
import { entities, loadEntities } from '@/stores/entities'
import { fleet, loadFleet } from '@/stores/fleet'
import { ago, ensureChats, harnessById, hub, liveSummaries, machineById, snippet } from '@/stores/hub'
import { loadUsage, usage } from '@/stores/usage'
import { activeWorkspace } from '@/stores/workspaces'

/**
 * The workspace as a crew. The cabinet says who this workspace is and how far
 * the crew has come, the ribbon says what is broken, and the cards are the
 * page's product. Nothing here re-fetches: the filters are a client pass over
 * `hub.agents`, and the crew's XP is the entity page's own formula, summed.
 */
const router = useRouter()

onMounted(() => {
  ensureChats()
  if (!fleet.loaded) loadFleet()
  /* The workspace open already reads the entity files; a second call here would
     be a second file walk for the same list. */
  if (!entities.loaded && !entities.loading) loadEntities().catch(() => {})
  loadUsage().catch(() => {})
})

const newThreadKey = shortcutLabel('new-thread')

/* Before `entity.list` answers the page is reading, not empty: the cabinet
   paints from the workspace record while the crew renders six skeletons. A
   failed read is neither — it keeps the cabinet and both bands on screen. */
const reading = computed(() => !entities.error && (entities.loading || !entities.loaded))
const empty = computed(() => !reading.value && !entities.error && hub.agents.length === 0)
const summaries = computed(() => liveSummaries())
const recentThreads = computed(() => summaries.value.slice(0, 5))
const machineCount = computed(() => 1 + fleet.hosts.length)
const sortedAgents = computed(() => [...hub.agents].sort((a, b) => a.name.localeCompare(b.name)))
const pad = (value) => String(value).padStart(2, '0')
/* Written out, never `1 entity(s)`. A dash is not a number, so it keeps the
   plural: "— entities" reads as a count that has not arrived. */
const plural = (n, one, many) => (n === 1 ? one : many)
/* A count that has not answered yet is a dash, never a zero. */
const dash = (value) => (reading.value ? '—' : value)
const countLabel = (value, one, many) => `${dash(value)} ${plural(value, one, many)}`

/* ── the crew's experience: the entity page's formula, summed ─────── */
const threadsOf = (name) => hub.chat.summaries.filter((thread) => thread.entity === name)
const turnsOf = (list) =>
  list.reduce((sum, thread) => sum + (thread.queries || 0) + (thread.replies || 0), 0)
const xpOf = (name) => {
  const threads = threadsOf(name)
  return threads.length * 20 + turnsOf(threads) * 10
}
const levelOf = (name) => Math.floor(xpOf(name) / 100) + 1
const levelXpOf = (name) => xpOf(name) % 100

const crewConversations = computed(
  () => hub.agents.reduce((sum, agent) => sum + threadsOf(agent.name).length, 0),
)
const crewTurns = computed(() =>
  hub.agents.reduce((sum, agent) => sum + turnsOf(threadsOf(agent.name)), 0),
)
const crewLevel = computed(
  () => Math.floor(hub.agents.reduce((sum, agent) => sum + xpOf(agent.name), 0) / 100) + 1,
)
const crewLevelXp = computed(() => hub.agents.reduce((sum, agent) => sum + xpOf(agent.name), 0) % 100)

/* ── status: one vocabulary, never the word "error" ─────────────────
   The file's own problem outranks the run's: `needs a look` is the fact the
   person has to act on, and the card carries the sentence underneath. */
const hasProblem = (agent) => Boolean(agent.problems?.length || agent.runError)
const statusWord = (agent) => {
  if (agent.problems?.length) return 'needs a look'
  if (agent.runError || agent.status === 'error') return 'failed'
  return { running: 'running', sleep: 'sleeping' }[agent.status] || 'idle'
}
const statusDot = (word) =>
  ({ running: 'live', failed: 'fail', 'needs a look': 'fail', sleeping: 'sleep' })[word] || 'idle'
/* The spec's order: a live run paints the card warm first; a problem or a
   failed run paints it red; a clean card keeps the plain edge. */
const toneOf = (agent) => {
  if (agent.status === 'running') return 'live'
  return hasProblem(agent) ? 'fail' : ''
}

/* ── the ribbon: the problem, or that the files are still being read ────
   It is absent when there is nothing to report. A calm page states its calm
   in the cards and the counts; a ribbon that only ever says "all clear" is a
   banner people learn to skip, and it costs the crew a row of height. */
const problemRows = computed(() =>
  hub.agents.flatMap((agent) => (agent.problems || []).map((what) => ({ agent, what }))),
)
const shownProblems = computed(() => problemRows.value.slice(0, 3))
const hiddenProblems = computed(() => Math.max(0, problemRows.value.length - 3))
/* An empty workspace is not "all clear" — it has not been checked, it has
   nothing — so it keeps its own sentence in the crew's empty state. */
const ribbonState = computed(() => {
  if (problemRows.value.length) return 'problems'
  if (entities.error) return 'unreadable'
  if (reading.value) return 'reading'
  return 'none'
})

/* ── the filter: a client pass, never a re-fetch ──────────────────── */
const filter = ref('all')
const runningCount = computed(() => hub.agents.filter((agent) => agent.status === 'running').length)
const problemCount = computed(() => hub.agents.filter(hasProblem).length)
const FILTERS = computed(() => [
  { id: 'all', label: 'All', count: hub.agents.length },
  { id: 'running', label: 'Running', count: runningCount.value },
  { id: 'problem', label: 'Needs a look', count: problemCount.value },
])
const crew = computed(() => {
  if (filter.value === 'running') return sortedAgents.value.filter((agent) => agent.status === 'running')
  if (filter.value === 'problem') return sortedAgents.value.filter(hasProblem)
  return sortedAgents.value
})
const filterWord = computed(() => (filter.value === 'running' ? 'running' : 'needing a look'))

/* ── the cabinet ──────────────────────────────────────────────────── */
/* The workspace has no face of its own, and the brand voxel belongs to an
   entity: one entity's colour wearing the house sticker was a quiet lie about
   which entity the cabinet was showing. The cabinet wears the app's accent,
   and its mark is four squares on the voxel's own grid. */
const accentMark = computed(() => colorById('sun'))

const lede = computed(() => {
  const context = String(activeWorkspace.value?.context || '').trim()
  if (context) {
    const first = context.match(/^[^.!?]*[.!?]/)
    return (first ? first[0] : context).trim()
  }
  if (!hub.agents.length) return 'No entities yet — this workspace is a room with nothing in it.'
  const entitiesWord = hub.agents.length === 1 ? 'entity' : 'entities'
  return `${hub.agents.length} ${entitiesWord} on ${machineCount.value} ${
    machineCount.value === 1 ? 'machine' : 'machines'
  }, ${crewConversations.value} ${
    crewConversations.value === 1 ? 'conversation' : 'conversations'
  } this year.`
})

/* ── cards ────────────────────────────────────────────────────────── */
const lastThread = (name) => threadsOf(name)[0] || null
const threadTitle = (thread) => thread.title || snippet(thread.preview) || 'New thread'
const lastTitle = (name) => {
  const thread = lastThread(name)
  return thread ? threadTitle(thread) : ''
}
const cardLabel = (agent) => {
  const parts = [agent.name, `level ${levelOf(agent.name)}`, statusWord(agent)]
  const title = lastTitle(agent.name)
  if (title) parts.push(`last conversation ${title}`)
  return parts.join(', ')
}
const machineLabel = (id) => machineById(id)?.label || id
/* The problem is the file's own sentence, verbatim — never a translation of it
   into "configuration problem". A failed run gets its own fixed sentence. */
const problemNote = (agent) => (agent.problems || []).join(' · ')
const hasNote = (agent) => Boolean(agent.problems?.length || agent.runError)

const openEntity = (agent) =>
  router.push({ name: 'entity', params: { workspace: hub.workspace, name: agent.id } })
/* A page-bar action leaves the rail's entity panel behind: it was opened here,
   so it is closed here. */
const toChat = (query) => {
  hub.rail.entities = false
  const target = { name: 'chat', params: { workspace: hub.workspace } }
  router.push(query ? { ...target, query } : target)
}
const openThread = (id) => toChat({ thread: id })
const openChat = () => toChat()
const newThread = () => toChat({ new: '1' })
const openEntities = () => {
  hub.rail.entities = true
}
/* The create dialog belongs to the rail's entity panel and its `openCreate()`
   is not reachable from a page, so this opens that panel and presses its own
   Add control. One dialog, one owner — the page never copies it. */
async function newEntity() {
  hub.rail.entities = true
  await nextTick()
  document.querySelector('.rail-t2-add[aria-label="Add entity"]')?.click()
}

/* ── this year ────────────────────────────────────────────────────── */
const YEAR_TOTALS = [
  { key: 'turns', label: 'Turns' },
  { key: 'days', label: 'Active days' },
  { key: 'spend', label: 'Spend' },
  { key: 'tokens', label: 'Tokens' },
]
const yearTotals = computed(() => {
  /* Nothing has answered yet (not even a failure) — the cells read a dash. */
  if (usage.loading || (!usage.data && !usage.error)) {
    return { turns: '—', days: '—', spend: '—', tokens: '—' }
  }
  const data = usage.data || {}
  const totals = data.totals || {}
  const days = Object.values(data.days || {}).filter((day) => Number(day?.turns) > 0).length
  /* A failed read prints a dash: zero is a measurement, a dash is not. */
  const value = (raw) => (usage.error ? '—' : raw)
  return {
    turns: value(totals.turns || 0),
    days: value(days),
    spend: value(formatUsd(totals.costUsd)),
    tokens: value(formatTokens((totals.tokensIn || 0) + (totals.tokensOut || 0))),
  }
})
const heatLegend = computed(() => [
  emptyHeatColor(themeMode.value === 'dark'),
  ...heatColors(themeMode.value === 'dark'),
])
</script>

<template>
  <div class="view ovc">
    <div class="ovc-bar">
      <span class="ovc-barcrumb">Workspace</span>
      <span class="spacer"></span>
      <button class="btn btn-sm" type="button" @click="newEntity">New entity</button>
      <button class="btn btn-ink" type="button" @click="newThread">
        New conversation
        <kbd class="btn-kbd">{{ newThreadKey }}</kbd>
      </button>
    </div>

    <section
      class="ovc-hero entp-hero"
      :data-ribbon="ribbonState === 'none' ? '0' : '1'"
      :style="{ '--hero': accentMark.hex }"
      aria-labelledby="ovc-name"
    >
      <PixelBackdrop variant="hero" :color="accentMark.hex" :count="16" />
      <div class="ovc-hero-inner">
        <div class="ovc-idhead">
          <span class="ovc-hero-mark" aria-hidden="true">
            <VoxelMark shape="station" />
          </span>
          <div class="ovc-title">
            <p class="eyebrow">Workspace · {{ hub.workspace }}</p>
            <h1 id="ovc-name">{{ hub.workspaceLabel || hub.workspace }}</h1>
            <p class="ovc-lede">{{ lede }}</p>
            <div class="ovc-chips">
              <span class="ovc-chip" :data-live="runningCount > 0 ? '1' : '0'">
                <i></i>{{ dash(runningCount) }} running now
              </span>
              <span class="ovc-chip">{{ countLabel(hub.agents.length, 'entity', 'entities') }}</span>
              <span class="ovc-chip">{{ countLabel(machineCount, 'machine', 'machines') }}</span>
              <span class="ovc-chip">{{ countLabel(hub.skills.length, 'workspace skill', 'workspace skills') }}</span>
            </div>
          </div>
          <aside
            class="ovc-xp"
            tabindex="0"
            :aria-label="`Crew level ${dash(crewLevel)}, ${dash(crewLevelXp)} of 100 experience. ${countLabel(
              crewConversations,
              'conversation',
              'conversations',
            )} and ${countLabel(crewTurns, 'turn', 'turns')}.`"
          >
            <div class="entp-lv ovc-lv">
              <span>LV</span>
              <b>{{ dash(pad(crewLevel)) }}</b>
            </div>
            <div class="entp-xp-main ovc-xp-main">
              <div class="entp-xp-head ovc-xp-head">
                <span>Crew experience</span>
                <b>{{ dash(crewLevelXp) }} / 100 XP</b>
              </div>
              <div
                class="entp-xp-track ovc-xp-track"
                role="progressbar"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-valuenow="reading ? 0 : crewLevelXp"
                :aria-valuetext="`${crewLevelXp} of 100 XP to level ${crewLevel + 1}`"
              >
                <i :style="{ width: `${reading ? 0 : crewLevelXp}%` }"></i>
              </div>
              <div class="entp-xp-foot ovc-xp-foot">
                <span>{{ countLabel(crewConversations, 'conversation', 'conversations') }}</span>
                <span>{{ countLabel(crewTurns, 'turn', 'turns') }}</span>
              </div>
            </div>
          </aside>
        </div>

        <div v-if="ribbonState === 'reading'" class="ovc-ribbon" data-ok="1">
          <p>Reading the entity files…</p>
        </div>
        <div v-else-if="ribbonState === 'unreadable'" class="ovc-ribbon">
          <div class="ovc-ribbon-row">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
              <path d="M8 2.4l6 11H2z" />
              <path d="M8 6.6v3.1M8 11.6v.1" />
            </svg>
            <b>entity files</b><span>{{ entities.error }}</span>
            <button class="ovc-ribbon-go" type="button" @click="loadEntities()">Try again</button>
          </div>
        </div>
        <div v-else-if="ribbonState === 'problems'" class="ovc-ribbon">
          <div v-for="row in shownProblems" :key="`${row.agent.id}:${row.what}`" class="ovc-ribbon-row">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
              <path d="M8 2.4l6 11H2z" />
              <path d="M8 6.6v3.1M8 11.6v.1" />
            </svg>
            <b>{{ row.agent.name }}</b><span>{{ row.what }}</span>
            <button class="ovc-ribbon-go" type="button" @click="openEntity(row.agent)">Open entity</button>
          </div>
          <div v-if="hiddenProblems" class="ovc-ribbon-row">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
              <path d="M8 2.4l6 11H2z" />
              <path d="M8 6.6v3.1M8 11.6v.1" />
            </svg>
            <b>+{{ hiddenProblems }} more</b>
            <span>{{ plural(hiddenProblems, 'entity file needs', 'entity files need') }} a look</span>
            <button class="ovc-ribbon-go" type="button" @click="openEntities">Open entities</button>
          </div>
        </div>
      </div>
    </section>

    <section class="ovc-sec">
      <div class="ovc-sec-head">
        <h2>The crew</h2>
        <span class="n">{{ reading ? '— entities' : countLabel(hub.agents.length, 'entity', 'entities') }}</span>
        <div class="ovc-filters" role="group" aria-label="Filter the crew">
          <button
            v-for="pill in FILTERS"
            :key="pill.id"
            class="ovc-filter"
            type="button"
            :data-on="filter === pill.id ? '1' : '0'"
            :aria-pressed="filter === pill.id"
            @click="filter = pill.id"
          >
            {{ pill.label }} <b>{{ dash(pill.count) }}</b>
          </button>
        </div>
        <span class="ovc-sort">Sort · name</span>
      </div>

      <div v-if="reading" class="ovc-crew">
        <article v-for="n in 6" :key="n" class="ovc-skel" aria-hidden="true"></article>
      </div>

      <div v-else-if="entities.error" class="ovc-none">
        <b>{{ entities.error }}</b>
        <p>The entity files could not be read.</p>
        <button class="btn btn-sm" type="button" @click="loadEntities()">Try again</button>
      </div>

      <div v-else-if="empty" class="ovc-none">
        <b>No entities in this workspace yet.</b>
        <p>An entity is a Markdown file in <code>entities/</code> — a name, a harness, and a folder to work in.</p>
        <button class="btn btn-sm" type="button" @click="newEntity">Create an entity →</button>
      </div>

      <div v-else-if="!crew.length" class="ovc-none">
        <b>Nothing matches “{{ filterWord }}”.</b>
        <p>
          {{ countLabel(hub.agents.length, 'entity', 'entities') }} in this workspace, none of them
          {{ filterWord }}.
          <button class="empty-link" type="button" @click="filter = 'all'">Clear the filter</button>        </p>
      </div>

      <div v-else class="ovc-crew">
        <article
          v-for="agent in crew"
          :key="agent.id"
          class="ovc-card"
          :data-tone="toneOf(agent)"
          tabindex="0"
          :aria-label="cardLabel(agent)"
          @click="openEntity(agent)"
          @keydown.enter="openEntity(agent)"
          @keydown.space.prevent="openEntity(agent)"
        >
          <div class="ovc-card-top">
            <EntityMark :entity="agent.name" />
            <span class="ovc-card-id">
              <b>{{ agent.name }}</b>
              <em>{{ agent.harnessLabel }}<template v-if="agent.model"> · {{ agent.model }}</template></em>
            </span>
            <span class="state" :data-s="statusDot(statusWord(agent))"><i></i>{{ statusWord(agent) }}</span>
          </div>
          <div class="ovc-lvrow">
            <span class="ovc-lvchip">LV {{ pad(levelOf(agent.name)) }}</span>
            <span
              class="ovc-track"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="levelXpOf(agent.name)"
              :aria-valuetext="`${levelXpOf(agent.name)} of 100 XP to level ${levelOf(agent.name) + 1}`"
            >
              <i :style="{ width: `${levelXpOf(agent.name)}%` }"></i>
            </span>
            <span class="ovc-xpn">{{ levelXpOf(agent.name) }}/100</span>
          </div>
          <p v-if="hasNote(agent)" class="ovc-note">
            <template v-if="agent.problems?.length">{{ problemNote(agent) }}</template>
            <template v-else>the run exited non-zero — <b>retry the session</b></template>
          </p>
          <div class="ovc-meta">
            <span class="ovc-mach">
              <template v-if="agent.machines.length">
                <MachineIcon :size="9" />{{ machineLabel(agent.machines[0]) }}
              </template>
              <span v-else class="nowhere">nowhere</span>
            </span>
            <span class="ovc-dir" :title="agent.dir"><span class="ovc-dir-in">{{ agent.dir || 'no directory' }}</span></span>
          </div>
          <div class="ovc-card-foot">
            <span class="ovc-last">{{ lastTitle(agent.name) || 'No conversation yet' }}</span>
            <span class="ovc-when">{{ ago(lastThread(agent.name)?.updatedAt) }}</span>
          </div>
        </article>
      </div>
    </section>

    <div v-if="!empty" class="ovc-bands">
      <section class="ovc-sec">
        <div class="ovc-sec-head">
          <h2>This year</h2>
          <span class="n">{{ usage.year }}</span>
        </div>
        <div class="ovc-year">
          <dl class="ovc-totals">
            <div v-for="total in YEAR_TOTALS" :key="total.key">
              <dt>{{ total.label }}</dt>
              <dd>{{ yearTotals[total.key] }}</dd>
            </div>
          </dl>
          <OverviewHeatmap :days="usage.data?.days || {}" :year="usage.year" />
          <div class="ovc-legend">
            <span>One square per day.</span>
            <span class="hm-key"><i v-for="color in heatLegend" :key="color" :style="{ background: color }"></i></span>
          </div>
        </div>
      </section>

      <section class="ovc-sec">
        <div class="ovc-sec-head">
          <h2>Recent conversations</h2>
          <span class="n">{{ recentThreads.length }} of {{ summaries.length }}</span>
          <button class="ovc-sort" type="button" @click="openChat">All chat →</button>
        </div>
        <div v-if="recentThreads.length" class="ovc-rows">
          <div
            v-for="thread in recentThreads"
            :key="thread.id"
            class="ovc-row"
            role="button"
            tabindex="0"
            @click="openThread(thread.id)"
            @keydown.enter="openThread(thread.id)"
            @keydown.space.prevent="openThread(thread.id)"
          >
            <time>{{ ago(thread.updatedAt) }}</time>
            <EntityMark :entity="thread.entity" mini />
            <span class="ovc-q"><b>{{ threadTitle(thread) }}</b></span>
            <span class="ovc-where2">
              {{ machineLabel(thread.machine) }} · {{ harnessById(thread.harness).label }} ·
              {{ (thread.queries || 0) + (thread.replies || 0) }}
              {{ (thread.queries || 0) + (thread.replies || 0) === 1 ? 'turn' : 'turns' }}
            </span>
          </div>
        </div>
        <div v-else class="ovc-none">
          <b>No conversations yet.</b>
          <p>Open an entity and start a turn — every conversation opens a chapter.</p>
        </div>
      </section>
    </div>

    <div class="ovc-foot">
      <span>
        <b>{{ dash(hub.agents.length) }}</b> {{ plural(hub.agents.length, 'entity', 'entities') }} ·
        <b>{{ dash(hub.skills.length) }}</b> {{ plural(hub.skills.length, 'skill', 'skills') }} ·
        <b>{{ dash(machineCount) }}</b> {{ plural(machineCount, 'machine', 'machines') }} ·
        <b>{{ dash(summaries.length) }}</b>
        {{ plural(summaries.length, 'conversation', 'conversations') }}
      </span>
      <span class="r">Sorted by name</span>
    </div>
  </div>
</template>
