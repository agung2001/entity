<script setup>
/**
 * Backlog (§F6) — every open task from every open goal, in date order.
 *
 * The rows are the goal page's task objects: nothing is copied, so ticking on
 * either page moves the same row and this page needs no Refresh. The priority
 * word is the workspace's own four (§5), never a P0…P3 scale.
 *
 * `ponytail:` the `.bt` table — priority groups, the Goal and Source columns,
 * the URL-held filters and the `17 of 17` foot — is the backlog task's. This page
 * already answers "what is open and when", which is what its sub-nav cell
 * promises, without drawing a second table shape the group header will replace.
 */
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import GoalsSubnav from '@/components/goal/GoalsSubnav.vue'
import { day, priorityWord } from '@/lib/goals'
import { plural } from '@/lib/transfer'
import { goals, loadGoals, openGoals } from '@/stores/goals'

const route = useRoute()

const workspace = computed(() => String(route.params.workspace || ''))
const rows = computed(() =>
  openGoals()
    .flatMap((goal) =>
      (goal.tasks || [])
        .filter((task) => !task.done)
        /* A task with no date sorts last: it cannot be late, and putting it first
           would claim a date it does not have. */
        .map((task) => ({ goal, task, due: task.date || '9999-12-31' })),
    )
    .sort((a, b) => a.due.localeCompare(b.due) || a.task.title.localeCompare(b.task.title)),
)
const goalCount = computed(() => openGoals().length)

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
            Backlog <b aria-hidden="true">·</b>
            {{ goals.loaded ? plural(rows.length, 'open task') : 'reading' }}
          </div>
          <h1>Backlog</h1>
          <p class="page-sub">
            Every open task from your {{ plural(goalCount, 'goal') }}, nearest date first. A task here
            is the same row you tick on its goal.
          </p>
        </div>
      </header>

      <div v-if="goals.error" class="errbar" role="status">
        <b>Could not read the backlog.</b>
        <p>{{ goals.error }} The file is still on disk and nothing was changed.</p>
      </div>

      <div v-else-if="!goals.loaded" class="goals-list" aria-busy="true" aria-label="Reading the backlog">
        <div v-for="n in 4" :key="n" class="goals-row">
          <span class="skel" :style="{ width: `${70 - n * 7}%`, height: '10px' }"></span>
        </div>
      </div>

      <div v-else-if="!rows.length" class="blank">
        <h3>No open task</h3>
        <p>
          Nothing is waiting on you: every task with a date is ticked, or no goal has a task yet. A
          task appears here the moment its goal has one.
        </p>
      </div>

      <div v-else class="goals-list">
        <router-link
          v-for="row in rows"
          :key="row.task.id"
          class="goals-row"
          :to="{ name: 'goal', params: { workspace, id: row.goal.id } }"
        >
          <span class="pri" :data-p="row.task.priority">{{ priorityWord(row.task.priority) }}</span>
          <span class="goals-nm">
            <b :title="row.task.title">{{ row.task.title }}</b>
            <span :title="row.goal.title">{{ row.goal.title }}</span>
          </span>
          <span class="due tdate" :data-none="row.task.date ? undefined : '1'">{{ day(row.task.date) }}</span>
        </router-link>
      </div>
    </div>
  </div>
</template>
