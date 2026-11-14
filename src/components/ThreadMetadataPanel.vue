<script setup>
import { computed, ref, watch } from 'vue'
import { call, hasDesktopBridge } from '@/composables/localBridge'
import { matchesQuery } from '@/composables/search'
import { useDialogDismiss } from '@/composables/useDialog'
import { playSfx } from '@/lib/sfx'
import { toast } from '@/stores/hub'

/**
 * The thread metadata drawer.
 *
 * A conversation leaves more behind than its prose: the YouTrack issue the
 * entity was asked about, the PR it opened, the files it read and the folder it
 * worked in. Those are in the transcript — scattered across answers, tool calls
 * and their output — which makes them hard to find once the thread is long.
 *
 * This panel is a second view of the same transcript: links and paths, newest
 * first, each one actionable. It is derived on demand by the main process
 * (`thread.metadata`), so nothing here is a second store that can disagree with
 * the chat. Paths are only listed when they exist, and `thread.pathAction`
 * re-derives the list before touching the filesystem: a row can only open what
 * the thread mentioned.
 *
 * Default closed; the chat header's panel button toggles it, `Esc` closes it,
 * and the shortcut lives in `src/lib/shortcuts.js`.
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  workspace: { type: String, default: '' },
  threadId: { type: String, default: '' },
  machine: { type: String, default: 'local' },
  /** changes when the transcript grows; the panel refreshes while open */
  revision: { type: String, default: '' },
})

const emit = defineEmits(['close'])

const data = ref(null)
const loading = ref(false)
const error = ref('')
const query = ref('')
const expanded = ref('')
const busy = ref('')
let request = 0
let refreshTimer = null

function close() {
  expanded.value = ''
  emit('close')
}

/* The drawer itself is one surface; an expanded path's action row is another,
   so Escape folds the row before it closes the panel. */
useDialogDismiss({ active: () => props.open, close })
useDialogDismiss({
  active: () => Boolean(expanded.value),
  close: () => {
    expanded.value = ''
  },
})

const remote = computed(() => Boolean(data.value?.remote) || props.machine !== 'local')
const isMac = computed(() => /Mac|iPhone|iPad/.test(navigator.platform || ''))
const isWindows = computed(() => /Win/.test(navigator.platform || ''))
const fileManager = computed(() =>
  isMac.value ? 'Finder' : isWindows.value ? 'File Explorer' : 'File manager',
)

const links = computed(() => {
  const rows = data.value?.links || []
  return rows.filter((item) => matchesQuery(`${item.label} ${item.url} ${item.host}`, query.value))
})

const paths = computed(() => {
  const rows = data.value?.paths || []
  return rows.filter((item) =>
    matchesQuery(`${item.name} ${item.dir} ${item.path} ${item.kind}`, query.value),
  )
})

const total = computed(
  () => (data.value?.counts?.links || 0) + (data.value?.counts?.paths || 0),
)

const nothing = computed(
  () => !loading.value && !error.value && !links.value.length && !paths.value.length,
)

const searching = computed(() => Boolean(query.value.trim()))

async function load({ quiet = false } = {}) {
  if (!props.threadId || !props.workspace) return
  const id = ++request
  if (!quiet) loading.value = true
  error.value = ''
  try {
    const result = await call('thread.metadata', {
      workspace: props.workspace,
      id: props.threadId,
    })
    if (id !== request) return
    data.value = result
  } catch (err) {
    if (id !== request) return
    error.value = err?.message || 'The metadata for this thread could not be read.'
    data.value = null
  } finally {
    if (id === request) loading.value = false
  }
}

async function refresh() {
  await load({ quiet: Boolean(data.value) })
}

function openLink(item) {
  call('link.open', { url: item.url })
    .then(() => playSfx('tap'))
    .catch((err) => {
      /* A static deploy has no main process; the browser is still a browser.
         In the desktop app the same failure is real, so report it. */
      if (hasDesktopBridge()) {
        playSfx('error')
        toast(err?.message || 'The link could not be opened.')
        return
      }
      window.open(item.url, '_blank', 'noopener,noreferrer')
      playSfx('tap')
    })
}

/* Modifier and middle clicks keep the browser's own new-tab behaviour; a plain
   click goes through the main process so the app never navigates itself. */
function onLinkClick(event, item) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  if (event.button !== 0) return
  event.preventDefault()
  openLink(item)
}

async function copy(value, label) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
    } else {
      throw new Error('no clipboard')
    }
  } catch {
    try {
      const area = document.createElement('textarea')
      area.value = value
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    } catch {
      toast('The clipboard is not available.')
      return
    }
  }
  playSfx('copy')
  toast(`${label} copied`)
}

function togglePath(item) {
  expanded.value = expanded.value === item.path ? '' : item.path
}

async function pathAction(item, action) {
  const key = `${item.path}:${action}`
  if (busy.value) return
  busy.value = key
  try {
    await call('thread.pathAction', {
      workspace: props.workspace,
      id: props.threadId,
      path: item.path,
      action,
    })
    playSfx('open')
    if (action === 'editor') toast('Opened in VS Code')
    else if (item.kind === 'directory') toast(`Opened in ${fileManager.value}`)
    else toast(`Revealed in ${fileManager.value}`)
  } catch (err) {
    playSfx('error')
    toast(err?.message || 'The path could not be opened.')
  } finally {
    busy.value = ''
  }
}

watch(
  () => [props.open, props.threadId, props.workspace],
  ([open], previous) => {
    const moved = previous && (previous[1] !== props.threadId || previous[2] !== props.workspace)
    if (moved) {
      expanded.value = ''
      query.value = ''
    }
    if (open) load()
  },
  { immediate: true },
)

/* A streaming turn adds links and paths; refresh behind the debounce so the
   panel follows the transcript without re-reading it on every token. */
watch(
  () => props.revision,
  () => {
    if (!props.open) return
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => load({ quiet: true }), 450)
  },
)

defineExpose({ refresh })
</script>

<template>
  <aside
    id="thread-metadata"
    class="tmeta"
    :data-open="open ? '1' : '0'"
    :aria-hidden="open ? 'false' : 'true'"
    :inert="open ? undefined : true"
    role="region"
    aria-label="Thread metadata"
  >
    <div class="tmeta-inner">
      <header class="tmeta-head">
        <svg class="tmeta-head-ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
          <rect x="2" y="2.6" width="12" height="10.8" rx="1.6" />
          <path d="M10.2 2.6v10.8" />
        </svg>
        <h2>Thread metadata</h2>
        <span v-if="data" class="tmeta-count" :title="`${total} item${total === 1 ? '' : 's'}`">{{ total }}</span>
        <button
          class="tmeta-x"
          type="button"
          title="Close thread metadata"
          aria-label="Close thread metadata"
          @click="close"
        >
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </header>

      <div class="tmeta-tools">
        <label class="tmeta-search">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <circle cx="7" cy="7" r="4.6" />
            <path d="M10.4 10.4L14 14" />
          </svg>
          <input
            v-model="query"
            type="search"
            autocomplete="off"
            spellcheck="false"
            placeholder="Search links and paths"
            aria-label="Search links and paths in this thread"
          />
        </label>
        <button
          class="tmeta-btn"
          type="button"
          :disabled="loading"
          title="Refresh metadata"
          aria-label="Refresh metadata"
          @click="refresh"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <path d="M13 8a5 5 0 11-1.7-3.8" />
            <path d="M13 2.4V5h-2.6" />
          </svg>
        </button>
      </div>

      <div class="tmeta-body" :aria-busy="loading ? 'true' : 'false'">
        <p v-if="remote" class="tmeta-remote">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <rect x="2" y="3" width="12" height="8" rx="1.4" />
            <path d="M5.4 13.4h5.2M8 11v2.4" />
          </svg>
          <span>Runs on <b>{{ data?.machine || machine }}</b> — paths are listed, open them there.</span>
        </p>

        <p v-if="loading && !data" class="tmeta-empty">Reading this thread…</p>

        <div v-else-if="error" class="tmeta-empty">
          <b>Metadata unavailable</b>
          <span>{{ error }}</span>
          <button class="tmeta-retry" type="button" @click="refresh">Try again</button>
        </div>

        <template v-else>
          <p v-if="nothing" class="tmeta-empty">
            <b>{{ searching ? 'No match' : 'Nothing yet' }}</b>
            <span v-if="searching">No link or path matches “{{ query }}”.</span>
            <span v-else>When the entity mentions a URL, a file or a folder, it shows up here.</span>
          </p>

          <section v-if="links.length" class="tmeta-group" aria-label="Links">
            <div class="tmeta-group-head">
              <h3>Links</h3>
              <span>{{ links.length }}</span>
            </div>
            <div v-for="item in links" :key="item.url" class="tmeta-row">
              <a
                class="tmeta-row-main"
                :href="item.url"
                target="_blank"
                rel="noreferrer noopener"
                :title="item.url"
                @click="onLinkClick($event, item)"
              >
                <span class="tmeta-ic" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
                    <path d="M6.4 9.6a2.8 2.8 0 004 0l2-2a2.8 2.8 0 00-4-4l-1 1" />
                    <path d="M9.6 6.4a2.8 2.8 0 00-4 0l-2 2a2.8 2.8 0 004 4l1-1" />
                  </svg>
                </span>
                <span class="tmeta-t">
                  <b>{{ item.label || item.url }}</b>
                  <span class="tmeta-m">
                    {{ item.host }}<template v-if="item.count > 1"> · {{ item.count }}×</template>
                  </span>
                </span>
              </a>
              <button
                class="tmeta-act"
                type="button"
                title="Copy link"
                :aria-label="`Copy ${item.url}`"
                @click="copy(item.url, 'Link')"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
                  <rect x="5.2" y="5.2" width="8" height="8" rx="1.5" />
                  <path d="M10.8 5.2V3.8a1.5 1.5 0 00-1.5-1.5H3.8a1.5 1.5 0 00-1.5 1.5v5.5a1.5 1.5 0 001.5 1.5h1.4" />
                </svg>
              </button>
            </div>
          </section>

          <section v-if="paths.length" class="tmeta-group" aria-label="Paths">
            <div class="tmeta-group-head">
              <h3>Paths</h3>
              <span>{{ paths.length }}</span>
            </div>
            <template v-for="item in paths" :key="item.path">
              <div class="tmeta-row tmeta-row--path" :data-open="expanded === item.path ? '1' : '0'">
                <button
                  class="tmeta-row-main"
                  type="button"
                  :title="item.path"
                  :aria-expanded="expanded === item.path ? 'true' : 'false'"
                  @click="togglePath(item)"
                >
                  <span class="tmeta-ic" aria-hidden="true">
                    <svg v-if="item.kind === 'directory'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
                      <path d="M1.8 4.4c0-.9.7-1.6 1.6-1.6h3l1.4 1.6h5.8c.9 0 1.6.7 1.6 1.6v5.6c0 .9-.7 1.6-1.6 1.6H3.4c-.9 0-1.6-.7-1.6-1.6z" />
                    </svg>
                    <svg v-else viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
                      <path d="M3.4 1.8h5.2l4 4v8.4H3.4z" />
                      <path d="M8.6 1.8v4h4" />
                    </svg>
                  </span>
                  <span class="tmeta-t">
                    <b>{{ item.name }}</b>
                    <span class="tmeta-m">{{ item.dir }}</span>
                  </span>
                  <span v-if="remote" class="tmeta-badge" data-tone="remote">remote</span>
                  <span v-else class="tmeta-badge">{{ item.kind === 'directory' ? 'folder' : 'file' }}</span>
                </button>
                <button
                  class="tmeta-act"
                  type="button"
                  title="Copy path"
                  :aria-label="`Copy ${item.path}`"
                  @click="copy(item.path, 'Path')"
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
                    <rect x="5.2" y="5.2" width="8" height="8" rx="1.5" />
                    <path d="M10.8 5.2V3.8a1.5 1.5 0 00-1.5-1.5H3.8a1.5 1.5 0 00-1.5 1.5v5.5a1.5 1.5 0 001.5 1.5h1.4" />
                  </svg>
                </button>
              </div>
              <div v-if="expanded === item.path" class="tmeta-actions">
                <template v-if="!remote">
                  <button
                    type="button"
                    :disabled="Boolean(busy)"
                    @click="pathAction(item, 'reveal')"
                  >
                    {{ busy === `${item.path}:reveal` ? 'Opening…' : item.kind === 'directory' ? `Open in ${fileManager}` : `Reveal in ${fileManager}` }}
                  </button>
                  <button
                    v-if="item.kind === 'file'"
                    type="button"
                    :disabled="Boolean(busy)"
                    @click="pathAction(item, 'editor')"
                  >
                    {{ busy === `${item.path}:editor` ? 'Opening…' : 'Open in VS Code' }}
                  </button>
                </template>
                <button type="button" @click="copy(item.path, 'Path')">Copy path</button>
                <p v-if="remote" class="tmeta-note">
                  This thread runs on {{ data?.machine || machine }}. Copy the path and open it there.
                </p>
              </div>
            </template>
          </section>

          <p v-if="data?.truncated" class="tmeta-note tmeta-note--foot">
            Showing the most recent {{ data.links.length + data.paths.length }} of {{ total }} items;
            the rest is older than the scan window.
          </p>
        </template>
      </div>

      <footer v-if="data && !error" class="tmeta-foot">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <circle cx="8" cy="8" r="6" />
          <path d="M8 7.2v4.2M8 4.9v.1" stroke-linecap="round" />
        </svg>
        <span>Derived from this thread's messages and tool calls.</span>
      </footer>
    </div>
  </aside>
</template>
