<script setup>
/**
 * One goal (§F5) — its sentence, its deadline and the tasks behind it.
 *
 * The goal is read from the store by id, not fetched again: a task is one object
 * shared with the backlog and the calendar, so this page must render the same row
 * those pages hold. An id the store does not have is a refusal with a way back,
 * never an empty page.
 *
 * `ponytail:` the tick, the bar, Sources and What-to-do-next are the goal-page
 * task's. This page prints the four facts a task row is made of (priority, title,
 * the token it was reasoned from, its date) so the record the store wrote is
 * visible and a done task already reads as done.
 */
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import GoalsSubnav from '@/components/goal/GoalsSubnav.vue'
import { day, priorityWord } from '@/lib/goals'
import { plural } from '@/lib/transfer'
import { goals, loadGoals, taskCounts } from '@/stores/goals'

const route = useRoute()

const workspace = computed(() => String(route.params.workspace || ''))
const goal = computed(() => goals.items.find((entry) => entry.id === String(route.params.id || '')))
const counts = computed(() => taskCounts(goal.value))

onMounted(() => {
  if (!goals.loaded || goals.workspace !== workspace.value) loadGoals(workspace.value)
})
</script>

<template>
  <div class="view detail-view">
    <div class="goals-page">
      <GoalsSubnav />

      <div v-if="goals.error" class="errbar" role="status">
        <b>Could not read this goal.</b>
        <p>{{ goals.error }} The file is still on disk and nothing was changed.</p>
      </div>

      <div v-else-if="!goals.loaded" class="goals-list" aria-busy="true" aria-label="Reading this goal">
        <div class="goals-row"><span class="skel" style="width: 46%; height: 12px"></span></div>
        <div class="goals-row"><span class="skel" style="width: 72%; height: 10px"></span></div>
      </div>

      <template v-else-if="goal">
        <header class="page-head">
          <div>
            <div class="board-eyebrow">
              Goals <b aria-hidden="true">·</b>
              {{ goal.privacy === 'workspace' ? 'shared with the workspace' : 'private' }}
              <b aria-hidden="true">·</b>
              {{ counts.done }} of {{ counts.total }}
            </div>
            <h1>{{ goal.title }}</h1>
            <p class="page-sub">{{ goal.sentence }}</p>
          </div>
          <div class="head-actions">
            <span class="due tdate">{{ day(goal.deadline) }}</span>
          </div>
        </header>

        <div class="goals-band">
          <span class="goals-band-t">Tasks</span>
          <span class="goals-band-n">{{ plural(goal.tasks?.length || 0, 'task') }}</span>
        </div>

        <div v-if="!goal.tasks?.length" class="blank">
          <h3>No tasks yet</h3>
          <p>
            This goal has a sentence and a date but nothing to tick. The tasks are drafted from the
            sentence and accepted before they land here.
          </p>
        </div>

        <div v-else class="goals-list">
          <div
            v-for="task in goal.tasks"
            :key="task.id"
            class="goals-row"
            :data-done="task.done ? '1' : undefined"
          >
            <span class="pri" :data-p="task.priority">{{ priorityWord(task.priority) }}</span>
            <span class="goals-nm">
              <b :title="task.title">{{ task.title }}</b>
              <span v-if="task.token?.label">{{ task.token.label }}</span>
            </span>
            <span class="due tdate" :data-none="task.date ? undefined : '1'">{{ day(task.date) }}</span>
          </div>
        </div>
      </template>

      <div v-else class="blank">
        <h3>That goal is not here</h3>
        <p>
          No goal in this workspace has that id. It may have been archived, or the link may belong to
          another workspace.
        </p>
        <div class="row">
          <router-link class="btn" :to="{ name: 'goals', params: { workspace } }">Back to your goals</router-link>
        </div>
      </div>
    </div>
  </div>
</template>
