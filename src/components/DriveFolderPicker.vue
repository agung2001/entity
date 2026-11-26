<script setup>
/**
 * One Drive folder, chosen for the Lynk.id report.
 *
 * The dialog exists because a folder id is not something a person types: the
 * alternative is pasting `1JBOqnc3-…` out of a Drive URL, which is one truncated
 * character away from an empty report. So the list is the whole interface, the id
 * under every name is there because *that* is what gets stored, and the only two
 * buttons are the two things a dialog is allowed to do.
 *
 * Four decisions worth keeping:
 *
 *   1. **Search is the first focus stop, and it takes an id.** A Drive with two
 *      hundred folders is not scrolled, it is filtered — and the one value a person
 *      already has is the folder id out of a Drive URL, so a pasted id or link is
 *      looked up by id instead of being searched for as a name.
 *   2. **A refused grant does not hide the footer.** The person needs to read the
 *      scope and the refusal in the same breath, and a footer that vanishes looks
 *      like a broken dialog rather than a refused grant.
 *   3. **No folder is preselected** — the arrow keys move, Enter confirms the one
 *      under the cursor, and nothing is written until the footer's button is
 *      pressed.
 *   4. **Esc closes and focus goes back where it came from**, through the one
 *      `useDialogDismiss` stack rather than a listener of this component's own.
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useDialogDismiss } from '@/composables/useDialog'
import { lynk, readFolders } from '@/composables/lynkDashboard'

const props = defineProps({
  /** The folder already picked, so the list can say which one is in use. */
  folderId: { type: String, default: '' },
})
const emit = defineEmits(['close', 'pick'])

const query = ref('')
const cursor = ref(0)
const search = ref(null)
const list = ref(null)
/* What had focus before the dialog opened: a dialog that drops focus on `<body>`
   makes the next Tab start from the top of the page. */
const opener = typeof document !== 'undefined' ? document.activeElement : null

const rows = computed(() => lynk.folders)
const busy = computed(() => lynk.foldersLoading)
const problem = computed(() => lynk.foldersError)
/* A refusal is a sentence with a scope in it, and the footer prints that scope —
   so the two are not the same string and must not be conflated. */
const refused = computed(() => /403|insufficient|drive\.readonly|refused|invalid_grant/i.test(problem.value))
const empty = computed(() => !busy.value && !problem.value && !rows.value.length)
/* A pasted folder id (or a Drive link) is not a name, and "no folder matches" is
   then the wrong sentence: nothing was searched, one id was looked up and refused.
   Same detection as `pastedId()` in the main process, kept in step on purpose. */
const pasted = computed(() => {
  const said = String(query.value || '').trim()
  const link = said.match(/\/folders\/([A-Za-z0-9_-]{10,})/) || said.match(/[?&]id=([A-Za-z0-9_-]{10,})/)
  if (link) return link[1]
  return /^[A-Za-z0-9_-]{20,}$/.test(said) ? said : ''
})
const chosen = computed(() => rows.value[cursor.value] || null)

useDialogDismiss({
  active: () => true,
  close: () => dismiss(),
})

function dismiss() {
  restore()
  emit('close')
}

onMounted(async () => {
  await nextTick()
  search.value?.focus()
  await load('')
})

/* Typing is not a request per keystroke: 200 ms after the last one, the list is
   asked once. A pasted id therefore costs one lookup, not twenty. */
let timer = 0
watch(query, (value) => {
  cursor.value = 0
  clearTimeout(timer)
  timer = setTimeout(() => load(String(value || '').trim()), 200)
})
onUnmounted(() => clearTimeout(timer))

async function load(text) {
  await readFolders({ query: text })
}

function move(delta) {
  if (!rows.value.length) return
  cursor.value = (cursor.value + delta + rows.value.length) % rows.value.length
  nextTick(() => {
    const at = list.value?.querySelector('[aria-selected="true"]')
    at?.scrollIntoView({ block: 'nearest' })
  })
}

function onKey(event) {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    move(1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    move(-1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    confirm()
  }
}

function choose(entry) {
  if (!entry) return
  restore()
  emit('pick', { id: entry.id, name: entry.name })
}

function confirm() {
  choose(chosen.value)
}

const when = (iso) => {
  const date = new Date(String(iso || ''))
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleDateString('en-gb', { day: 'numeric', month: 'short', year: 'numeric' })
}

/* Hand focus back to whatever opened this, once it is gone. */
function restore() {
  const target = opener
  if (!target || typeof target.focus !== 'function') return
  nextTick(() => target.focus?.())
}
watch(
  () => lynk.folders,
  () => {
    if (!rows.value.length) return
    const at = rows.value.findIndex((entry) => entry.id === props.folderId)
    if (at >= 0) cursor.value = at
  },
)
</script>

<template>
  <div class="scrim scrim-dialog" data-open="1" @click="emit('close')"></div>
  <div
    class="modal picker"
    role="dialog"
    aria-modal="true"
    aria-labelledby="pick-title"
    aria-describedby="pick-sub"
    data-open="1"
    @keydown="onKey"
  >
    <header class="mo-head pick-h">
      <h2 id="pick-title">Choose a Drive folder</h2>
      <p id="pick-sub" class="pick-sub">
        Lynk.id writes one spreadsheet per product. Pick the folder they live in — the dashboard
        reads every spreadsheet inside it and nothing else. You can paste the folder's id, or its
        Drive link, if you already have one.
      </p>
      <div class="pick-search">
        <input
          ref="search"
          v-model="query"
          type="search"
          class="input"
          placeholder="Search folders, or paste a folder id…"
          aria-label="Search Drive folders, or paste a folder id"
          aria-controls="pick-list"
          :aria-activedescendant="chosen ? `pick-${chosen.id}` : undefined"
          autocomplete="off"
        />
      </div>
    </header>

    <div class="mo-body pick-body">
      <!-- Refused: Google's own sentence, kept verbatim, with the scope named. The
           footer below still offers Cancel, because a dialog with no way out is a
           worse answer than a refused grant. -->
      <div v-if="problem" class="pick-empty" data-tone="bad">
        <b>The Drive did not answer</b>
        <p class="mono">{{ problem }}</p>
        <p v-if="refused">403 insufficientPermissions — the grant has no <code class="mono">drive.readonly</code>. Reauthorize on Overview.</p>
      </div>

      <ul v-else-if="busy && !rows.length" class="pick-list" aria-busy="true">
        <li v-for="n in 5" :key="`sk${n}`" class="pick-skel">
          <span class="skel" style="width: 58%; height: 11px"></span>
          <span class="skel" style="width: 34%; height: 9px; margin-top: 7px"></span>
        </li>
      </ul>

      <div v-else-if="empty && pasted" class="pick-empty">
        <b>No folder has the id <code class="mono">{{ pasted }}</code></b>
        <p>
          Drive answered either “not found” or “no access”. A folder id is case-sensitive, and a
          folder shared with someone else is invisible until it is shared with this account.
        </p>
        <button class="btn btn-sm" type="button" @click="query = ''">Back to every folder</button>
      </div>

      <div v-else-if="empty" class="pick-empty">
        <b>No folder matches “{{ query }}”</b>
        <p>Lynk.id's own folder is usually named after the store. Clear the search to see every folder again.</p>
        <button class="btn btn-sm" type="button" @click="query = ''">Clear the search</button>
      </div>

      <ul
        v-else
        id="pick-list"
        ref="list"
        class="pick-list"
        role="listbox"
        aria-label="Drive folders"
        tabindex="0"
      >
        <li
          v-for="(entry, index) in rows"
          :id="`pick-${entry.id}`"
          :key="entry.id"
          class="pick-row"
          role="option"
          :aria-selected="index === cursor ? 'true' : 'false'"
          @click="cursor = index"
          @dblclick="choose(entry)"
        >
          <span class="nm">{{ entry.name }}</span>
          <!-- The id is what gets stored, so it is printed rather than hidden in a
               title: two folders may share a name, and only this tells them apart. -->
          <span class="id mono">{{ entry.id }}</span>
          <span class="tail">
            <span v-if="entry.id === folderId" class="in-use">in use</span>
            <span v-else class="when">{{ when(entry.modifiedTime) }}</span>
          </span>
        </li>
      </ul>
    </div>

    <footer class="mo-foot pick-f">
      <span class="scope mono">read-only · drive.readonly</span>
      <span class="spacer"></span>
      <button class="btn btn-sm btn-ghost" type="button" @click="dismiss()">Cancel</button>
      <button class="btn btn-sm btn-primary" type="button" :disabled="!chosen" @click="confirm()">
        Use this folder
      </button>
    </footer>
  </div>
</template>
