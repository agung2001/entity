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
 * `ponytail:` the drafting step is deterministic and local: one task per clause of
 * the sentence, an even spread of dates, priority from the clause's own words.
 * There is no agent round-trip and no `@` context picker, because both exist to
 * feed one and shipping a picker that feeds nothing is a control that lies. The
 * ceiling is reasoning, not the data: `draftFrom` already returns the task objects
 * a harness answer would have to arrive in, and the merge below is the rule that
 * answer must keep.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import PickMenu from '@/components/PickMenu.vue'
import SlashComposer from '@/components/SlashComposer.vue'
import TaskRow from '@/components/goal/TaskRow.vue'
import { today, PRIORITY_ORDER, draftFrom, blankTask, priorityWord } from '@/lib/goals'
import { markFor, moodGlyph } from '@/composables/entityMark'
import { dialogDepth } from '@/composables/useDialog'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import { plural } from '@/lib/transfer'
import { hub } from '@/stores/hub'

const props = defineProps({
  /** the write, owned by the view: a promise, so a refusal lands beside the button */
  save: { type: Function, required: true },
  initialSentence: { type: String, default: '' },
  initialTitle: { type: String, default: '' },
})
const emit = defineEmits(['cancel'])

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
  const first = sentence.value.trim().split(/[.,;\n]/)[0].replace(/\s+/g, ' ').trim()
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

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

/** The composer's send is this flow's `Draft tasks`: the sentence stays in the
    box (a goal is written once and edited, not sent away). */
function onSend(text) {
  draft()
  nextTick(() => {
    sentence.value = text
  })
}

/** One short delay, so the skeleton is never a bare spinner over empty space. */
function draft() {
  touched.value.sentence = true
  touched.value.date = true
  if (!canDraft.value || drafting.value) return
  drafting.value = true
  window.setTimeout(() => {
    const answer = draftFrom(sentence.value, deadline.value, tasks.value)
    backup.value = tasks.value.map((task) => ({ ...task }))
    tasks.value = answer.tasks
    merged.value = answer.merged
    drafting.value = false
    step.value = 2
  }, 450)
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
      tasks: tasks.value.map((task) => ({ ...task, title: String(task.title).trim() })),
    })
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
        <button v-if="step === 1" class="btn" type="button" @click="emit('cancel')">Cancel</button>
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

    <!-- ── step 1 ─────────────────────────────────────────────────────── -->
    <div v-if="step === 1" class="wiz">
      <div class="fld-solo">
        <label for="goal-title">Title <kbd class="fld-key">{{ keys.title }}</kbd></label>
        <input id="goal-title" ref="titleField" v-model="title" type="text" :placeholder="titleOf" />
        <span class="hint">The line the backlog and the calendar will print. Left empty, it takes the first line of the sentence.</span>
      </div>

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
        <span class="hint">Planning runs on this machine — there is no machine to pick. The entity supplies the skills and the mentions the composer offers.</span>
      </div>

      <div class="fld-solo">
        <label class="fld-head">Goal <b aria-hidden="true">·</b> required <kbd class="fld-key">{{ keys.sentence }}</kbd></label>
        <!-- The thread composer, not a textarea: `/` inserts a skill and `@` a
             mention, and a picked item becomes a token in the sentence — the same
             box the chat uses, so a goal can be written the way a prompt is. -->
        <div class="cm cm-composer" :data-state="sentenceWhy ? 'error' : undefined" @focusout="touched.sentence = true">
          <SlashComposer
            ref="composer"
            :agent="agent"
            machine="local"
            base-dir=""
            placeholder="Describe the outcome you want by the deadline — / skills · @ mentions"
            label="Goal sentence — / for a skill, @ to mention"
            :draft="sentence"
            @update:draft="sentence = $event"
            @send="onSend"
          />
          <div class="cm-acts">
            <span class="cm-hint" :class="{ danger: sentenceWhy }">
              {{ sentenceWhy || 'One sentence. The draft reasons from it and nothing else.' }}
            </span>
            <span class="cm-grow"></span>
            <span class="cm-hint"><kbd>{{ draftKey }}</kbd> drafts the tasks</span>
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

      <div class="wiz-foot">
        <span class="why">{{ required }} of 2 required</span>
        <button class="btn" type="button" @click="emit('cancel')">Cancel</button>
        <button class="btn btn-primary" type="button" :disabled="!canDraft || drafting" @click="draft">
          {{ drafting ? 'Drafting…' : 'Draft tasks' }}<span class="btn-kbd">{{ draftKey }}</span>
        </button>
      </div>
    </div>

    <!-- ── step 2 ─────────────────────────────────────────────────────── -->
    <div v-else class="split">
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
        <div class="panel">
          <div class="panel-h"><span class="t">What the draft used</span></div>
          <div class="panel-body">
            <div v-for="group in groups" :key="`bar-${group.priority}`" class="prow">
              <span class="lb"><span class="pri" :data-p="group.priority">{{ priorityWord(group.priority) }}</span></span>
              <span class="bar" aria-hidden="true">
                <span class="fill" :style="{ width: `${Math.round((group.tasks.length / Math.max(1, tasks.length)) * 100)}%` }"></span>
              </span>
              <span class="ct">{{ group.tasks.length }}</span>
            </div>
            <p class="ctx-note">
              {{ plural(tasks.length, 'task') }} over {{ days }} {{ days === 1 ? 'day' : 'days' }}, drafted
              from the sentence. The dates are an even spread to the deadline — no tracker was read.
            </p>
          </div>
        </div>

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
  </div>
</template>
