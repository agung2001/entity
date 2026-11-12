<script setup>
import { computed } from 'vue'
import EntityMark from '@/components/EntityMark.vue'
import { ago, hub, openDrawer } from '@/stores/hub'
import { runs } from '@/stores/runs'

/**
 * The journal is the run log, not a separate event feed. Every line is a real
 * `<ws>/runs/<runId>.jsonl` file, so the page can be checked against the
 * directory.
 */
const rows = computed(() => runs.history || [])

const detail = (run) => {
  if (run.status === 'running') return `${run.harness} · running`
  if (run.status === 'canceled') return run.note || 'canceled'
  return `${run.harness} · exit ${run.exitCode ?? '—'}${run.ms ? ` · ${run.ms} ms` : ''}`
}
</script>

<template>
  <div class="view">
    <div class="page-head">
      <div>
        <p class="eyebrow">Journal · {{ hub.workspaceLabel || hub.workspace }}</p>
        <h1>Activity</h1>
        <p class="lede">
          Every run in this workspace, read from its own log file. Newest first. Nothing is
          uploaded; a workspace that is deleted takes its history with it.
        </p>
      </div>
    </div>

    <div class="tbl">
      <div class="jrn-row jrn-th">
        <span>Time</span><span>Entity</span><span>Event</span><span class="rt">Detail</span>
      </div>
      <div
        v-for="run in rows"
        :key="run.id"
        class="jrn-row jrn-row-btn"
        role="button"
        tabindex="0"
        @click="openDrawer(run.entity, 'run')"
        @keydown.enter="openDrawer(run.entity, 'run')"
      >
        <time>{{ ago(run.startedAt) }}</time>
        <span class="jrn-ent"><EntityMark :entity="run.entity" /><span class="nm2">{{ run.entity }}</span></span>
        <span class="jrn-act">
          <b>{{ run.status }}</b>
          <template v-if="run.prompt"> · {{ run.prompt.slice(0, 60) }}</template>
        </span>
        <span class="jrn-det">{{ detail(run) }}</span>
      </div>
      <div v-if="!rows.length" class="jrn-row" style="color: var(--muted); font-size: 12.5px">
        No runs yet in this workspace.
      </div>
    </div>
  </div>
</template>
