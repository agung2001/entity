<script setup>
import { computed, nextTick, onMounted, ref } from 'vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import { useDialogDismiss } from '@/composables/useDialog'
import { call } from '@/composables/localBridge'
import { COLORS } from '@/composables/entityMark'
import { loadWorkspaceList, workspaces } from '@/stores/workspaces'

/**
 * Install a skill into one or more workspaces.
 *
 * One sheet for both lists: clicking a `Local` row or a `Libraries` row opens it,
 * because "where does this go?" is the same question from either side.
 *
 * The rules this sheet exists to hold:
 *
 * 1. **`01 workspaces` and `02 harnesses`, in that order.** The workspace is a
 *    destination; a harness folder is a read-only source. A harness row can be
 *    ticked to say "this is where the bytes come from", never to be written into.
 * 2. **A symlinked folder is untickable and says what it points at.** 45 of the
 *    79 harness folders on this machine are links into one real folder; writing
 *    through one would change six apps at once.
 * 3. **Already-attached copies are checked and disabled.** They are the reason the
 *    primary button can be disabled: if every destination is satisfied, there is
 *    nothing to do.
 * 4. **Esc, the scrim and the X all refuse while a copy is in flight.** A
 *    dismissed sheet over a half-renamed folder is how a skill goes missing.
 */
const props = defineProps({
  /** The skill being installed: `{ name, source?, harness?, skillId? }`. */
  item: { type: Object, required: true },
  /** Which list it came from — `local` reads the harness folder, `libraries` names a repo. */
  from: { type: String, default: 'local' },
})
const emit = defineEmits(['close', 'installed'])

const sheet = ref(null)
const busy = ref(false)
const error = ref('')
const checking = ref(true)
/** workspace id → its skill list, read once for all destinations */
const index = ref({})
/** workspace ids that will receive a copy */
const chosen = ref([])
/** the harness whose bytes are the source, when the row came from `local` */
const source = ref(props.item.harness || '')
/** harness id → the skill folder's own state, read from the scan */
const harnessRows = ref([])

useDialogDismiss({
  active: true,
  close: () => emit('close'),
  /* Esc and the scrim do nothing while a copy is in flight */
  guard: () => busy.value,
})

/* The sigil is the app's own FNV-1a, copied from `SkillsView`, so the same skill
   carries the same badge in the sheet as in the roster. */
const SIGIL_CELLS = [
  [0, 0],
  [0, 1],
  [1, 0],
  [2, 0],
  [2, 1],
]

function fnv(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

const sig = computed(() => {
  const hash = fnv(String(props.item.name || ''))
  const shape = hash & 31
  const cells = [[1, 1]]
  SIGIL_CELLS.forEach(([y, x], index2) => {
    if (!(shape & (1 << index2))) return
    cells.push([x, y])
    if (x !== 1) cells.push([2 - x, y])
  })
  return { hue: COLORS[(hash >>> 13) % COLORS.length].hex, cells }
})

const sourceLabel = computed(() => {
  if (props.from === 'libraries') return props.item.source ? `@${props.item.source}` : 'skills.sh'
  return props.item.path || 'the harness folder'
})

/* A library row has no local bytes: skills.sh names a repo, and resolving one is
   out of scope (`spec.md` §0). The sheet says so instead of offering a copy it
   cannot make. */
const resolvable = computed(() => props.from === 'local')

const candidates = computed(() => workspaces.items)

const hasHere = (id) => {
  const list = index.value[id]
  if (!Array.isArray(list)) return false
  return list.some((skill) => String(skill.name).toLowerCase() === props.item.name.toLowerCase())
}

const chosenCount = computed(() => chosen.value.length)

/** What each workspace row says on its right. */
function stateOf(id) {
  if (id === workspaces.active) {
    return hasHere(id) ? 'already here' : 'will be copied'
  }
  if (hasHere(id)) return 'already has it'
  return chosen.value.includes(id) ? 'will be copied' : 'not selected'
}

const canInstall = computed(
  () => resolvable.value && !busy.value && !checking.value && chosenCount.value > 0,
)

/* One pass over every destination's skill list, so the sheet can say "already
   here" on a row nobody has looked at yet, and a copy never discovers a clash
   halfway through. */
async function loadIndex() {
  checking.value = true
  const next = {}
  await Promise.all(
    candidates.value.map(async (item) => {
      try {
        const list = await call('workspace.skills', { id: item.id })
        next[item.id] = Array.isArray(list) ? list : []
      } catch {
        next[item.id] = []
      }
    }),
  )
  index.value = next
  checking.value = false
  /* the workspace on screen is ticked first, because that is the one the person
     was looking at; every other row starts unselected */
  chosen.value = candidates.value
    .filter((item) => item.id === workspaces.active && !hasHere(item.id))
    .map((item) => item.id)
}

/* The harness folders that carry this name, so `02` can say `already there` on
   the one the row came from and name the other copies as links. */
async function loadHarnessRows() {
  try {
    const scan = await call('skills.scan', { hash: false })
    const wanted = String(props.item.name || '').toLowerCase()
    harnessRows.value = (scan?.items || [])
      .filter((entry) => String(entry.name).toLowerCase() === wanted)
      .map((entry) => ({
        id: entry.harness,
        label: entry.harnessLabel,
        path: entry.path,
        link: Boolean(entry.link),
        realPath: entry.realPath || '',
        current: entry.harness === props.item.harness,
      }))
  } catch {
    harnessRows.value = []
  }
}

onMounted(async () => {
  if (!workspaces.items.length) {
    try {
      await loadWorkspaceList()
    } catch {
      /* the empty block covers it */
    }
  }
  await Promise.all([loadIndex(), loadHarnessRows()])
  await nextTick()
  sheet.value?.querySelector('.destbtn')?.focus({ preventScroll: true })
})

function toggle(id) {
  if (busy.value || hasHere(id)) return
  chosen.value = chosen.value.includes(id)
    ? chosen.value.filter((entry) => entry !== id)
    : [...chosen.value, id]
}

async function submit() {
  if (!canInstall.value) return
  busy.value = true
  error.value = ''
  try {
    let installed = 0
    for (const id of chosen.value) {
      /* `attachSkill`, not `replaceSkill`: a destination that already has the
         name is not in `chosen`, so there is nothing here to overwrite */
      const result = await call('workspace.attachSkill', {
        id,
        name: props.item.name,
        harness: props.item.harness || null,
      })
      if (result?.copied) installed += 1
    }
    emit('installed', { name: props.item.name, count: installed })
    emit('close')
  } catch (problem) {
    error.value = problem?.message || 'The skill could not be installed.'
  } finally {
    busy.value = false
  }
}

/* Keep Tab inside the sheet: the roster behind it is dimmed but still focusable,
   and tabbing into a hidden row button is a way to open a second sheet. */
function trapTab(event) {
  const focusable = [
    ...(sheet.value?.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) || []),
  ]
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
      class="modal skinstall-modal"
      data-open="1"
      role="dialog"
      aria-modal="true"
      aria-labelledby="skinstall-name"
      @keydown.tab="trapTab"
    >
      <div class="sheet-head">
        <!-- the same badge the row wore: a sigil from the workspace and Libraries
             tabs, the harness mark from Local, where every row is a folder -->
        <span
          v-if="from === 'local'"
          class="sig-tile"
          :title="item.harnessLabel || ''"
        >
          <HarnessIcon :name="item.harness" :size="13" />
        </span>
        <span v-else class="sig-tile sig-tile-nm" :style="{ '--sg': sig.hue }">
          <svg class="sig" viewBox="0 0 3 3" shape-rendering="crispEdges" aria-hidden="true">
            <g fill="currentColor">
              <rect
                v-for="(cell, i) in sig.cells"
                :key="i"
                :x="cell[0]"
                :y="cell[1]"
                width="1"
                height="1"
              />
            </g>
          </svg>
        </span>
        <span class="hh">
          <h2 id="skinstall-name">{{ item.name }}</h2>
          <span class="src">{{ sourceLabel }}</span>
        </span>
        <button
          class="x"
          type="button"
          aria-label="Close"
          :disabled="busy"
          @click="emit('close')"
        >
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>

      <div class="sheet-body">
        <p v-if="item.description">{{ item.description }}</p>

        <div v-if="!resolvable" class="notice" data-tone="warn">
          <b>Skills.sh names a repository, not a folder on this machine.</b>
          <span>
            Resolving one would download and unpack it here, which is out of scope for this page.
            Open the skill on skills.sh to see how its repository is installed.
          </span>
        </div>

        <div class="step">
          <div class="step-head">
            <span class="step-n">01</span><b>Where it goes</b>
            <span class="stt">real folders, copied</span>
          </div>
          <div class="dest-group">
            <div class="dest-group-head">
              <b>Workspaces</b>
              <span class="cnt">{{ candidates.length }} on this machine</span>
            </div>
            <button
              v-for="entry in candidates"
              :key="entry.id"
              class="dest destbtn"
              type="button"
              role="checkbox"
              :aria-checked="hasHere(entry.id) || chosen.includes(entry.id) ? 'true' : 'false'"
              :aria-disabled="hasHere(entry.id) ? 'true' : 'false'"
              :data-off="hasHere(entry.id) ? '1' : '0'"
              :disabled="busy || hasHere(entry.id)"
              @click="toggle(entry.id)"
            >
              <span class="rd" aria-hidden="true"></span>
              <span class="dt">
                <b>
                  {{ entry.label }}
                  <span v-if="entry.id === workspaces.active" class="tg" data-t="here">this one</span>
                </b>
                <span>{{ entry.path || `~/.entity/workspaces/${entry.id}/skills/${item.name}` }}</span>
              </span>
              <span
                class="state"
                :data-s="hasHere(entry.id) ? 'ok' : chosen.includes(entry.id) ? 'ok' : 'off'"
              >
                {{ checking ? 'reading…' : stateOf(entry.id) }}
              </span>
            </button>
          </div>
        </div>

        <div v-if="harnessRows.length" class="step">
          <div class="step-head">
            <span class="step-n">02</span><b>Already in a harness folder</b>
            <span class="stt">read-only sources</span>
          </div>
          <div class="dest-group">
            <div class="dest-group-head">
              <b>Harness folders</b>
              <span class="cnt">never written into</span>
            </div>
            <div
              v-for="row in harnessRows"
              :key="row.id"
              class="dest"
              :data-off="row.link ? '1' : '0'"
            >
              <span class="ico"><HarnessIcon :name="row.id" :size="15" /></span>
              <span class="dt">
                <b>{{ row.label }}</b>
                <span>{{ row.path }}</span>
              </span>
              <span class="state" :data-s="row.link ? 'drift' : row.current ? 'ok' : 'off'">
                <template v-if="row.link">link → {{ row.realPath }}</template>
                <template v-else-if="row.current">the source</template>
                <template v-else>real folder</template>
              </span>
            </div>
          </div>
        </div>

        <p v-if="busy" class="mnote">
          Staged in each workspace and renamed into place — a half-written folder never
          appears, and a failure leaves the copy that was already there.
        </p>

        <p v-if="error" class="run-warn" role="alert">{{ error }}</p>
      </div>

      <div class="sheet-foot">
        <span class="sum">
          <b>Writes {{ chosenCount }} {{ chosenCount === 1 ? 'folder' : 'folders' }}</b>
          · nothing else is touched
        </span>
        <span class="sp"></span>
        <button class="btn" type="button" :disabled="busy" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" type="button" :disabled="!canInstall" @click="submit">
          {{ busy ? 'Installing…' : `Install${chosenCount ? ` ${chosenCount}` : ''}` }}
        </button>
      </div>

      <p class="sheet-rule">
        A copy is a folder copy: staged in <code>.tmp</code> then renamed, so a failure never
        leaves half a skill. A linked folder is never written through.
      </p>
    </div>
  </Teleport>
</template>
