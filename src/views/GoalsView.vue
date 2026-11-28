<script setup>
/**
 * Goals — the destination's landing page (§F1).
 *
 * The rail's count and this list read one store, so the number in the rail and
 * the number in the eyebrow cannot disagree. A goal that cannot be read prints
 * the read's refusal and an empty workspace prints the teaching state; neither
 * invents a row.
 *
 * `ponytail:` the full `.glist` row — the bar, the late-first sort, the met
 * goal's sink and the 231-character long-content variant — is the index task's
 * job. What is here is the real data path: a row per open goal, the count of
 * dated tasks and the deadline, so the store and the file are visible today.
 */
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import GoalsSubnav from '@/components/goal/GoalsSubnav.vue'
import { day } from '@/lib/goals'
import { plural } from '@/lib/transfer'
import { goals, loadGoals, openGoalCount, openGoals, taskCounts } from '@/stores/goals'

const route = useRoute()

const workspace = computed(() => String(route.params.workspace || ''))
const rows = computed(() =>
  [...openGoals()]
    .map((goal) => ({ goal, counts: taskCounts(goal) }))
    .sort((a, b) => String(a.goal.deadline).localeCompare(String(b.goal.deadline))),
)

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
            {{ goals.loaded ? `${openGoalCount()} open` : 'reading' }}
          </div>
          <h1>Your goals</h1>
          <p class="page-sub">
            One sentence and one date each. Open a goal to read the tasks behind it.
          </p>
        </div>
      </header>

      <!-- A read that refused: the reason is the store's, and nothing is lost. -->
      <div v-if="goals.error" class="errbar" role="status">
        <b>Could not read your goals.</b>
        <p>{{ goals.error }} The file is still on disk and nothing was changed.</p>
      </div>

      <div v-else-if="!goals.loaded" class="goals-list" aria-busy="true" aria-label="Reading your goals">
        <div v-for="n in 3" :key="n" class="goals-row">
          <span class="skel" :style="{ width: `${64 - n * 8}%`, height: '10px' }"></span>
        </div>
      </div>

      <!-- The one screen that has to teach the feature (§F1e), in three sentences. -->
      <div v-else-if="!rows.length" class="blank">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
          <path d="M8 2.4v11.2M4.6 13.6L8 10.2l3.4 3.4" />
          <circle cx="8" cy="5.4" r="3" />
        </svg>
        <h3>No goals yet</h3>
        <p>
          A goal is one sentence and one date. The agent drafts the tasks, you change them, and the
          page keeps the count. Nothing appears in Wake Space.
        </p>
      </div>

      <div v-else class="goals-list">
        <router-link
          v-for="row in rows"
          :key="row.goal.id"
          class="goals-row"
          :to="{ name: 'goal', params: { workspace, id: row.goal.id } }"
        >
          <span class="goals-nm">
            <b :title="row.goal.title">{{ row.goal.title }}</b>
            <span>
              {{ row.goal.privacy === 'workspace' ? 'shared with the workspace' : 'private' }} ·
              {{ plural(row.goal.tasks?.length || 0, 'task') }}
            </span>
          </span>
          <span class="goals-cnt">{{ row.counts.done }} of {{ row.counts.total }}</span>
          <span class="due tdate">{{ day(row.goal.deadline) }}</span>
        </router-link>
      </div>
    </div>
  </div>
</template>
