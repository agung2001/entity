<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { call } from '@/composables/localBridge'
import { useDialogDismiss } from '@/composables/useDialog'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import { harnessById, hub } from '@/stores/hub'

/**
 * Enhance this prompt.
 *
 * Reads the composer's draft for the open thread and writes it back only on
 * Apply — the composer is the source of truth, so nothing this dialog refuses
 * or fails can empty it. Not one control here sends a turn: Apply is a write to
 * a text field, and the send arrow is still the only way out.
 *
 * One request at a time. `Generate` fills the output region with skeleton rows
 * in the shape of the answer and the footer with `Stop`; a second `Generate` is
 * reachable only from a terminal state, so two harness calls never race.
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  /* A field outside the composer can ask for a rewrite: `seed` is what it holds
     now, and `from` tells the dialog where Apply writes back. */
  seed: { type: String, default: '' },
  from: { type: String, default: 'composer' },
  scope: { type: String, default: '' },
  /* A page that is not a thread (the goal composer) names the harness itself;
     a thread always wins, because its context is the history. */
  harness: { type: String, default: '' },
  model: { type: String, default: '' },
})
const emit = defineEmits(['close', 'apply'])

const COUNT_OPTIONS = [1, 2, 3, 4, 5]

/* This dialog is mounted twice — once beside the composer and once inside a
   held plan — and both copies are in the document at the same time. An id is
   the one thing on this markup that is shared state: `aria-labelledby` and a
   `<label for>` resolve against the **first** match, so a literal `enh-guide`
   in the plan would label the composer's textarea. `useId()` is stable per
   instance, which is all that is needed to tell the two apart. */
const uid = useId()
const titleId = `enh-title-${uid}`
const countId = `enh-count-lbl-${uid}`
const guideId = `enh-guide-${uid}`

const draft = ref('')
/* The thread this dialog is rewriting for: a result that lands after a thread
   switch belongs to nobody, so it is discarded instead of painted. */
const owner = ref('')
const count = ref(1)
const guide = ref('')
const advanced = ref(false)
const phase = ref('idle')
const variations = ref([])
const failure = ref('')
const focusAt = ref(0)
const expanded = ref([])
/* Which rows genuinely overflow three lines: measured once the text is laid
   out, so `Show more` appears only where there is something behind it. */
const clamped = ref([])
const elapsed = ref(0)
const startedAt = ref(0)
const bodyEl = ref(null)
const generateBtn = ref(null)
let ticker = 0
let token = 0

const enhanceKey = shortcutLabel('enhance-prompt')
const generateKey = shortcutLabel('send')

const busy = computed(() => phase.value === 'busy')
const done = computed(() => phase.value === 'results')
const words = computed(() => (draft.value.trim() ? draft.value.trim().split(/\s+/).length : 0))
const lines = computed(() => (draft.value ? draft.value.split('\n').length : 0))
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
/* Where Apply writes: the composer for a message, this field for a plan card. */
const origin = computed(() => (props.from === 'plan' ? 'this field' : 'the composer'))
const countLabel = computed(() =>
  count.value === 1 ? 'Generate' : `Generate ${plural(count.value, 'variation', 'variations')}`,
)
const guideLabel = computed(() =>
  count.value === 1 ? 'Describe the enhancement' : 'How should the variations differ?',
)
const guidePlaceholder = computed(() =>
  count.value === 1
    ? 'What should the rewrite do? e.g. name the file, ask for the acceptance check'
    : 'e.g. one diagnostic-first, one shortest possible, one with the acceptance check',
)
const summaryLabel = computed(
  () =>
    `${plural(count.value, 'variation', 'variations')} · ${
      guide.value.trim() ? `${guide.value.trim().length} characters of guidance` : 'no extra instruction'
    }`,
)
const lede = computed(() => {
  if (!draft.value.trim()) return `There is nothing in ${origin.value} to rewrite.`
  if (done.value) {
    const keeps =
      props.from === 'plan'
        ? 'leaves this field as it was'
        : 'leaves the original in the composer'
    return `${plural(variations.value.length, 'variation', 'variations')} below. Apply keeps the one you pick and ${keeps} until then.`
  }
  return 'A clearer rewrite of what you typed — same intent, fewer things to guess.'
})
const primaryLabel = computed(() => {
  if (done.value) return 'Apply & close'
  if (phase.value === 'error') return 'Retry'
  return countLabel.value
})
const secondaryLabel = computed(() => {
  if (busy.value) return 'Stop'
  if (phase.value === 'error' || !draft.value.trim()) return 'Close'
  return 'Cancel'
})
const focusHint = computed(() =>
  variations.value.length > 1
    ? `1–${variations.value.length} selects · ${generateKey} applies`
    : `${generateKey} applies`,
)
const clock = computed(() => {
  const total = Math.max(0, Math.round(elapsed.value))
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return `${mm}:${ss}`
})
const threadHarness = computed(
  () => props.harness || hub.chat.threads[owner.value]?.harness || '',
)
const harnessLabel = computed(() => harnessById(threadHarness.value).label)

function onToggle(event) {
  advanced.value = Boolean(event.target?.open)
}

/** Every field back to its opening value, except the draft this dialog is about. */
function reset() {
  count.value = 1
  guide.value = ''
  advanced.value = false
  phase.value = 'idle'
  variations.value = []
  failure.value = ''
  focusAt.value = 0
  expanded.value = []
  clamped.value = []
  elapsed.value = 0
  startedAt.value = 0
  stopClock()
}

function stopClock() {
  if (ticker) clearInterval(ticker)
  ticker = 0
}

function startClock() {
  stopClock()
  startedAt.value = Date.now()
  elapsed.value = 0
  ticker = setInterval(() => {
    elapsed.value = (Date.now() - startedAt.value) / 1000
  }, 250)
}

watch(
  () => props.open,
  (open) => {
    if (!open) {
      cancel()
      reset()
      draft.value = ''
      return
    }
    reset()
    owner.value = hub.chat.active
    /* A caller that hands its own text (`seed`) is rewriting for a page that is
       not a thread — the goal composer — so it must not be seeded from an
       unrelated conversation's draft. */
    draft.value =
      props.from === 'plan' || props.seed
        ? String(props.seed || '')
        : String(hub.chat.drafts[hub.chat.active] || '')
    nextTick(() => generateBtn.value?.focus())
  },
  { immediate: true },
)

/* A thread switch closes the dialog: the draft it would write belongs to the
   conversation that asked for it. */
watch(
  () => hub.chat.active,
  () => {
    if (props.open) dismiss()
  },
)

function cancel() {
  token += 1
  stopClock()
}

function stop() {
  if (!busy.value) return
  cancel()
  phase.value = 'idle'
  variations.value = []
}

function dismiss() {
  cancel()
  emit('close')
}

/* The guard is what makes Escape stop the run instead of closing the dialog:
   it swallows the first Escape only after stopping, and lets the second one
   close. One line here, no local keydown handler anywhere. */
useDialogDismiss({
  active: () => props.open,
  close: () => dismiss(),
  guard: () => {
    if (!busy.value) return false
    stop()
    return true
  },
})

async function generate() {
  if (busy.value) return
  const text = String(draft.value || '').trim()
  if (!text) return
  const mine = ++token
  phase.value = 'busy'
  variations.value = []
  failure.value = ''
  focusAt.value = 0
  expanded.value = []
  startClock()
  try {
    const data = await call('chat.enhance', {
      workspace: hub.workspace,
      /* with an explicit harness there is no thread to read: a stale active
         thread would otherwise win and rewrite with the wrong context */
      threadId: props.harness ? '' : owner.value,
      harness: props.harness,
      model: props.model,
      draft: text,
      count: count.value,
      /* closed Advanced sends exactly what open-but-untouched sends */
      guide: guide.value.trim(),
    })
    if (mine !== token) return
    const list = Array.isArray(data?.variations) ? data.variations : []
    if (!list.length) throw new Error('The rewrite came back empty. Nothing was applied to your draft.')
    stopClock()
    elapsed.value = (Date.now() - startedAt.value) / 1000
    variations.value = list
    phase.value = 'results'
    focusAt.value = 0
    expanded.value = []
    nextTick(() => {
      measureRows()
      bodyEl.value?.querySelector('.enhrow')?.focus()
    })
  } catch (error) {
    if (mine !== token) return
    stopClock()
    elapsed.value = (Date.now() - startedAt.value) / 1000
    failure.value = error?.message || 'The rewrite did not run.'
    phase.value = 'error'
  }
}

function applyRow(index) {
  const row = variations.value[index]
  if (!row || busy.value) return
  /* A write, not a send: the view owns the composer and the undo toast. */
  emit('apply', { text: row.text, index })
  dismiss()
}

function applyFocused() {
  if (!done.value) return
  applyRow(Math.min(focusAt.value, variations.value.length - 1))
}

function moveFocus(delta) {
  const total = variations.value.length
  if (!total) return
  focusAt.value = (focusAt.value + delta + total) % total
  nextTick(() => {
    const rows = bodyEl.value?.querySelectorAll('.enhrow')
    rows?.[focusAt.value]?.focus()
  })
}

function toggleMore(index) {
  expanded.value = expanded.value.includes(index)
    ? expanded.value.filter((item) => item !== index)
    : [...expanded.value, index]
}

/* A clamped row reports the height of the text behind the cut, so the clamp
   itself is the measurement: an unclamped row reports nothing to compare. */
function measureRows() {
  const els = [...(bodyEl.value?.querySelectorAll('.enhtext') || [])]
  clamped.value = els.map((el) => el.scrollHeight - el.clientHeight > 2)
}

/* A narrower window clamps a row it did not clamp before, and the way back has
   to appear with it. */
onMounted(() => window.addEventListener('resize', measureRows))
onBeforeUnmount(() => window.removeEventListener('resize', measureRows))

function onKey(event) {
  /* The composer's own send never fires here: the send key is Generate, Retry
     or the focused row's Apply, and `hub.chat.sending` stays false throughout. */
  if (matchesShortcut('send', event)) {
    event.preventDefault()
    event.stopPropagation()
    if (busy.value) return
    if (done.value) applyFocused()
    else generate()
    return
  }
  if (!done.value) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if (/^[1-9]$/.test(event.key)) {
    const at = Number(event.key) - 1
    if (at >= variations.value.length) return
    event.preventDefault()
    focusAt.value = at
    nextTick(() => bodyEl.value?.querySelectorAll('.enhrow')?.[at]?.focus())
  }
}

function onRowKey(event, index) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    applyRow(index)
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="scrim" :data-open="open ? '1' : '0'" @click="dismiss" />
    <div
      class="modal enhdlg"
      :data-open="open ? '1' : '0'"
      :data-phase="phase"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      tabindex="-1"
      @keydown="onKey"
    >
      <div class="mo-head">
        <h2 :id="titleId">Enhance this prompt</h2>
        <p class="enhlede">{{ lede }}</p>
        <p v-if="from === 'plan' && scope" class="enhcount">
          from the plan · {{ scope }} · {{ plural(words, 'word', 'words') }}
        </p>
        <button
          class="mo-x"
          type="button"
          aria-label="Close"
          :disabled="busy"
          @click="dismiss"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>

      <div class="mo-body" ref="bodyEl">
        <div class="enhmeta">
          <span class="lbl">Your draft</span>
          <span class="enhcount">
            {{ plural(words, 'word', 'words') }} · {{ lines > 4 ? 'scrolls' : plural(lines, 'line', 'lines') }}
          </span>
        </div>
        <div class="enhbase" :data-empty="draft.trim() ? '0' : '1'">{{ draft.trim() ? draft : 'No draft' }}</div>

        <p v-if="!draft.trim()" class="enhhint">
          Type your question in {{ origin }} first, then press <kbd>{{ enhanceKey }}</kbd> again.
        </p>

        <details class="enhadv" :open="advanced" @toggle="onToggle">
          <summary>
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
              <path d="M6 3.5L10.5 8 6 12.5" />
            </svg>
            Advanced
            <span class="enhsum">{{ summaryLabel }}</span>
          </summary>

          <div class="fld">
            <span class="lbl" :id="countId">Number of variations</span>
            <div class="enhseg" role="radiogroup" :aria-labelledby="countId">
              <button
                v-for="option in COUNT_OPTIONS"
                :key="option"
                type="button"
                role="radio"
                :aria-checked="count === option ? 'true' : 'false'"
                :data-on="count === option ? '1' : '0'"
                :disabled="busy"
                @click="count = option"
              >
                {{ option }}
              </button>
            </div>
          </div>

          <div class="fld">
            <label class="lbl" :for="guideId">{{ guideLabel }}</label>
            <textarea
              :id="guideId"
              v-model="guide"
              class="acct-input enharea"
              rows="3"
              :placeholder="guidePlaceholder"
              :disabled="busy"
            ></textarea>
            <p class="hint">
              Extra instruction sent with the draft. Leave it empty and the variations differ by approach alone.
            </p>
          </div>
        </details>

        <section class="enhout" aria-live="polite">
          <template v-if="busy">
            <div class="enhsection">
              <span class="lbl">Rewriting · {{ plural(count, 'variation', 'variations') }}</span>
            </div>
            <div class="enhskeletons" aria-hidden="true">
              <div v-for="n in count" :key="n" class="enhskel"><i></i><i></i></div>
            </div>
            <p class="enhclock" role="status">
              <span class="enhspin" aria-hidden="true"></span>
              {{ harnessLabel }} · <span aria-hidden="true">{{ clock }}</span>
            </p>
          </template>

          <template v-else-if="done">
            <div class="enhsection">
              <span class="lbl">Rewritten · {{ plural(variations.length, 'variation', 'variations') }}</span>
              <button class="btn enhregen" type="button" @click="generate">
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                  <path d="M13 8a5 5 0 11-1.7-3.8M13 2v3.4h-3.4" />
                </svg>
                Regenerate
              </button>
            </div>
            <ul class="enhrows" role="listbox" aria-label="Rewritten prompts">
              <li
                v-for="(row, index) in variations"
                :key="`${index}:${row.text.slice(0, 24)}`"
                class="enhrow"
                role="option"
                :data-on="focusAt === index ? '1' : '0'"
                tabindex="0"
                :aria-selected="focusAt === index ? 'true' : 'false'"
                @focus="focusAt = index"
                @keydown="onRowKey($event, index)"
              >
                <span class="enhn">{{ index + 1 }}</span>
                <div class="enhcell">
                  <div
                    class="enhtext"
                    :data-clamped="expanded.includes(index) ? '0' : '1'"
                  >{{ row.text }}</div>
                  <div v-if="row.differs" class="enhtags">
                    <span class="enhtag">{{ row.differs }}</span>
                  </div>
                  <button
                    v-if="clamped[index]"
                    class="btn enhmore"
                    type="button"
                    @click="toggleMore(index)"
                  >
                    {{ expanded.includes(index) ? 'Show less' : 'Show more' }}
                  </button>
                </div>
                <div class="enhact">
                  <button class="btn" type="button" :disabled="busy" @click="applyRow(index)">Apply</button>
                </div>
              </li>
            </ul>
          </template>

          <template v-else-if="phase === 'error'">
            <p class="acct-error enherror" role="alert">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                <circle cx="8" cy="8" r="6.2" />
                <path d="M8 5v3.6M8 11h.01" />
              </svg>
              <span>{{ failure }}</span>
            </p>
          </template>
        </section>
      </div>

      <div class="mo-foot">
        <span class="enhnote">
          <template v-if="done">{{ focusHint }}</template>
          <template v-else-if="!busy">{{ enhanceKey }} opens this; {{ generateKey }} generates</template>
        </span>
        <button class="btn" type="button" @click="busy ? stop() : dismiss()">
          {{ secondaryLabel }}
        </button>
        <button
          ref="generateBtn"
          class="btn btn-primary"
          type="button"
          :disabled="busy || !draft.trim()"
          @click="done ? applyFocused() : generate()"
        >
          {{ primaryLabel }}
          <span v-if="!done" class="btn-kbd">{{ generateKey }}</span>
        </button>
      </div>
    </div>
  </Teleport>
</template>
