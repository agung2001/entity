<script setup>
/**
 * One goal (§F5) — four cards, one bar, one list, and the two panels that answer
 * "where is this from" and "what do I do next".
 *
 * The tick is the action: it writes one task and one boolean, and because the
 * backlog and the calendar read the same task object, both move without a
 * Refresh. `Refresh` is the only thing that may change `.goalbar .big`; a local
 * edit moves the count beside it and leaves the bar alone, and the footnote says
 * so. Read-only (a workspace goal opened by someone who is not its owner) keeps
 * the tick as `aria-disabled`, drops `.tmenu` and `+ task` from the DOM, and names
 * the owner in a `.notebar` (§F5r).
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import GoalBar from '@/components/goal/GoalBar.vue'
import GoalNext from '@/components/goal/GoalNext.vue'
import GoalSources from '@/components/goal/GoalSources.vue'
import NavIcon from '@/components/NavIcon.vue'
import GoalsSubnav from '@/components/goal/GoalsSubnav.vue'
import TaskRow from '@/components/goal/TaskRow.vue'
import UiIcon from '@/components/UiIcon.vue'
import { ago, hub } from '@/stores/hub'
import { PRIORITY_ORDER, barOf, blankTask, countsOf, day, priorityWord } from '@/lib/goals'
import { plural } from '@/lib/transfer'
import { archiveGoal, goals, loadGoals, refreshGoal, tickTask, updateGoal } from '@/stores/goals'

const route = useRoute()
const router = useRouter()

const busy = ref(false)
const refreshing = ref(false)
const refreshingError = ref('')
const pageError = ref('')

const workspace = computed(() => String(route.params.workspace || hub.workspace || ''))
const goal = computed(() => goals.items.find((entry) => entry.id === String(route.params.id || '')))
const owner = computed(() => Boolean(goal.value?.owner) && goal.value.owner !== String(hub.session?.email || ''))
const readOnly = computed(() => goal.value?.privacy === 'workspace' && owner.value)
const editable = computed(() => Boolean(goal.value) && !readOnly.value)
const counts = computed(() => countsOf(goal.value))
const bar = computed(() => barOf(goal.value))
const groups = computed(() =>
  PRIORITY_ORDER.map((priority) => ({
    priority,
    tasks: (goal.value?.tasks || []).filter((task) => task.priority === priority),
  })).filter((group) => group.tasks.length),
)
const ownerName = computed(() => String(goal.value?.owner || '').split('@')[0] || 'Its owner')

onMounted(() => {
  if (!goals.loaded || goals.workspace !== workspace.value) loadGoals(workspace.value)
})

async function save(patch) {
  if (!goal.value) return
  busy.value = true
  pageError.value = ''
  try {
    await updateGoal(goal.value.id, patch, workspace.value)
  } catch (problem) {
    pageError.value = problem?.message || 'The change was not saved.'
  } finally {
    busy.value = false
  }
}

const tasksWith = (task, patch) =>
  (goal.value?.tasks || []).map((entry) => (entry.id === task.id ? { ...entry, ...patch } : entry))

async function patchTask(task, patch) {
  if (!editable.value) return
  await save({ tasks: tasksWith(task, patch) })
}

async function removeTask(task) {
  if (!editable.value) return
  await save({ tasks: (goal.value?.tasks || []).filter((entry) => entry.id !== task.id) })
}

async function addTask(priority) {
  if (!editable.value) return
  await save({ tasks: [...(goal.value?.tasks || []), blankTask(priority)] })
}

async function tick(task, done) {
  if (!editable.value) return
  pageError.value = ''
  try {
    await tickTask(goal.value.id, task.id, done, workspace.value)
  } catch (problem) {
    pageError.value = problem?.message || 'The tick was not saved.'
  }
}

async function refresh() {
  if (refreshing.value) return
  refreshing.value = true
  refreshingError.value = ''
  pageError.value = ''
  try {
    const answer = await refreshGoal(goal.value.id, workspace.value)
    refreshingError.value = answer?.error || ''
  } catch (problem) {
    pageError.value = problem?.message || 'The read could not run.'
  } finally {
    refreshing.value = false
  }
}

async function archive() {
  if (!goal.value) return
  busy.value = true
  try {
    await archiveGoal(goal.value.id, workspace.value)
    router.push({ name: 'goals', params: { workspace: workspace.value } })
  } catch (problem) {
    pageError.value = problem?.message || 'The goal was not archived.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="view detail-view">
    <GoalsSubnav />
    <div class="goals-page">

      <div v-if="goal" class="goal-head-wrap">
        <header class="page-head">
          <div>
            <div class="board-eyebrow">
              Goal <b aria-hidden="true">·</b>
              {{ goal.privacy === 'workspace' ? 'shared with the workspace' : 'private to you' }}
              <template v-if="goal.entity"><b aria-hidden="true">·</b> planned by {{ goal.entity }}</template>
              <b aria-hidden="true">·</b>
              {{ counts.done }} of {{ counts.total }} dated tasks
            </div>
            <h1>{{ goal.title }}</h1>
            <p class="page-sub">{{ goal.sentence }}</p>
          </div>
          <div class="head-actions">
            <button v-if="editable" class="btn" type="button" :disabled="busy || refreshing" @click="archive">Archive</button>
            <button class="btn btn-ink" type="button" :disabled="busy || refreshing" @click="refresh">
              <UiIcon name="refresh" />
              {{ refreshing ? 'Reading…' : 'Refresh' }}
            </button>
          </div>
        </header>

        <div v-if="readOnly" class="notebar" role="status">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <rect x="3.4" y="7" width="9.2" height="6.4" rx="1.4" /><path d="M5.8 7V5.6a2.2 2.2 0 0 1 4.4 0V7" />
          </svg>
          <p><b>{{ ownerName }} owns this goal.</b> You can read it, tick nothing and add nothing. Ask them for edit access.</p>
        </div>

        <div v-if="pageError" class="errbar" role="status">
          <b>That change was not saved.</b>
          <p>{{ pageError }}</p>
        </div>

        <div v-if="refreshingError" class="errbar" role="status">
          <b>The read did not answer.</b>
          <p>{{ refreshingError }} The bar keeps the figure its last read answered with.</p>
        </div>

        <div class="stats">
          <div class="stat">
            <div class="l">Done</div>
            <p class="v">{{ counts.done }}<small> / {{ counts.total }}</small></p>
            <p class="n">{{ plural(counts.open, 'open task') }}</p>
          </div>
          <div class="stat" :data-tone="counts.late ? 'late' : undefined">
            <div class="l">Late</div>
            <p class="v">{{ counts.late }}</p>
            <p class="n">{{ counts.late ? 'past their date and still open' : 'nothing past its date' }}</p>
          </div>
          <div class="stat">
            <div class="l">Next</div>
            <p class="v small">{{ goal.read?.next?.title || '—' }}</p>
            <p class="n">{{ goal.read?.next?.due ? `due ${day(goal.read.next.due)}` : 'not read yet' }}</p>
          </div>
          <div class="stat" :data-tone="bar.missed ? 'late' : 'ok'">
            <div class="l">Deadline</div>
            <p class="v">{{ bar.left === null ? '—' : Math.abs(bar.left) }}<small> {{ Math.abs(bar.left) === 1 ? 'day' : 'days' }}{{ bar.missed ? ' late' : '' }}</small></p>
            <p class="n">{{ day(goal.deadline) }}</p>
          </div>
        </div>

        <GoalBar :goal="goal" />

        <div class="split">
          <div>
            <div v-for="group in groups" :key="group.priority" class="tgroup">
              <div class="tgh">
                <span :data-p="group.priority">{{ priorityWord(group.priority) }}</span>
                <span class="c">{{ group.tasks.length }}</span>
                <span class="sp"></span>
                <button v-if="editable" class="add" type="button" :disabled="busy" @click="addTask(group.priority)">+ task</button>
              </div>
              <ul class="tasks">
                <TaskRow
                  v-for="task in group.tasks"
                  :key="task.id"
                  :task="task"
                  :editable="editable"
                  :readonly="readOnly"
                  @tick="tick(task, $event)"
                  @update="patchTask(task, $event)"
                  @remove="removeTask(task)"
                />
              </ul>
            </div>

            <div v-if="!counts.all" class="blank">
              <h3>No tasks yet</h3>
              <p>
                This goal has a sentence and a date but nothing to tick. Add a task, or archive the goal and
                start again from a sentence the draft can work from.
              </p>
            </div>

            <div class="tasks-foot">
              {{ plural(counts.all, 'task') }} · <b>{{ counts.late }}</b> late · <b>{{ counts.undated }}</b> with no date ·
              <template v-if="goal.readAt">read {{ ago(goal.readAt) }} by <b>GOAL.js</b></template>
              <template v-else>not read yet — <b>Refresh</b> runs GOAL.js</template>
            </div>
          </div>

          <div>
            <GoalSources :goal="goal" />
            <GoalNext :goal="goal" />
            <div class="notebar">
              <NavIcon name="goal" />
              <p>
                <b>{{ bar.percent === null ? '—' : `${bar.percent}%` }} is a count, not a judgement.</b>
                {{ counts.done }} of {{ counts.total }} closed. A tick moves the count at once; the bar waits for
                Refresh, because a new figure is the one thing this page may not invent. The stripe is where the
                pace lands if nothing changes; it is not a promise.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div v-else-if="goals.error" class="errbar" role="status">
        <b>Could not read this goal.</b>
        <p>{{ goals.error }} The file is still on disk and nothing was changed.</p>
      </div>

      <div v-else-if="!goals.loaded" class="glist" aria-busy="true" aria-label="Reading this goal">
        <div class="grow"><span class="skel" style="width: 46%; height: 12px"></span></div>
        <div class="grow"><span class="skel" style="width: 72%; height: 10px"></span></div>
      </div>

      <div v-else class="blank">
        <h3>That goal is not here</h3>
        <p>No goal in this workspace has that id. It may have been archived, or the link may belong to another workspace.</p>
        <div class="row">
          <router-link class="btn" :to="{ name: 'goals', params: { workspace } }">Back to your goals</router-link>
        </div>
      </div>
    </div>
  </div>
</template>
