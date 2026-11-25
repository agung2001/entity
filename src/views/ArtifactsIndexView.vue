<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import VoxelMark from '@/components/VoxelMark.vue'
import { matchesQuery } from '@/composables/search'
import { dialogDepth } from '@/composables/useDialog'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import { groupWorks, typeOf } from '@/lib/artifact-works'
import { hub, toast } from '@/stores/hub'
import { artifacts, loadArtifacts, readArtifact, revealArtifact, uploadArtifact } from '@/stores/artifacts'

/**
 * Artifacts — the shelf, drawn as the folders that produced something (ENTITY-67).
 *
 * The rail answers "which file", one row and one name at a time, which is the
 * right answer when you already remember the name. This page answers the other
 * question — *which folder* — because a person who finished a mockup remembers
 * the shot, not the name of the png inside it.
 *
 * Nothing is stored to make that possible. A work is derived from the rows the
 * store already returns (`src/lib/artifact-works.js`), so the same shelf always
 * draws the same cards and an upload appears without a migration.
 *
 * The shelf is the URL's (`?shelf=shared`), the opened work is the URL's
 * (`?in=design/tailscale-lan`), and the query, the type and the scroll position
 * are this component's: a link, a saved view and Back all land where they should.
 */
const route = useRoute()
const router = useRouter()

const search = ref('')
const type = ref('all')
const uploading = ref(false)
const fileInput = ref(null)
const searchField = ref(null)
const searchKey = shortcutLabel('inventory-search')

/* One read per cover, and never more than three at once: the shelf can hold
   ninety works and the call table is a request per file. */
const covers = reactive(new Map())
const coverPending = reactive(new Set())
const coverGone = reactive(new Set())
const MAX_READS = 3
let reads = 0
let observer = null

const TYPES = [
  { id: 'all', label: 'All' },
  { id: 'images', label: 'Images' },
  { id: 'pages', label: 'Pages' },
  { id: 'notes', label: 'Notes' },
  { id: 'code', label: 'Code' },
  { id: 'other', label: 'Other' },
]

const loading = computed(() => artifacts.loading && !artifacts.items.length)
const failed = computed(() => Boolean(artifacts.error) && !artifacts.loading)
const ready = computed(() => artifacts.loaded && !failed.value)
const workspaceLabel = computed(() => hub.workspaceLabel || hub.workspace || 'this workspace')

/* The shelf follows the URL first and the rail's switch second: `?shelf=` is what
   a link carries, and the store is what a person toggles in the rail beside this
   page — they must not disagree after a navigation. */
const shelf = computed(() => {
  if (route.query.shelf === 'shared') return 'shared'
  if (route.query.shelf === 'personal') return 'personal'
  return artifacts.scope === 'shared' ? 'shared' : 'personal'
})

const rows = computed(() =>
  artifacts.items.filter((item) => (item.scope === 'shared') === (shelf.value === 'shared')),
)
const grouped = computed(() => groupWorks(rows.value))
const counts = computed(() => grouped.value.counts)

const query = computed(() => search.value.trim())
const filterType = computed(() => TYPES.find((entry) => entry.id === type.value) || TYPES[0])

const works = computed(() =>
  grouped.value.works.filter((work) => {
    if (type.value !== 'all' && !work.files.some((file) => typeOf(file.ext) === type.value)) return false
    if (!query.value) return true
    /* The folder's own path, the extensions it holds and every name inside it —
       "which folder was the tailscale thing in" is answered by the path. */
    const haystack = `${work.path} ${work.extMix.map((entry) => entry.ext).join(' ')} ${work.files
      .map((file) => file.name)
      .join(' ')}`
    return matchesQuery(haystack, query.value)
  }),
)

const loose = computed(() =>
  grouped.value.loose.filter((item) => {
    if (type.value !== 'all' && typeOf(item.ext) !== type.value) return false
    return !query.value || matchesQuery(`${item.id} ${item.ext}`, query.value)
  }),
)

const openedPath = computed(() => (typeof route.query.in === 'string' ? route.query.in : ''))
const opened = computed(() => grouped.value.works.find((work) => work.path === openedPath.value) || null)
const openedFiles = computed(() => (opened.value ? [...opened.value.files].sort(byName) : []))

/* Reveal needs a *file* id: the call table reveals a file's containing folder, so
   the deepest row whose own directory is the work is the one that opens it. A
   work that only holds files in subfolders falls back to its cover, which shares
   the folder or sits below it. */
const revealable = computed(() => {
  const work = opened.value
  if (!work) return ''
  const direct = work.files.find((file) => file.id.slice(0, file.id.lastIndexOf('/')) === work.path)
  return direct?.id || work.cover?.id || ''
})

const previewPct = computed(() => {
  const total = counts.value.works
  return total ? Math.round((counts.value.previews / total) * 100) : 0
})
const noPreview = computed(() => Math.max(0, counts.value.works - counts.value.previews))
const looseWord = computed(() => (counts.value.loose === 1 ? 'file' : 'files'))

function byName(a, b) {
  return a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id))
}

/* ── formatting ──────────────────────────────────────────────────────────────
   Two formatters, both from the spec's rule sheet: a size is whole KB below a
   megabyte and one decimal above it, and an age is minutes, hours, days, then a
   date — the same ladder the rail already prints, so a file cannot show two. */
function sizeLabel(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value)) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function ageLabel(iso) {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return '—'
  const mins = Math.floor((Date.now() - then) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} ${days === 1 ? 'day' : 'days'} ago`
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/* ── covers ──────────────────────────────────────────────────────────────────
   A cover is read on demand and only when its card comes near the viewport.
   Loading is an `<img>` with a data URL — the same path the artifact detail page
   takes — so a shot that cannot be read falls back to the type tile instead of a
   background that is silently `none`. */
function shotState(work) {
  if (!work.cover) return 'none'
  const id = work.cover.id
  if (covers.has(id)) return 'img'
  if (coverGone.has(id)) return 'none'
  return 'wait'
}

function shotSrc(work) {
  return (work.cover && covers.get(work.cover.id)) || ''
}

async function requestCover(id) {
  if (!id || covers.has(id) || coverGone.has(id) || coverPending.has(id)) return
  coverPending.add(id)
  while (reads >= MAX_READS) await new Promise((resolve) => setTimeout(resolve, 60))
  reads += 1
  try {
    const result = await readArtifact(id)
    if (result?.dataUrl) covers.set(id, result.dataUrl)
    else coverGone.add(id)
  } catch {
    /* A shot that will not read is a card with its type tile — never a broken
       frame, and never a toast for something the person did not ask for. */
    coverGone.add(id)
  } finally {
    reads -= 1
    coverPending.delete(id)
  }
}

function attachObserver() {
  if (observer || typeof IntersectionObserver !== 'function') return
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        observer.unobserve(entry.target)
        requestCover(entry.target.dataset.cover)
      }
    },
    { rootMargin: '300px' },
  )
}

function bindShot(element, work) {
  if (!element || !work.cover) return
  if (covers.has(work.cover.id) || coverGone.has(work.cover.id)) return
  element.dataset.cover = work.cover.id
  if (observer) observer.observe(element)
  /* No observer in this build: read the one cover rather than nothing. */
  else requestCover(work.cover.id)
}

/* Built during setup, not in `onMounted`: a child's ref callback runs before the
   parent mounts, and an observer that arrives after the cards would never see
   them. */
attachObserver()

/* ── navigation ──────────────────────────────────────────────────────────────
   The shelf switch is a `replace` (it is a narrowing of the same page), opening
   a work is a `push` (it is a place you come back from). */
function shelfQuery(next = shelf.value) {
  return { ...(next === 'shared' ? { shelf: 'shared' } : {}) }
}

function setShelf(next) {
  if (next === shelf.value) return
  artifacts.scope = next
  router.replace({ name: 'artifacts', params: { workspace: hub.workspace }, query: shelfQuery(next) })
}

function openWork(work) {
  router.push({
    name: 'artifacts',
    params: { workspace: hub.workspace },
    query: { ...shelfQuery(), in: work.path },
  })
}

function closeWork() {
  router.replace({ name: 'artifacts', params: { workspace: hub.workspace }, query: shelfQuery() })
}

function openFile(item) {
  router.push({ name: 'artifact', params: { workspace: hub.workspace, id: item.id } })
}

function back() {
  if (opened.value) closeWork()
  else router.push({ name: 'overview', params: { workspace: hub.workspace } })
}

function clearSearch() {
  search.value = ''
  type.value = 'all'
}

async function revealFolder() {
  if (!revealable.value) return
  try {
    await revealArtifact(revealable.value)
  } catch (error) {
    toast(error?.message || 'Could not reveal that folder.')
  }
}

/* ── upload ──────────────────────────────────────────────────────────────────
   The page's one filled button. It writes in place — no dialog — and the shelf
   is re-read afterwards, so the new file lands in the card it belongs to. */
function pickUpload() {
  if (uploading.value) return
  fileInput.value?.click()
}

async function onFiles(event) {
  const files = [...(event.target?.files || [])]
  event.target.value = ''
  if (!files.length || uploading.value) return
  uploading.value = true
  let saved = 0
  try {
    for (const file of files) {
      try {
        await uploadArtifact(file)
        saved += 1
      } catch (error) {
        toast(`${file.name}: ${error?.message || 'upload failed'}`)
      }
    }
    if (saved) toast(`${plural(saved, 'artifact')} uploaded`)
    await loadArtifacts()
  } finally {
    uploading.value = false
  }
}

/* ── keyboard ────────────────────────────────────────────────────────────────
   One listener for the two keys this page owns: the list-search combo (from the
   catalog, never a literal combo) and Escape, which closes the opened work
   before it leaves the page. */
function focusSearch() {
  if (!(searchField.value instanceof HTMLInputElement)) return
  searchField.value.focus()
  searchField.value.select()
}

function onKey(event) {
  if (matchesShortcut('inventory-search', event)) {
    event.preventDefault()
    focusSearch()
    return
  }
  if (event.key !== 'Escape' || event.isComposing) return
  if (document.activeElement === searchField.value) {
    searchField.value.blur()
    return
  }
  /* A dialog's Escape is the dialog's: the shared stack already closed it and
     stopped the event, so this is the belt to that braces — the page must not
     also walk back a step underneath a surface that is still open. */
  if (dialogDepth()) return
  back()
}

onMounted(() => {
  if (!artifacts.loaded || artifacts.workspace !== hub.workspace) loadArtifacts()
  window.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  observer?.disconnect()
  observer = null
})

/* The router keeps no scroll position, and this page scrolls inside
   `.main-scroll`: a card opened from halfway down the grid would otherwise land
   halfway down its own file list. */
watch(openedPath, () => {
  document.querySelector('.main-scroll')?.scrollTo({ top: 0 })
})

/* The opened work's head shows the same shot at 168 px; it is above the fold, so
   it is read eagerly rather than waited on. */
watch(
  opened,
  (work) => {
    if (work?.cover) requestCover(work.cover.id)
  },
  { immediate: true },
)

watch(shelf, (value) => {
  if (artifacts.scope !== value) artifacts.scope = value
})
</script>

<template>
  <div class="view ash-page">
    <header class="ash-bar">
      <button class="ash-back" type="button" :aria-label="opened ? 'Back to the artifact shelf' : 'Back to the workspace'" @click="back">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M10 3L5 8l5 5" />
        </svg>
      </button>
      <span class="ash-crumb">
        Artifacts<span class="ash-crumb-n">/ {{ opened ? opened.path : workspaceLabel }}</span>
      </span>
      <span class="ash-spacer"></span>
      <div class="ash-actions">
        <!-- Reveal needs a file id, so it appears only where one exists: the
             head of an opened work, never the shelf (the call table reveals a
             file's folder, not a directory of its own). -->
        <button v-if="opened && revealable" class="btn" type="button" @click="revealFolder">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M2 4.5A1.5 1.5 0 013.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0114 6v6a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12V4.5z" />
          </svg>
          Reveal folder
        </button>
        <button class="btn btn-ink" type="button" :disabled="uploading" @click="pickUpload">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
            <path d="M8 11.5V3M4.5 6.5L8 3l3.5 3.5M3 12.5v1h10v-1" />
          </svg>
          Upload
        </button>
        <input ref="fileInput" class="hidden-file" type="file" multiple @change="onFiles" />
      </div>
    </header>
    <div class="ash-band">
      <!-- The unopened shelf: the works, the facts and the two ways to narrow. -->
      <template v-if="!opened">
        <section class="ash-hero">
          <div class="ash-hero-in">
            <div class="ash-hero-id">
              <span class="ash-crest" aria-hidden="true"><VoxelMark shape="station" /></span>
              <div class="ash-hero-text">
                <p class="eyebrow">Artifacts <span class="sep">·</span> {{ workspaceLabel }}</p>
                <h1 class="ash-h1">Artifacts</h1>
                <p class="ash-lede">
                  Every folder that finished something — a mockup and its shots, a spec and the page
                  it describes. The picture is the folder's own cover shot, cropped from the top left;
                  open a card to get the files inside it.
                </p>
              </div>
            </div>

            <!-- Counts are empty, never zero, until the shelf answers: a zero is a claim. -->
            <div v-if="ready" class="ash-meter" role="group" aria-label="Works with a preview">
              <div class="ash-lv"><span>SHOT</span><b>{{ counts.previews }}</b></div>
              <div class="ash-meter-main">
                <div class="ash-meter-head">
                  <span>Works with a preview</span>
                  <b>{{ counts.previews }} / {{ counts.works }}</b>
                </div>
                <div
                  class="ash-track"
                  role="progressbar"
                  aria-valuemin="0"
                  :aria-valuemax="Math.max(counts.works, 1)"
                  :aria-valuenow="counts.previews"
                  :aria-valuetext="`${counts.previews} of ${counts.works} works hold a shot the card can show`"
                >
                  <i :style="{ width: `${previewPct}%` }"></i>
                </div>
                <div class="ash-meter-foot">
                  <span>{{ noPreview }} show their type instead</span>
                </div>
              </div>
            </div>
            <div v-else class="ash-meter" aria-hidden="true">
              <div class="ash-lv"><span>SHOT</span><b>—</b></div>
              <div class="ash-meter-main">
                <div class="ash-meter-head"><span>Works with a preview</span><b>— / —</b></div>
                <div class="ash-track"><i style="width: 0" /></div>
                <div class="ash-meter-foot"><span>reading the shelf…</span></div>
              </div>
            </div>
          </div>
        </section>

        <dl class="ash-strip">
          <div>
            <dt>Folder</dt>
            <dd class="ash-mono" :title="artifacts.path || ''">{{ artifacts.path || '—' }}</dd>
          </div>
          <div>
            <dt>Files</dt>
            <dd><b>{{ ready ? counts.files : '—' }}</b> in {{ ready ? plural(counts.works, 'work') : '—' }}</dd>
          </div>
          <div>
            <dt>On disk</dt>
            <dd>{{ ready ? sizeLabel(counts.bytes) : '—' }}</dd>
          </div>
          <div>
            <dt>Loose</dt>
            <dd><b>{{ ready ? counts.loose : '—' }}</b> {{ looseWord }} · {{ ready ? sizeLabel(counts.looseBytes) : '—' }}</dd>
          </div>
          <div>
            <dt>Previews</dt>
            <dd><b>{{ ready ? counts.previews : '—' }}</b> of {{ ready ? counts.works : '—' }} works</dd>
          </div>
          <div>
            <dt>Newest</dt>
            <dd>{{ ready && grouped.works[0] ? ageLabel(grouped.works[0].modifiedAt) : '—' }}</dd>
          </div>
        </dl>

        <div class="ash-tool">
          <label class="ash-search">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
              <circle cx="7" cy="7" r="4.2" />
              <path d="M10.2 10.2L14 14" />
            </svg>
            <input
              ref="searchField"
              v-model="search"
              type="search"
              placeholder="Search a work, a file, a folder…"
              aria-label="Search artifacts"
              autocomplete="off"
            />
            <kbd v-if="!search" class="search-kbd" aria-hidden="true">{{ searchKey }}</kbd>
          </label>
          <div class="ash-seg" role="group" aria-label="Which shelf">
            <button type="button" :aria-pressed="shelf === 'personal'" @click="setShelf('personal')">
              Personal <b>{{ artifacts.counts.personal }}</b>
            </button>
            <button type="button" :aria-pressed="shelf === 'shared'" @click="setShelf('shared')">
              Shared <b>{{ artifacts.counts.shared }}</b>
            </button>
          </div>
          <span class="ash-count">{{ ready ? plural(counts.works, 'work') : '—' }}</span>
        </div>

        <div class="ash-types" role="group" aria-label="Filter by file type">
          <button
            v-for="entry in TYPES"
            :key="entry.id"
            class="ash-pill"
            type="button"
            :aria-pressed="type === entry.id"
            @click="type = entry.id"
          >
            {{ entry.label }}
            <b>{{ ready ? (entry.id === 'all' ? counts.files : counts.types[entry.id].count) : '—' }}</b>
          </button>
        </div>
      </template>

      <!-- The opened work: its own head, then every file as a row. -->
      <template v-else>
        <div class="ash-crumbs">
          <a href="#" @click.prevent="closeWork">Artifacts</a>
          <template v-for="part in opened.path.split('/')" :key="part">
            <span aria-hidden="true">/</span>
            <span>{{ part }}</span>
          </template>
        </div>
        <div class="ash-whead">
          <span class="ash-whead-shot">
            <img
              v-if="shotSrc(opened)"
              :src="shotSrc(opened)"
              :alt="`Cover shot of ${opened.path}`"
              loading="lazy"
              decoding="async"
            />
            <span v-else class="ash-whead-none" aria-hidden="true">{{ opened.extMix[0]?.ext || 'file' }}</span>
          </span>
          <div class="ash-whead-main">
            <h1>{{ opened.name }}</h1>
            <p>
              {{ plural(opened.fileCount, 'file') }}<span class="ash-dot">·</span>{{ sizeLabel(opened.size) }}<span class="ash-dot">·</span>
              edited {{ ageLabel(opened.modifiedAt) }}<span class="ash-dot">·</span>{{ plural(opened.shots, 'shot') }}
            </p>
          </div>
        </div>

        <div class="ash-table" role="table" :aria-label="`Files in ${opened.path}`">
          <div class="ash-row ash-head" role="row">
            <span class="ash-k1" role="columnheader">File</span>
            <span class="ash-k2" role="columnheader">Type</span>
            <span class="ash-k3" role="columnheader">Size</span>
            <span class="ash-k4" role="columnheader">Edited</span>
            <span class="ash-acts" role="columnheader" aria-label="Open" />
          </div>
          <div
            v-for="file in openedFiles"
            :key="file.id"
            class="ash-row"
            role="row"
            tabindex="0"
            @click="openFile(file)"
            @keydown.enter="openFile(file)"
          >
            <span class="ash-k1" role="cell">
              <span class="ash-fn">
                <span class="ash-ft">{{ file.ext.replace('.', '') || 'file' }}</span>
                <span class="ash-nm">{{ file.id.slice(opened.path.length + 1) }}</span>
              </span>
            </span>
            <span class="ash-k2" role="cell"><span class="ash-kind">{{ file.ext.replace('.', '') || 'file' }}</span></span>
            <span class="ash-k3" role="cell"><span class="ash-num">{{ sizeLabel(file.size) }}</span></span>
            <span class="ash-k4" role="cell"><span class="ash-num">{{ ageLabel(file.modifiedAt) }}</span></span>
            <span class="ash-acts" role="cell">
              <button class="ash-rowact" type="button" :aria-label="`Open ${file.name}`" @click.stop="openFile(file)">
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </span>
          </div>
        </div>
      </template>

      <!-- One ribbon for a shelf that could not be read, in every state: the raw
           reason and the path, so it can be pasted into a terminal unchanged. -->
      <div v-if="failed" class="ash-ribbon" role="alert">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
          <circle cx="8" cy="8" r="6.2" />
          <path d="M8 4.6v4.1M8 11.2h.01" stroke-linecap="round" />
        </svg>
        <div class="ash-ribbon-b">
          <b>This shelf could not be read</b>
          <p>{{ artifacts.error }}</p>
        </div>
        <button class="btn" type="button" :disabled="artifacts.loading" @click="loadArtifacts()">Try again</button>
      </div>

      <template v-if="!opened">
        <div class="ash-sechead">
          <h2>Works</h2>
          <span class="ash-tot">
            {{ ready ? `${plural(works.length, 'folder')} · newest first` : 'reading the shelf…' }}
          </span>
          <span class="ash-spacer"></span>
        </div>

        <ul v-if="loading" class="ash-works">
          <li v-for="n in 6" :key="n" class="ash-work" aria-hidden="true">
            <div class="ash-card ash-card--skel">
              <div class="ash-skel"></div>
              <div class="ash-body">
                <span class="ash-skel ash-skel--l" style="width: 74%"></span>
                <span class="ash-skel ash-skel--l" style="width: 52%"></span>
              </div>
            </div>
          </li>
        </ul>
        <ul v-else-if="works.length" class="ash-works">
          <li v-for="work in works" :key="work.path" class="ash-work">
            <a
              class="ash-card"
              :href="`#${work.path}`"
              :aria-label="`Open ${work.path}`"
              @click.prevent="openWork(work)"
            >
              <span class="ash-shot" :ref="(element) => bindShot(element, work)">
                <img
                  v-if="shotState(work) === 'img'"
                  :src="shotSrc(work)"
                  :alt="`Cover shot of ${work.path}`"
                  loading="lazy"
                  decoding="async"
                />
                <span v-else-if="shotState(work) === 'none'" class="ash-none" aria-hidden="true">
                  <b>{{ work.extMix[0]?.ext || 'file' }}</b>
                  <i>no preview</i>
                </span>
                <span v-else class="ash-skel ash-skel--shot" aria-hidden="true"></span>
                <span v-if="work.shots" class="ash-shots">{{ plural(work.shots, 'shot') }}</span>
              </span>
              <span class="ash-body">
                <span class="ash-name">
                  {{ work.name }} <span class="ash-par">{{ work.parent ? `${work.parent} /` : 'shelf root' }}</span>
                </span>
                <span class="ash-mix">
                  <span v-for="entry in work.extMix.slice(0, 3)" :key="entry.ext">
                    <i></i>{{ entry.ext }} <b>{{ entry.count }}</b>
                  </span>
                </span>
                <span class="ash-meta">
                  {{ plural(work.fileCount, 'file') }}<span class="ash-dot">·</span>{{ sizeLabel(work.size) }}<span class="ash-dot">·</span>
                  {{ ageLabel(work.modifiedAt) }}
                </span>
              </span>
            </a>
          </li>
        </ul>
        <div v-else-if="ready" class="ash-empty">
          <template v-if="query || type !== 'all'">
            <b v-if="query">No work matches <q>{{ query }}</q></b>
            <b v-else>No {{ filterType.label.toLowerCase() }} file on this shelf</b>
            Folder paths and the file names inside each work are searched —
            {{ plural(counts.works, 'work') }}, {{ plural(counts.files, 'file') }} checked.
            <div class="ash-empty-actions">
              <button class="btn" type="button" @click="clearSearch">Clear the filters</button>
            </div>
          </template>
          <template v-else-if="shelf === 'shared'">
            <b>Nothing shared yet</b>
            A file lands on your own shelf first, and reaches this one only when you share it —
            so a teammate's sync clone reads it too.
            <div class="ash-empty-actions">
              <button class="btn" type="button" @click="setShelf('personal')">Back to personal</button>
            </div>
          </template>
          <template v-else>
            <b>No artifacts yet</b>
            Anything an entity writes to this shelf lands here as a work — a folder, or a single
            file if it never got one.
            <div class="ash-empty-actions">
              <button class="btn btn-ink" type="button" :disabled="uploading" @click="pickUpload">Upload a file</button>
            </div>
          </template>
        </div>

        <!-- Loose rows are the files no folder claims: at the shelf root, or under
             a folder that never wrote a document or held a batch of images. -->
        <template v-if="ready && loose.length">
          <div class="ash-sechead ash-ledge">
            <h2>Outside any work</h2>
            <span class="ash-tot">{{ plural(loose.length, 'file') }} · {{ sizeLabel(counts.looseBytes) }}</span>
            <span class="ash-spacer"></span>
          </div>
          <ul class="ash-loose">
            <li v-for="item in loose" :key="item.id" class="ash-lrow">
              <span class="ash-lfn">
                <span class="ash-ft">{{ item.ext.replace('.', '') || 'file' }}</span>
                <a :href="`#${item.id}`" :title="item.id" @click.prevent="openFile(item)">{{ item.name }}</a>
              </span>
              <span class="ash-lsz">{{ sizeLabel(item.size) }}</span>
              <span class="ash-lage">{{ ageLabel(item.modifiedAt) }}</span>
            </li>
          </ul>
        </template>
      </template>
    </div>
  </div>
</template>
