<script setup>
/**
 * The create flow, steps 1 and 2 in one `.wiz` (§1 F2–F4a, §2.2).
 *
 * Step 1 is three inputs and two radio cards: `Draft tasks` is disabled until the
 * sentence is non-empty **and** a date is chosen, no date is pre-filled, and a
 * refusal prints beside the field that caused it while the button keeps its label.
 * Step 2 is the drafted list — every row editable — and `Create goal` is the only
 * thing that writes.
 *
 * `Draft tasks` is the planning step: the sentence and the context it names go
 * to the chosen entity's harness (`goals.draft`), which reads the mentioned
 * `@orca:` projects and answers with the task list. The skeleton is the screen
 * while it runs. A failure says why and offers the two real exits — Retry, or
 * `Write the tasks myself`, the harness-free clause split that keeps the goal
 * creatable offline.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { call, onRunEvent } from '@/composables/localBridge'
import PickMenu from '@/components/PickMenu.vue'
import PromptEnhanceDialog from '@/components/PromptEnhanceDialog.vue'
import SlashComposer from '@/components/SlashComposer.vue'
import GoalDraftCharts from '@/components/goal/GoalDraftCharts.vue'
import TaskRow from '@/components/goal/TaskRow.vue'
import { EFFORT_WEIGHT, PRIORITY_ORDER, blankTask, draftFrom, mergeTasks, priorityWord, today } from '@/lib/goals'
import { markFor, moodGlyph } from '@/composables/entityMark'
import { clearDraft, readDraft, saveDraft, sweepDrafts } from '@/lib/draftCache'
import { dialogDepth } from '@/composables/useDialog'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import { plural } from '@/lib/transfer'
import { pickableHarnesses } from '@/stores/harnesses'
import { ago, hub, toast } from '@/stores/hub'

const props = defineProps({
  /** the write, owned by the view: a promise, so a refusal lands beside the button */
  save: { type: Function, required: true },
  initialSentence: { type: String, default: '' },
  initialTitle: { type: String, default: '' },
})
const emit = defineEmits(['cancel', 'update:step'])

const step = ref(1)
const title = ref(props.initialTitle)
const sentence = ref(props.initialSentence)
/* The entity that plans this goal. It is a real choice, not decoration: the
   composer's `/` menu offers that entity's preferred skills, and the record
   keeps the name so the goal page can say who it was planned by. */
const entities = computed(() => hub.agents || [])
/* The chat's own entity picker: the same mark, the same rows, the same search. */
const entityOptions = computed(() =>
  entities.value.map((entry) => ({
    id: entry.id || entry.name,
    label: entry.name,
    meta: entry.harnessLabel,
    glyph: moodGlyph(markFor(hub.workspace, entry.id || entry.name, entry.mark).mood),
  })),
)
const entity = ref(String(entities.value[0]?.id || entities.value[0]?.name || ''))
const agent = computed(
  () => entities.value.find((entry) => (entry.id || entry.name) === entity.value) || entities.value[0] || { name: 'Goal' },
)
/* A harness is the entity's default until the person picks another one; the
   choice rides with the goal so the plan can be run with it later. */
watch(entity, () => {
  const next = String(agent.value?.harness || '')
  if (next) harness.value = next
})
/* One digit per field, from the catalog, so the key on the label and the
   handler below cannot drift — the same contract the New-thread dialog keeps. */
const keys = {
  title: shortcutLabel('goal-title'),
  entity: shortcutLabel('goal-entity'),
  sentence: shortcutLabel('goal-sentence'),
  deadline: shortcutLabel('goal-deadline'),
  privacy: shortcutLabel('goal-privacy'),
}
const draftKey = shortcutLabel('goal-draft')
const elapsedLabel = computed(() => {
  const seconds = Math.max(0, Math.round(draftElapsed.value / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
})

function startClock() {
  stopClock()
  draftStartedAt.value = Date.now()
  draftElapsed.value = 0
  elapsedTimer = setInterval(() => {
    draftElapsed.value = Date.now() - draftStartedAt.value
  }, 250)
}

function stopClock() {
  if (!elapsedTimer) return
  clearInterval(elapsedTimer)
  elapsedTimer = null
}

/* The planning turn streams the same way a thread does: the main process emits
   `goal.draft` phases, and this page draws the steps and the clock it owns. */
function onDraftEvent(event) {
  if (!event || event.kind !== 'goal.draft' || !draftId.value || event.draftId !== draftId.value) return
  if (event.phase === 'start') {
    draftSteps.value = []
    return
  }
  if (event.phase !== 'step' || !event.data) return
  const step = event.data
  const list = draftSteps.value
  const last = list[list.length - 1]
  /* a text block grows; refresh its row instead of stacking a row per chunk */
  if (step.type === 'text' && last && last.type === 'text') {
    draftSteps.value = [...list.slice(0, -1), step]
    return
  }
  draftSteps.value = [...list.slice(-9), step]
}
const attachments = ref([])
const harness = ref(String(entities.value[0]?.harness || ''))
const harnessOptions = computed(() =>
  pickableHarnesses.value.map((item) => ({
    id: item.id,
    label: item.label,
    meta: item.installed ? 'installed' : 'not found',
  })),
)
const enhanceOpen = ref(false)
const restoredAt = ref(0)
const draftId = ref('')
const draftSteps = ref([])
const draftStartedAt = ref(0)
const draftElapsed = ref(0)
let elapsedTimer = null
let stopDraftEvents = null
const CACHE_KEY = `goals-new:${hub.workspace}`
let saveTimer = null
const titleField = ref(null)
const entityPick = ref(null)
const composer = ref(null)
const dateField = ref(null)
const privacyField = ref(null)
const deadline = ref('')
const privacy = ref('private')
const touched = ref({ sentence: false, date: false })
const tasks = ref([])
const drafting = ref(false)
const draftError = ref('')
const draftSource = ref('')
const draftSummary = ref('')
const draftModel = ref('')
const merged = ref([])
const backup = ref(null)
const creating = ref(false)
const refused = ref('')

const pad = (value) => String(value).padStart(2, '0')
const addDays = (days) => {
  const now = new Date()
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days)
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

const pills = computed(() => [
  { label: 'Today', value: today() },
  { label: 'Today + 2 w', value: addDays(14) },
  { label: 'Today + 1 m', value: addDays(30) },
])

const required = computed(() => (sentence.value.trim() ? 1 : 0) + (deadline.value ? 1 : 0))
const canDraft = computed(() => required.value === 2)
const sentenceWhy = computed(() =>
  touched.value.sentence && !sentence.value.trim()
    ? 'Write one sentence. Draft tasks stays disabled.'
    : '',
)
const dateWhy = computed(() => (touched.value.date && !deadline.value ? 'No date yet' : ''))

const titleOf = computed(() => {
  const typed = title.value.trim()
  if (typed) return typed
  /* a token is context, not a title: strip `@mention` and `/skill` before the
     sentence's first clause becomes the default title */
  const first = sentence.value
    .trim()
    .split(/[.,;\n]/)[0]
    .replace(/(^|\s)[@/][\w:.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (first || 'A new goal').slice(0, 90)
})

const groups = computed(() =>
  PRIORITY_ORDER.map((priority) => ({
    priority,
    tasks: tasks.value.filter((task) => task.priority === priority),
  })).filter((group) => group.tasks.length),
)

const broken = computed(
  () => tasks.value.length > 0 && tasks.value.some((task) => !String(task.title || '').trim()),
)
const canCreate = computed(() => tasks.value.length > 0 && !broken.value && !creating.value)
const createWhy = computed(() => {
  if (!tasks.value.length) return 'Draft at least one task.'
  if (broken.value) return 'Every task needs a title before it can be stored.'
  return ''
})

const days = computed(() => {
  if (!deadline.value) return 0
  const start = new Date()
  const [year, month, date] = deadline.value.split('-').map(Number)
  return Math.max(0, Math.round((Date.UTC(year, month - 1, date) - Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) / 86_400_000))
})

function pick(value) {
  deadline.value = value
  touched.value.date = true
}

/* The page owns its keys at the window, like the thread dialog: focus moves
   between a text input, a picker, a composer, a date field and two radios, and a
   handler on one element would only work while that element had focus. The
   composer's own send handler runs first on its textarea and prevents default,
   so a Cmd+Enter inside it is not also handled here. */
function onKey(event) {
  if (event.defaultPrevented) return
  /* a modal owns the keyboard while it is open (the guide, a picker's own stack) */
  if (dialogDepth()) return
  if (matchesShortcut('goal-draft', event)) {
    event.preventDefault()
    runStep()
    return
  }
  if (step.value !== 1) return
  if (matchesShortcut('enhance-prompt', event) && sentence.value.trim()) {
    event.preventDefault()
    openEnhance()
    return
  }
  const targets = {
    'goal-title': titleField,
    'goal-entity': entityPick,
    'goal-sentence': composer,
    'goal-deadline': dateField,
    'goal-privacy': privacyField,
  }
  for (const [id, target] of Object.entries(targets)) {
    if (!matchesShortcut(id, event)) continue
    event.preventDefault()
    /* the picker opens; a field or the composer takes the caret */
    if (id === 'goal-entity') target.value?.toggle?.()
    else target.value?.focus?.()
    return
  }
}

/* Cmd+Enter takes the step: draft on step 1, create on step 2. Blur first, so a
   row that is mid-edit commits before the goal is stored from the task list. */
async function runStep() {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  await nextTick()
  if (step.value === 1) draft()
  else await create()
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  stopDraftEvents = onRunEvent(onDraftEvent)
  /* a restored draft can already be on step 2; the listener is bound by now, so
     the page can widen before the first paint of the list */
  emit('update:step', step.value)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  stopClock()
  stopDraftEvents?.()
  stopDraftEvents = null
})

function openEnhance() {
  if (!sentence.value.trim()) return
  enhanceOpen.value = true
}

/* A rewrite replaces the sentence, in place, and offers the one step back the
   chat's own enhance offers. */
function applyEnhancement({ text, index }) {
  const previous = sentence.value
  sentence.value = text
  enhanceOpen.value = false
  toast(`Applied variation ${index + 1} · the sentence was replaced`, {
    actionLabel: 'Undo',
    onAction: () => {
      sentence.value = previous
    },
  })
}

/** The composer's send is this flow's `Draft tasks`: the sentence stays in the
    box (a goal is written once and edited, not sent away). */
function onSend(text) {
  draft()
  nextTick(() => {
    sentence.value = text
  })
}

/** The agent's answer lands in the list with the same merge a retry keeps. */
/* the page widens for step 2: the plan, its charts and its columns need the band */
watch(step, (value) => emit('update:step', value), { immediate: true })

function applyDraft(proposed, source) {
  const answer = mergeTasks(tasks.value, proposed)
  backup.value = tasks.value.map((task) => ({ ...task }))
  tasks.value = answer.tasks
  merged.value = answer.merged
  draftSource.value = source
  step.value = 2
}

/**
 * `Draft tasks` is a planning turn: the sentence plus the context it names go to
 * the chosen entity's harness, and the tasks come back from it. The skeleton is
 * the screen while it runs; a failure says why and offers the two real exits.
 */
async function draft() {
  touched.value.sentence = true
  touched.value.date = true
  if (!canDraft.value || drafting.value) return
  drafting.value = true
  draftError.value = ''
  draftId.value = crypto.randomUUID()
  draftSteps.value = []
  startClock()
  try {
    const answer = await call('goals.draft', {
      workspace: hub.workspace,
      draftId: draftId.value,
      entity: entity.value,
      harness: harness.value,
      sentence: sentence.value,
      deadline: deadline.value,
      context: attachments.value,
      entities: entityOptions.value.map((option) => option.id),
    })
    const tasks = Array.isArray(answer?.tasks) ? answer.tasks : []
    if (!tasks.length) throw new Error('The harness answered with no task list.')
    draftSummary.value = String(answer?.summary || '')
    draftModel.value = String(answer?.model || '')
    applyDraft(tasks, 'harness')
  } catch (problem) {
    draftError.value = problem?.message || 'The draft did not answer.'
  } finally {
    stopClock()
    drafting.value = false
  }
}

/** The F4b exit that never needs a harness: one task per clause, locally. */
function draftLocally() {
  if (!canDraft.value) return
  draftError.value = ''
  const answer = draftFrom(sentence.value, deadline.value, tasks.value)
  backup.value = tasks.value.map((task) => ({ ...task }))
  tasks.value = answer.tasks
  merged.value = answer.merged
  draftSource.value = 'local'
  draftSummary.value = ''
  step.value = 2
}

function addTask(priority) {
  tasks.value = [...tasks.value, blankTask(priority)]
}

function updateTask(task, patch) {
  tasks.value = tasks.value.map((entry) => (entry.id === task.id ? { ...entry, ...patch } : entry))
}

function removeTask(task) {
  tasks.value = tasks.value.filter((entry) => entry.id !== task.id)
}

function toggle(task, done) {
  updateTask(task, { done })
}

/** The banner offers the real alternative: put back the rows the merge joined. */
function keepSeparate() {
  if (!backup.value) return
  const mergedTitles = new Set(merged.value.map((value) => value.trim().toLowerCase()))
  const kept = tasks.value.filter((task) => !mergedTitles.has(String(task.title).trim().toLowerCase()))
  tasks.value = [...kept, ...backup.value.filter((task) => mergedTitles.has(String(task.title).trim().toLowerCase()))]
  merged.value = []
}

/** What this tab remembers while the person is away from the page. */
function snapshot() {
  return {
    step: step.value,
    title: title.value,
    sentence: sentence.value,
    deadline: deadline.value,
    privacy: privacy.value,
    entity: entity.value,
    harness: harness.value,
    tasks: tasks.value,
    merged: merged.value,
    draftSource: draftSource.value,
    summary: draftSummary.value,
    /* a local file's bytes are not a draft: they are what the quota cannot hold,
       and the goal keeps the reference anyway */
    attachments: attachments.value.map(({ data, ...rest }) => rest),
  }
}

const RESTORE_ENTITY = (value) =>
  entityOptions.value.some((option) => option.id === value) ? String(value) : entity.value
const RESTORE_HARNESS = (value) =>
  harnessOptions.value.some((option) => option.id === value) ? String(value) : harness.value
const RESTORE_TASK = (task) =>
  task && typeof task === 'object' && typeof task.id === 'string' && typeof task.title === 'string'

function restore() {
  sweepDrafts()
  const hit = readDraft(CACHE_KEY)
  const value = hit?.value
  if (!value || typeof value !== 'object') return
  const meaningful =
    value.step === 2 ||
    Boolean(String(value.title || '').trim() || String(value.sentence || '').trim() || value.deadline)
  if (!meaningful) {
    clearDraft(CACHE_KEY)
    return
  }
  if (value.step === 2) step.value = 2
  title.value = typeof value.title === 'string' ? value.title : ''
  sentence.value = typeof value.sentence === 'string' ? value.sentence : ''
  deadline.value = typeof value.deadline === 'string' ? value.deadline : ''
  if (value.privacy === 'workspace' || value.privacy === 'private') privacy.value = value.privacy
  entity.value = RESTORE_ENTITY(value.entity)
  harness.value = RESTORE_HARNESS(value.harness)
  tasks.value = Array.isArray(value.tasks) ? value.tasks.filter(RESTORE_TASK) : []
  merged.value = Array.isArray(value.merged) ? value.merged.map(String) : []
  if (value.draftSource === 'local' || value.draftSource === 'harness') draftSource.value = value.draftSource
  draftSummary.value = typeof value.summary === 'string' ? value.summary : ''
  attachments.value = Array.isArray(value.attachments) ? value.attachments : []
  restoredAt.value = hit.savedAt
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveDraft(CACHE_KEY, snapshot())
  }, 350)
}

function startOver() {
  clearDraft(CACHE_KEY)
  restoredAt.value = 0
  step.value = 1
  title.value = ''
  sentence.value = ''
  deadline.value = ''
  privacy.value = 'private'
  tasks.value = []
  merged.value = []
  backup.value = null
  attachments.value = []
  draftSource.value = ''
  draftSummary.value = ''
  draftError.value = ''
}

function cancel() {
  clearDraft(CACHE_KEY)
  emit('cancel')
}

restore()
watch(
  [step, title, sentence, deadline, privacy, entity, harness, tasks, merged, draftSource, attachments],
  scheduleSave,
  { deep: true },
)
onBeforeUnmount(() => {
  if (saveTimer) clearTimeout(saveTimer)
  if (step.value === 2 || sentence.value.trim() || title.value.trim() || deadline.value) {
    saveDraft(CACHE_KEY, snapshot())
  }
})

async function create() {
  if (!canCreate.value) return
  creating.value = true
  refused.value = ''
  try {
    await props.save({
      title: titleOf.value,
      sentence: sentence.value.trim(),
      deadline: deadline.value,
      privacy: privacy.value,
      entity: entity.value,
      harness: harness.value,
      context: attachments.value,
      tasks: tasks.value.map((task) => ({ ...task, title: String(task.title).trim() })),
    })
    /* the write landed and the view is leaving: the tab has nothing to restore */
    clearDraft(CACHE_KEY)
    restoredAt.value = 0
  } catch (problem) {
    refused.value = problem?.message || 'The goal could not be created.'
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="goal-wiz">
    <header class="page-head">
      <div>
        <div class="board-eyebrow">
          Goals <b aria-hidden="true">·</b> new
          <template v-if="step === 2"><b aria-hidden="true">·</b> step 2 of 3 <b aria-hidden="true">·</b> draft</template>
        </div>
        <h1>{{ step === 2 ? titleOf : 'New goal' }}</h1>
      </div>
      <div class="head-actions">
        <button v-if="step === 2" class="btn" type="button" :disabled="creating" @click="step = 1">Back</button>
        <button v-if="step === 1" class="btn" type="button" @click="cancel()">Cancel</button>
        <button v-else class="btn btn-primary" type="button" :disabled="!canCreate" @click="create">
          {{ creating ? 'Creating…' : 'Create goal' }}<span class="btn-kbd">{{ draftKey }}</span>
        </button>
      </div>
    </header>

    <div class="steps" :aria-label="`Step ${step} of 3`">
      <span class="st" :data-done="step === 2 ? '1' : undefined" :data-on="step === 1 ? '1' : undefined" :aria-current="step === 1 ? 'step' : undefined">
        <span class="num">{{ step === 2 ? '✓' : '1' }}</span><span class="lb">Describe</span>
      </span>
      <span class="ln"></span>
      <span class="st" :data-on="step === 2 ? '1' : undefined" :aria-current="step === 2 ? 'step' : undefined">
        <span class="num">2</span><span class="lb">Draft the tasks</span>
      </span>
      <span class="ln"></span>
      <span class="st"><span class="num">3</span><span class="lb">Work the goal</span></span>
    </div>

    <!-- the tab's own draft, with the day it expires -->
    <div v-if="restoredAt" class="notebar restored-bar">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
        <circle cx="8" cy="8" r="6" /><path d="M8 4.6V8l2.4 1.6" stroke-linecap="round" />
      </svg>
      <p>
        <b>Draft restored.</b> Saved {{ ago(new Date(restoredAt).toISOString()) }} — this tab keeps it for
        24 hours. <button class="lnk" type="button" @click="startOver">Start over</button>
      </p>
    </div>

    <!-- ── step 1 ─────────────────────────────────────────────────────── -->
    <div v-if="step === 1" class="wiz">
      <div v-if="drafting" class="skel-list" aria-busy="true" aria-label="Planning the tasks">
        <div class="draft-live" role="status">
          <span class="model-spin" aria-hidden="true"></span>
          <span class="draft-live-t">Planning with {{ entity || 'the entity' }}</span>
          <b class="draft-live-clock">{{ elapsedLabel }}</b>
        </div>
        <ol v-if="draftSteps.length" class="draft-steps" aria-live="polite">
          <li v-for="(step, index) in draftSteps" :key="`${index}-${step.tool}`" :data-type="step.type">
            <b>{{ step.tool }}</b><span v-if="step.detail">{{ step.detail }}</span>
          </li>
        </ol>
        <p v-else class="ctx-note draft-note">Reading the sentence and the context it names…</p>
        <div v-for="n in 4" :key="n" class="task skel-task"><span class="skel" :style="{ width: `${70 - n * 7}%`, height: '10px' }"></span></div>
      </div>

      <template v-if="!drafting">
      <div class="fld-solo">
        <label for="goal-title">Title <kbd class="fld-key">{{ keys.title }}</kbd></label>
        <input id="goal-title" ref="titleField" v-model="title" type="text" :placeholder="titleOf" />
        <span class="hint">The line the backlog and the calendar will print. Left empty, it takes the first line of the sentence.</span>
      </div>

      <div class="fld-row">
        <div class="fld-solo">
          <label class="fld-head">Entity <kbd class="fld-key">{{ keys.entity }}</kbd></label>
          <PickMenu
            ref="entityPick"
            class="field-select"
            head="Entity"
            icons="entity"
            :options="entityOptions"
            :model-value="entity"
            @update:model-value="entity = $event"
          />
        </div>
        <div class="fld-solo">
          <label class="fld-head">Harness</label>
          <PickMenu
            class="field-select"
            head="Harness"
            icons="harness"
            :options="harnessOptions"
            :model-value="harness"
            @update:model-value="harness = $event"
          />
        </div>
      </div>
      <span class="hint fld-row-hint">Planning runs on this machine — there is no machine to pick. The entity supplies the skills and the mentions the composer offers; its harness is the one the goal is planned with.</span>

      <div class="fld-solo">
        <label class="fld-head">Goal <b aria-hidden="true">·</b> required <kbd class="fld-key">{{ keys.sentence }}</kbd></label>
        <!-- The thread composer, not a textarea: `/` inserts a skill and `@` a
             mention, and a picked item becomes a token in the sentence — the same
             box the chat uses, so a goal can be written the way a prompt is. -->
        <div class="cm cm-composer" :data-state="sentenceWhy ? 'error' : undefined" @focusout="touched.sentence = true">
          <SlashComposer
            ref="composer"
            :agent="agent"
            :show-send="false"
            machine="local"
            base-dir=""
            placeholder="Describe the outcome you want by the deadline — / skills · @ mentions"
            label="Goal sentence — / for a skill, @ to mention"
            :draft="sentence"
            v-model:attachments="attachments"
            @update:draft="sentence = $event"
            @send="onSend"
            @enhance="openEnhance"
          />
          <div class="cm-acts">
            <span class="cm-hint" :class="{ danger: sentenceWhy }">
              {{ sentenceWhy || 'One sentence, plus whatever you mention — the draft reads that context and plans from it.' }}
            </span>
          </div>
        </div>
      </div>

      <div class="fld-solo">
        <label for="goal-due">Deadline <b aria-hidden="true">·</b> required <kbd class="fld-key">{{ keys.deadline }}</kbd></label>
        <div class="dates">
          <button
            v-for="pill in pills"
            :key="pill.label"
            type="button"
            :aria-pressed="deadline === pill.value ? 'true' : 'false'"
            @click="pick(pill.value)"
          >{{ pill.label }}</button>
          <span class="own">
            <input id="goal-due" ref="dateField" type="date" :value="deadline" @change="pick($event.target.value); $event.target.blur()" />
            <span class="hint" :class="{ danger: Boolean(dateWhy) }">{{ dateWhy || 'or a date' }}</span>
          </span>
        </div>
        <span class="hint">No default. A goal without a date is a wish; the field stays empty until you pick one.</span>
      </div>

      <div class="fld-solo" role="radiogroup" aria-label="Who can see this goal">
        <label class="fld-head">Who can see it <kbd class="fld-key">{{ keys.privacy }}</kbd></label>
        <div class="priv">
          <label :data-on="privacy === 'private' ? '1' : undefined">
            <input ref="privacyField" v-model="privacy" type="radio" value="private" name="goal-privacy" />
            <span class="rd"></span>
            <span class="t"><b>Only me</b><span>Not in Wake Space, not in anyone else's backlog.</span></span>
          </label>
          <label :data-on="privacy === 'workspace' ? '1' : undefined">
            <input v-model="privacy" type="radio" value="workspace" name="goal-privacy" />
            <span class="rd"></span>
            <span class="t"><b>The workspace</b><span>Visible to everyone here. They can read it; only you can edit the tasks.</span></span>
          </label>
        </div>
      </div>

      </template>

      <div v-if="draftError" class="errbar" role="status">
        <b>The draft did not answer.</b>
        <p>{{ draftError }}</p>
        <div class="err-actions">
          <button class="btn btn-sm" type="button" :disabled="!canDraft || drafting" @click="draft">Retry</button>
          <button class="btn btn-sm" type="button" :disabled="!canDraft || drafting" @click="draftLocally">
            Write the tasks myself
          </button>
        </div>
      </div>

      <div class="wiz-foot">
        <span class="why">{{ required }} of 2 required</span>
        <button class="btn" type="button" :disabled="drafting" @click="cancel()">Cancel</button>
        <button class="btn btn-primary" type="button" :disabled="!canDraft || drafting" @click="draft">
          {{ drafting ? `Drafting… ${elapsedLabel}` : 'Draft tasks' }}<span class="btn-kbd">{{ draftKey }}</span>
        </button>
      </div>
    </div>

    <!-- ── step 2 ─────────────────────────────────────────────────────── -->
    <template v-else>
      <section v-if="draftSummary" class="draft-summary" aria-labelledby="draft-summary-t">
        <div class="dsh-head">
          <span class="dsh-t" id="draft-summary-t">The plan, in a paragraph</span>
          <span class="dsh-by">{{ draftSource === 'local' ? 'written locally' : `planned by ${entity || 'the entity'}` }}</span>
        </div>
        <p class="dsh-body">{{ draftSummary }}</p>
        <div class="dsh-stats">
          <span><b>{{ tasks.length }}</b> tasks</span>
          <span><b>{{ criticalCount }}</b> critical</span>
          <span><b>{{ new Set(tasks.map((task) => task.entity).filter(Boolean)).size }}</b> entities</span>
          <span><b>{{ effortPoints }}</b> effort points over {{ days }} days</span>
        </div>
      </section>

    <div class="split draft-split">
      <div>
        <div v-if="merged.length" class="dedupe">
          <span class="lbl">Merged</span>
          <span><b>{{ merged.length }}</b> of the {{ tasks.length }} tasks were already on the list — <b>{{ merged.map((value) => `“${value}”`).join(', ') }}</b> kept the earliest date.</span>
          <button class="lnk" type="button" @click="keepSeparate">Keep them separate</button>
        </div>

        <div v-if="drafting" class="skel-list" aria-busy="true" aria-label="Drafting the tasks">
          <div v-for="n in 6" :key="n" class="task skel-task"><span class="skel" :style="{ width: `${72 - n * 5}%`, height: '10px' }"></span></div>
        </div>

        <div v-for="group in groups" v-else :key="group.priority" class="tgroup">
          <div class="tgh">
            <span :data-p="group.priority">{{ priorityWord(group.priority) }}</span>
            <span class="c">{{ plural(group.tasks.length, 'task') }}</span>
            <span class="sp"></span>
            <button class="add" type="button" @click="addTask(group.priority)">+ task</button>
          </div>
          <ul class="tasks">
            <TaskRow
              v-for="task in group.tasks"
              :key="task.id"
              :task="task"
              editable
              show-entity
              show-effort
              @tick="toggle(task, $event)"
              @update="updateTask(task, $event)"
              @remove="removeTask(task)"
            />
          </ul>
        </div>

        <div v-if="!drafting && !tasks.length" class="blank">
          <h3>No task came back</h3>
          <p>
            The sentence produced no clause to work from. Write the sentence as a few clauses — one job
            each — and draft again. Nothing was created.
          </p>
        </div>

        <p v-if="createWhy" class="ctx-note danger">{{ createWhy }}</p>
      </div>

      <div>
        <GoalDraftCharts :tasks="tasks" :deadline="deadline" />

        <div class="notebar">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <circle cx="8" cy="8" r="6" /><path d="M8 7.4v4M8 5.2v.2" />
          </svg>
          <p><b>No figures yet.</b> Progress on this screen is a count of tasks. The read appears after the first Refresh on the goal.</p>
        </div>

        <div v-if="refused" class="errbar" role="status">
          <b>Could not create the goal.</b>
          <p>{{ refused }}</p>
        </div>
      </div>
    </div>
    </template>

    <PromptEnhanceDialog
      :open="enhanceOpen"
      :seed="sentence"
      :harness="harness"
      @close="enhanceOpen = false"
      @apply="applyEnhancement"
    />
  </div>
</template>
