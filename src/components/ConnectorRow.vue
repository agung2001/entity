<script setup>
/**
 * One connector row: who, what kind, which scope, whether it answers.
 *
 * The name is the disclosure control and nothing else in the row is interactive
 * except its one action, so there is no anchor wrapping a button and no second
 * way to open the same pane. The scope is a **column**, never implied by the
 * section a row happens to sit in: a page listing connectors must not leave you
 * guessing whether you still have it on the other laptop.
 */
defineProps({
  row: { type: Object, required: true },
  open: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
})

const emit = defineEmits(['toggle', 'adopt', 'copy'])

/* `ok | fail | off | warn`, the four dots the row may wear. */
const toneOf = (row) => {
  const word = String(row?.status || '')
  if (/fail|missing|needs sign-in/i.test(word)) return 'fail'
  if (/unmanaged|untracked|parked|not probed|not set up/i.test(word)) return 'warn'
  if (/found|connected|in the pool|ok/i.test(word)) return 'ok'
  return 'off'
}
</script>

<template>
  <div
    class="ct-row"
    :class="{ 'row-act': row.scope === 'machine' || row.unmanaged }"
    :data-open="open ? '1' : '0'"
    role="row"
  >
    <button
      v-if="row.editable"
      class="ct-who"
      type="button"
      role="cell"
      :aria-expanded="open ? 'true' : 'false'"
      :aria-label="`${row.label}, ${row.kind} connector, ${row.scope} scope`"
      :disabled="busy"
      @click="emit('toggle', row)"
    >
      <span class="ct-mk" :data-brand="row.kind === 'mcp' ? '1' : '0'" aria-hidden="true">{{ row.initial }}</span>
      <span class="ct-copy">
        <span class="ct-name">{{ row.label }}</span>
        <span class="ct-line">
          {{ row.kind }}
          <template v-if="row.binding"> · <b>{{ row.binding }}</b></template>
          <template v-if="row.mention"> · <span>{{ row.mention }}</span></template>
        </span>
      </span>
    </button>
    <div v-else class="ct-who" role="cell">
      <span class="ct-mk" aria-hidden="true">{{ row.initial }}</span>
      <div class="ct-copy">
        <div class="ct-name">{{ row.label }}</div>
        <div class="ct-line">
          {{ row.kind }}
          <template v-if="row.binding"> · <b>{{ row.binding }}</b></template>
        </div>
      </div>
    </div>

    <span class="cxn-pill cxn-pill-kind" role="cell">{{ row.kind }}</span>
    <span role="cell">
      <span class="cxn-pill" :class="{ 'cxn-pill-machine': row.scope === 'machine' }">{{ row.scope }}</span>
    </span>

    <span class="ct-status" role="cell" :data-s="toneOf(row)">
      <span class="dot" aria-hidden="true"></span>
      {{ row.status }}
      <small v-if="row.statusDetail" :title="row.statusDetail">{{ row.statusDetail }}</small>
    </span>

    <span v-if="row.scope === 'machine'" class="ct-act" role="cell">
      <button
        class="btn btn-sm"
        type="button"
        :disabled="busy"
        title="Copies the definition into this workspace. Credentials do not travel."
        @click="emit('copy', row)"
      >
        Copy here
      </button>
    </span>
    <span v-else-if="row.unmanaged" class="ct-act" role="cell">
      <button
        class="btn btn-sm"
        type="button"
        :disabled="busy"
        title="Creates a workspace connector from this server. The token is not copied."
        @click="emit('adopt', row)"
      >
        Adopt
      </button>
    </span>
    <span v-else class="ct-act" role="cell">
      <span class="cxn-when">{{ row.verified || '—' }}</span>
    </span>
  </div>
</template>
