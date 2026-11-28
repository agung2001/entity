<script setup>
/**
 * Calendar (§F7) — the same tasks, on the month their deadlines fall on.
 *
 * One object, three views: the rows here are the goal page's tasks, so a tick
 * there moves this chip without a Refresh. Done tasks stay on their month and
 * read as done — a calendar that hid them would claim the month was empty.
 *
 * `ponytail:` the 24 px `.cal-chip` month grid, `+1 more` and the ≤760 `.agenda`
 * are the calendar task's. Month headings group the same rows today, which keeps
 * the page's promise ("these tasks, on their month") without drawing a grid the
 * `@media (max-width:760px)` agenda then has to duplicate.
 */
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import GoalsSubnav from '@/components/goal/GoalsSubnav.vue'
import { day, month, priorityWord } from '@/lib/goals'
import { plural } from '@/lib/transfer'
import { goals, loadGoals, openGoals } from '@/stores/goals'

const route = useRoute()

const workspace = computed(() => String(route.params.workspace || ''))
const months = computed(() => {
  const dated = openGoals()
    .flatMap((goal) =>
      (goal.tasks || [])
        .filter((task) => task.date)
        .map((task) => ({ goal, task, month: String(task.date).slice(0, 7) })),
    )
    .sort((a, b) => a.task.date.localeCompare(b.task.date) || a.task.title.localeCompare(b.task.title))
  const groups = []
  for (const row of dated) {
    const last = groups[groups.length - 1]
    if (last && last.key === row.month) last.rows.push(row)
    else groups.push({ key: row.month, rows: [row] })
  }
  return groups
})
const total = computed(() => months.value.reduce((sum, group) => sum + group.rows.length, 0))

onMounted(() => {
  if (!goals.loaded || goals.workspace !== workspace.value) loadGoals(workspace.value)
})
</script>

<template>
  <div class="view detail-view">
    <div class="goals-page">
      <GoalsSubnav />

      <header class="page-head">
        <div>
          <div class="board-eyebrow">
            Goals <b aria-hidden="true">·</b>
            Calendar <b aria-hidden="true">·</b>
            {{ goals.loaded ? plural(total, 'dated task') : 'reading' }}
          </div>
          <h1>Calendar</h1>
          <p class="page-sub">
            The same tasks on the month their deadlines fall on. A task with no date has no month, so
            it is in the backlog and nowhere here.
          </p>
        </div>
      </header>

      <div v-if="goals.error" class="errbar" role="status">
        <b>Could not read the calendar.</b>
        <p>{{ goals.error }} The file is still on disk and nothing was changed.</p>
      </div>

      <div v-else-if="!goals.loaded" class="goals-list" aria-busy="true" aria-label="Reading the calendar">
        <div v-for="n in 4" :key="n" class="goals-row">
          <span class="skel" :style="{ width: `${68 - n * 6}%`, height: '10px' }"></span>
        </div>
      </div>

      <div v-else-if="!months.length" class="blank">
        <h3>Nothing dated</h3>
        <p>
          No goal has a dated task yet. A task lands on its month the moment it has a date, and a
          goal's own deadline is not a task — it is the date the whole goal has to be true by.
        </p>
      </div>

      <template v-else>
        <section v-for="group in months" :key="group.key" class="goals-month" :aria-label="month(group.key)">
          <div class="goals-band">
            <span class="goals-band-t">{{ month(group.key) }}</span>
            <span class="goals-band-n">{{ plural(group.rows.length, 'task') }}</span>
          </div>
          <div class="goals-list">
            <router-link
              v-for="row in group.rows"
              :key="row.task.id"
              class="goals-row"
              :data-done="row.task.done ? '1' : undefined"
              :to="{ name: 'goal', params: { workspace, id: row.goal.id } }"
            >
              <span class="pri" :data-p="row.task.priority">{{ priorityWord(row.task.priority) }}</span>
              <span class="goals-nm">
                <b :title="row.task.title">{{ row.task.title }}</b>
                <span :title="row.goal.title">{{ row.goal.title }}</span>
              </span>
              <span class="due tdate">{{ day(row.task.date) }}</span>
            </router-link>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>
