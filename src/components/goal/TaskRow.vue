<script setup>
/**
 * One task row — the unit the whole destination exists to serve (§2.3).
 *
 * It renders in five places: the draft step, the goal page, the backlog (with the
 * goal column, `.bt-row`'s grid), the calendar's agenda, and read-only. The tick
 * draws 13×13 and carries an `::after` inset so the *hit area* is 29×29 (47×47 at
 * ≤600); the drawn box never grows (§6.3).
 *
 * Read-only is `aria-disabled`, never absent: whether a task is done is
 * information, not an action. `.tmenu` is absent from the DOM when it is, because
 * a menu that can do nothing is a control that lies.
 */
import { computed, nextTick, ref } from 'vue'
import EntityMark from '@/components/EntityMark.vue'
import { useDialogDismiss } from '@/composables/useDialog'
import { PRIORITY_ORDER, day, effortWord, priorityWord, taskState } from '@/lib/goals'

const props = defineProps({
  task: { type: Object, required: true },
  editable: { type: Boolean, default: false },
  readonly: { type: Boolean, default: false },
  /** the backlog's extra Goal column */
  showGoal: { type: Boolean, default: false },
  goalTitle: { type: String, default: '' },
  /** the agenda's title + priority/goal subline, no token column */
  compact: { type: Boolean, default: false },
  /** the planner's two extra columns: who the job is for, and how big it is */
  showEntity: { type: Boolean, default: false },
  showEffort: { type: Boolean, default: false },
  /** the draft hides the source: every token there is the goal itself */
  showSource: { type: Boolean, default: true },
})
const emit = defineEmits(['tick', 'update', 'remove', 'chat', 'edit'])

const editing = ref('')
const value = ref('')
const menuOpen = ref(false)
const fields = { title: ref(null), token: ref(null), date: ref(null) }

const state = computed(() => {
  const found = taskState(props.task)
  return found === 'done' || found === 'overdue' ? found : undefined
})
const due = computed(() => {
  const found = taskState(props.task)
  return { late: found === 'overdue', soon: found === 'soon', none: found === 'none' }
})
const editable = computed(() => props.editable && !props.readonly)
const tickLabel = computed(() => {
  if (props.readonly) return `${props.task.title || 'This task'} — read only`
  return `Mark “${props.task.title || 'this task'}” ${props.task.done ? 'not done' : 'done'}`
})
const priorities = PRIORITY_ORDER

useDialogDismiss({
  active: () => menuOpen.value,
  close: () => {
    menuOpen.value = false
  },
})

function tick() {
  if (props.readonly || props.task.done === undefined) return
  emit('tick', !props.task.done)
}

async function start(field) {
  if (!editable.value) return
  editing.value = field
  value.value =
    field === 'title'
      ? props.task.title || ''
      : field === 'token'
        ? props.task.token?.label || ''
        : props.task.date || ''
  await nextTick()
  const fieldRef = fields[field]
  fieldRef.value?.focus?.()
}

function commit() {
  const next = String(value.value || '')
  if (editing.value === 'title') {
    const title = next.trim()
    if (title && title !== props.task.title) emit('update', { title })
  } else if (editing.value === 'token') {
    const label = next.trim()
    if (label !== (props.task.token?.label || '')) {
      emit('update', { token: { ...(props.task.token || { kind: 'draft' }), label } })
    }
  } else if (editing.value === 'date') {
    if (next !== (props.task.date || '')) emit('update', { date: next })
  }
  editing.value = ''
}

/** Enter commits, Escape reverts. A field is not a dismissible surface, so this
    is a key handler and not a stack entry — the popover below does register. */
function onFieldKey(event) {
  if (event.key === 'Enter') {
    event.preventDefault()
    commit()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    editing.value = ''
  }
}

function setPriority(event) {
  const priority = String(event.target.value || '')
  if (priority && priority !== props.task.priority) emit('update', { priority })
}
</script>

<template>
  <li
    class="task"
    :class="{
      'bt-row': showGoal,
      'task-compact': compact,
      'task-wide': showEntity || showEffort,
      'task-no-source': !showSource,
    }"
    :data-state="state"
  >
    <button
      class="chk"
      type="button"
      role="checkbox"
      :aria-checked="task.done ? 'true' : 'false'"
      :aria-disabled="readonly ? 'true' : undefined"
      :aria-label="tickLabel"
      @click="tick"
    ></button>

    <template v-if="compact">
      <span class="tx">
        <b>{{ task.title || 'Untitled task' }}</b>
        <span class="crumb">
          <span class="pri" :data-p="task.priority">{{ priorityWord(task.priority) }}</span>
          <template v-if="goalTitle"> · {{ goalTitle }}</template>
        </span>
      </span>
    </template>

    <template v-else>
      <span class="pri-wrap" :data-edit="editable ? '1' : undefined">
        <select
          v-if="editable"
          class="pri"
          :data-p="task.priority"
          :value="task.priority"
          :aria-label="`Priority of “${task.title || 'this task'}”`"
          @change="setPriority"
        >
          <option v-for="word in priorities" :key="word" :value="word">{{ priorityWord(word) }}</option>
        </select>
        <span v-else class="pri" :data-p="task.priority">{{ priorityWord(task.priority) }}</span>
      </span>

      <input
        v-if="editing === 'title'"
        :ref="fields.title"
        v-model="value"
        type="text"
        class="tx tx-input"
        :aria-label="`Title of “${task.title || 'this task'}”`"
        @keydown="onFieldKey"
        @blur="commit"
      />
      <button v-else-if="editable" class="tx" type="button" :title="task.title" @click="start('title')">
        {{ task.title || 'Untitled task' }}
      </button>
      <span v-else class="tx" :title="task.title">{{ task.title || 'Untitled task' }}</span>

      <span v-if="showEntity" class="te" :title="task.entity || 'No entity assigned'">
        <EntityMark v-if="task.entity" mini animate :entity="task.entity" />
        <span class="l">{{ task.entity || '—' }}</span>
      </span>

      <span v-if="showEffort" class="eff" :data-e="task.effort || undefined">{{ effortWord(task.effort) || '—' }}</span>

      <span v-if="showGoal" class="gl" :title="goalTitle">{{ goalTitle }}</span>

      <span v-if="showSource" class="tk">
        <input
          v-if="editing === 'token'"
          :ref="fields.token"
          v-model="value"
          type="text"
          class="tk-input"
          :aria-label="`Source of “${task.title || 'this task'}”`"
          @keydown="onFieldKey"
          @blur="commit"
        />
        <button
          v-else-if="task.token?.label"
          class="tok"
          type="button"
          :data-kind="task.token.kind"
          :title="task.token.label"
          :disabled="!editable"
          @click="start('token')"
        ><span class="l">{{ task.token.label }}</span></button>
        <button
          v-else-if="editable"
          class="tok tok-empty"
          type="button"
          aria-label="Add a source for this task"
          @click="start('token')"
        >+ source</button>
      </span>
    </template>

    <input
      v-if="editing === 'date'"
      :ref="fields.date"
      v-model="value"
      type="date"
      class="tdate tdate-input"
      :aria-label="`Date of “${task.title || 'this task'}”`"
      @keydown="onFieldKey"
      @change="commit"
      @blur="commit"
    />
    <button
      v-else-if="editable"
      class="tdate"
      type="button"
      :data-late="due.late ? '1' : undefined"
      :data-soon="due.soon ? '1' : undefined"
      :data-none="due.none ? '1' : undefined"
      :aria-label="`Date of “${task.title || 'this task'}”: ${day(task.date)}`"
      @click="start('date')"
    >{{ day(task.date) }}</button>
    <span
      v-else
      class="tdate"
      :data-late="due.late ? '1' : undefined"
      :data-soon="due.soon ? '1' : undefined"
      :data-none="due.none ? '1' : undefined"
    >{{ day(task.date) }}</span>

    <span v-if="!compact && !readonly" class="tmenu-wrap">
      <button
        class="tmenu"
        type="button"
        aria-label="Task actions"
        aria-haspopup="menu"
        :aria-expanded="menuOpen ? 'true' : 'false'"
        @click="menuOpen = !menuOpen"
      >⋯</button>
      <span v-if="menuOpen" class="tmenu-pop" role="menu">
        <button type="button" role="menuitem" @click="menuOpen = false; emit('edit')">
          Edit task
        </button>
        <button
          v-if="task.entity"
          type="button"
          role="menuitem"
          @click="menuOpen = false; emit('chat')"
        >
          Chat with {{ task.entity }}
        </button>
        <button type="button" role="menuitem" @click="menuOpen = false; emit('remove')">
          Remove task
        </button>
      </span>
    </span>
  </li>
</template>
