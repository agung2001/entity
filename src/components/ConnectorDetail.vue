<script setup>
import { computed, nextTick, ref } from 'vue'

/**
 * One connector, open: its definition, the fields that make it work, and the
 * three verbs it owns.
 *
 * This is a sibling of the row on the page's grid — not a child of a cell — so
 * the name column does not shift when it opens (spec §3.3, §8). The edit verbs
 * talk to the store through the parent: this component owns its draft, never a
 * write.
 */
const props = defineProps({
  row: { type: Object, required: true },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
  notice: { type: String, default: '' },
})

const emit = defineEmits(['test', 'save', 'disable', 'remove', 'close'])

const draft = ref({ token: '', host: props.row.statusDetail || '' })
const reveal = ref(false)
const confirming = ref(false)
const testField = ref(null)

/* `rest` and `mcp` rows hold a credential; a `cli` row's credential belongs to the
   CLI's own store, so there is no field to edit and the page says so. */
const holdsToken = computed(() => props.row.kind !== 'cli')
const canEdit = computed(() => props.row.editable !== false)

const fields = computed(() => {
  const row = props.row
  const out = [
    { k: 'kind', v: row.kind },
    { k: 'scope', v: row.scope === 'machine' ? 'machine — this computer only' : 'workspace — travels with the workspace' },
    { k: 'binding', v: row.binding || '—' },
    { k: 'mention', v: row.mention || 'not offered in the composer' },
    { k: 'status', v: row.statusDetail ? `${row.status} · ${row.statusDetail}` : row.status },
  ]
  return out
})

function focusTest() {
  nextTick(() => testField.value?.focus())
}
focusTest()

function runTest() {
  if (props.busy) return
  emit('test', { ...draft.value })
}

function save() {
  if (props.busy) return
  emit('save', { ...draft.value })
}

function remove() {
  if (!confirming.value) {
    confirming.value = true
    return
  }
  emit('remove')
}
</script>

<template>
  <div class="ct-detail">
    <div class="detail-grid">
      <div v-for="field in fields" :key="field.k" class="field">
        <span class="k">{{ field.k }}</span>
        <span class="v" :title="String(field.v)">{{ field.v }}</span>
      </div>
    </div>

    <div v-if="canEdit && holdsToken" class="cxn-fields cxn-detail-fields">
      <label>
        endpoint
        <input v-model="draft.host" type="text" placeholder="https://…" autocomplete="off" />
      </label>
      <label>
        token
        <input
          v-model="draft.token"
          :type="reveal ? 'text' : 'password'"
          placeholder="paste a token — it is verified before it is saved"
          autocomplete="off"
          spellcheck="false"
        />
      </label>
    </div>

    <div v-if="error" class="cxn-error" role="alert">{{ error }}</div>
    <div v-else-if="notice" class="cxn-ok" role="status">{{ notice }}</div>

    <p v-if="canEdit && holdsToken" class="detail-note">
      Editing the token writes this workspace's binding on this machine only. If the call fails,
      nothing is saved.
    </p>
    <p v-else-if="row.kind === 'cli'" class="detail-note">
      This row's credential belongs to the CLI's own store on this machine. Signing in happens in
      the CLI, never here.
    </p>

    <div class="detail-actions">
      <button ref="testField" class="btn btn-sm" type="button" :disabled="busy" @click="runTest">
        {{ busy ? 'Testing…' : 'Test connection' }}
      </button>
      <button class="btn btn-sm" type="button" :disabled="busy" @click="reveal = !reveal">
        {{ reveal ? 'Hide token' : 'Edit token' }}
      </button>
      <button class="btn btn-sm btn-primary" type="button" :disabled="busy" @click="save">Save</button>
      <span class="spacer"></span>
      <button class="btn btn-sm btn-ghost" type="button" :disabled="busy" @click="emit('disable', row)">
        Disable
      </button>
      <button class="btn btn-sm btn-danger" type="button" :disabled="busy" @click="remove">
        {{ confirming ? 'Remove for good?' : 'Remove' }}
      </button>
      <button class="btn btn-sm btn-ghost" type="button" :disabled="busy" @click="emit('close')">Close</button>
    </div>
  </div>
</template>
