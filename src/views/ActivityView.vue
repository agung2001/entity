<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import EntityMark from '@/components/EntityMark.vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import MachineIcon from '@/components/MachineIcon.vue'
import { HARNESSES } from '@/data/mock'
import { call } from '@/composables/localBridge'
import {
  ago,
  ensureChats,
  harnessById,
  hub,
  machineById,
  snippet,
  toast,
} from '@/stores/hub'

/**
 * Two readings of the same history.
 *
 * `Journal` is this workspace's own thread files — the conversations Entity
 * started. `Sessions` is the harness's own session store, one tab per CLI, so a
 * conversation can be picked up in a terminal where the harness left off. Only
 * sessions whose cwd belongs to an entity in this workspace are shown.
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
  await ensureChats()
})

const rows = computed(() => hub.chat.summaries || [])
const machineLabel = (id) => machineById(id)?.label || id

const filteredJournal = computed(() => {
  const q = journalQuery.value.trim().toLowerCase()
  if (!q) return rows.value
  return rows.value.filter((thread) =>
    [
      thread.title,
      thread.entity,
      thread.preview,
      thread.id,
      thread.harness,
      thread.machine,
      machineLabel(thread.machine),
      snippet(thread.preview),
    ]
      .join(' ')
      .toLowerCase()
      .includes(q),
  )
})

const labelOf = (harness) =>
  HARNESSES.find((entry) => entry.id === harness)?.label || harness

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
  const q = sessionQuery.value.trim().toLowerCase()
  if (!q) return state.value.items
  return state.value.items.filter((session) =>
    [
      session.title,
      session.preview,
      session.id,
      session.dir,
      session.harnessLabel,
      ...(session.entities || []),
    ]
      .join(' ')
      .toLowerCase()
      .includes(q),
  )
})

const shownSessions = computed(() =>
  filteredSessions.value.slice(0, sessionLimit.value),
)

function openThread(id) {
  router.push({ name: 'chat', query: { thread: id } })
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
    <div v-if="!props.embedded" class="page-head">
      <div>
        <p class="eyebrow">Journal · {{ hub.workspaceLabel || hub.workspace }}</p>
        <h1>Activity</h1>
        <p class="lede">
          Every conversation in this workspace, plus the sessions each harness keeps on this
          machine. A session row carries the command that picks it up in a terminal.
        </p>
      </div>
    </div>

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
        v-for="harness in HARNESSES"
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
      <div class="hsearch session-search">
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
        />
        <button
          v-if="journalQuery"
          class="hclear"
          type="button"
          aria-label="Clear journal search"
          @click="journalQuery = ''"
        >
          ×
        </button>
      </div>

      <div v-if="journalQuery && !filteredJournal.length" class="empty-note">
        <b>No conversations match “{{ journalQuery }}”.</b>
        <span>Try an entity name, a title, a harness, or part of the preview.</span>
      </div>

      <div v-else class="tbl">
        <div class="jrn-row jrn-th">
          <span>Time</span><span>Entity</span><span>Conversation</span><span class="rt">Context</span>
        </div>
        <div
          v-for="thread in filteredJournal"
          :key="thread.id"
          class="jrn-row jrn-row-btn"
          role="button"
          tabindex="0"
          @click="openThread(thread.id)"
          @keydown.enter="openThread(thread.id)"
        >
          <time>{{ ago(thread.updatedAt) }}</time>
          <span class="jrn-ent">
            <EntityMark mini animate :entity="thread.entity" /><span class="nm2">{{ thread.entity }}</span>
          </span>
          <span class="jrn-act">
            <b>{{ thread.title || snippet(thread.preview) || 'New thread' }}</b>
            <template v-if="thread.queries">
              · {{ thread.queries }} {{ thread.queries === 1 ? 'query' : 'queries' }}
            </template>
          </span>
          <span class="jrn-det">
            <MachineIcon :size="10" />{{ machineLabel(thread.machine) }}
            <span aria-hidden="true">·</span>
            <HarnessIcon :name="thread.harness" :size="10" />{{ harnessById(thread.harness).label }}
          </span>
        </div>
        <div v-if="!rows.length" class="jrn-row" style="color: var(--muted); font-size: 12.5px">
          No conversations yet in this workspace.
        </div>
      </div>
      <p v-if="journalQuery && filteredJournal.length" class="mnote">
        {{ filteredJournal.length }} of {{ rows.length }} conversations.
      </p>
    </template>

    <template v-else>
      <div class="lib-bar">
        <span class="lib-meta">
          {{ labelOf(active) }} sessions whose working directory belongs to an entity in this
          workspace.
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

      <div v-if="state.loading" class="empty-note">
        <b>Reading {{ labelOf(active) }} sessions…</b>
        <span>This is a local file scan; nothing leaves this machine.</span>
      </div>

      <div v-else-if="state.error" class="empty-note">
        <b>{{ state.error }}</b>
        <button class="btn btn-sm" type="button" @click="load(active, true)">Try again</button>
      </div>

      <div v-else-if="!state.items.length" class="empty-note">
        <b>No {{ labelOf(active) }} sessions found.</b>
        <span>
          {{ state.note || 'Start a session in one of this workspace’s entity directories, then refresh.' }}
        </span>
      </div>

      <template v-else>
        <div class="hsearch session-search">
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
          />
          <button
            v-if="sessionQuery"
            class="hclear"
            type="button"
            aria-label="Clear session search"
            @click="sessionQuery = ''"
          >
            ×
          </button>
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
              Showing {{ shownSessions.length }} of {{ filteredSessions.length }} sessions
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
