<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { call } from '@/composables/localBridge'
import { useDialogDismiss } from '@/composables/useDialog'
import { copyText } from '@/lib/clipboard'
import { diffRows } from '@/lib/diff'
import { hub, toast } from '@/stores/hub'

/**
 * "Learning" — the entity reads its own recent conversations and proposes
 * better standing instructions.
 *
 * The proposal is shown as a side-by-side diff against the current body, with
 * the model's summary above it. Nothing is written until the person applies it,
 * and applying goes through the same entity file write as the editor.
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  entity: { type: String, default: '' },
})
const emit = defineEmits(['close', 'applied'])

const busy = ref(false)
const applying = ref(false)
const error = ref('')
const result = ref(null)
const requestId = ref(0)
const editing = ref(false)
const draft = ref('')
const editor = ref(null)

/* The proposal is a draft: it can be edited before it is applied, and the diff
   always compares the current file with whatever is in the editor. */
const rows = computed(() =>
  result.value && !editing.value ? diffRows(result.value.current, draft.value) : [],
)
const added = computed(() => rows.value.filter((row) => row.kind !== 'same').length)
const dirty = computed(() => Boolean(result.value) && draft.value !== result.value.proposed)

function close() {
  /* Escape inside the editor leaves edit mode first; a second Escape closes. */
  if (editing.value) {
    editing.value = false
    return
  }
  emit('close')
}

useDialogDismiss({
  active: () => props.open,
  close,
  guard: () => applying.value,
})

watch(
  () => props.open,
  (open) => {
    if (open) run()
    else {
      requestId.value += 1
      busy.value = false
      error.value = ''
      editing.value = false
    }
  },
)

async function run() {
  if (!props.entity) return
  const id = ++requestId.value
  busy.value = true
  error.value = ''
  result.value = null
  try {
    const data = await call('entity.learn', {
      workspace: hub.workspace,
      entity: props.entity,
    })
    if (id !== requestId.value) return
    result.value = data
    draft.value = data.proposed
    editing.value = false
    await nextTick()
  } catch (failure) {
    if (id !== requestId.value) return
    error.value = failure?.message || 'The review could not finish.'
  } finally {
    if (id === requestId.value) busy.value = false
  }
}

async function applyProposal() {
  if (!result.value || applying.value || !draft.value.trim()) return
  applying.value = true
  try {
    const updated = await call('entity.learnApply', {
      workspace: hub.workspace,
      entity: props.entity,
      instructions: draft.value,
    })
    const changes = diffRows(result.value.current, draft.value).filter(
      (row) => row.kind !== 'same',
    ).length
    toast(`${props.entity} learned ${changes} change${changes === 1 ? '' : 's'}`)
    emit('applied', updated)
    emit('close')
  } catch (failure) {
    error.value = failure?.message || 'The instructions could not be saved.'
  } finally {
    applying.value = false
  }
}

async function startEditing() {
  editing.value = true
  await nextTick()
  editor.value?.focus()
}

async function copyProposal() {
  if (!result.value || !draft.value.trim()) return
  const copied = await copyText(draft.value)
  toast(copied ? 'Proposed instructions copied' : 'Could not copy to the clipboard')
}
</script>

<template>
  <div class="scrim" :data-open="open ? '1' : '0'" @click="!applying && emit('close')"></div>
  <div
    class="modal modal-wide learn-modal"
    :data-open="open ? '1' : '0'"
    role="dialog"
    aria-modal="true"
    aria-label="Learn from recent conversations"
  >
    <header class="mo-head">
      <div>
        <p class="eyebrow">Learning · {{ entity }}</p>
        <h2>What the conversations taught it</h2>
      </div>
      <button class="x mo-x" type="button" aria-label="Close" :disabled="applying" @click="emit('close')">
        <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5">
          <path d="M2 2l8 8M10 2l-8 8" />
        </svg>
      </button>
    </header>

    <div class="mo-body learn-body">
      <div v-if="busy" class="learn-state">
        <span class="spinner" aria-hidden="true"></span>
        <div>
          <b>Reading the last conversations</b>
          <p>The entity's own harness compares its instructions with how it was actually used. This can take a minute.</p>
        </div>
      </div>

      <div v-else-if="error && !result" class="learn-state learn-state--error">
        <div>
          <b>The review did not finish</b>
          <p>{{ error }}</p>
        </div>
        <button class="btn" type="button" @click="run">Try again</button>
      </div>

      <template v-else-if="result">
        <div class="learn-summary">
          <p>{{ result.summary }}</p>
          <p class="learn-meta">
            {{ result.sources.length }} conversations · {{ result.harness }}
            <template v-if="result.model"> · {{ result.model }}</template>
            · {{ Math.round(result.ms / 1000) }}s
          </p>
        </div>

        <div class="learn-toolbar">
          <div class="learn-tabs" role="tablist" aria-label="Review mode">
            <button
              type="button"
              role="tab"
              :aria-selected="!editing ? 'true' : 'false'"
              @click="editing = false"
            >
              Side by side
            </button>
            <button
              type="button"
              role="tab"
              :aria-selected="editing ? 'true' : 'false'"
              @click="startEditing"
            >
              Edit proposed
            </button>
          </div>
          <span v-if="dirty" class="learn-dirty">Edited · {{ draft.split('\n').length }} lines</span>
          <span v-else class="learn-hint">Edit the proposal before applying it.</span>
        </div>

        <div
          v-if="editing"
          class="learn-editor-wrap"
          :data-editor-open="'1'"
        >
          <textarea
            ref="editor"
            v-model="draft"
            class="learn-editor"
            spellcheck="false"
            aria-label="Proposed instructions"
          ></textarea>
        </div>

        <div v-else class="learn-diff" role="table" aria-label="Proposed instruction changes">
          <div class="learn-diff-head" role="row">
            <span>Current instructions</span>
            <span>Proposed</span>
          </div>
          <div
            v-for="(row, index) in rows"
            :key="index"
            class="learn-row"
            :data-kind="row.kind"
            role="row"
          >
            <div
              class="learn-cell"
              role="cell"
              :data-kind="row.kind === 'add' ? 'blank' : row.kind === 'change' ? 'remove' : row.kind"
            >
              <span class="learn-no">{{ row.leftNo }}</span>
              <code>{{ row.left }}</code>
            </div>
            <div
              class="learn-cell"
              role="cell"
              :data-kind="row.kind === 'remove' ? 'blank' : row.kind === 'change' ? 'add' : row.kind"
            >
              <span class="learn-no">{{ row.rightNo }}</span>
              <code>{{ row.right }}</code>
            </div>
          </div>
        </div>

        <p v-if="error" class="learn-error">{{ error }}</p>
      </template>
    </div>

    <footer class="mo-foot">
      <span class="learn-count">
        <template v-if="result && !editing">{{ added }} changed {{ added === 1 ? 'line' : 'lines' }}</template>
        <template v-else-if="result">Editing the proposal</template>
        <template v-else-if="busy">Nothing is written until you apply.</template>
      </span>
      <button class="btn" type="button" :disabled="busy || applying" @click="emit('close')">Cancel</button>
      <button class="btn" type="button" :disabled="!result || busy || applying || !draft.trim()" @click="copyProposal">
        Copy proposed
      </button>
      <button
        class="btn btn-ink"
        type="button"
        :disabled="!result || applying || !draft.trim()"
        @click="applyProposal"
      >
        {{ applying ? 'Applying…' : 'Apply to instructions' }}
      </button>
    </footer>
  </div>
</template>
