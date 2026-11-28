<script setup>
/**
 * A new goal — the address step 1 of the create flow will live at (§F2).
 *
 * The flow's job is to turn one sentence and one date into a drafted task list,
 * and it is a task of its own: the composer, the `@` picker, the deadline pills,
 * the two privacy cards and the refusal beside whichever field caused it. Until
 * that ships this page states what a goal is and sends you back to the index —
 * it does not draw a half-form whose button would have to lie about what it does.
 *
 * `ponytail:` no controls here on purpose. A form with no draft step would create
 * a goal with no tasks, which is the one state the feature exists to avoid.
 */
import { useRoute } from 'vue-router'
import GoalsSubnav from '@/components/goal/GoalsSubnav.vue'

const route = useRoute()
const workspace = String(route.params.workspace || '')
</script>

<template>
  <div class="view detail-view">
    <div class="goals-page">
      <GoalsSubnav />

      <header class="page-head">
        <div>
          <div class="board-eyebrow">
            Goals <b aria-hidden="true">·</b> new <b aria-hidden="true">·</b> step 1 of 3
          </div>
          <h1>New goal</h1>
          <p class="page-sub">One sentence and one date. Nothing is created until you accept the list.</p>
        </div>
      </header>

      <div class="blank">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
          <path d="M8 2.4v11.2M4.6 13.6L8 10.2l3.4 3.4" />
          <circle cx="8" cy="5.4" r="3" />
        </svg>
        <h3>A goal is a sentence and a date</h3>
        <p>
          Write the thing you want to be true — “Take the pilot’s open Major and Critical tickets to
          zero” — and the day it has to be true by. The agent drafts the tasks from that sentence, you
          change them, and only then is anything stored.
        </p>
        <p>
          The date is required and it is never moved afterwards. A goal that passes prints how late it
          is instead of quietly rescheduling itself.
        </p>
        <div class="row">
          <router-link class="btn" :to="{ name: 'goals', params: { workspace } }">Back to your goals</router-link>
        </div>
      </div>
    </div>
  </div>
</template>
