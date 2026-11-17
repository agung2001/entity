<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import { useDialogDismiss } from '@/composables/useDialog'
import { call } from '@/composables/localBridge'
import { copySkill, loadWorkspaceList, workspaces } from '@/stores/workspaces'

/**
 * Copy one workspace's skill into another workspace on this machine.
 *
 * `attachSkill` only ever reads a harness library, so a second workspace used to
 * be re-attached by hand — and got the library's version, not the edits the first
 * workspace carries. This sheet moves the workspace's **own** bytes and leaves
 * the source alone.
 *
 * Everything here is a decision made *before* a byte is written: the destination,
 * and what happens to a name that already exists there. The clash is decided in
 * the sheet (Replace / Keep both), never discovered halfway through a copy, and
 * the main process re-checks it because a second window can be at the same time.
 */
const props = defineProps({
  /* the skill to copy, and the workspace it currently lives in */
  name: { type: String, required: true },
  source: { type: String, required: true },
})
const emit = defineEmits(['close', 'copied'])

const target = ref('')
/* workspace id → the skills it already carries. Read for every destination at
   once, because the sheet has to say "already has code" on the row you are not
   looking at yet, and a copy must never discover a clash halfway through. */
const targetIndex = ref({})
const checking = ref(true)
const busy = ref(false)
const error = ref('')
const onConflict = ref('')
const sheet = ref(null)
let indexToken = 0

useDialogDismiss({
  active: true,
  close: () => emit('close'),
  /* Esc and the scrim do nothing while the copy is in flight: a dismissed sheet
     over a half-renamed directory is how a skill goes missing. */
  guard: () => busy.value,
})

const sourceLabel = computed(
  () => workspaces.items.find((item) => item.id === props.source)?.label || props.source,
)
const sourceItem = computed(
  () => workspaces.skills.find((skill) => skill.name === props.name) || null,
)
/* The source is not a destination: a copy into itself is a rename, not a copy. */
const candidates = computed(() => workspaces.items.filter((item) => item.id !== props.source))
const targetRecord = computed(
  () => candidates.value.find((item) => item.id === target.value) || null,
)
const targetLabel = computed(() => targetRecord.value?.label || target.value)

const targetSkills = computed(() => targetIndex.value[target.value] || [])

const clashItem = computed(
  () => targetSkills.value.find((skill) => skill.name.toLowerCase() === props.name.toLowerCase()) || null,
)
const clash = computed(() => Boolean(clashItem.value))

/** The name a kept copy lands under — the same `-2`, `-3` … the main process picks. */
const landingName = computed(() => {
  if (!clash.value) return props.name
  const taken = new Set(targetSkills.value.map((skill) => skill.name.toLowerCase()))
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${props.name}-${n}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return `${props.name}-2`
})

/** What each destination row says under its name. */
const describeTarget = (item) => {
  const has = (targetIndex.value[item.id] || []).some(
    (skill) => skill.name.toLowerCase() === props.name.toLowerCase(),
  )
  return has ? `local · already has ${props.name}` : `local · no ${props.name}`
}

const targetSize = (item) => {
  const has = (targetIndex.value[item.id] || []).find(
    (skill) => skill.name.toLowerCase() === props.name.toLowerCase(),
  )
  return has?.size || '—'
}

/** Before the index is known, the sheet cannot promise anything. */
const canCopyReady = computed(() =>
  candidates.value.every((item) => Object.prototype.hasOwnProperty.call(targetIndex.value, item.id)),
)

const canCopy = computed(
  () =>
    Boolean(target.value) &&
    !busy.value &&
    !checking.value &&
    canCopyReady.value &&
    (!clash.value || Boolean(onConflict.value)),
)

/**
 * Read every destination's skill names in one pass.
 *
 * A workspace that cannot be read is recorded as an empty list *and* an error, so
 * the sheet still opens (the target's own state decides on submit) but the person
 * is told the row is unknown rather than shown "no code".
 */
async function loadIndex() {
  indexToken += 1
  const token = indexToken
  checking.value = true
  const next = {}
  const problems = []
  await Promise.all(
    candidates.value.map(async (item) => {
      try {
        const list = await call('workspace.skills', { id: item.id })
        next[item.id] = Array.isArray(list) ? list : []
      } catch (problem) {
        next[item.id] = []
        problems.push(problem?.message || `Could not read ${item.label || item.id}.`)
      }
    }),
  )
  if (token !== indexToken) return
  targetIndex.value = next
  checking.value = false
  if (problems.length) error.value = problems[0]
}

/* A different destination is a different clash, and the choice made for the
   previous one does not carry over. */
watch(target, () => {
  onConflict.value = ''
  error.value = ''
})

onMounted(async () => {
  if (!workspaces.items.length) {
    try {
      await loadWorkspaceList()
    } catch {
      /* the empty block below covers it */
    }
  }
  if (!target.value) target.value = candidates.value[0]?.id || ''
  await loadIndex()
  await nextTick()
  /* Focus the first destination so the sheet is usable from the keyboard at
     once — without scrolling the "From → To" line out of view, which is what
     focus() does by default inside a scrollable body. */
  sheet.value?.querySelector('.destbtn')?.focus({ preventScroll: true })
  const body = sheet.value?.querySelector('.mo-body')
  if (body) body.scrollTop = 0
})

async function submit() {
  if (!canCopy.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await copySkill({
      name: props.name,
      to: target.value,
      onConflict: clash.value ? onConflict.value : 'error',
    })
    emit('copied', result)
    emit('close')
  } catch (problem) {
    error.value = problem?.message || 'The skill could not be copied.'
  } finally {
    busy.value = false
  }
}

/* Keep Tab inside the sheet while it is open: the page behind it is dimmed but
   still focusable, and tabbing into a hidden detach button is a way to lose a
   skill you were only trying to copy. */
function trapTab(event) {
  const focusable = [...(sheet.value?.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  ) || [])]
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="scrim" data-open="1" @click="busy || emit('close')"></div>
    <div
      ref="sheet"
      class="modal modal-narrow skcopy-modal"
      data-open="1"
      role="dialog"
      aria-modal="true"
      aria-label="Copy skill to another workspace"
      @keydown.tab="trapTab"
    >
      <div class="mo-head">
        <h2>Copy skill</h2>
        <p v-if="busy">
          Copying {{ sourceItem?.files || 1 }} {{ sourceItem?.files === 1 ? 'file' : 'files' }}
          into {{ targetLabel }}.
        </p>
        <p v-else>
          Copy the workspace's own files into another workspace on this machine. The
          source keeps its copy.
        </p>
        <button
          class="x mo-x"
          type="button"
          aria-label="Close"
          :disabled="busy"
          @click="emit('close')"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5"><path d="M2 2l8 8M10 2l-8 8" /></svg>
        </button>
      </div>

      <div class="mo-body">
        <div class="clone-flow" aria-label="Copy direction">
          <div class="clone-side">
            <HarnessIcon :name="sourceItem?.harness || 'workspace'" :size="16" />
            <span class="clone-copy">
              <em>From</em>
              <b>{{ name }}</b>
              <span>{{ sourceLabel }}</span>
            </span>
          </div>
          <span class="clone-arrow" aria-hidden="true">→</span>
          <div class="clone-side" :data-empty="targetRecord ? '0' : '1'">
            <HarnessIcon :size="16" />
            <span class="clone-copy">
              <em>To</em>
              <b>{{ targetRecord?.label || 'No target yet' }}</b>
              <span>{{ targetRecord?.id || 'pick a workspace' }}</span>
            </span>
          </div>
        </div>

        <template v-if="candidates.length">
          <div class="fld">
            <span id="skcopy-dest" class="lbl">Destination workspace</span>
            <div class="dest" role="radiogroup" aria-labelledby="skcopy-dest">
              <button
                v-for="item in candidates"
                :key="item.id"
                type="button"
                class="destbtn"
                role="radio"
                :aria-checked="target === item.id ? 'true' : 'false'"
                :disabled="busy"
                @click="target = item.id"
              >
                <span class="rd" aria-hidden="true"></span>
                <span>
                  <span class="nm">{{ item.label }}</span>
                  <span class="d">{{ describeTarget(item) }}</span>
                </span>
                <span class="ver">{{ targetSize(item) }}</span>
              </button>
            </div>
          </div>

          <div class="fld">
            <span class="lbl">Hand-off</span>
            <div class="vline">
              <div>
                <small>From</small>
                <b>{{ sourceLabel }} · {{ sourceItem?.files || 0 }} {{ sourceItem?.files === 1 ? 'file' : 'files' }} · {{ sourceItem?.size || '—' }}</b>
              </div>
              <div>
                <small>To</small>
                <b v-if="checking" class="new">reading {{ targetLabel }}…</b>
                <b v-else-if="!clash" class="new">{{ targetLabel }} · nothing to replace</b>
                <b v-else-if="onConflict === 'keep'" class="new">
                  {{ targetLabel }} · the copy lands as {{ landingName }}
                </b>
                <b v-else-if="onConflict === 'replace'" class="new">
                  {{ targetLabel }} · the existing copy is replaced
                </b>
                <b v-else class="new">
                  {{ targetLabel }} · {{ clashItem?.files || 1 }}
                  {{ clashItem?.files === 1 ? 'file' : 'files' }} · {{ clashItem?.size || '—' }}
                </b>
              </div>
            </div>
          </div>

          <div v-if="clash" class="fld">
            <span class="lbl">Name clash</span>
            <div class="skclash">
              <p>
                <b>{{ targetLabel }} already has a skill called “{{ name }}”.</b>
                Choose what happens to the copy that is already there.
              </p>
              <div class="skchoose" role="group" aria-label="Resolve the name clash">
                <button
                  type="button"
                  :aria-pressed="onConflict === 'replace' ? 'true' : 'false'"
                  :disabled="busy"
                  @click="onConflict = 'replace'"
                >
                  Replace the copy<span>{{ targetLabel }}'s files are deleted</span>
                </button>
                <button
                  type="button"
                  :aria-pressed="onConflict === 'keep' ? 'true' : 'false'"
                  :disabled="busy"
                  @click="onConflict = 'keep'"
                >
                  Keep both<span>the new one lands as {{ landingName }}</span>
                </button>
              </div>
            </div>
          </div>

          <p v-if="busy" class="mnote">
            Staged in the target, then renamed into place — a half-written directory
            never appears.
          </p>

          <p v-if="error" class="run-warn" role="alert">{{ error }}</p>
        </template>

        <div v-else class="clone-empty">
          <b>No other workspace to copy into.</b>
          <p>A copy needs a second workspace on this machine. Create one, then come back.</p>
        </div>
      </div>

      <div class="mo-foot clone-foot">
        <template v-if="candidates.length">
          <button class="btn" type="button" :disabled="busy" @click="emit('close')">Cancel</button>
          <button
            class="btn btn-ink"
            type="button"
            :disabled="!canCopy"
            :title="clash && !onConflict ? 'Choose Replace or Keep both first' : ''"
            @click="submit"
          >
            {{ busy ? 'Copying…' : 'Copy skill' }}
          </button>
        </template>
        <template v-else>
          <button class="btn" type="button" @click="emit('close')">Close</button>
          <button class="btn btn-ink" type="button" disabled>Copy skill</button>
        </template>
      </div>
    </div>
  </Teleport>
</template>
