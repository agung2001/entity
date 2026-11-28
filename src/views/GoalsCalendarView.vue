<script setup>
/**
 * Calendar (§F7) — the same tasks, on the month their deadlines fall on.
 *
 * No new data: a chip is the backlog's date cell drawn, and a done task keeps its
 * chip (struck through) because a month that hid finished work would claim it was
 * empty. At ≥761 px the month grid; at ≤760 the same tasks as a day-grouped
 * `.agenda`, because a 44 px column is decoration, not a plan.
 *
 * The month is a place, so it lives in the address (`?month=YYYY-MM`) and is
 * validated against the closed set of what a month can be.
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import GoalsSubnav from '@/components/goal/GoalsSubnav.vue'
import TaskRow from '@/components/goal/TaskRow.vue'
import { month, shortDay, today } from '@/lib/goals'
import { plural } from '@/lib/transfer'
import { hub } from '@/stores/hub'
import { goals, loadGoals, openGoals, tickTask } from '@/stores/goals'

const route = useRoute()
const router = useRouter()

const expanded = ref([])
const pageError = ref('')

const workspace = computed(() => String(route.params.workspace || ''))
const rows = computed(() =>
  openGoals().flatMap((goal) =>
    (goal.tasks || []).filter((task) => task.date).map((task) => ({ goal, task })),
  ),
)

const stamp = (at) => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`

/** The nearest dated task's month, else this one — a month with work in it. */
const defaultMonth = computed(() => {
  const dates = rows.value.map((row) => row.task.date).sort()
  return dates.length ? String(dates[0]).slice(0, 7) : today().slice(0, 7)
})

const at = computed(() => {
  const asked = String(route.query.month || '')
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(asked) ? asked : defaultMonth.value
})

const byDate = computed(() => {
  const map = new Map()
  for (const row of rows.value) {
    const list = map.get(row.task.date) || []
    list.push(row)
    map.set(row.task.date, list)
  }
  for (const list of map.values()) list.sort((a, b) => String(a.task.title).localeCompare(String(b.task.title)))
  return map
})

const dueByDate = computed(() => {
  const map = new Map()
  for (const goal of openGoals()) {
    if (!goal.deadline) continue
    const list = map.get(goal.deadline) || []
    list.push(goal)
    map.set(goal.deadline, list)
  }
  return map
})

const cells = computed(() => {
  const [year, monthNumber] = at.value.split('-').map(Number)
  const first = new Date(year, monthNumber - 1, 1)
  const offset = (first.getDay() + 6) % 7
  const start = new Date(year, monthNumber - 1, 1 - offset)
  const list = []
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    list.push({
      key,
      date: date.getDate(),
      out: stamp(date) !== at.value,
      today: key === today(),
      tasks: byDate.value.get(key) || [],
      due: dueByDate.value.get(key) || [],
    })
  }
  return list
})

const agenda = computed(() =>
  [...byDate.value.keys()]
    .filter((key) => key.startsWith(at.value))
    .sort()
    .map((key) => ({ key, rows: byDate.value.get(key) || [], due: dueByDate.value.get(key) || [] })),
)
const total = computed(() => agenda.value.reduce((sum, group) => sum + group.rows.length, 0))
const late = computed(() => rows.value.filter((row) => (row.task.date || '') < today() && !row.task.done).length)

onMounted(() => {
  if (!goals.loaded || goals.workspace !== workspace.value) loadGoals(workspace.value)
})

function go(value) {
  const [year, monthNumber] = value.split('-').map(Number)
  const next = new Date(year, monthNumber - 1, 1)
  const query = { ...route.query, month: stamp(next) }
  router.replace({ name: 'goals-calendar', params: { workspace: workspace.value }, query })
}

function step(delta) {
  const [year, monthNumber] = at.value.split('-').map(Number)
  go(stamp(new Date(year, monthNumber - 1 + delta, 1)))
}

function shiftMonth(value, delta) {
  const [year, monthNumber] = value.split('-').map(Number)
  return stamp(new Date(year, monthNumber - 1 + delta, 1))
}

const isOpen = (key) => expanded.value.includes(key)
function toggle(key) {
  expanded.value = isOpen(key) ? expanded.value.filter((entry) => entry !== key) : [...expanded.value, key]
}
const visible = (cell) => (isOpen(cell.key) ? cell.tasks : cell.tasks.slice(0, 2))

async function tick(row, done) {
  pageError.value = ''
  try {
    await tickTask(row.goal.id, row.task.id, done, workspace.value)
  } catch (problem) {
    pageError.value = problem?.message || 'The tick was not saved.'
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
            Calendar <b aria-hidden="true">·</b> {{ goals.loaded ? month(at) : 'reading' }}
            <template v-if="goals.loaded"><b aria-hidden="true">·</b> {{ plural(openGoals().length, 'goal') }}</template>
          </div>
          <h1>{{ month(at) }}</h1>
          <p class="page-sub">
            The same tasks on the month their deadlines fall on. A task with no date has no month, so it is in
            the backlog and nowhere here.
          </p>
        </div>
        <div class="head-actions">
          <button class="btn" type="button" :aria-label="`Previous month, ${month(shiftMonth(at, -1))}`" @click="step(-1)">←</button>
          <button class="btn" type="button" @click="go(today().slice(0, 7))">Today</button>
          <button class="btn" type="button" :aria-label="`Next month, ${month(shiftMonth(at, 1))}`" @click="step(1)">→</button>
        </div>
      </header>

      <div v-if="pageError" class="errbar" role="status">
        <b>That tick was not saved.</b>
        <p>{{ pageError }}</p>
      </div>

      <div v-if="goals.error" class="errbar" role="status">
        <b>Could not read the calendar.</b>
        <p>{{ goals.error }} The file is still on disk and nothing was changed.</p>
      </div>

      <div v-else-if="!goals.loaded" class="glist" aria-busy="true" aria-label="Reading the calendar">
        <div v-for="n in 4" :key="n" class="grow"><span class="skel" :style="{ width: `${68 - n * 6}%`, height: '10px' }"></span></div>
      </div>

      <div v-else-if="!rows.length" class="blank">
        <h3>Nothing dated</h3>
        <p>No goal has a dated task yet. A task lands on its month the moment it has a date, and a goal's own deadline is not a task — it is the date the whole goal has to be true by.</p>
      </div>

      <template v-else>
        <p class="list-meta cal-meta">
          {{ plural(total, 'dated task') }} this month · <b>{{ late }}</b> late across every month · a goal's deadline is marked <b>due</b>
        </p>

        <div class="cal">
          <div class="cal-hd"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div>
          <div class="cal-grid">
            <div
              v-for="cell in cells"
              :key="cell.key"
              class="cal-cell"
              :data-out="cell.out ? '1' : undefined"
              :data-today="cell.today ? '1' : undefined"
            >
              <div class="d"><b>{{ cell.date }}</b><span v-if="cell.due.length" class="due">due</span></div>
              <router-link
                v-for="row in cell.out ? [] : visible(cell)"
                :key="row.task.id"
                class="cal-chip"
                :data-p="row.task.priority"
                :data-done="row.task.done ? '1' : undefined"
                :title="row.task.title"
                :to="{ name: 'goal', params: { workspace, id: row.goal.id } }"
              ><span class="l">{{ row.task.title }}</span></router-link>
              <router-link
                v-for="goal in cell.out ? [] : cell.due"
                :key="`due-${goal.id}`"
                class="cal-chip cal-chip-due"
                :title="`${goal.title} — deadline`"
                :to="{ name: 'goal', params: { workspace, id: goal.id } }"
              ><span class="l">{{ goal.title }} — deadline</span></router-link>
              <button
                v-if="!cell.out && cell.tasks.length > 2"
                class="cal-more"
                type="button"
                :aria-expanded="isOpen(cell.key) ? 'true' : 'false'"
                @click="toggle(cell.key)"
              >{{ isOpen(cell.key) ? 'Show less' : `+${cell.tasks.length - 2} more` }}</button>
            </div>
          </div>
        </div>

        <div class="agenda" :aria-label="`${month(at)}, by day`">
          <template v-for="group in agenda" :key="group.key">
            <div class="d">{{ shortDay(group.key) }}<template v-if="group.due.length"> <b>· {{ group.due.map((goal) => goal.title).join(', ') }} due</b></template></div>
            <ul class="tasks">
              <TaskRow
                v-for="{ goal: parent, task } in group.rows"
                :key="task.id"
                :task="task"
                :goal-title="parent.title"
                compact
                :readonly="Boolean(parent.privacy === 'workspace' && parent.owner && parent.owner !== hub.session?.email)"
                @tick="tick({ goal: parent, task }, $event)"
              />
            </ul>
          </template>
          <div v-if="!agenda.length" class="agenda-empty">Nothing dated in {{ month(at) }}.</div>
        </div>

        <p class="ctx-note cal-foot">
          A chip is the backlog's date cell drawn. A done chip is struck through and stays on its month; the
          priority word is in the agenda, where the row has room for it.
        </p>
      </template>
    </div>
  </div>
</template>
