<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useDialogDismiss } from '@/composables/useDialog'
import EraseAllDialog from '@/components/EraseAllDialog.vue'
import { hub, toast } from '@/stores/hub'
import { eraseArtifacts } from '@/stores/artifacts'
import {
  artifactRetention,
  loadArtifactRetention,
  runArtifactRetention,
  setArtifactRetention,
} from '@/stores/artifactRetention'

/**
 * Artifacts — when a file on the shelf archives itself, and when it is gone
 * (ENTITY-16).
 *
 * The same card as Workspace → Chats (ENTITY-20), on a different population: the
 * histogram's two dashed lines *are* the two thresholds, and the rows underneath
 * move them. Every number here answers four questions at once — what leaves the
 * shelf, what leaves the machine, where the shelf settles, and which files a
 * protection holds back.
 *
 * The arithmetic lives in `electron/artifact-retention-store.cjs`. This view
 * draws its answer and never computes a count of its own, which is why the
 * legend, the rule effects, the forecast and the pass cannot disagree.
 */
const state = computed(() => artifactRetention.state)
const settings = computed(() => state.value?.settings || null)
const meta = computed(() => state.value?.meta || null)
const bands = computed(() => state.value?.bands || [])
const legend = computed(() => state.value?.legend || null)
const forecast = computed(() => state.value?.forecast || null)
const schedule = computed(() => state.value?.schedule || null)
const last = computed(() => state.value?.last || null)

const loading = computed(() => artifactRetention.loading && !state.value)
const saving = computed(() => artifactRetention.saving)
const error = computed(() => artifactRetention.error)
const open = ref(false)
/* The forecast's file list is a dismissible surface: Esc closes it, like every
   dialog in the app, and so does the button that opened it. */
useDialogDismiss({
  active: () => open.value,
  close: () => {
    open.value = false
  },
})
/* A typed number is a burst of keystrokes; the store is asked once they stop. */
let timer = null

const ARCHIVE_UNITS = ['days', 'weeks', 'months', 'never']
/* ② has no `Never`: the archive is closed by ① reaching `Never`, not by a
   second off switch that can contradict it. */
const DELETE_UNITS = ['days', 'weeks', 'months']
const EVENTS = [
  { id: 'day', label: 'every day' },
  { id: 'week', label: 'every week' },
  { id: 'month', label: 'every month' },
  { id: 'manual', label: 'only when I ask' },
]

const role = computed(() => String(hub.session?.role || 'owner'))
/* A member reads the card; owner and admin may change it. There is no separate
   remote state here: a workspace is a directory on this machine, and the pass
   that runs is the one next to these files. */
const canEdit = computed(() => ['owner', 'admin'].includes(role.value))

const arcDays = computed(() => state.value?.thresholds.archiveAfterDays ?? 0)
const delDays = computed(() => state.value?.thresholds.deleteAfterDays ?? 0)
const deathDays = computed(() => state.value?.thresholds.deathDays ?? 0)
const off = computed(() => arcDays.value <= 0 && delDays.value <= 0)
/* The idle switch is a desktop promise; the sync host has no person to wait for. */
const idle = computed(() => Boolean(settings.value?.whenIdle) && !executor.value?.alwaysOn)
const late = computed(() => Boolean(schedule.value?.archive.late || schedule.value?.delete.late))
/* The rule is workspace configuration; the pass is one machine's job. */
const executor = computed(() => state.value?.executor || null)
const configured = computed(() => Boolean(state.value?.configured))
const here = computed(() => Boolean(executor.value?.isThis))
const executorPlace = computed(
  () => executor.value?.where || executor.value?.label || 'another machine',
)
const manual = computed(
  () => settings.value?.archiveEvery === 'manual' && settings.value?.deleteEvery === 'manual',
)
const danger = computed(() => delDays.value > 0 && delDays.value <= 7)
const maxFiles = computed(() => Math.max(1, ...bands.value.map((band) => band.files || 0)))
const trashMode = computed(() => state.value?.trash || 'folder')
const trashWord = computed(() => (trashMode.value === 'system' ? 'the Trash' : 'the workspace trash'))

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
/* The word is the promise: a quiet pass may run *by* the deadline, a wall-clock
   pass runs *at* it. */
const deadlineWord = computed(() => (idle.value ? 'by' : 'at'))

const whenLabel = (kind) => {
  const entry = schedule.value?.[kind]
  if (!entry || !entry.automatic) return 'only when you press it'
  if (entry.late) return 'due now'
  const due = new Date(entry.dueAt)
  if (!Number.isFinite(due.getTime())) return `next pass ${deadlineWord.value} ${entry.by}`
  const days = Math.ceil((due.getTime() - Date.now()) / 86_400_000)
  if (days <= 1) return `next pass ${deadlineWord.value} ${entry.by} today`
  if (days <= 7) {
    return `next pass ${deadlineWord.value} ${entry.by} ${due.toLocaleDateString(undefined, { weekday: 'short' })}`
  }
  return `next pass ${deadlineWord.value} ${entry.by} ${due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

/* ── the chart ───────────────────────────────────────────────────── */
const barHeight = (band) =>
  band.files ? Math.max(3, Math.round((band.files / maxFiles.value) * 168)) : 0

/** The column a threshold line stands in, clamped to the last one at the edge. */
function colOf(days) {
  if (days <= 0) return 0
  const at = bands.value.findIndex((band) => days >= band.from && (band.to === null || days < band.to))
  return at === -1 ? bands.value.length - 1 : at
}

/** A bar's tooltip says the split, because the colour can only say one thing. */
function bandTitle(band) {
  const range = band.to === null ? `${band.from}+ days old` : `${band.from}–${band.to} days old`
  const parts = []
  if (band.keep) parts.push(`${band.keep} kept`)
  if (band.arch) parts.push(`${band.arch} to archive`)
  if (band.del) parts.push(`${band.del} to delete`)
  return parts.length
    ? `${range} · ${plural(band.files, 'file')} · ${mb(band.bytes)} — ${parts.join(', ')}`
    : range
}

const arcCol = computed(() => colOf(arcDays.value))
const delCol = computed(() => colOf(deathDays.value))
const edgeTag = (col) => col >= bands.value.length - 3

/* The narrow restatement of the legend: a stacked bar plus the same three keys. */
const shares = computed(() => {
  const total = Math.max(
    1,
    (legend.value?.keep.files || 0) + (legend.value?.arch.files || 0) + (legend.value?.del.files || 0),
  )
  return {
    keep: ((legend.value?.keep.files || 0) / total) * 100,
    arch: ((legend.value?.arch.files || 0) / total) * 100,
    del: ((legend.value?.del.files || 0) / total) * 100,
  }
})

/* ── writing ─────────────────────────────────────────────────────── */
async function patch(next, label) {
  if (!canEdit.value) return
  await setArtifactRetention(next, { label })
}

/** The number field saves on pause; the unit saves on change. */
function typeNumber(which, value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    const pair = which === 'archive' ? settings.value?.archiveAfter : settings.value?.deleteAfter
    const unit = pair?.unit || 'days'
    patch(
      { [which === 'archive' ? 'archiveAfter' : 'deleteAfter']: { n, unit } },
      plural(n, unitWord(unit)),
    )
  }, 450)
}

function setUnit(which, unit) {
  const pair = which === 'archive' ? settings.value?.archiveAfter : settings.value?.deleteAfter
  const n = unit === 'never' ? 0 : pair?.n || (which === 'archive' ? 30 : 90)
  patch({ [which === 'archive' ? 'archiveAfter' : 'deleteAfter']: { n, unit } }, unit)
}

function setEvery(which, every) {
  patch({ [which === 'archive' ? 'archiveEvery' : 'deleteEvery']: every }, every)
}

function setBy(which, by) {
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(String(by))) return
  patch({ [which === 'archive' ? 'archiveBy' : 'deleteBy']: by }, by)
}

function toggleIdle() {
  patch({ whenIdle: !idle.value }, 'quiet')
}

function toggleReferenced() {
  patch({ protectReferenced: !settings.value?.protectReferenced }, 'referenced')
}

/** The shelf is the rail's own panel, not a page: this opens it where it lives. */
function openShelf() {
  hub.rail.entities = false
  hub.rail.artifacts = true
}

/* ── erase all ─────────────────────────────────────────────────────── */
/* The one control on this card that is not a threshold: it empties a shelf. Three
   buttons, because the card draws three populations and one button that removed
   all of them could not say which half a person meant. Each asks in the same
   dialog, because the sweep has no restore and neither does this. */
const eraseScope = ref('')
const erasing = ref(false)
const eraseError = ref('')

const eraseOpen = computed({
  get: () => Boolean(eraseScope.value),
  set: (open) => {
    if (!open) eraseScope.value = ''
  },
})

/**
 * What each scope costs, from the same `meta` the card draws — a dialog with its
 * own arithmetic is a second count that can disagree with the button beside it.
 * The personal shelf is counted by the shelf walk, so its bytes are the shelf's.
 */
function summaryFor(scope) {
  const sharedFiles = meta.value?.files || 0
  const archivedFiles = meta.value?.archived || 0
  const personalFiles = meta.value?.personal || 0
  if (scope === 'shared') {
    return {
      count: sharedFiles + archivedFiles,
      bytes: mb((meta.value?.bytes || 0) + (meta.value?.archivedBytes || 0)),
      extra: archivedFiles ? plural(archivedFiles, 'archived file') : '',
    }
  }
  if (scope === 'personal') {
    return { count: personalFiles, bytes: '', extra: '' }
  }
  return {
    count: sharedFiles + archivedFiles + personalFiles,
    bytes: mb((meta.value?.bytes || 0) + (meta.value?.archivedBytes || 0)),
    extra: personalFiles ? plural(personalFiles, 'personal file') : '',
  }
}

const eraseTarget = computed(() =>
  eraseScope.value === 'personal' ? '.personal/<account>/artifacts/' : 'artifacts/',
)

async function erase() {
  if (erasing.value) return
  const scope = eraseScope.value
  erasing.value = true
  eraseError.value = ''
  try {
    const result = await eraseArtifacts(scope)
    toast(`Erased ${plural(result?.removed || 0, 'file')}`)
    eraseScope.value = ''
    await loadArtifactRetention({ force: true })
  } catch (problem) {
    eraseError.value = problem?.message || 'The shelf could not be erased.'
  } finally {
    erasing.value = false
  }
}

async function runNow() {
  if (!canEdit.value || saving.value) return
  const result = await runArtifactRetention()
  if (!result) return
  const archived = result.archived?.length || 0
  const deleted = result.deleted?.length || 0
  const failed = result.failed?.length || 0
  if (!archived && !deleted && !failed) {
    toast('Nothing was due')
    return
  }
  toast(
    `${plural(archived, 'file')} archived · ${plural(deleted, 'file')} removed` +
      (failed ? ` · ${failed} could not be moved` : ''),
  )
}

/* A different workspace is a different rule. */
watch(
  () => hub.workspace,
  () => loadArtifactRetention({ force: true }),
)

/* Forced: the schedule is shared with the Chats card, and that card may be the
   one that changed it since this view last loaded. */
onMounted(() => loadArtifactRetention({ force: true }))
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <div class="acct-page ws-page">
    <section class="acct-card" aria-labelledby="art-ret-title">
      <div class="acct-card-head">
        <h2 id="art-ret-title">Artifacts</h2>
        <span v-if="meta" class="role-badge">{{ plural(meta.files, 'file') }}</span>
        <span v-else class="skel skel--line" style="width: 74px; height: 18px"></span>
      </div>

      <p class="ret-intro">
        Everything on this workspace's <b>shared</b> artifacts shelf, by how long it has
        been since anyone opened it. ① decides what moves into the archive; ② decides what
        leaves this machine for good. An archived file is out of the shelf's list, not off
        the disk. A personal shelf (<code class="mono">.personal/&lt;account&gt;/artifacts/</code>)
        is one account's own and is never swept.
      </p>

      <div v-if="!canEdit" class="role-line">
        <span class="role-badge">{{ role }}</span>
        <span>
          You can see these rules but not change them — only an owner or an admin moves
          the lines, changes a cadence, or runs a pass.
        </span>
      </div>

      <div v-if="state && !configured" class="role-line">
        <span class="role-badge">unset</span>
        <span>
          The sweep is not configured for this workspace yet. The numbers below are the
          defaults — nothing is archived or deleted until an owner or admin saves a value,
          and then every clone reads the same rule.
        </span>
      </div>

      <div v-else-if="executor && !here" class="role-line">
        <span class="role-badge">elsewhere</span>
        <span>
          One machine runs the sweep: {{ executorPlace }}. This page shows the shared
          rule on that machine's clock; every other clone stands down, so the same file is
          never archived twice.
          <router-link :to="`/${hub.workspace}/settings?tab=machines`">Change it in Machines</router-link>
        </span>
      </div>

      <div v-if="late && here && !manual" class="role-line">
        <span class="role-badge">waiting</span>
        <span>
          The pass due at {{ clock(settings?.archiveBy) }} has not run yet. The deadline
          passed while this machine was busy or shut, so nothing is skipped: it starts at
          the next tick, or within a minute of the next launch.
        </span>
      </div>

      <div class="acct-sep">
        The shelf, by age
        <small v-if="meta">
          {{ plural(meta.files, 'file') }} · {{ mb(meta.bytes) }} on the shelf ·
          {{ plural(meta.archived, 'file') }} · {{ mb(meta.archivedBytes) }} in the archive<template
            v-if="meta.personal"
          >
            · {{ meta.personal }} personal, not swept</template
          >
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
              <i class="sw-keep"></i>Kept all
              {{ (meta?.files || 0) + (meta?.archived || 0) }} · {{ mb((meta?.bytes || 0) + (meta?.archivedBytes || 0)) }}
            </span>
          </template>
          <template v-else>
            <span class="legend-key">
              <i class="sw-keep"></i>Kept <b>{{ legend?.keep.files || 0 }}</b>
              <span> · {{ mb(legend?.keep.bytes) }}</span>
            </span>
            <span class="legend-key">
              <i class="sw-arch"></i>Archived <b>{{ legend?.arch.files || 0 }}</b>
              <span> · {{ mb(legend?.arch.bytes) }}</span>
            </span>
            <span class="legend-key">
              <i class="sw-del"></i>Deleted <b>{{ legend?.del.files || 0 }}</b>
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

          <div v-else-if="!meta?.files && !meta?.archived" class="empty-inline">
            <b>No artifacts yet.</b>
            <span>
              Files an entity saves land here. The rule starts applying the day the first
              one arrives — nothing to archive tonight.
            </span>
          </div>

          <template v-else>
            <span
              v-for="(band, index) in bands"
              :key="band.from"
              class="bar"
              :class="`bar--${band.region}`"
              :data-empty="band.files ? '0' : '1'"
              :style="{ height: `${barHeight(band)}px` }"
              :title="bandTitle(band)"
              :data-index="index"
            ></span>
          </template>

          <div
            v-if="!loading && !off && (meta?.files || meta?.archived) && arcDays > 0"
            class="ages-rule"
            data-n="1"
            :data-edge="edgeTag(arcCol) ? '1' : '0'"
            :style="{ gridColumn: arcCol + 1 }"
          >
            <span class="tag"><b>1</b> Archive at {{ arcDays }} d</span>
          </div>
          <div
            v-if="!loading && !off && (meta?.files || meta?.archived) && delDays > 0"
            class="ages-rule"
            data-n="2"
            :data-edge="edgeTag(delCol) ? '1' : '0'"
            :style="{ gridColumn: delCol + 1 }"
          >
            <span class="tag"><b>2</b> Delete at {{ deathDays }} d</span>
          </div>
        </div>

        <div v-if="!loading && (meta?.files || meta?.archived)" class="ages-axis">
          <span v-for="band in bands" :key="`t-${band.from}`">{{ band.from }}</span>
        </div>
        <p v-if="!loading && (meta?.files || meta?.archived)" class="ages-xtitle">
          days since a file was last opened
        </p>

        <figcaption v-if="!loading && (meta?.files || meta?.archived)" class="ages-caption">
          Two thresholds on one axis: the first line archives, the second removes. The
          bars are groups of files by age, not individual documents, and ② is drawn on
          this axis as {{ deathDays }} days — the age at which an archived file dies.
        </figcaption>

        <div v-if="!loading && (meta?.files || meta?.archived)" class="ages-summary">
          <div class="split" aria-hidden="true">
            <i class="sw-keep" :style="{ width: `${shares.keep}%` }"></i>
            <i class="sw-arch" :style="{ width: `${shares.arch}%` }"></i>
            <i class="sw-del" :style="{ width: `${shares.del}%` }"></i>
          </div>
          <div class="keys">
            <span class="legend-key"><i class="sw-keep"></i>Kept {{ legend?.keep.files || 0 }}</span>
            <span class="legend-key"><i class="sw-arch"></i>Archived {{ legend?.arch.files || 0 }}</span>
            <span class="legend-key"><i class="sw-del"></i>Deleted {{ legend?.del.files || 0 }}</span>
          </div>
        </div>
      </figure>

      <div class="acct-sep">
        The rule ②
        <small>
          Saves as you change it — there is no Save button.
          <span v-if="saving"> Saving… {{ artifactRetention.pending }} · the previous value stays until the store answers.</span>
        </small>
      </div>

      <div class="rule-rows">
        <div class="rule-row">
          <span class="rule-badge">1</span>
          <span class="rule-who"><span class="rule-label">Archive a file</span></span>
          <input
            class="acct-input rule-num"
            type="number"
            min="0"
            :max="3650"
            :value="settings?.archiveAfter.n ?? 30"
            :disabled="!canEdit || saving || settings?.archiveAfter.unit === 'never'"
            aria-label="Archive a file after this many days since it was last opened"
            @input="typeNumber('archive', $event.target.value)"
          />
          <select
            class="acct-input rule-unit"
            :value="settings?.archiveAfter.unit || 'days'"
            :disabled="!canEdit || saving"
            aria-label="Unit for the archive threshold"
            @change="setUnit('archive', $event.target.value)"
          >
            <option
              v-for="unit in ARCHIVE_UNITS"
              :key="unit"
              :value="unit"
              :selected="settings?.archiveAfter.unit === unit"
            >
              {{ unit === 'never' ? 'Never' : unit }}
            </option>
          </select>
          <span class="rule-tail">after it was last opened</span>
          <span class="rule-effect">
            <template v-if="loading"><span class="skel skel--line" style="width: 96px"></span></template>
            <template v-else-if="arcDays <= 0">Nothing archived</template>
            <template v-else>
              {{ plural(legend?.arch.files || 0, 'file') }} · {{ mb(legend?.arch.bytes) }}
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
            :value="settings?.deleteAfter.n ?? 90"
            :disabled="!canEdit || saving"
            aria-label="Delete a file this many days after it was archived"
            @input="typeNumber('delete', $event.target.value)"
          />
          <select
            class="acct-input rule-unit"
            :value="settings?.deleteAfter.unit || 'days'"
            :disabled="!canEdit || saving"
            aria-label="Unit for the delete threshold"
            @change="setUnit('delete', $event.target.value)"
          >
            <option
              v-for="unit in DELETE_UNITS"
              :key="unit"
              :value="unit"
              :selected="settings?.deleteAfter.unit === unit"
            >
              {{ unit }}
            </option>
          </select>
          <span class="rule-tail">after it was archived</span>
          <span class="rule-effect">
            <template v-if="loading"><span class="skel skel--line" style="width: 96px"></span></template>
            <template v-else-if="delDays <= 0">Nothing deleted</template>
            <template v-else>
              {{ plural(legend?.del.files || 0, 'file') }} · {{ mb(legend?.del.bytes) }} · to
              {{ trashWord }}
            </template>
          </span>
        </div>
      </div>

      <p v-if="!loading" class="rule-derived mnote">
        <template v-if="off">
          Retention is off: nothing is archived on its own and nothing is ever removed.
          The shelf stays where you put it.
        </template>
        <template v-else-if="arcDays <= 0">
          Nothing new is archived on its own. Files already in the archive are removed
          {{ delDays }} days after they were archived, and the archive never grows.
        </template>
        <template v-else-if="delDays <= 0">
          A file is archived at {{ arcDays }} days since it was last opened and never
          removed — the archive is where a finished file stays until you take it out.
        </template>
        <template v-else>
          A file is archived at {{ arcDays }} days since it was last opened and deleted at
          <b>{{ deathDays }}</b>: ② is a count of days <em>in the archive</em>, so moving ①
          moves both lines.
        </template>
      </p>

      <div v-if="danger" class="ret-warn" role="status">
        <b>② is {{ delDays }} {{ delDays === 1 ? 'day' : 'days' }}.</b>
        The next pass removes <b>{{ plural(forecast?.delete.files || 0, 'file') }}</b> from
        {{ trashWord }}. On the system Trash that is restorable until the Trash is emptied;
        in this build's fallback folder it is not restored by the OS at all. Raising ① is
        what empties the archive without touching the files.
      </div>

      <div class="acct-sep">
        When it runs
        <small v-if="executor?.alwaysOn">On the sync host's clock, which is always on</small>
        <small v-else-if="here">On this machine's clock, and within a minute of the next launch</small>
        <small v-else>On {{ executorPlace }}'s clock — a pass runs when that machine is open</small>
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
            <option
              v-for="event in EVENTS"
              :key="event.id"
              :value="event.id"
              :selected="settings?.archiveEvery === event.id"
            >
              {{ event.label }}
            </option>
          </select>
          <span class="sched-tail" :hidden="settings?.archiveEvery === 'manual'">{{ deadlineWord }}</span>
          <input
            class="acct-input sched-time"
            type="time"
            :value="clock(settings?.archiveBy)"
            :hidden="settings?.archiveEvery === 'manual'"
            :disabled="!canEdit || saving || settings?.archiveEvery === 'manual'"
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
            <option
              v-for="event in EVENTS"
              :key="event.id"
              :value="event.id"
              :selected="settings?.deleteEvery === event.id"
            >
              {{ event.label }}
            </option>
          </select>
          <span class="sched-tail" :hidden="settings?.deleteEvery === 'manual'">{{ deadlineWord }}</span>
          <input
            class="acct-input sched-time"
            type="time"
            :value="clock(settings?.deleteBy)"
            :hidden="settings?.deleteEvery === 'manual'"
            :disabled="!canEdit || saving || settings?.deleteEvery === 'manual'"
            aria-label="The latest the delete pass may wait"
            @change="setBy('delete', $event.target.value)"
          />
          <span class="sched-effect">{{ whenLabel('delete') }}</span>
        </div>
      </div>

      <div v-if="!executor?.alwaysOn" class="notif-options">
        <div class="notif-option">
          <span class="sfx-copy">
            <b>Start a pass when the machine is idle</b>
            <span>
              A pass waits while a run or a chat turn is answering, and runs at the first
              tick after that — which is all this build can see of "idle": typing and the
              pointer are not measured. Off: a pass runs exactly at the time above. Either
              way, one the machine slept through starts within a minute of the app opening.
            </span>
          </span>
          <button
            class="sfx-switch"
            type="button"
            role="switch"
            :aria-checked="idle ? 'true' : 'false'"
            :aria-label="`Start a pass when the machine is idle, ${idle ? 'on' : 'off'}`"
            :disabled="!canEdit || saving"
            @click="toggleIdle"
          >
            <span></span>
          </button>
        </div>
      </div>

      <div class="forecast">
        <p class="forecast-head">
          <template v-if="!configured">Not configured yet — nothing is swept</template>
          <template v-else-if="!here">
            Runs on {{ executorPlace }}<template v-if="manual"> · no automatic pass</template>
          </template>
          <template v-else-if="manual">No automatic pass</template>
          <template v-else-if="late">Due now — the deadline has passed</template>
          <template v-else-if="idle">
            Next pass · any quiet moment, by {{ clock(settings?.archiveBy) }}
          </template>
          <template v-else>
            Next pass · exactly at {{ clock(settings?.archiveBy) }}, when due
          </template>
        </p>

        <ul v-if="!loading">
          <li>
            <b>{{ plural(forecast?.archive.files || 0, 'file') }} archived</b>
            <em>· {{ mb(forecast?.archive.bytes) }} moves into .archive/</em>
          </li>
          <li class="del">
            <b>{{ plural(forecast?.delete.files || 0, 'file') }} deleted</b>
            <em v-if="trashMode === 'system'">
              · {{ mb(forecast?.delete.bytes) }} to the Trash, restorable until it is emptied
            </em>
            <em v-else>
              · {{ mb(forecast?.delete.bytes) }} to artifacts/.trash — this build has no OS
              Trash, so nothing restores it for you
            </em>
          </li>
          <li v-if="forecast?.held.referenced">
            <b>{{ plural(forecast.held.referenced, 'file') }} held back</b>
            <em>· a live chat still names them, so this pass does not touch them</em>
          </li>
          <li>
            <b>
              Shelf {{ forecast?.shelf.filesBefore || 0 }} files ·
              {{ mb(forecast?.shelf.bytesBefore) }} → {{ forecast?.shelf.filesAfter || 0 }} files ·
              {{ mb(forecast?.shelf.bytesAfter) }}
            </b>
            <em>· one more pass brings it to {{ mb(forecast?.shelf.bytesSettled) }}</em>
          </li>
        </ul>

        <button
          v-if="forecast?.total"
          class="disclose"
          type="button"
          :aria-expanded="open ? 'true' : 'false'"
          aria-controls="art-ret-list"
          @click="open = !open"
        >
          {{ open ? 'Hide' : 'Show' }} what changes tonight
        </button>

        <ul v-if="open && forecast?.list.length" id="art-ret-list" class="tlist">
          <li v-for="row in forecast.list" :key="row.id" class="tlist-row">
            <span class="n" :title="row.id">{{ row.name }}</span>
            <span class="d">{{ row.age }}d</span>
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
            <b>Never archive or delete a file a live chat still names</b>
            <span>
              {{ plural(forecast?.held.referenced || 0, 'file') }} ·
              {{ mb(forecast?.held.bytes) }} named by an
              <code class="mono">artifact://</code> path in a message, a tool call or a
              tool result of a thread that has not been archived. The conversation is how
              you remember why the file exists, so the file keeps its place.
              <template v-if="!state?.references">
                This build has no chat index wired in, so the switch currently protects
                nothing.
              </template>
            </span>
          </span>
          <button
            class="sfx-switch"
            type="button"
            role="switch"
            :aria-checked="settings?.protectReferenced ? 'true' : 'false'"
            aria-label="Never move a file a live chat still names"
            :disabled="!canEdit || saving"
            @click="toggleReferenced"
          >
            <span></span>
          </button>
        </div>
      </div>

      <p class="mnote sweep-note">
        A pinned file has no row here, because a file on this shelf has no pin to set and
        the switch would promise a state nothing can hold. And a reference is matched by its
        exact path: a message pointing at <code class="mono">design/</code> protects no file
        inside it.
      </p>

      <p v-if="error" class="acct-error" role="alert">
        <b>{{ error }}</b>
        <button class="btn btn-sm" type="button" @click="loadArtifactRetention({ force: true })">
          Retry now
        </button>
      </p>

      <p class="mnote sweep-note">
        Rules save as you change them. This runs the pass now, instead of waiting for the
        deadline. It never restores and it never overrides a protection.
      </p>

      <div class="acct-actions">
        <button class="btn btn-ghost" type="button" @click="openShelf">
          Open the shelf
        </button>
        <button
          class="btn btn-ink"
          type="button"
          :disabled="!canEdit || saving || !configured || !here"
          :title="
            !configured
              ? 'Set a threshold first — this workspace has no sweep yet'
              : !here
                ? `The sweep runs on ${executorPlace}`
                : `Archives ${plural(forecast?.archive.files || 0, 'file')} and removes ${plural(forecast?.delete.files || 0, 'file')}`
          "
          @click="runNow"
        >
          {{ saving && artifactRetention.pending === 'pass' ? 'Running…' : 'Archive due now' }}
        </button>
      </div>

      <div class="acct-sep">
        Erase all
        <small>The one write here that the archive and the trash cannot undo</small>
      </div>

      <div class="erase-options">
        <div class="erase-option">
          <span class="sfx-copy">
            <b>Shared shelf</b>
            <span>
              {{ plural(meta?.files || 0, 'file') }} on the shelf ·
              {{ plural(meta?.archived || 0, 'file') }} in the archive. The hidden
              <code class="mono">.archive/</code> and <code class="mono">.trash/</code>
              go with them.
            </span>
          </span>
          <button
            class="btn btn-danger btn-sm"
            type="button"
            :disabled="!canEdit || saving || erasing || !(meta?.files || meta?.archived)"
            :title="
              !canEdit
                ? 'Only an owner or an admin can erase the shelf'
                : !(meta?.files || meta?.archived)
                  ? 'The shared shelf is empty'
                  : `Removes ${plural((meta?.files || 0) + (meta?.archived || 0), 'file')}`
            "
            @click="eraseScope = 'shared'"
          >
            Erase shared
          </button>
        </div>

        <div class="erase-option">
          <span class="sfx-copy">
            <b>Your personal shelf</b>
            <span>
              {{ plural(meta?.personal || 0, 'file') }} under
              <code class="mono">.personal/&lt;account&gt;/artifacts/</code> for the account
              this window is signed in as. It syncs nowhere, and the shared shelf keeps
              its files.
            </span>
          </span>
          <button
            class="btn btn-danger btn-sm"
            type="button"
            :disabled="!canEdit || saving || erasing || !meta?.personal"
            :title="
              !canEdit
                ? 'Only an owner or an admin can erase a shelf'
                : !meta?.personal
                  ? 'Your personal shelf is empty'
                  : `Removes ${plural(meta.personal, 'file')}`
            "
            @click="eraseScope = 'personal'"
          >
            Erase personal
          </button>
        </div>

        <div class="erase-option">
          <span class="sfx-copy">
            <b>Everything in this workspace</b>
            <span>
              The shared shelf with its archive and trash, and your personal shelf —
              both buttons above in one write.
            </span>
          </span>
          <button
            class="btn btn-danger btn-sm"
            type="button"
            :disabled="
              !canEdit || saving || erasing || !((meta?.files || 0) + (meta?.archived || 0) + (meta?.personal || 0))
            "
            :title="
              !canEdit
                ? 'Only an owner or an admin can erase these shelves'
                : !((meta?.files || 0) + (meta?.archived || 0) + (meta?.personal || 0))
                  ? 'There is no artifact in this workspace yet'
                  : 'Removes the shared world and every personal shelf'
            "
            @click="eraseScope = 'all'"
          >
            Erase all
          </button>
        </div>
      </div>

      <EraseAllDialog
        :open="eraseOpen"
        kind="artifacts"
        :scope="eraseScope"
        :workspace="hub.workspaceLabel || hub.workspace"
        :summary="summaryFor(eraseScope)"
        :target="eraseTarget"
        :busy="erasing"
        :error="eraseError"
        @close="eraseOpen = false"
        @confirm="erase"
      />

      <p class="mnote ret-foot">
        <template v-if="last?.error">
          Last pass failed {{ ago(last.at) }} — {{ last.error }}
        </template>
        <template v-else-if="!last?.at">
          No pass has run yet · the first one runs
          <template v-if="schedule?.archive.automatic">
            {{ deadlineWord }} {{ clock(settings?.archiveBy) }}, or at the next launch
          </template>
          <template v-else>when you press Archive due now</template>
        </template>
        <template v-else>
          Last pass {{ ago(last.at) }} · {{ plural(last.archived || 0, 'file') }} archived ·
          {{ plural(last.deleted || 0, 'file') }} removed
        </template>
        <template v-if="!configured"> · not configured — an owner or admin sets the rule once</template>
        <template v-else-if="!here"> · runs on {{ executorPlace }}</template>
        <template v-else-if="off"> · retention off — the pass wakes up when a day count comes back</template>
        <template v-else-if="manual"> · no automatic pass — press Archive due now</template>
        <template v-else-if="idle"> · next pass by {{ clock(settings?.archiveBy) }}, the first quiet moment</template>
        <template v-else> · next pass at {{ clock(settings?.archiveBy) }}</template>
      </p>
    </section>

    <aside class="role-card">
      <h2>Archive shelf</h2>
      <p class="mnote">
        An artifact is one file under the workspace's
        <code class="mono">artifacts/</code> folder. Archiving moves it; deleting is the
        one-way door, and this build labels which door it has.
      </p>

      <pre class="codebox ret-code">~/entity/workspaces/{{ hub.workspace }}/
  artifacts/               {{ plural(meta?.files || 0, 'file') }} · {{ mb(meta?.bytes) }}
  artifacts/.archive/      {{ plural(meta?.archived || 0, 'file') }} · {{ mb(meta?.archivedBytes) }}
  artifacts/.opened.json   the last time each file was opened
  workspace.json           the rule on this card
  artifact-retention.json  this machine's sweep position</pre>

      <p class="mnote">
        <b>Restore</b> — move the file back out of
        <code class="mono">artifacts/.archive/</code>. The shelf lists everything except dot
        folders, so an archived file leaves the app's list, not the disk.
      </p>
      <p class="mnote">
        <b>Delete</b> —
        <template v-if="trashMode === 'system'">
          the OS Trash. It stays restorable until the Trash is emptied, which is the
          desktop's own promise, not this card's 30 days.
        </template>
        <template v-else>
          this build has no OS Trash, so the file is copied to
          <code class="mono">artifacts/.trash/</code> and removed from the archive. Restoring
          it is a file-manager job.
        </template>
      </p>
      <p class="mnote">
        <b>Erase all</b> — three buttons, one per population: the shared shelf with
        <code class="mono">.archive/</code> and <code class="mono">.trash/</code>, every
        personal shelf under <code class="mono">.personal/</code>, or both at once. One
        dialog each, no undo.
      </p>
      <p class="mnote">
        <b>Where it runs</b> — the one machine named in
        <code class="mono">artifactRetention.executor</code>, anywhere the files are. The
        deadline is that machine's local time: a sync host in a container usually runs UTC,
        so its 03:00 is 03:00 UTC, not yours.
      </p>
      <p class="mnote">
        <b>Age</b> — days since this machine last opened or read the file.
        {{ meta?.opened || 0 }} of {{ meta?.files || 0 }} files on the shelf have been
        opened here; the rest count from their modification time. A machine that takes an
        existing sweep over from another one inherits no age — its clock starts when it
        starts watching — so a takeover cannot archive a shelf that was healthy elsewhere.
      </p>
      <p class="mnote">
        <b>Shared with the team</b> — the thresholds, the cadences and the machine that
        runs the pass are workspace configuration: one owner or admin sets them and every
        clone reads them. The archive, its dates and the opened map stay on the machine
        that runs the pass. A personal shelf
        (<code class="mono">.personal/&lt;account&gt;/artifacts/</code>) is private to one account
        and is outside this rule.
      </p>
      <p class="mnote">
        <b>The archive date</b> — stamped once, the moment a file moves in. ② counts from
        that stamp, so a pass that runs every thirty minutes cannot reset it.
      </p>
    </aside>
  </div>
</template>
