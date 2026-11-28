<script setup>
/**
 * Goals — the destination's landing page (§F1, §2.1).
 *
 * A list, not a gallery: one row per open goal with its count, its bar and its
 * deadline, sorted late-first and then by the nearest deadline; a met goal sinks
 * and keeps its row until it is archived, because it is the only proof the
 * surface produced anything.
 *
 * The empty state is the one screen that has to teach the feature: what a goal is,
 * what the draft does, what will not happen — and three examples that are already
 * complete sentences, each starting the same flow (§F1e).
 */
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import NavIcon from '@/components/NavIcon.vue'
import GoalsSubnav from '@/components/goal/GoalsSubnav.vue'
import { barOf, countsOf, day, indexOrder, paceOf } from '@/lib/goals'
import { plural } from '@/lib/transfer'
import { goals, loadGoals, openGoalCount, openGoals } from '@/stores/goals'

const route = useRoute()

const EXAMPLES = [
  {
    title: 'Ship v0.9 to the pilot group',
    sentence: 'Take the pilot’s open Major and Critical tickets to zero by the deadline, with the checks holding on every push.',
    chips: 'YouTrack · GitHub · 12 tasks',
  },
  {
    title: 'Close the Q4 eval gap',
    sentence: 'Get the retrieval eval above 0.82 on the 40-case set by the deadline.',
    chips: 'GitHub · Maka · 18 tasks',
  },
  {
    title: 'Move 8 000 steps a day',
    sentence: 'Average 8 000 steps a day through the deadline, with a walk every working day.',
    chips: 'Fitbit · 30 tasks',
  },
]

const workspace = computed(() => String(route.params.workspace || ''))
const rows = computed(() =>
  indexOrder(openGoals()).map((goal) => ({
    goal,
    bar: barOf(goal),
    counts: countsOf(goal),
    pace: paceOf(goal),
  })),
)
const late = computed(() => rows.value.filter((row) => row.bar.state === 'missed' || row.counts.late).length)

onMounted(() => {
  if (!goals.loaded || goals.workspace !== workspace.value) loadGoals(workspace.value)
})

const exampleLink = (example) => ({
  name: 'goal-new',
  params: { workspace: workspace.value },
  query: { title: example.title, sentence: example.sentence },
})
const counts = (row) => `${row.counts.done} of ${row.counts.total}`
</script>

<template>
  <div class="view detail-view">
    <GoalsSubnav />
    <div class="goals-page">

      <header class="page-head">
        <div>
          <div class="board-eyebrow">
            Goals <b aria-hidden="true">·</b>
            {{ goals.loaded ? `${openGoalCount()} open` : 'reading' }}
            <template v-if="goals.loaded && late"><b aria-hidden="true">·</b> {{ late }} late</template>
          </div>
          <h1>Your goals</h1>
          <p class="page-sub">
            {{ rows.length ? 'Sorted by late first, then the nearest deadline. A tick on a goal moves the same row in the backlog and its chip on the calendar.' : 'One sentence and one date each. The agent drafts the tasks from the sentence; nothing appears in Wake Space.' }}
          </p>
        </div>
        <div class="head-actions">
          <router-link class="btn btn-primary" :to="{ name: 'goal-new', params: { workspace } }">New goal</router-link>
        </div>
      </header>

      <div v-if="goals.error" class="errbar" role="status">
        <b>Could not read your goals.</b>
        <p>{{ goals.error }} The file is still on disk and nothing was changed.</p>
      </div>

      <div v-else-if="!goals.loaded" class="glist" aria-busy="true" aria-label="Reading your goals">
        <div v-for="n in 3" :key="n" class="grow"><span class="skel" :style="{ width: `${64 - n * 8}%`, height: '10px' }"></span></div>
      </div>

      <template v-else-if="!rows.length">
        <div class="blank">
          <NavIcon name="goal" />
          <h3>No goals yet</h3>
          <p>
            A goal is one sentence and one date. The agent drafts the tasks, you change them, and the
            page keeps the count. Nothing appears in Wake Space.
          </p>
          <div class="row">
            <router-link class="btn btn-primary" :to="{ name: 'goal-new', params: { workspace } }">New goal</router-link>
          </div>
        </div>
        <div class="cxns examples">
          <router-link v-for="(example, index) in EXAMPLES" :key="example.title" class="cxn" :to="exampleLink(example)">
            <span class="cxn-mk">{{ index + 1 }}</span>
            <span class="cxn-b">
              <b>{{ example.title }}</b>
              <span>“{{ example.sentence }}”</span>
              <span class="uses">{{ example.chips }} · a goal like this starts the same three steps</span>
            </span>
          </router-link>
        </div>
      </template>

      <template v-else>
        <div class="ghead">
          <span>Goal</span><span class="h2x">Tasks</span><span class="h3">Progress</span><span class="h4">Deadline</span><span></span>
        </div>
        <div class="glist">
          <router-link
            v-for="row in rows"
            :key="row.goal.id"
            class="grow"
            :to="{ name: 'goal', params: { workspace, id: row.goal.id } }"
          >
            <span class="nm">
              <b :title="row.goal.title">{{ row.goal.title }}</b>
              <span>{{ row.goal.privacy === 'workspace' ? 'shared with the workspace' : 'private' }} · {{ plural(row.counts.all, 'task') }}</span>
            </span>
            <span class="cnt">
              {{ counts(row) }}
              <template v-if="row.counts.late"> · <b>{{ row.counts.late }} late</b></template>
            </span>
            <span class="bar" :data-state="row.bar.state">
              <span class="proj" :style="{ width: `${row.pace}%` }"></span>
              <span class="fill" :style="{ width: `${row.bar.percent ?? 0}%` }"></span>
              <span class="tick" :style="{ left: `${row.pace}%` }"></span>
            </span>
            <span class="due tdate" :data-late="row.bar.missed ? '1' : undefined">{{ row.bar.met ? `met ${day(row.goal.deadline)}` : day(row.goal.deadline) }}</span>
            <span class="tmenu" aria-hidden="true"></span>
          </router-link>
        </div>
        <p class="ctx-note goals-foot">
          Sorted by <b>late first</b>, then the nearest deadline. A met goal sinks to the bottom and keeps its
          row until it is archived — it is the only proof the surface ever produced anything.
        </p>
      </template>
    </div>
  </div>
</template>
