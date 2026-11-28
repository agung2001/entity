<script setup>
/**
 * A goal's five fields — title, entity + harness, the sentence, the deadline and
 * who can see it.
 *
 * It is one component because step 1 and the "adjust before creating" dialog are
 * the same form: the review is not a second design of the goal, it is the goal's
 * own fields, reopened. The shortcuts stay page-level; the component exposes the
 * two moves those keys need (focus a field, open the entity picker), so a page
 * never reaches into another component's refs.
 */
import { ref } from 'vue'
import EntityMark from '@/components/EntityMark.vue'
import PickMenu from '@/components/PickMenu.vue'
import SlashComposer from '@/components/SlashComposer.vue'
import { shortcutLabel } from '@/lib/shortcuts'

const props = defineProps({
  title: { type: String, default: '' },
  /* who runs the planning turn — not who the tasks are for */
  plannedBy: { type: String, default: '' },
  harness: { type: String, default: '' },
  /* who may be given a task: 'auto' or 'only'. A mention in the sentence is the
     scope; the cards are the two readings of that sentence. */
  scope: { type: String, default: 'auto' },
  entities: { type: Array, default: () => [] },
  sentence: { type: String, default: '' },
  deadline: { type: String, default: '' },
  privacy: { type: String, default: 'private' },
  attachments: { type: Array, default: () => [] },
  entityOptions: { type: Array, default: () => [] },
  harnessOptions: { type: Array, default: () => [] },
  agent: { type: Object, default: () => ({}) },
  pills: { type: Array, default: () => [] },
  titlePlaceholder: { type: String, default: '' },
  sentenceWhy: { type: String, default: '' },
  dateWhy: { type: String, default: '' },
})
const emit = defineEmits([
  'update:title',
  'update:plannedBy',
  'update:harness',
  'update:scope',
  'toggle-scope',
  'clear-scope',
  'update:sentence',
  'update:deadline',
  'update:privacy',
  'update:attachments',
  'enhance',
  'send',
  'touch',
])

const keys = {
  title: shortcutLabel('goal-title'),
  entity: shortcutLabel('goal-entity'),
  scope: shortcutLabel('goal-scope'),
  sentence: shortcutLabel('goal-sentence'),
  deadline: shortcutLabel('goal-deadline'),
  privacy: shortcutLabel('goal-privacy'),
}

const titleField = ref(null)
const entityPick = ref(null)
const composer = ref(null)
const dateField = ref(null)
const privacyField = ref(null)
const scopeAuto = ref(null)
const scopeOnly = ref(null)

/** The page's digits: one target per field, and the picker opens rather than
    focusing (its rows are the thing the key is for). */
function focus(field) {
  if (field === 'scope') {
    /* the checked card, so the arrow keys land on the current answer */
    const card = props.scope === 'only' ? scopeOnly : scopeAuto
    card?.value?.focus?.()
    return
  }
  const target = { title: titleField, sentence: composer, deadline: dateField, privacy: privacyField }[field]
  target?.value?.focus?.()
}

function toggleEntity() {
  entityPick.value?.toggle?.()
}

const inScope = (name) => props.entities.some((entry) => String(entry).toLowerCase() === String(name).toLowerCase())

defineExpose({ focus, toggleEntity })
</script>

<template>
  <div class="fld-solo">
    <label for="goal-title">Title <kbd class="fld-key">{{ keys.title }}</kbd></label>
    <input
      id="goal-title"
      ref="titleField"
      :value="title"
      type="text"
      :placeholder="titlePlaceholder"
      @input="emit('update:title', $event.target.value)"
    />
    <span class="hint">The line the backlog and the calendar will print. Left empty, it takes the first line of the sentence.</span>
  </div>

  <div class="fld-row">
    <div class="fld-solo">
      <label class="fld-head">Planned by <kbd class="fld-key">{{ keys.entity }}</kbd></label>
      <PickMenu
        ref="entityPick"
        class="field-select"
        head="Planned by"
        icons="entity"
        :options="entityOptions"
        :model-value="plannedBy"
        @update:model-value="emit('update:plannedBy', $event)"
      />
    </div>
    <div class="fld-solo">
      <label class="fld-head">Harness</label>
      <PickMenu
        class="field-select"
        head="Harness"
        icons="harness"
        :options="harnessOptions"
        :model-value="harness"
        @update:model-value="emit('update:harness', $event)"
      />
    </div>
  </div>
  <span class="hint fld-row-hint">Who writes the plan. Its harness runs the draft and its skills are the ones the composer offers — not who the tasks are for.</span>

  <!-- The second question, and the one that is about the work: who may be given
       a task. Automatic is the honest default; a mention in the sentence wins. -->
  <div class="fld-solo scope-fld">
    <label class="fld-head">Work goes to <kbd class="fld-key">{{ keys.scope }}</kbd></label>
    <div class="priv scope" role="radiogroup" aria-label="Which entities may be given a task">
      <label :data-on="scope === 'auto' ? '1' : undefined">
        <input
          ref="scopeAuto"
          :checked="scope === 'auto'"
          type="radio"
          name="goal-scope"
          value="auto"
          @change="emit('update:scope', 'auto')"
        />
        <span class="rd"></span>
        <span class="t"><b>Automatic</b><span>The planner gives each task to whichever entity fits.</span></span>
      </label>
      <label :data-on="scope === 'only' ? '1' : undefined">
        <input
          ref="scopeOnly"
          :checked="scope === 'only'"
          type="radio"
          name="goal-scope"
          value="only"
          @change="emit('update:scope', 'only')"
        />
        <span class="rd"></span>
        <span class="t"><b>Only these</b><span>Each entity you pick is written into the sentence as <code>@name</code>.</span></span>
      </label>
    </div>

    <!-- a chip is a shortcut for the mention: the sentence stays the one truth -->
    <div v-if="scope === 'only'" class="scope-chips" role="group" aria-label="Entities a task may be given to">
      <button
        v-for="option in entityOptions"
        :key="option.id"
        type="button"
        :aria-pressed="inScope(option.label) ? 'true' : 'false'"
        @click="emit('toggle-scope', option.label)"
      >
        <EntityMark mini animate :entity="option.label" />
        {{ option.label }}
      </button>
    </div>

    <span v-if="scope === 'only' && !entities.length" class="hint">
      Pick an entity — it is added to the sentence as <code>@name</code>. With none picked, work stays
      automatic.
    </span>
    <span v-else-if="scope === 'only'" class="hint">
      In the sentence: <b>{{ entities.join(', ') }}</b>. Click a selected entity to take its mention back out.
    </span>
    <span v-else class="hint">
      Any entity that fits. Pick <b>Only these</b> to name them — each becomes an <code>@mention</code>.
    </span>
  </div>

  <div class="fld-solo">
    <label class="fld-head">Goal <b aria-hidden="true">·</b> required <kbd class="fld-key">{{ keys.sentence }}</kbd></label>
    <!-- The thread composer, not a textarea: `/` inserts a skill and `@` a
         mention, and a picked item becomes a token in the sentence — the same
         box the chat uses, so a goal can be written the way a prompt is. -->
    <div class="cm cm-composer" :data-state="sentenceWhy ? 'error' : undefined" @focusout="emit('touch', 'sentence')">
      <SlashComposer
        ref="composer"
        :agent="agent"
        :show-send="false"
        machine="local"
        base-dir=""
        placeholder="Describe the outcome you want by the deadline — / skills · @ mentions"
        label="Goal sentence — / for a skill, @ to mention"
        :draft="sentence"
        :attachments="attachments"
        @update:draft="emit('update:sentence', $event)"
        @update:attachments="emit('update:attachments', $event)"
        @send="emit('send', $event)"
        @enhance="emit('enhance')"
      />
      <div class="cm-acts">
        <span class="cm-hint" :class="{ danger: sentenceWhy }">
          {{ sentenceWhy || 'One sentence, plus whatever you mention — the draft reads that context and plans from it.' }}
        </span>
      </div>
    </div>
  </div>

  <div class="fld-solo">
    <label for="goal-due">Deadline <b aria-hidden="true">·</b> required <kbd class="fld-key">{{ keys.deadline }}</kbd></label>
    <div class="dates">
      <button
        v-for="pill in pills"
        :key="pill.label"
        type="button"
        :aria-pressed="deadline === pill.value ? 'true' : 'false'"
        @click="emit('update:deadline', pill.value); emit('touch', 'date')"
      >{{ pill.label }}</button>
      <span class="own">
        <input
          id="goal-due"
          ref="dateField"
          type="date"
          :value="deadline"
          @change="emit('update:deadline', $event.target.value); emit('touch', 'date'); $event.target.blur()"
        />
        <span class="hint" :class="{ danger: Boolean(dateWhy) }">{{ dateWhy || 'or a date' }}</span>
      </span>
    </div>
    <span class="hint">No default. A goal without a date is a wish; the field stays empty until you pick one.</span>
  </div>

  <div class="fld-solo" role="radiogroup" aria-label="Who can see this goal">
    <label class="fld-head">Who can see it <kbd class="fld-key">{{ keys.privacy }}</kbd></label>
    <div class="priv">
      <label :data-on="privacy === 'private' ? '1' : undefined">
        <input ref="privacyField" :checked="privacy === 'private'" type="radio" value="private" name="goal-privacy" @change="emit('update:privacy', 'private')" />
        <span class="rd"></span>
        <span class="t"><b>Only me</b><span>Not in Wake Space, not in anyone else's backlog.</span></span>
      </label>
      <label :data-on="privacy === 'workspace' ? '1' : undefined">
        <input :checked="privacy === 'workspace'" type="radio" value="workspace" name="goal-privacy" @change="emit('update:privacy', 'workspace')" />
        <span class="rd"></span>
        <span class="t"><b>The workspace</b><span>Visible to everyone here. They can read it; only you can edit the tasks.</span></span>
      </label>
    </div>
  </div>
</template>
