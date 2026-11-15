<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { call } from '@/composables/localBridge'
import { useDialogDismiss } from '@/composables/useDialog'
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
  try {
    await navigator.clipboard.writeText(draft.value)
    toast('Proposed instructions copied')
  } catch {
    toast('Could not copy to the clipboard')
  }
}

/* ── side-by-side diff ─────────────────────────────────────────────────────
   Longest common subsequence on lines, then paired rows: a removal followed by
   an addition becomes one row so a rewritten sentence sits beside its old
   version instead of in a separate block. */

function diffRows(before, after) {
  const a = String(before || '').split('\n')
  const b = String(after || '').split('\n')
  const n = a.length
  const m = b.length
  /* Trim common head and tail so the table stays small for small edits. */
  let head = 0
  while (head < n && head < m && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < n - head && tail < m - head && a[n - 1 - tail] === b[m - 1 - tail]) tail += 1

  const midA = a.slice(head, n - tail)
  const midB = b.slice(head, m - tail)
  const rows = []
  for (let i = 0; i < head; i += 1) rows.push({ kind: 'same', left: a[i], right: b[i] })

  const ops = lcsDiff(midA, midB)
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i]
    if (op.type === 'same') {
      rows.push({ kind: 'same', left: op.text, right: op.text })
      continue
    }
    if (op.type === 'remove') {
      const next = ops[i + 1]
      if (next && next.type === 'add') {
        rows.push({ kind: 'change', left: op.text, right: next.text })
        i += 1
      } else {
        rows.push({ kind: 'remove', left: op.text, right: null })
      }
      continue
    }
    rows.push({ kind: 'add', left: null, right: op.text })
  }

  for (let i = 0; i < tail; i += 1) {
    rows.push({ kind: 'same', left: a[n - tail + i], right: b[m - tail + i] })
  }

  /* Line numbers follow each side independently: a row that exists on only one
     side does not consume a number on the other. */
  let ln = 1
  let rn = 1
  for (const row of rows) {
    row.leftNo = row.left === null ? '' : ln++
    row.rightNo = row.right === null ? '' : rn++
  }
  return rows
}

function lcsDiff(a, b) {
  const n = a.length
  const m = b.length
  if (!n) return b.map((text) => ({ type: 'add', text }))
  if (!m) return a.map((text) => ({ type: 'remove', text }))

  /* One row of the DP table at a time; the table is small because the head and
     tail were already trimmed and instructions are a few hundred lines. */
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }

  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', text: a[i] })
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ type: 'remove', text: a[i] })
      i += 1
    } else {
      ops.push({ type: 'add', text: b[j] })
      j += 1
    }
  }
  while (i < n) ops.push({ type: 'remove', text: a[i++] })
  while (j < m) ops.push({ type: 'add', text: b[j++] })
  return ops
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
