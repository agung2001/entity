<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import EntityMark from '@/components/EntityMark.vue'
import PreferPicker from '@/components/PreferPicker.vue'

/**
 * The start-from shelf: one line in an entity file — `prefer:` — drawn once.
 *
 * The entity page reads it forwards (the skills this entity reaches for first),
 * the skill page backwards (the entities that reach for this skill first). Both
 * are editing the same single line and neither is granting a permission, so the
 * order is the fact worth drawing: the row number *is* the `/` menu position.
 *
 * It is a numbered list, not a chip soup and not a card grid. The card is the
 * only bordered object; rows are `--border` hairlines and nothing else.
 *
 * `kind` is the subject of a row, and it decides two things at once: the tile
 * (a skill glyph, or the entity's own mark) and the meta line (a `/` menu
 * position, or where this entity puts the skill). One prop, because a page can
 * only ever list one of the two.
 */
const props = defineProps({
  /** section title */
  head: { type: String, required: true },
  /** "1 of 11 skills" — plain text, never a live region */
  count: { type: String, default: '' },
  /** trigger text; the sheet adds the leading + */
  addLabel: { type: String, default: 'Add' },
  /** the sheet's own title */
  addHead: { type: String, required: true },
  /** [{ id, label, meta, on }] — the state in the file */
  pickOptions: { type: Array, default: () => [] },
  /** [{ key, name, meta, present, to, position?, up?, down? }] in file order */
  rows: { type: Array, default: () => [] },
  /** 'skill' (rows are skills) | 'entity' (rows are entities) */
  kind: { type: String, default: 'skill' },
  /** the one sentence that carries the semantics */
  note: { type: String, default: '' },
  /** skill page only: { route, items: [{ name }] } — everyone else */
  rest: { type: Object, default: null },
  emptyTitle: { type: String, default: '' },
  emptyBody: { type: String, default: '' },
  /** the write cannot happen at all — the list stays readable evidence */
  disabled: { type: Boolean, default: false },
  /** the row key being written; only that row locks */
  busy: { type: String, default: '' },
  /** the first read is still in flight: two skeleton rows, never a spinner */
  loading: { type: Boolean, default: false },
  /** { file, message } — a rejected write, shown under the card */
  error: { type: [Object, String], default: null },
})
const emit = defineEmits(['toggle', 'move', 'remove'])

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth']
const ordinal = (n) => ORDINALS[n - 1] || `${n}th`

/* On the entity page the row's own order is the file order, so the list index is
   the `/` menu position. On the skill page the row is an entity that has its own
   file, and it is `position` there — stating the list index instead would print
   a number that means nothing to anyone. */
const positionOf = (row, i) => row.position || i + 1

/* A name `prefer:` holds and the workspace does not is a note, not an error: it
   keeps its index, says `gone`, and its × still writes the removal. */
function metaOf(row, i) {
  const at = positionOf(row, i)
  if (row.present === false) {
    return `gone — not in this workspace · still ${ordinal(at)} in the file`
  }
  const detail = String(row.meta || '').trim()
  if (props.kind === 'skill') {
    return detail ? `${ordinal(at)} in the / menu · ${detail}` : `${ordinal(at)} in the / menu`
  }
  const where = at === 1 ? 'starts with it first' : `position ${at}`
  return detail ? `${detail} · ${where}` : where
}

/* The entity page's arrows follow the list; a skill page row may be pinned to a
   position the sheet's sort already reflects, so the view states them itself. */
const canUp = (row, i) => (typeof row.up === 'boolean' ? row.up : i > 0)
const canDown = (row, i) => (typeof row.down === 'boolean' ? row.down : i < props.rows.length - 1)

const stopLabel = (name) =>
  props.kind === 'skill'
    ? `Stop starting from ${name}`
    : `${name} no longer starts from this skill`

const errorFile = computed(() => (typeof props.error === 'string' ? '' : props.error?.file || ''))
const errorMessage = computed(() =>
  typeof props.error === 'string'
    ? props.error
    : props.error?.message || 'the file could not be written.',
)

const root = ref(null)
const card = ref(null)

/* Focus after a write. Disabling the busy row's tools drops focus to <body>, and
   a removed row takes its button with it — so remember what was clicked and put
   focus back when the write settles: on the same tool, on the row that took the
   removed one's place, or on the trigger when the list emptied. */
let acted = null

const locked = (row) => props.disabled || props.busy === row.key

function act(tool, row, index) {
  if (locked(row)) return
  if (tool === 'up' && !canUp(row, index)) return
  if (tool === 'down' && !canDown(row, index)) return
  acted = { key: row.key, index, tool }
  if (tool === 'remove') emit('remove', row.key)
  else emit('move', row.key, tool)
}

function settle() {
  const done = acted
  acted = null
  /* a pick in the sheet never held focus in the card, and a person who moved on
     while the write ran keeps where they went */
  if (!done) return
  if (document.activeElement && document.activeElement !== document.body) return
  nextTick(() => {
    const rows = [...(card.value?.querySelectorAll('.sf-row') || [])]
    const own = rows.find((el) => el.dataset.key === done.key)
    const tool = (el, name) => el?.querySelector(`[data-tool="${name}"]:not([disabled])`)
    const any = (el) => el?.querySelector('[data-tool]:not([disabled])')
    /* a removed row hands its place to the next one in the file; a moved or
       retried row keeps its own key and its own tool */
    const next = rows[done.index]
    const previous = rows[done.index - 1]
    const target =
      tool(own, done.tool) ||
      any(own) ||
      (done.tool === 'remove' ? tool(next, 'remove') || any(next) || tool(previous, 'remove') : null) ||
      root.value?.querySelector('.sf-head .pickbtn:not([disabled])')
    target?.focus()
  })
}

watch(
  () => props.busy,
  (now) => {
    if (!now) settle()
  },
)
</script>

<template>
  <section ref="root" class="sf" :data-kind="kind">
    <div class="sf-head">
      <h2>{{ head }}</h2>
      <span class="k">{{ count }}</span>
      <PreferPicker
        class="sf-add"
        :head="addHead"
        :label="addLabel"
        :options="pickOptions"
        :disabled="disabled || Boolean(busy)"
        @toggle="(id) => emit('toggle', id)"
      />
    </div>

    <div ref="card" class="sf-card" :aria-busy="loading ? 'true' : null">
      <template v-if="loading">
        <div v-for="n in 2" :key="n" class="sf-row sf-row--skeleton">
          <span class="sf-ix sf-skel" aria-hidden="true"></span>
          <span class="sf-ic sf-skel" aria-hidden="true"></span>
          <span class="sf-body">
            <span class="sf-skel sf-skel--name" aria-hidden="true"></span>
            <span class="sf-skel sf-skel--meta" aria-hidden="true"></span>
          </span>
          <span class="sf-tools"></span>
        </div>
      </template>

      <div v-if="!loading && !rows.length" class="sf-empty">
        <div class="t">
          <b>{{ emptyTitle }}</b>
          <p v-if="emptyBody">{{ emptyBody }}</p>
        </div>
        <!-- the entity page's way out of an empty shelf; the skill page already
             has its `+ Add entity` on the head and the everyone-else set below -->
        <PreferPicker
          v-if="kind === 'skill'"
          class="sf-add"
          :head="addHead"
          label="Pick the first one"
          :options="pickOptions"
          :disabled="disabled || Boolean(busy)"
          @toggle="(id) => emit('toggle', id)"
        />
      </div>

      <div
        v-for="(row, i) in rows"
        :key="row.key"
        class="sf-row"
        :data-key="row.key"
        :data-gone="row.present === false ? '1' : '0'"
        :data-state="busy === row.key ? 'saving' : null"
      >
        <span class="sf-ix">{{ i + 1 }}</span>
        <span class="sf-ic">
          <EntityMark v-if="kind === 'entity'" :entity="row.name" mini />
          <svg v-else viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <path d="M8 1.8l1.5 3.9 3.9 1.5-3.9 1.5L8 12.6 6.5 8.7 2.6 7.2l3.9-1.5z" />
          </svg>
        </span>
        <span class="sf-body">
          <router-link v-if="row.to" class="sf-name" :to="row.to" :title="row.name">{{ row.name }}</router-link>
          <span v-else class="sf-name" :title="row.name">{{ row.name }}</span>
          <span class="sf-meta">{{ metaOf(row, i) }}</span>
        </span>
        <span class="sf-tools">
          <button
            class="sf-icon"
            type="button"
            data-tool="up"
            :disabled="locked(row) || !canUp(row, i)"
            :aria-label="`Move ${row.name} up`"
            @click="act('up', row, i)"
          >
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
              <path d="M6 10V3M2.6 6.2L6 2.8l3.4 3.4" />
            </svg>
          </button>
          <button
            class="sf-icon"
            type="button"
            data-tool="down"
            :disabled="locked(row) || !canDown(row, i)"
            :aria-label="`Move ${row.name} down`"
            @click="act('down', row, i)"
          >
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
              <path d="M6 2v7M2.6 5.8L6 9.2l3.4-3.4" />
            </svg>
          </button>
          <button
            class="sf-icon rm"
            type="button"
            data-tool="remove"
            :disabled="locked(row)"
            :aria-label="stopLabel(row.name)"
            @click="act('remove', row, i)"
          >
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
              <path d="M2.6 2.6l6.8 6.8M9.4 2.6l-6.8 6.8" />
            </svg>
          </button>
        </span>
      </div>
    </div>

    <p v-if="busy" class="sf-note" role="status">Saving {{ busy }}…</p>
    <p v-else-if="note" class="sf-note">{{ note }}</p>

    <p v-if="error" class="sf-err" role="alert">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
        <path d="M8 2.4l6 11H2z" />
        <path d="M8 6.6v3.1M8 11.6v.1" />
      </svg>
      <span>
        <template v-if="errorFile">Could not write <code>{{ errorFile }}</code> — </template>
        {{ errorMessage }} <b>Hand back and retry.</b>
      </span>
    </p>

    <div v-if="rest && rest.items.length" class="sf-rest">
      <p class="sf-rest-h">
        Everyone else — still gets it in <code>/{{ rest.route }}</code>
      </p>
      <div class="sf-more">
        <span v-for="item in rest.items" :key="item.name" class="sf-mchip">
          <EntityMark :entity="item.name" mini />
          <span class="nm">{{ item.name }}</span>
        </span>
      </div>
    </div>
  </section>
</template>
