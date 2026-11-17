<script setup>
import { computed } from 'vue'
import ArtifactDetailView from '@/views/ArtifactDetailView.vue'
import { useDialogDismiss } from '@/composables/useDialog'
import { closeArtifactPreview, hub } from '@/stores/hub'

/**
 * The artifact page, over the conversation.
 *
 * A screenshot in a chat is not something to squint at in a lightbox: the page
 * is the preview, the editor, the annotator and every action on the file, and
 * it knows how to be a dialog. Full width and height, one X, Escape closes.
 */
const open = computed(() => Boolean(hub.artifact.open))
const id = computed(() => hub.artifact.open)

useDialogDismiss({ active: () => open.value, close: () => closeArtifactPreview() })
</script>

<template>
  <Transition name="modal-fade">
    <div v-if="open" class="artifact-dialog" role="dialog" aria-modal="true" :aria-label="id">
      <div class="artifact-dialog-scrim" @click="closeArtifactPreview()"></div>
      <div class="artifact-dialog-panel">
        <!-- The page owns its bar, so the X is the last control in that row
             (`ArtifactDetailView`, `modal`). A second floating one would sit on
             top of the actions and need offsets to look aligned. -->
        <ArtifactDetailView :id="id" modal @close="closeArtifactPreview()" />
      </div>
    </div>
  </Transition>
</template>
