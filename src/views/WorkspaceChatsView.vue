<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { hub, toast } from '@/stores/hub'
import {
  loadRetention,
  retention,
  runRetention,
  setRetention,
} from '@/stores/retention'

/**
 * Chats — when a thread archives itself, and when it is gone (ENTITY-20).
 *
 * The card is the control: the histogram's two dashed lines *are* the two
 * thresholds, and the rows underneath move them. A member who cannot say what
 * "30 days" costs tonight has not been given a setting, they have been given a
 * number field — so every number here answers four questions at once: what
 * leaves the working list, what dies, where the rail settles, and which threads
 * a protection holds back.
 *
 * The arithmetic lives in `electron/retention-store.cjs`. This view draws its
 * answer and never computes a count of its own, which is why the legend, the
 * rule effects, the forecast and the pass cannot disagree.
 */
const router = useRouter()
const state = computed(() => retention.state)
const settings = computed(() => state.value?.settings || null)
const meta = computed(() => state.value?.meta || null)
const bands = computed(() => state.value?.bands || [])
const legend = computed(() => state.value?.legend || null)
const forecast = computed(() => state.value?.forecast || null)
const schedule = computed(() => state.value?.schedule || null)
const last = computed(() => state.value?.last || null)

const loading = computed(() => retention.loading && !state.value)
const saving = computed(() => retention.saving)
const error = computed(() => retention.error)
const open = ref(false)
/* A typed number is a burst of keystrokes; the store is asked once they stop. */
let timer = null
const typed = ref(null)

const UNITS = ['days', 'weeks', 'months', 'never']
const EVENTS = [
  { id: 'day', label: 'every day' },
  { id: 'week', label: 'every week' },
  { id: 'month', label: 'every month' },
  { id: 'manual', label: 'only when I ask' },
]
const TICKS = [0, 7, 14, 21, 30, 45, 60, 90, 120, 180, 240, 300, 365, 540]

const role = computed(() => String(hub.session?.role || 'owner'))
/* A member reads the card; owner and admin may change it. There is no separate
   remote state here: a workspace is a directory on this machine, and the pass
   that runs is the one next to these threads. */
const canEdit = computed(() => ['owner', 'admin'].includes(role.value))

const arcDays = computed(() => state.value?.thresholds.archiveAfterDays ?? 0)
const delDays = computed(() => state.value?.thresholds.deleteAfterDays ?? 0)
const deathDays = computed(() => state.value?.thresholds.deathDays ?? 0)
const off = computed(() => arcDays.value <= 0 && delDays.value <= 0)
const manual = computed(
  () => settings.value?.archiveEvery === 'manual' && settings.value?.deleteEvery === 'manual',
)
const danger = computed(() => delDays.value > 0 && delDays.value <= 7)
const maxThreads = computed(() =>
  Math.max(1, ...bands.value.map((band) => band.threads || 0)),
)

/* ── formatting ─────────────────────────────────────────────────── */
function mb(value) {
  const n = (Number(value) || 0) / (1024 * 1024)
  if (n >= 1024) return `${(n / 1024).toFixed(1)} GB`
  if (n >= 100) return `${Math.round(n)} MB`
  return `${n.toFixed(1)} MB`
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
/* `plural()` adds the s, so it wants the singular: "21 days", never "21 dayss". */
const unitWord = (unit) => (unit === 'weeks' ? 'week' : unit === 'months' ? 'month' : 'day')

function ago(iso) {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return 'never'
  const minutes = Math.floor((Date.now() - then) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

const clock = (value) => String(value || '03:00')
const whenLabel = (kind) => {
  const entry = schedule.value?.[kind]
  if (!entry || !entry.automatic) return 'no automatic pass'
  if (entry.late) return 'due now'
  const due = new Date(entry.dueAt)
  if (!Number.isFinite(due.getTime())) return `next pass by ${entry.by}`
  const days = Math.ceil((due.getTime() - Date.now()) / 86_400_000)
  if (days <= 1) return `next pass by ${entry.by} today`
  if (days <= 7) {
    return `next pass by ${entry.by} ${due.toLocaleDateString(undefined, { weekday: 'short' })}`
  }
  return `next pass by ${entry.by} ${due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

/* ── the chart ───────────────────────────────────────────────────── */
const barHeight = (band) =>
  band.threads ? Math.max(3, Math.round((band.threads / maxThreads.value) * 168)) : 0

/** The column a threshold line stands in, clamped to the last one at the edge. */
function colOf(days) {
  if (days <= 0) return 0
  const at = bands.value.findIndex((band) => days >= band.from && days < band.to)
  return at === -1 ? bands.value.length - 1 : at
}

/** A bar's tooltip says the split, because the colour can only say one thing. */
function bandTitle(band) {
  const range = `${band.from}–${band.to} days silent`
  const parts = []
  if (band.keep) parts.push(`${band.keep} kept`)
  if (band.arch) parts.push(`${band.arch} to archive`)
  if (band.del) parts.push(`${band.del} to delete`)
  return parts.length
    ? `${range} · ${plural(band.threads, 'thread')} · ${mb(band.bytes)} — ${parts.join(', ')}`
    : range
}

const arcCol = computed(() => colOf(arcDays.value))
const delCol = computed(() => colOf(deathDays.value))
const edgeTag = (col) => col >= bands.value.length - 3

/* The narrow restatement of the legend: a stacked bar plus the same three keys. */
const shares = computed(() => {
  const total = Math.max(
    1,
    (legend.value?.keep.threads || 0) +
      (legend.value?.arch.threads || 0) +
      (legend.value?.del.threads || 0),
  )
  return {
    keep: ((legend.value?.keep.threads || 0) / total) * 100,
    arch: ((legend.value?.arch.threads || 0) / total) * 100,
    del: ((legend.value?.del.threads || 0) / total) * 100,
  }
})

/* ── writing ─────────────────────────────────────────────────────── */
async function patch(next, label) {
  if (!canEdit.value) return
  await setRetention(next, { label })
}

/** The number field saves on pause; the unit saves on change. */
function typeNumber(which, value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return
  typed.value = which
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    typed.value = null
    const pair = which === 'archive' ? settings.value?.archiveAfter : settings.value?.deleteAfter
    const unit = pair?.unit || 'days'
    patch({ [which === 'archive' ? 'archiveAfter' : 'deleteAfter']: { n, unit } }, plural(n, unitWord(unit)))
  }, 450)
}

function setUnit(which, unit) {
  const pair = which === 'archive' ? settings.value?.archiveAfter : settings.value?.deleteAfter
  const n = unit === 'never' ? 0 : pair?.n || (which === 'archive' ? 30 : 180)
  patch({ [which === 'archive' ? 'archiveAfter' : 'deleteAfter']: { n, unit } }, unit)
}

function setEvery(which, every) {
  patch({ [which === 'archive' ? 'archiveEvery' : 'deleteEvery']: every }, every)
}

function setBy(which, by) {
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(String(by))) return
  patch({ [which === 'archive' ? 'archiveBy' : 'deleteBy']: by }, by)
}

function toggle(which) {
  const key = which === 'pinned' ? 'protectPinned' : which === 'running' ? 'protectRunning' : 'protectArtifacts'
  patch({ [key]: !settings.value?.[key] }, key)
}

async function runNow() {
  if (!canEdit.value || saving.value) return
  const result = await runRetention()
  if (!result) return
  const archived = result.archived?.length || 0
  const deleted = result.deleted?.length || 0
  const failed = result.failed?.length || 0
  if (!archived && !deleted && !failed) {
    toast('Nothing was due')
    return
  }
  toast(
    `${plural(archived, 'thread')} archived · ${plural(deleted, 'thread')} removed` +
      (failed ? ` · ${failed} could not be moved` : ''),
  )
}

/** The rail's archived group is the other way to the same threads. */
function showArchived() {
  try {
    localStorage.setItem('entity.rail.archivedOpen', 'true')
  } catch {
    /* a browser with storage disabled still gets the chat page */
  }
  router.push({ name: 'chat', params: { workspace: hub.workspace } })
}

/* A different workspace is a different rule. */
watch(
  () => hub.workspace,
  () => loadRetention({ force: true }),
)

onMounted(() => loadRetention())
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <div class="acct-page ws-page">
    <section class="acct-card" aria-labelledby="ret-title">
      <div class="acct-card-head">
        <h2 id="ret-title">Chats</h2>
        <span v-if="meta" class="role-badge">{{ plural(meta.threads, 'thread') }}</span>
        <span v-else class="skel skel--line" style="width: 74px; height: 18px"></span>
      </div>

      <p class="ret-intro">
        Every thread in this workspace, by how long it has been silent. ① decides what
        leaves the rail's working list; ② decides what is removed for good. Archived
        threads stay one group down, and come back with one click.
      </p>

      <div class="acct-sep">
        Chat history
        <small v-if="meta">
          {{ plural(meta.threads, 'thread') }} · {{ mb(meta.bytes) }} ·
          the largest 5 threads are {{ mb(meta.largest5Bytes) }} of it
        </small>
      </div>

      <figure class="ages" :data-loading="loading ? '1' : '0'">
        <div class="ages-legend" aria-live="off">
          <template v-if="loading">
            <span class="skel skel--line" style="width: 92px"></span>
            <span class="skel skel--line" style="width: 92px"></span>
            <span class="skel skel--line" style="width: 92px"></span>
          </template>
          <template v-else-if="off">
            <span class="legend-key">
              <i class="sw-keep"></i>Kept all {{ meta?.threads || 0 }} · {{ mb(meta?.bytes) }}
            </span>
          </template>
          <template v-else>
            <span class="legend-key">
              <i class="sw-keep"></i>Kept <b>{{ legend?.keep.threads || 0 }}</b>
              <span> · {{ mb(legend?.keep.bytes) }}</span>
            </span>
            <span class="legend-key">
              <i class="sw-arch"></i>Archived <b>{{ legend?.arch.threads || 0 }}</b>
              <span> · {{ mb(legend?.arch.bytes) }}</span>
            </span>
            <span class="legend-key">
              <i class="sw-del"></i>Deleted <b>{{ legend?.del.threads || 0 }}</b>
              <span> · {{ mb(legend?.del.bytes) }}</span>
            </span>
          </template>
        </div>

        <div class="ages-plot">
          <template v-if="loading">
            <span
              v-for="n in 14"
              :key="`sk-${n}`"
              class="skel skel--bar"
              :style="{ height: `${[120, 86, 60, 48, 74, 40, 58, 32, 44, 26, 18, 22, 14, 10][n - 1]}px` }"
            ></span>
          </template>

          <div v-else-if="!meta?.threads" class="empty-inline">
            <b>No chats yet.</b>
            <span>
              A thread appears here the moment someone sends the first message. The rule
              starts applying then — nothing to archive tonight.
            </span>
          </div>

          <template v-else>
            <span
              v-for="(band, index) in bands"
              :key="band.from"
              class="bar"
              :class="`bar--${band.region}`"
              :data-empty="band.threads ? '0' : '1'"
              :style="{ height: `${barHeight(band)}px` }"
              :title="bandTitle(band)"
              :data-index="index"
            ></span>
          </template>

          <div
            v-if="!loading && !off && meta?.threads && arcDays > 0"
            class="ages-rule"
            data-n="1"
            :data-edge="edgeTag(arcCol) ? '1' : '0'"
            :style="{ gridColumn: arcCol + 1 }"
          >
            <span class="tag"><b>1</b> Archive at {{ arcDays }} d</span>
          </div>
          <div
            v-if="!loading && !off && meta?.threads && delDays > 0"
            class="ages-rule"
            data-n="2"
            :data-edge="edgeTag(delCol) ? '1' : '0'"
            :style="{ gridColumn: delCol + 1 }"
          >
            <span class="tag"><b>2</b> Gone at {{ deathDays }} d</span>
          </div>
        </div>

        <div v-if="!loading && meta?.threads" class="ages-axis">
          <span v-for="tick in TICKS" :key="tick">{{ tick }}</span>
        </div>
        <p v-if="!loading && meta?.threads" class="ages-xtitle">
          days since the thread's last message
        </p>

        <figcaption v-if="!loading && meta?.threads" class="ages-caption">
          Two thresholds on one axis: the first line archives, the second removes. The
          bars are groups of threads by silence, not individual conversations.
        </figcaption>

        <div v-if="!loading && meta?.threads" class="ages-summary">
          <div class="split" aria-hidden="true">
            <i class="sw-keep" :style="{ width: `${shares.keep}%` }"></i>
            <i class="sw-arch" :style="{ width: `${shares.arch}%` }"></i>
            <i class="sw-del" :style="{ width: `${shares.del}%` }"></i>
          </div>
          <div class="keys">
            <span class="legend-key"><i class="sw-keep"></i>Kept {{ legend?.keep.threads || 0 }}</span>
            <span class="legend-key"><i class="sw-arch"></i>Archived {{ legend?.arch.threads || 0 }}</span>
            <span class="legend-key"><i class="sw-del"></i>Deleted {{ legend?.del.threads || 0 }}</span>
          </div>
        </div>
      </figure>

      <div class="acct-sep">
        The rule ②
        <small>
          Saves as you change it — there is no Save button.
          <span v-if="saving"> Saving… {{ retention.pending }} · the previous value stays until the store answers.</span>
        </small>
      </div>

      <div class="rule-rows">
        <div class="rule-row">
          <span class="rule-badge">1</span>
          <span class="rule-who"><span class="rule-label">Archive a thread</span></span>
          <input
            class="acct-input rule-num"
            type="number"
            min="0"
            :max="3650"
            :value="settings?.archiveAfter.n ?? 30"
            :disabled="!canEdit || saving || settings?.archiveAfter.unit === 'never'"
            aria-label="Archive a thread after this many days of silence"
            @input="typeNumber('archive', $event.target.value)"
          />
          <select
            class="acct-input rule-unit"
            :value="settings?.archiveAfter.unit || 'days'"
            :disabled="!canEdit || saving"
            aria-label="Unit for the archive threshold"
            @change="setUnit('archive', $event.target.value)"
          >
            <option v-for="unit in UNITS" :key="unit" :value="unit" :selected="settings?.archiveAfter.unit === unit">
              {{ unit === 'never' ? 'Never' : unit }}
            </option>
          </select>
          <span class="rule-tail">after its last message</span>
          <span class="rule-effect">
            <template v-if="loading"><span class="skel skel--line" style="width: 96px"></span></template>
            <template v-else-if="off">Nothing archived</template>
            <template v-else>
              {{ plural(legend?.arch.threads || 0, 'thread') }} · {{ mb(legend?.arch.bytes) }}
            </template>
          </span>
        </div>

        <div class="rule-row" :data-off="delDays > 0 ? '0' : '1'">
          <span class="rule-badge">2</span>
          <span class="rule-who"><span class="rule-label">Delete it</span></span>
          <input
            class="acct-input rule-num"
            type="number"
            min="0"
            :max="3650"
            :value="settings?.deleteAfter.n ?? 180"
            :disabled="!canEdit || saving || settings?.deleteAfter.unit === 'never'"
            aria-label="Delete a thread this many days after it was archived"
            @input="typeNumber('delete', $event.target.value)"
          />
          <select
            class="acct-input rule-unit"
            :value="settings?.deleteAfter.unit || 'days'"
            :disabled="!canEdit || saving"
            aria-label="Unit for the delete threshold"
            @change="setUnit('delete', $event.target.value)"
          >
            <option v-for="unit in UNITS" :key="unit" :value="unit" :selected="settings?.deleteAfter.unit === unit">
              {{ unit === 'never' ? 'Never' : unit }}
            </option>
          </select>
          <span class="rule-tail">after it was archived</span>
          <span class="rule-effect">
            <template v-if="loading"><span class="skel skel--line" style="width: 96px"></span></template>
            <template v-else-if="delDays <= 0">Nothing deleted</template>
            <template v-else>
              {{ plural(legend?.del.threads || 0, 'thread') }} · {{ mb(legend?.del.bytes) }}
            </template>
          </span>
        </div>
      </div>

      <p v-if="!loading" class="rule-derived mnote">
        <template v-if="off">
          Retention is off: the rail archives nothing on its own and nothing is ever
          removed. Your threads stay where you put them.
        </template>
        <template v-else-if="delDays <= 0">
          A thread is archived at {{ arcDays }} days of silence and never removed — the
          archive is where a finished conversation stays until you delete it by hand.
        </template>
        <template v-else>
          A thread is archived at {{ arcDays }} days of silence and removed at
          <b>{{ deathDays }}</b>: ② is a count of days <em>in the archive</em>, so moving ①
          moves both lines — and nothing removed this way comes back.
        </template>
      </p>

      <div v-if="danger" class="ret-warn" role="status">
        <b>② is {{ delDays }} {{ delDays === 1 ? 'day' : 'days' }}.</b>
        The next pass removes
        <b>{{ plural(forecast?.delete.threads || 0, 'thread') }}</b><template
          v-if="forecast?.held.artifact"
        > and the other {{ forecast.held.artifact }} saved an artifact, which ④ keeps</template>.
        There is no Trash and no undo for it. Raising ① is what empties the archive
        without losing the conversation.
      </div>

      <div class="acct-sep">
        When it runs
        <small>On this machine's clock, and within a minute of the next launch</small>
      </div>

      <div class="rule-rows sched">
        <div class="rule-row sched-row">
          <span class="rule-badge">1</span>
          <span class="rule-who"><span class="rule-label">Archive</span></span>
          <select
            class="acct-input rule-unit"
            :value="settings?.archiveEvery || 'day'"
            :disabled="!canEdit || saving"
            aria-label="How often the archive pass runs"
            @change="setEvery('archive', $event.target.value)"
          >
            <option v-for="event in EVENTS" :key="event.id" :value="event.id" :selected="settings?.archiveEvery === event.id">
              {{ event.label }}
            </option>
          </select>
          <span class="sched-tail" :hidden="settings?.archiveEvery === 'manual'">by</span>
          <input
            class="acct-input sched-time"
            type="time"
            :value="clock(settings?.archiveBy)"
            :hidden="settings?.archiveEvery === 'manual'"
            :disabled="!canEdit || saving"
            aria-label="The latest the archive pass may wait"
            @change="setBy('archive', $event.target.value)"
          />
          <span class="sched-effect">{{ whenLabel('archive') }}</span>
        </div>

        <div class="rule-row sched-row">
          <span class="rule-badge">2</span>
          <span class="rule-who"><span class="rule-label">Delete</span></span>
          <select
            class="acct-input rule-unit"
            :value="settings?.deleteEvery || 'week'"
            :disabled="!canEdit || saving"
            aria-label="How often the delete pass runs"
            @change="setEvery('delete', $event.target.value)"
          >
            <option v-for="event in EVENTS" :key="event.id" :value="event.id" :selected="settings?.deleteEvery === event.id">
              {{ event.label }}
            </option>
          </select>
          <span class="sched-tail" :hidden="settings?.deleteEvery === 'manual'">by</span>
          <input
            class="acct-input sched-time"
            type="time"
            :value="clock(settings?.deleteBy)"
            :hidden="settings?.deleteEvery === 'manual'"
            :disabled="!canEdit || saving"
            aria-label="The latest the delete pass may wait"
            @change="setBy('delete', $event.target.value)"
          />
          <span class="sched-effect">{{ whenLabel('delete') }}</span>
        </div>
      </div>

      <div class="forecast">
        <p class="forecast-head">
          <template v-if="manual">No automatic pass</template>
          <template v-else-if="schedule?.archive.late || schedule?.delete.late">
            Due now — the deadline passed while the app was closed
          </template>
          <template v-else-if="schedule?.archive.automatic">
            Next pass · by {{ schedule.archive.by }} tonight, or at the next launch ③
          </template>
        </p>

        <ul v-if="!loading">
          <li>
            <b>{{ plural(forecast?.archive.threads || 0, 'thread') }} archived</b>
            <em>they leave the working list and join Archived</em>
          </li>
          <li class="del">
            <b>{{ plural(forecast?.delete.threads || 0, 'thread') }} deleted permanently</b>
            <em>
              <template v-if="forecast?.held.artifact">
                {{ plural(forecast.held.artifact, 'thread') }} past it saved an artifact, and
                ④ keeps them
              </template>
              <template v-else>no Trash, no restore</template>
            </em>
          </li>
          <li>
            <b>
              Rail {{ forecast?.rail.visibleBefore || 0 }} visible →
              {{ forecast?.rail.visibleAfter || 0 }} · Archived
              {{ forecast?.rail.archivedBefore || 0 }} →
              {{ forecast?.rail.archivedAfter || 0 }}
            </b>
          </li>
        </ul>

        <button
          v-if="forecast?.total"
          class="disclose"
          type="button"
          :aria-expanded="open ? 'true' : 'false'"
          aria-controls="ret-list"
          @click="open = !open"
        >
          {{ open ? 'Hide' : 'Show' }} what changes tonight
        </button>

        <ul v-if="open && forecast?.list.length" id="ret-list" class="tlist">
          <li v-for="row in forecast.list" :key="row.id" class="tlist-row">
            <span class="n" :title="row.title">{{ row.title }}</span>
            <span class="d">{{ row.silence }}d</span>
            <span class="s">{{ mb(row.bytes) }}</span>
          </li>
        </ul>
      </div>

      <div class="acct-sep">
        Protection ④
        <small>Counted right now, before anything moves</small>
      </div>

      <div class="notif-options">
        <div class="notif-option">
          <span class="sfx-copy">
            <b>Never archive a thread you pinned</b>
            <span>
              {{ plural(forecast?.held.pinned || 0, 'thread') }} pinned by hand. A pin is
              never cleared by a sweep.
            </span>
          </span>
          <button
            class="sfx-switch"
            type="button"
            role="switch"
            :aria-checked="settings?.protectPinned ? 'true' : 'false'"
            aria-label="Never archive a thread you pinned"
            :disabled="!canEdit || saving"
            @click="toggle('pinned')"
          >
            <span></span>
          </button>
        </div>

        <div class="notif-option">
          <span class="sfx-copy">
            <b>Never archive a thread with a turn still running</b>
            <span>
              A run must not lose the conversation it is writing to.
              {{ plural(forecast?.held.running || 0, 'thread') }} has a turn in flight; the
              pass waits for it, it does not queue behind it.
            </span>
          </span>
          <button
            class="sfx-switch"
            type="button"
            role="switch"
            :aria-checked="settings?.protectRunning ? 'true' : 'false'"
            aria-label="Never archive a thread with a turn still running"
            :disabled="!canEdit || saving"
            @click="toggle('running')"
          >
            <span></span>
          </button>
        </div>

        <div class="notif-option">
          <span class="sfx-copy">
            <b>Never delete a thread that saved an artifact</b>
            <span>
              {{ plural(forecast?.held.artifact || 0, 'thread') }} ·
              {{ plural(forecast?.held.artifactFiles || 0, 'file') }}. The conversation is
              how you remember why the file exists, so it keeps its place in Archived.
            </span>
          </span>
          <button
            class="sfx-switch"
            type="button"
            role="switch"
            :aria-checked="settings?.protectArtifacts ? 'true' : 'false'"
            aria-label="Never delete a thread that saved an artifact"
            :disabled="!canEdit || saving"
            @click="toggle('artifacts')"
          >
            <span></span>
          </button>
        </div>
      </div>

      <p v-if="error" class="acct-error" role="alert">
        <b>{{ error }}</b>
        <button class="btn btn-sm" type="button" @click="loadRetention({ force: true })">
          Retry now
        </button>
      </p>

      <p class="mnote sweep-note">
        Rules save as you change them. This runs the pass now, instead of waiting for the
        deadline. It never restores and it never overrides a protection.
      </p>

      <div class="acct-actions">
        <button class="btn" type="button" @click="showArchived">Show archived threads</button>
        <button
          class="btn btn-ink"
          type="button"
          :disabled="!canEdit || saving"
          :title="`Archives ${plural(forecast?.archive.threads || 0, 'thread')} and removes ${plural(forecast?.delete.threads || 0, 'thread')}`"
          @click="runNow"
        >
          {{ saving && retention.pending === 'pass' ? 'Running…' : 'Archive due now' }}
        </button>
      </div>

      <p class="mnote ret-foot">
        <template v-if="last?.error">
          Last pass failed {{ ago(last.at) }} — {{ last.error }}
        </template>
        <template v-else-if="!last?.at">
          No pass has run yet · the first one runs
          {{ schedule?.archive.automatic ? `by ${clock(settings?.archiveBy)}, or at the next launch` : 'when you press Archive due now' }}
        </template>
        <template v-else>
          Last pass {{ ago(last.at) }} · {{ plural(last.archived || 0, 'thread') }} archived ·
          {{ plural(last.deleted || 0, 'thread') }} removed
        </template>
        <template v-if="off"> · retention off — the pass wakes up when a day count comes back</template>
        <template v-else-if="manual"> · no automatic pass — press Archive due now</template>
        <template v-else>
          · next pass by {{ schedule?.archive.by || '03:00' }}, or at the next launch
        </template>
      </p>
    </section>

    <aside class="role-card">
      <h2>Chat history</h2>
      <p class="mnote">
        A thread is one <code class="mono">.json</code> in the workspace's
        <code class="mono">chats/</code> folder. Archiving is reversible; deleting is not,
        and the sweep has no Trash to fall back on.
      </p>

      <pre class="codebox ret-code">~/entity/workspaces/{{ hub.workspace }}/
  chats/            {{ plural(meta?.threads || 0, 'thread') }} · {{ mb(meta?.bytes) }}
  retention.json    the rule on this card

  chats/3f9c1e2a-….json
    "archived": true
    "archivedAt": "2026-11-17T03:40:44.043Z"</pre>

      <p class="mnote"><b>Restore</b> — one click in the rail's Archived group; the thread comes back with its messages.</p>
      <p class="mnote">
        <b>Delete</b> — <code class="mono">remove()</code> is
        <code class="mono">fs.rmSync</code>. Nothing goes to the Trash.
      </p>
      <p class="mnote">
        <b>Where it runs</b> — this machine, where the threads are. A workspace opened
        elsewhere sweeps its own copy.
      </p>
      <p class="mnote">
        <b>Silence</b> — the age on the chart is days since the thread's last message, so
        a conversation you keep returning to never ages.
      </p>
      <p class="mnote">
        <b>⑤ Pinning</b> — a pin is the per-thread escape hatch: a pinned thread is never
        archived by the rule, so it is never deleted by it either.
      </p>
    </aside>
  </div>
</template>
