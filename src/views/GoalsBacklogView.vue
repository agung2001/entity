<script setup>
/**
 * Backlog (§F6) — every open task from every open goal, one table, grouped by
 * priority and sorted by date inside the group.
 *
 * A row is the goal page's task object, not a copy: the tick here writes the same
 * task, so both pages move together. The Goal and Source columns are what make a
 * row identifiable outside its parent; Goal hides first (≤1180), the source
 * survives.
 *
 * `ponytail:` one real filter (`late`) held in the URL, where the mockup draws
 * three. The goal picker and "Open only" both described the table's default — a
 * done task already leaves this table — so they would be controls that change
 * nothing. The ceiling is a per-goal filter; the URL key and the `.bt-foot` count
 * are already the shape it needs.
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import GoalsSubnav from '@/components/goal/GoalsSubnav.vue'
import TaskRow from '@/components/goal/TaskRow.vue'
import { PRIORITY_ORDER, daysTo, priorityWord } from '@/lib/goals'
import { plural } from '@/lib/transfer'
import { hub } from '@/stores/hub'
import { goals, loadGoals, openGoals, openTasks, tickTask, updateGoal } from '@/stores/goals'

const route = useRoute()
const router = useRouter()

const workspace = computed(() => String(route.params.workspace || ''))
const lateOnly = computed(() => String(route.query.late || '') === '1')
const pageError = ref('')

const all = computed(() => {
  const rows = openTasks()
  rows.sort(
    (a, b) =>
      PRIORITY_ORDER.indexOf(a.task.priority) - PRIORITY_ORDER.indexOf(b.task.priority) ||
      String(a.task.date || '9999-12-31').localeCompare(String(b.task.date || '9999-12-31')) ||
      String(a.task.title).localeCompare(String(b.task.title)),
  )
  return rows
})
const filtered = computed(() =>
  lateOnly.value ? all.value.filter((row) => row.task.date && (daysTo(row.task.date) ?? 0) < 0) : all.value,
)
const groups = computed(() =>
  PRIORITY_ORDER.map((priority) => ({
    priority,
    rows: filtered.value.filter((row) => row.task.priority === priority),
  })).filter((group) => group.rows.length),
)
const totals = computed(() => {
  const counts = { dated: 0, undated: 0, late: 0 }
  for (const { task } of all.value) {
    if (!task.date) counts.undated += 1
    else {
      counts.dated += 1
      if ((daysTo(task.date) ?? 0) < 0) counts.late += 1
    }
  }
  return counts
})

onMounted(() => {
  if (!goals.loaded || goals.workspace !== workspace.value) loadGoals(workspace.value)
})

function setLate(value) {
  const query = { ...route.query }
  if (value) query.late = '1'
  else delete query.late
  router.replace({ name: 'goals-backlog', params: { workspace: workspace.value }, query })
}

const goalOf = (row) => goals.items.find((goal) => goal.id === row.goal.id)

async function tick(row, done) {
  pageError.value = ''
  try {
    await tickTask(row.goal.id, row.task.id, done, workspace.value)
  } catch (problem) {
    pageError.value = problem?.message || 'The tick was not saved.'
  }
}

async function remove(row) {
  const goal = goalOf(row)
  if (!goal) return
  pageError.value = ''
  try {
    await updateGoal(goal.id, { tasks: goal.tasks.filter((task) => task.id !== row.task.id) }, workspace.value)
  } catch (problem) {
    pageError.value = problem?.message || 'The task was not removed.'
  }
}
</script>

<template>
  <div class="view detail-view">
    <GoalsSubnav />
    <div class="goals-page">

      <header class="page-head">
        <div>
          <div class="board-eyebrow">
            Backlog <b aria-hidden="true">·</b> {{ goals.loaded ? `${all.length} open` : 'reading' }}
            <template v-if="totals.late"><b aria-hidden="true">·</b> {{ totals.late }} late</template>
            <template v-if="totals.undated"><b aria-hidden="true">·</b> {{ totals.undated }} no date</template>
          </div>
          <h1>Backlog</h1>
          <p class="page-sub">Every open task from your {{ plural(openGoals().length, 'goal') }}, grouped by priority and sorted by date inside the group.</p>
        </div>
      </header>

      <div v-if="pageError" class="errbar" role="status">
        <b>That change was not saved.</b>
        <p>{{ pageError }}</p>
      </div>

      <div v-if="goals.error" class="errbar" role="status">
        <b>Could not read the backlog.</b>
        <p>{{ goals.error }} The file is still on disk and nothing was changed.</p>
      </div>

      <div v-else-if="!goals.loaded" class="bt" aria-busy="true" aria-label="Reading the backlog">
        <div v-for="n in 5" :key="n" class="bt-row"><span class="skel" :style="{ width: `${68 - n * 6}%`, height: '10px' }"></span></div>
      </div>

      <div v-else-if="!all.length" class="blank">
        <h3>No open task</h3>
        <p>Nothing is waiting on you: every task with a date is ticked, or no goal has a task yet. A task appears here the moment its goal has one.</p>
      </div>

      <template v-else>
        <div class="filters">
          <span class="tok" data-kind="goal"><span class="l">All goals</span></span>
          <button class="tok" type="button" :aria-pressed="lateOnly ? 'true' : 'false'" :data-state="lateOnly ? 'missing' : undefined" @click="setLate(!lateOnly)">
            <span class="l">late</span>
          </button>
          <span class="spacer"></span>
          <span class="list-meta">showing <b>{{ filtered.length }}</b> of {{ all.length }}</span>
        </div>

        <div v-if="!filtered.length" class="blank">
          <h3>Nothing is late</h3>
          <p>Every open task is still ahead of its date. Clear the filter to see all {{ all.length }}.</p>
          <div class="row"><button class="btn" type="button" @click="setLate(false)">Clear the filter</button></div>
        </div>

        <div v-else class="bt">
          <div class="bt-head">
            <span></span><span>Priority</span><span>Task</span><span class="h5">Goal</span><span>Source</span><span class="r">Date</span><span></span>
          </div>
          <template v-for="group in groups" :key="group.priority">
            <div class="bt-group">
              <span :data-p="group.priority">{{ priorityWord(group.priority) }}</span>
              <span class="c">{{ plural(group.rows.length, 'open task') }}</span>
            </div>
            <ul class="tasks bt-list">
              <TaskRow
                v-for="{ goal: parent, task } in group.rows"
                :key="task.id"
                :task="task"
                show-goal
                :goal-title="parent.title"
                :readonly="Boolean(parent.privacy === 'workspace' && parent.owner && parent.owner !== hub.session?.email)"
                @tick="tick({ goal: parent, task }, $event)"
                @remove="remove({ goal: parent, task })"
              />
            </ul>
          </template>
          <div class="bt-foot">
            {{ all.length }} open · <b>{{ totals.dated }}</b> dated, <b>{{ totals.undated }}</b> undated,
            <b>{{ totals.late }}</b> late · a done task leaves this table and stays on its goal
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
