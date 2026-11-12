<script setup>
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import EntityMark from '@/components/EntityMark.vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import MachineIcon from '@/components/MachineIcon.vue'
import {
  ago,
  ensureChats,
  harnessById,
  hub,
  machineById,
  snippet,
} from '@/stores/hub'

/**
 * The journal is the conversation history, not a separate event feed. Every
 * line is a real `<ws>/chats/<threadId>.json` file, so the page can be checked
 * against the directory.
 */
const router = useRouter()

onMounted(ensureChats)

const rows = computed(() => hub.chat.summaries || [])
const machineLabel = (id) => machineById(id)?.label || id

function openThread(id) {
  router.push({ name: 'chat', query: { thread: id } })
}
</script>

<template>
  <div class="view">
    <div class="page-head">
      <div>
        <p class="eyebrow">Journal · {{ hub.workspaceLabel || hub.workspace }}</p>
        <h1>Activity</h1>
        <p class="lede">
          Every conversation in this workspace, read from its own thread file. Newest first.
          Nothing is uploaded; a workspace that is deleted takes its history with it.
        </p>
      </div>
    </div>

    <div class="tbl">
      <div class="jrn-row jrn-th">
        <span>Time</span><span>Entity</span><span>Conversation</span><span class="rt">Context</span>
      </div>
      <div
        v-for="thread in rows"
        :key="thread.id"
        class="jrn-row jrn-row-btn"
        role="button"
        tabindex="0"
        @click="openThread(thread.id)"
        @keydown.enter="openThread(thread.id)"
      >
        <time>{{ ago(thread.updatedAt) }}</time>
        <span class="jrn-ent">
          <EntityMark :entity="thread.entity" /><span class="nm2">{{ thread.entity }}</span>
        </span>
        <span class="jrn-act">
          <b>{{ snippet(thread.preview) || 'New thread' }}</b>
          <template v-if="thread.queries">
            · {{ thread.queries }} {{ thread.queries === 1 ? 'query' : 'queries' }}
          </template>
        </span>
        <span class="jrn-det">
          <MachineIcon :size="10" />{{ machineLabel(thread.machine) }}
          <span aria-hidden="true">·</span>
          <HarnessIcon :name="thread.harness" :size="10" />{{ harnessById(thread.harness).label }}
        </span>
      </div>
      <div v-if="!rows.length" class="jrn-row" style="color: var(--muted); font-size: 12.5px">
        No conversations yet in this workspace.
      </div>
    </div>
  </div>
</template>
