<script setup>
import { computed, ref } from 'vue'
import { useDialogDismiss } from '@/composables/useDialog'
import { findEntity, removeEntity } from '@/stores/entities'
import { forgetMark } from '@/composables/entityMark'
import { hub, loadChats, toast } from '@/stores/hub'

/**
 * Deleting an entity is a file operation, so it asks first — in a dialog, not
 * in the chat turn. Nothing is sent to the harness and nothing is removed until
 * the button is pressed.
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  names: { type: Array, default: () => [] },
})
const emit = defineEmits(['close', 'deleted'])

const busy = ref(false)
const error = ref('')

const entities = computed(() =>
  props.names.map((name) => findEntity(name)).filter(Boolean),
)
const missing = computed(() => props.names.filter((name) => !findEntity(name)))
const threadCount = computed(() =>
  (hub.chat.summaries || []).filter((thread) => props.names.includes(thread.entity)).length,
)
const currentEntity = computed(() => {
  const thread = hub.chat.summaries?.find((item) => item.id === hub.chat.active)
  return thread ? thread.entity : ''
})
const closesThread = computed(() => Boolean(currentEntity.value && props.names.includes(currentEntity.value)))

useDialogDismiss({
  active: () => props.open,
  close: () => {
    if (!busy.value) emit('close')
  },
  guard: () => busy.value,
})

async function remove() {
  if (busy.value) return
  const targets = entities.value.map((entity) => entity.name)
  if (!targets.length) {
    emit('close')
    return
  }
  busy.value = true
  error.value = ''
  try {
    for (const name of targets) {
      await removeEntity(name)
      forgetMark(hub.workspace, name)
    }
    toast(`${targets.join(', ')} deleted`)
    emit('deleted', targets)
    /* The server already leaves these threads out of `chat.list`; drop the
       cached copy too so the rail and the badge agree without a reload. */
    await loadChats(hub.workspace).catch(() => {})
    emit('close')
  } catch (failure) {
    error.value = failure?.message || 'The entity could not be deleted.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="scrim" :data-open="open ? '1' : '0'" @click="busy || emit('close')"></div>
  <div
    class="modal modal-narrow confirm-modal"
    :data-open="open ? '1' : '0'"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="entity-delete-title"
    aria-describedby="entity-delete-body"
  >
    <header class="mo-head">
      <div>
        <p class="eyebrow">Delete entity</p>
        <h2 id="entity-delete-title">
          {{ entities.length === 1 ? `Remove ${entities[0].name}?` : `Remove ${entities.length} entities?` }}
        </h2>
      </div>
      <button class="x mo-x" type="button" aria-label="Close" :disabled="busy" @click="emit('close')">
        <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5">
          <path d="M2 2l8 8M10 2l-8 8" />
        </svg>
      </button>
    </header>

    <div class="mo-body">
      <p id="entity-delete-body" class="confirm-lead">
        This deletes the entity file from the workspace. It cannot be undone.
      </p>
      <ul class="confirm-list">
        <li v-for="entity in entities" :key="entity.name">
          <b>{{ entity.name }}</b>
          <span>{{ entity.displayPath || `${entity.name}.md` }}</span>
        </li>
        <li v-for="name in missing" :key="name" class="confirm-missing">
          <b>{{ name }}</b>
          <span>no longer exists</span>
        </li>
      </ul>
      <p class="confirm-note">
        <template v-if="threadCount">
          {{ threadCount }} {{ threadCount === 1 ? 'conversation stays' : 'conversations stay' }} on disk but
          {{ threadCount === 1 ? 'leaves' : 'leave' }} the chat history.
        </template>
        <template v-else>The file is removed from this workspace.</template>
        <template v-if="closesThread"> This is the entity in the open conversation, so that conversation will close.</template>
      </p>
      <p v-if="error" class="confirm-error">{{ error }}</p>
    </div>

    <footer class="mo-foot">
      <button class="btn" type="button" :disabled="busy" @click="emit('close')">Keep it</button>
      <button class="btn btn-danger" type="button" :disabled="busy || !entities.length" @click="remove">
        {{ busy ? 'Deleting…' : entities.length === 1 ? 'Delete entity' : `Delete ${entities.length} entities` }}
      </button>
    </footer>
  </div>
</template>
