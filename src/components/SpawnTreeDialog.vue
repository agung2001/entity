<script setup>
import { computed } from 'vue'
import EntityMark from '@/components/EntityMark.vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import { useDialogDismiss } from '@/composables/useDialog'
import { ago, harnessById, hub, isSending, retrySession, retrySessions } from '@/stores/hub'

/**
 * The sessions one conversation started, as a tree.
 *
 * A delegated mention is a conversation in its own right, and a busy thread can
 * own a dozen of them — so they are not rows in the rail. The parent row carries
 * a count, and this dialog is the map: the root at the top, its sessions under
 * it, and a session that delegated further under that. One click opens one, and
 * the rail marks the conversation the session belongs to.
 */
const props = defineProps({
  rootId: { type: String, default: '' },
})
const emit = defineEmits(['close', 'open'])

useDialogDismiss({ active: () => Boolean(props.rootId), close: () => emit('close') })

const rows = computed(() => hub.chat.summaries || [])
const byId = computed(() => new Map(rows.value.map((row) => [row.id, row])))
const root = computed(() => (props.rootId ? byId.value.get(props.rootId) || null : null))

/** Depth-first, so a session's own sessions sit under it. */
const tree = computed(() => {
  const children = new Map()
  for (const row of rows.value) {
    const from = row.spawnedFrom?.id
    if (!from) continue
    if (!children.has(from)) children.set(from, [])
    children.get(from).push(row)
  }
  const out = []
  const walked = new Set()
  /* The root is where the walk starts, not a node it visits: seeding a "seen"
     set with it made the first step return immediately and the tree empty. */
  const walk = (id, depth) => {
    if (walked.has(id) || depth > 6) return
    walked.add(id)
    for (const row of children.get(id) || []) {
      out.push({ row, depth })
      walk(row.id, depth + 1)
    }
  }
  if (props.rootId) walk(props.rootId, 0)
  return out
})

function statusOf(row) {
  if (row.working || isSending(row.id)) return { id: 'working', label: 'Working' }
  if (row.failed) return { id: 'failed', label: 'Failed' }
  if (!row.replies) return { id: 'starting', label: 'Starting…' }
  return { id: 'done', label: 'Done' }
}

/** Sessions whose last row is an error, and that are not answering now. */
const failed = computed(() => tree.value.filter((entry) => statusOf(entry.row).id === 'failed'))

/* Rows with no answer that have not failed: still queued or working. A failed
   session has no reply either, and counting it twice reads as two problems. */
const outstanding = computed(
  () => tree.value.filter((entry) => !entry.row.replies && statusOf(entry.row).id !== 'failed').length,
)

function retry(row) {
  retrySession(row.id)
}

/* The tree can nest, so "all failed" is the rows it is showing, not just the
   root's direct children — a session of a session fails the same way. */
function retryAll() {
  retrySessions(failed.value.map((entry) => entry.row.id))
}
</script>

<template>
  <div
    class="scrim"
    :data-open="rootId ? '1' : '0'"
    @click="emit('close')"
  ></div>
  <div
    class="modal modal-narrow spawn-tree"
    :data-open="rootId ? '1' : '0'"
    role="dialog"
    aria-modal="true"
    aria-label="Spawned sessions"
  >
    <div class="mo-head">
      <h2>Spawned sessions</h2>
      <p v-if="root">
        {{ tree.length }} session{{ tree.length === 1 ? '' : 's' }} started from
        <b>#{{ root.title || 'this conversation' }}</b>
        <template v-if="failed.length"> · {{ failed.length }} failed</template>
        <template v-if="outstanding"> · {{ outstanding }} still unanswered</template>
      </p>
      <button class="x mo-x" aria-label="Close" @click="emit('close')">
        <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5">
          <path d="M2 2l8 8M10 2l-8 8" />
        </svg>
      </button>
    </div>

    <div class="mo-body">
      <p v-if="!tree.length" class="spawn-tree-empty">
        This conversation has not spawned a session yet. Mention another entity —
        <code class="mono">@secretary do this</code> — and its session appears here.
      </p>
      <ul v-else class="spawn-tree-list">
        <li
          v-for="entry in tree"
          :key="entry.row.id"
          class="spawn-tree-row"
          :data-depth="entry.depth"
          :data-status="statusOf(entry.row).id"
          :style="{ '--depth': entry.depth }"
        >
          <span class="spawn-tree-rail" aria-hidden="true"></span>
          <EntityMark mini :entity="entry.row.entity" />
          <button
            class="spawn-tree-open"
            type="button"
            :title="entry.row.title"
            @click="emit('open', entry.row.id)"
          >
            <span class="spawn-tree-title">{{ entry.row.title || 'New thread' }}</span>
            <span class="spawn-tree-meta">
              <span>{{ entry.row.entity }}</span>
              <span class="spawn-tree-sep" aria-hidden="true">·</span>
              <HarnessIcon :name="entry.row.harness" :size="10" />
              <span>{{ harnessById(entry.row.harness).label }}</span>
              <span class="spawn-tree-sep" aria-hidden="true">·</span>
              <span>{{ ago(entry.row.updatedAt) }}</span>
            </span>
          </button>
          <span class="spawn-tree-pill" :data-status="statusOf(entry.row).id">
            <i aria-hidden="true"></i>{{ statusOf(entry.row).label }}
          </span>
          <!-- The session is where a failed run is retried: same question, same
               thread, and the row above is where the answer lands. -->
          <button
            v-if="statusOf(entry.row).id === 'failed'"
            class="spawn-tree-retry"
            type="button"
            :title="`Run ${entry.row.title || entry.row.entity} again`"
            :aria-label="`Retry ${entry.row.title || entry.row.entity}`"
            @click="retry(entry.row)"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
              <path d="M12.8 6.4A5 5 0 1 0 13 9" />
              <path d="M12.8 2.6v3.8H9" />
            </svg>
            Retry
          </button>
          <button
            class="spawn-tree-go"
            type="button"
            :aria-label="`Open ${entry.row.title || entry.row.entity}`"
            title="Open this session"
            @click="emit('open', entry.row.id)"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <path d="M6 3.5L10.5 8 6 12.5" />
            </svg>
          </button>
        </li>
      </ul>
    </div>

    <div class="mo-foot">
      <button
        v-if="failed.length"
        class="btn spawn-tree-retry-all"
        type="button"
        @click="retryAll"
      >
        Retry {{ failed.length }} failed
      </button>
      <button class="btn" type="button" @click="emit('close')">Close</button>
    </div>
  </div>
</template>
