<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import EntityMark from '@/components/EntityMark.vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import UiIcon from '@/components/UiIcon.vue'
import VoxelMark from '@/components/VoxelMark.vue'
import { isEditable } from '@/lib/dom'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import { entities, loadEntities } from '@/stores/entities'
import { ensureChats, hub } from '@/stores/hub'

/**
 * The roster the rail could not be.
 *
 * A 236px shelf showed a name and nothing else, so choosing an entity meant
 * opening them one at a time. The index states, in one screen, what each file
 * does, which harness and model it names, how much work has gone through it and
 * whether the file resolves at all. The rail's Entities panel stays — it still
 * owns the create dialog, which this page opens rather than duplicating.
 */
const route = useRoute()
const router = useRouter()

const query = ref('')
const filter = ref('all')
const searchEl = ref(null)
const searchKey = shortcutLabel('inventory-search')

onMounted(() => {
  ensureChats()
  /* The workspace open already read the entity files; a second walk for the same
     list would be a second walk. A page reached before that read finished lets
     the one in flight answer. */
  if (!entities.loaded && !entities.loading) loadEntities().catch(() => {})
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))

function reload() {
  loadEntities().catch(() => {})
}

function focusSearch() {
  const input = searchEl.value
  if (!(input instanceof HTMLInputElement)) return
  input.focus()
  input.select()
}

/* Slash is the catalog's, not this page's: `mod+/` on a desktop shell, `alt+/`
   in a browser. Escape gives the caret back before it gives up the page — the
   first press must not skip somebody out of a search they were mid-word in. */
function onKey(event) {
  if (event.key === 'Escape') {
    if (document.activeElement === searchEl.value) {
      event.preventDefault()
      searchEl.value.blur()
      return
    }
    if (isEditable(event.target)) return
    router.push({ name: 'overview', params: { workspace: hub.workspace } })
    return
  }
  if (!matchesShortcut('inventory-search', event)) return
  if (isEditable(event.target)) return
  event.preventDefault()
  focusSearch()
}

/* The create dialog has exactly one owner. Opening the shelf and pressing its
   own button keeps the form, the picker and the scaffold call in one place. */
async function newEntity() {
  hub.rail.entities = true
  await nextTick()
  document.querySelector('.rail-t2-add[aria-label="Add entity"]')?.click()
}

const goOverview = () => router.push({ name: 'overview', params: { workspace: route.params.workspace } })

/* ── the rows ───────────────────────────────────────────────────────
   Everything below is read, never fetched: `entity.list` answered the file
   side, `chat.list` the conversations. */
const reading = computed(() => !entities.error && (entities.loading || !entities.loaded))
const plural = (n, one, many) => (n === 1 ? one : many)
const NO_DESC = 'No description in the file yet.'

const threadsOf = (name) => hub.chat.summaries.filter((thread) => thread.entity === name)
const turnsOf = (list) =>
  list.reduce((sum, thread) => sum + (thread.queries || 0) + (thread.replies || 0), 0)

/* One vocabulary, and it is the overview's: the file's own problem outranks the
   run's, because `needs a look` is the thing a person has to act on. */
const stateWord = (agent) => {
  if (agent.problems?.length) return 'needs a look'
  if (agent.runError || agent.status === 'error') return 'failed'
  return { running: 'running', sleep: 'sleeping' }[agent.status] || 'idle'
}
const stateDot = (word) =>
  ({ running: 'live', failed: 'fail', 'needs a look': 'fail', sleeping: 'sleep' })[word] || 'idle'
/* `failed` and `needs a look` share one chip: both are a row that wants a person,
   and five chips is already the width of the toolbar. The chip's key is `look`,
   so `needs a look` has to be mapped too — left alone it became a bucket nobody
   could filter to, and pressing the chip hid the very rows it counts. */
const stateBucket = (word) => (word === 'failed' || word === 'needs a look' ? 'look' : word)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/* One clock for the page: an age is fixed at load, so a row nobody is writing to
   does not renumber under the reader. Under a week it is relative; past that the
   date is the answer, because "9d ago" is a number people convert by hand. */
const loadedAt = Date.now()
function seenOf(iso) {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return 'never'
  const ms = loadedAt - then
  if (ms < 60_000) return 'just now'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins} ${plural(mins, 'min', 'min')} ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  const date = new Date(then)
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`
}

const rows = computed(() =>
  hub.agents
    .map((agent) => {
      const threads = threadsOf(agent.name)
      const turns = turnsOf(threads)
      const xp = threads.length * 20 + turns * 10
      const stamps = threads.map((thread) => thread.updatedAt).filter(Boolean).sort()
      const lastAt = stamps[stamps.length - 1] || agent.lastAt || ''
      const word = stateWord(agent)
      /* `toAgent` already substituted the fallback sentence, so the missing case
         is asked as "is this the fallback", not "is this empty". */
      const bare = !agent.desc || agent.desc === NO_DESC
      return {
        name: agent.name,
        link: { name: 'entity', params: { workspace: hub.workspace, name: agent.name } },
        desc: bare ? NO_DESC : agent.desc,
        bare,
        harness: agent.harness || '',
        harnessLabel: agent.harnessLabel,
        model: agent.model || '',
        threads: threads.length,
        turns,
        threadWord: plural(threads.length, 'conversation', 'conversations'),
        turnLine: turns
          ? `${turns} ${plural(turns, 'turn', 'turns')} · ${seenOf(lastAt)}`
          : 'No turns yet',
        level: Math.floor(xp / 100) + 1,
        rest: xp % 100,
        state: word,
        dot: stateDot(word),
        bucket: stateBucket(word),
        seen: seenOf(lastAt),
        seenTitle: lastAt ? new Date(lastAt).toLocaleString() : 'never',
        problem: agent.problems?.[0] || '',
        lastAt,
      }
    })
    .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)) || a.name.localeCompare(b.name)),
)

/* Search is a client pass over four fields — the ones a row actually prints. */
const needle = computed(() => query.value.trim().toLowerCase())
const matching = computed(() => {
  const q = needle.value
  if (!q) return rows.value
  return rows.value.filter((row) =>
    [row.name, row.desc, row.harnessLabel, row.model].some((field) =>
      String(field || '').toLowerCase().includes(q),
    ),
  )
})

const SEGMENTS = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'look', label: 'Needs a look' },
  { key: 'idle', label: 'Idle' },
  { key: 'sleeping', label: 'Sleeping' },
]
const shown = computed(() => {
  if (reading.value) return []
  return filter.value === 'all'
    ? matching.value
    : matching.value.filter((row) => row.bucket === filter.value)
})
const segCount = (key) =>
  key === 'all' ? rows.value.length : rows.value.filter((row) => row.bucket === key).length
const filterWord = computed(
  () => (SEGMENTS.find((segment) => segment.key === filter.value) || SEGMENTS[0]).label.toLowerCase(),
)
const clearFilters = () => {
  query.value = ''
  filter.value = 'all'
}

/* ── the page's measures ────────────────────────────────────────────
   A count that has not answered yet, or that cannot answer at all, is a dash —
   never a zero: a folder the read refused is not a folder holding nothing. */
const dash = (value) => (reading.value || entities.error ? '—' : value)
const folder = computed(() =>
  hub.workspacePath ? `${hub.workspacePath}/entities` : 'entities/',
)
const described = computed(() => rows.value.filter((row) => !row.bare).length)
const total = computed(() => rows.value.length)
const describedPct = computed(() =>
  total.value ? Math.round((described.value / total.value) * 100) : 0,
)
const needCopy = computed(() => {
  const n = Math.max(0, total.value - described.value)
  return `${n} ${plural(n, 'row needs', 'rows need')} a line of copy`
})
const conversations = computed(() => rows.value.reduce((sum, row) => sum + row.threads, 0))
const turns = computed(() => rows.value.reduce((sum, row) => sum + row.turns, 0))
const unresolved = computed(() => rows.value.filter((row) => row.problem).length)
const harnessFact = computed(() => {
  /* An unread folder has no harnesses to describe; "no harness set" would be a
     claim about files nobody managed to open. */
  if (reading.value || entities.error) return '—'
  const labels = [...new Set(rows.value.map((row) => row.harnessLabel).filter(Boolean))]
  if (!labels.length) return 'no harness set'
  if (labels.length === 1) return `${labels[0]} on all ${rows.value.length}`
  return labels.join(' · ')
})
const lastSeen = computed(() => {
  if (reading.value || entities.error) return '—'
  const newest = rows.value.map((row) => row.lastAt).filter(Boolean).sort()
  return seenOf(newest[newest.length - 1])
})
const countLine = computed(() => (reading.value ? '— of —' : `${shown.value.length} of ${rows.value.length}`))

/* One tab stop per row, and Enter or Space opens it. Space is guarded: without
   `preventDefault` the page scrolls out from under the row it just opened. The
   name is a link and the chevron is a button, and both already answer to Enter
   and Space — a second open from the row under them would be a double push. */
function onRowKey(row, event) {
  if (event.key !== 'Enter' && event.key !== ' ') return
  if (event.target instanceof Element && event.target.closest('a, button')) return
  event.preventDefault()
  router.push(row.link)
}
</script>

<template>
  <div class="view detail-view">
    <!-- `.entp-bar` and `.ent-band` are siblings under `.detail-view`:
         `directory.css` hands every other child the 1180px reading measure and a
         20px margin, so wrapping the page in one element would inset the bar from
         the window edge and float it 20px under the top bar. -->
    <div class="entp-bar">
      <button class="back" type="button" aria-label="Back to the overview" @click="goOverview">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
          <path d="M7.5 2.5L4 6l3.5 3.5" />
        </svg>
      </button>
      <span class="entp-crumb">
        Entities<span class="crumb-n">/ {{ hub.workspaceLabel || hub.workspace }}</span>
      </span>
      <span class="spacer"></span>
      <div class="entp-actions">
        <button
          class="btn btn-sm"
          type="button"
          :disabled="entities.loading"
          :title="`Read ${folder} again`"
          @click="reload"
        >
          <UiIcon name="refresh" />
          {{ entities.loading ? 'Reading…' : 'Reload' }}
        </button>
        <button class="btn btn-sm btn-ink" type="button" @click="newEntity">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
            <path d="M8 3.5v9M3.5 8h9" />
          </svg>
          New entity
        </button>
      </div>
    </div>

    <div class="ent-band">
      <!-- The cabinet, in the skills page's material: the accent's paper, the
           30px grid, and one measure on the right that states the gap the
           roster shows below. -->
      <section class="ent-hero" aria-labelledby="entities-title">
        <div class="ent-hero-id">
          <!-- The page's ornament, in the slot every other index page uses: the
               specimen sheet's voxel, drawn the way the character is — square
               cells on an integer grid, one flat fill per light angle, no path
               and no request. A roster has no single entity's face, so it wears
               the object, not a mood. -->
          <span class="ent-crest" aria-hidden="true"><VoxelMark shape="drone" /></span>
          <div class="ent-hero-main">
            <p class="eyebrow">Workspace · Entities</p>
            <h1 id="entities-title">Entities</h1>
            <p class="ent-lede">
              Each file in <code class="mono">{{ folder }}</code> names a harness, a model and a
              working directory — open a name to read its instructions, its skills and its
              machines.
            </p>
          </div>
        </div>

        <div v-if="!entities.error" class="ent-meter" role="group" aria-label="Description coverage">
          <div class="ent-meter-lv"><span>SAY</span><b>{{ dash(described) }}</b></div>
          <div class="ent-meter-main">
            <div class="ent-meter-head">
              <span>Describe their job</span>
              <b>{{ dash(described) }} / {{ dash(total) }}</b>
            </div>
            <div
              class="ent-meter-track"
              role="progressbar"
              :aria-valuemin="0"
              :aria-valuemax="Math.max(total, 1)"
              :aria-valuenow="described"
              :aria-valuetext="`${described} of ${total} files carry a description`"
            >
              <i :style="{ width: `${describedPct}%` }"></i>
            </div>
            <div class="ent-meter-foot"><span>{{ reading ? '—' : needCopy }}</span></div>
          </div>
        </div>
      </section>

      <!-- Facts, in the machines page's grammar: six keys, never a sentence. -->
      <section class="ent-strip" aria-label="This roster">
        <dl class="ent-facts">
          <div>
            <dt>Folder</dt>
            <dd class="mono" :title="folder">{{ folder }}</dd>
          </div>
          <div>
            <dt>Files</dt>
            <dd><b>{{ dash(total) }}</b> markdown</dd>
          </div>
          <div>
            <dt>Conversations</dt>
            <dd><b>{{ dash(conversations) }}</b> · {{ dash(turns) }} turns</dd>
          </div>
          <div>
            <dt>Harness</dt>
            <dd>{{ harnessFact }}</dd>
          </div>
          <div v-if="unresolved">
            <dt>Unresolved</dt>
            <dd><b>{{ unresolved }}</b> {{ plural(unresolved, 'file', 'files') }}</dd>
          </div>
          <div>
            <dt>Last activity</dt>
            <dd>{{ lastSeen }}</dd>
          </div>
        </dl>
      </section>

      <div class="ent-tool">
        <label class="ent-search">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
            <circle cx="7" cy="7" r="4.2" />
            <path d="M10.2 10.2L14 14" />
          </svg>
          <input
            id="inventory-search"
            ref="searchEl"
            v-model="query"
            type="search"
            placeholder="Search name, description, model…"
            aria-label="Search entities"
            autocomplete="off"
            spellcheck="false"
          />
          <kbd class="search-kbd" aria-hidden="true">{{ searchKey }}</kbd>
        </label>
        <!-- The segments and the count are claims about rows. A read that
             failed has no rows to claim anything about, so the ribbon is the
             only thing left under the search field. -->
        <div v-if="!entities.error" class="ent-seg" role="group" aria-label="Filter by state">
          <button
            v-for="segment in SEGMENTS"
            :key="segment.key"
            type="button"
            :aria-pressed="filter === segment.key"
            @click="filter = segment.key"
          >
            {{ segment.label }} <b>{{ reading ? '—' : segCount(segment.key) }}</b>
          </button>
        </div>
        <span v-if="!entities.error" class="ent-count">{{ countLine }}</span>
      </div>

      <!-- Precedence is explicit and stated once: error > nothing yet > no
           results > the rows. The skeleton occupies the real grid so the table
           does not jump when the files land. -->
      <div v-if="entities.error" class="ent-ribbon" role="status">
        <div class="ent-ribbon-b">
          <b>This workspace's entity folder could not be read</b>
          <p class="mono">{{ entities.error }}</p>
        </div>
        <button class="btn btn-sm" type="button" @click="reload">Try again</button>
      </div>

      <div v-else-if="!reading && !rows.length" class="empty-note">
        <b>No entities yet</b>
        An entity is a markdown file in <code class="mono">{{ folder }}</code> — a harness, a
        model and the directory it works in.
        <div class="empty-actions">
          <button class="btn btn-sm btn-ink" type="button" @click="newEntity">New entity</button>
        </div>
      </div>

      <div v-else-if="!reading && !shown.length" class="empty-note">
        <b v-if="needle">No entity matches <q>{{ query.trim() }}</q>.</b>
        <b v-else>No entity is {{ filterWord }}.</b>
        Names, descriptions, harnesses and models are searched —
        {{ rows.length }} {{ plural(rows.length, 'file', 'files') }} checked.
        <div class="empty-actions">
          <button class="btn btn-sm" type="button" @click="clearFilters">Clear the search</button>
        </div>
      </div>

      <div
        v-else
        class="ent-table"
        role="table"
        aria-label="Entities in this workspace"
        :aria-rowcount="reading ? null : shown.length + 1"
      >
        <div class="row head" role="row">
          <span role="columnheader">Entity</span>
          <span role="columnheader">Harness · model</span>
          <span role="columnheader">Conversations</span>
          <span role="columnheader">Level</span>
          <span role="columnheader">State</span>
          <span role="columnheader" aria-label="Action"></span>
        </div>

        <template v-if="reading">
          <div v-for="n in 3" :key="`skel-${n}`" class="row" aria-hidden="true">
            <span class="cell ent-id">
              <span class="ent-mk"><span class="ent-skel ent-skel--mark"></span></span>
              <span class="ent-idt">
                <b class="ent-skel ent-skel--nm"></b>
                <span class="ent-skel ent-skel--line"></span>
              </span>
            </span>
            <span class="cell"><span class="ent-skel ent-skel--chip"></span></span>
            <span class="cell"><span class="ent-skel ent-skel--chip"></span></span>
            <span class="cell"><span class="ent-skel ent-skel--chip"></span></span>
            <span class="cell"><span class="ent-skel ent-skel--chip"></span></span>
            <span class="cell"></span>
          </div>
        </template>

        <div
          v-for="row in shown"
          :key="row.name"
          class="row"
          role="row"
          tabindex="0"
          :data-state="row.dot"
          :aria-label="`${row.name}, level ${row.level}, ${row.state}, ${row.threads} ${row.threadWord}`"
          @keydown="onRowKey(row, $event)"
        >
          <span class="cell ent-id" role="cell">
            <span class="ent-mk"><EntityMark mini :entity="row.name" /></span>
            <span class="ent-idt">
              <b><router-link class="ent-nm" :to="row.link">{{ row.name }}</router-link></b>
              <span class="ent-desc" :class="{ 'ent-desc--none': row.bare }" :title="row.desc">
                {{ row.desc }}
              </span>
              <span v-if="row.problem" class="ent-flag">{{ row.problem }}</span>
            </span>
          </span>

          <span class="cell ent-rt" role="cell">
            <span class="chipm chipm--harness">
              <HarnessIcon :name="row.harness" />
              {{ row.harnessLabel }}
            </span>
            <span class="ent-mdl" :title="row.model">{{ row.model || 'no model set' }}</span>
          </span>

          <span class="cell ent-th" role="cell">
            <span class="ent-thn"><b>{{ row.threads }}</b> {{ row.threadWord }}</span>
            <span class="ent-thn ent-thn--l">{{ row.turnLine }}</span>
          </span>

          <span class="cell ent-xp" role="cell">
            <span class="ent-lvl"><span>LV</span> <b>{{ row.level }}</b></span>
            <span
              class="ent-track"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="row.rest"
              :aria-label="`Level ${row.level} progress`"
              :aria-valuetext="`${row.rest} of 100 XP to level ${row.level + 1}`"
            >
              <i :style="{ width: `${row.rest}%` }"></i>
            </span>
          </span>

          <span class="cell ent-st" role="cell">
            <span class="state" :data-s="row.dot"><i></i>{{ row.state }}</span>
            <span class="ent-seen" :title="row.seenTitle">{{ row.seen }}</span>
          </span>

          <span class="cell ent-acts" role="cell">
            <button class="ent-row-act" type="button" :aria-label="`Open ${row.name}`" @click="router.push(row.link)">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M6 3l5 5-5 5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
