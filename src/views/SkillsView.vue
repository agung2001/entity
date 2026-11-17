<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import SkillCopyDialog from '@/components/SkillCopyDialog.vue'
import { call } from '@/composables/localBridge'
import { isEditable } from '@/lib/dom'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import { hub, toast } from '@/stores/hub'
import {
  attachSkill,
  detachSkill,
  loadLibrary,
  workspaces,
} from '@/stores/workspaces'

const props = defineProps({
  /* Rendered inside Workspace → Skills; the parent owns the page head. */
  embedded: { type: Boolean, default: false },
})

/**
 * One page, two scopes — workspace first.
 *
 * `workspace` is intent: the skills this workspace owns (real copies). It is drawn
 * as a dense table, because a roster is an inventory and a card grid gives a
 * two-line description the height of a card.
 *
 * `harness libraries` is discovery: every skill each harness on this machine
 * already carries, read from `~/.pi`, `~/.claude`, `~/.codex`, … Scanning all of
 * them walks six directory trees, so it is paid for only when this tab is
 * opened, and the result is cached for the session.
 */
const tab = ref('workspace')
const harness = ref('all')
const busy = ref('')

/* roster state: the query, the directory read, and the row that is mid-action */
const query = ref('')
const searchEl = ref(null)
const loading = ref(!workspaces.loaded)
const loadError = ref('')
const confirming = ref('')
const copying = ref('')
const searchKey = shortcutLabel('inventory-search')

/* lazy: nothing is scanned until the library tab is actually shown, and a
   half-armed row is dropped when the scope changes under it */
watch(tab, (value) => {
  confirming.value = ''
  if (value === 'library' && !workspaces.library) loadLibrary()
})

const library = computed(() => workspaces.library)
const items = computed(() => workspaces.skills)

const attachedNames = computed(
  () => new Set(items.value.map((item) => item.name.toLowerCase())),
)

const filters = computed(() => [
  { id: 'all', label: 'All', count: library.value?.count || 0 },
  ...(library.value?.harnesses || [])
    .filter((entry) => entry.count > 0)
    .map((entry) => ({ id: entry.id, label: entry.label, count: entry.count })),
])

const visibleLibrary = computed(() => {
  const all = library.value?.items || []
  if (harness.value === 'all') return all
  return all.filter((item) => item.harness === harness.value)
})

const isAttached = (item) => attachedNames.value.has(item.name.toLowerCase())

const when = (iso) => {
  if (!iso) return 'unknown'
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return 'unknown'
  const days = Math.floor((Date.now() - then) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days}d ago`
}

function bytes(value) {
  const size = Number(value)
  if (!Number.isFinite(size) || size <= 0) return '0 B'
  if (size < 1024) return `${size} B`
  const kb = size / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  const mb = kb / 1024
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

const totalBytes = computed(() =>
  items.value.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0),
)

/**
 * Search over everything the row can show, not just the name: a person hunting a
 * skill often remembers what it does ("youTrack", "vault") rather than its folder.
 */
const rows = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return items.value
  return items.value.filter((item) =>
    [item.name, item.description, item.path, item.size]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(needle),
  )
})

const descriptionOf = (item) => {
  if (item.missing) {
    return 'Link target missing — its entry file is gone. Re-attach it from the harness library.'
  }
  return item.description || 'Attached skill. Its frontmatter has no description.'
}

/**
 * The roster reads its own directory.
 *
 * The workspace scope loader also fills `workspaces.skills`, but it swallows a
 * failed read: an unreadable `skills/` then reached this page as `0 skills`, which
 * looks exactly like a workspace nobody has attached anything to. One readdir is
 * cheap next to that lie, and it makes `Try again` mean something.
 */
async function refresh() {
  loadError.value = ''
  loading.value = !items.value.length
  try {
    workspaces.skills = await call('workspace.skills', { id: workspaces.active })
  } catch (problem) {
    loadError.value = problem?.message || 'The skill directory could not be read.'
  } finally {
    loading.value = false
  }
}

function focusSearch() {
  const field = searchEl.value
  if (!(field instanceof HTMLInputElement)) return
  field.focus()
  field.select()
}

/* A bare `/` focuses the search — but only when the caret is not already in a
   field, so typing a path or a command still types. */
function onKey(event) {
  if (!matchesShortcut('inventory-search', event)) return
  if (isEditable(event.target)) return
  event.preventDefault()
  focusSearch()
}

/** The copy sheet needs a skill and a workspace to read it from. */
function openCopy(item) {
  if (item.missing) return
  copying.value = item.name
}

/** Detach asks twice, in the row: the first click arms it, the second removes. */
async function detach(item) {
  const name = item.name
  if (busy.value) return
  if (confirming.value !== name) {
    confirming.value = name
    return
  }
  confirming.value = ''
  busy.value = `detach:${name}`
  try {
    /* the store re-reads the directory, so a query that no longer matches
       simply stops matching — no second read here */
    await detachSkill(name)
  } catch (problem) {
    toast(problem?.message || 'Could not detach that skill')
  } finally {
    busy.value = ''
  }
}

function cancelConfirm() {
  confirming.value = ''
}

async function attach(item) {
  const key = `${item.harness}:${item.name}`
  if (busy.value) return
  busy.value = key
  try {
    await attachSkill({ name: item.name, harness: item.harness })
  } catch (error) {
    toast(error?.message || 'Could not attach that skill')
  } finally {
    busy.value = ''
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  refresh()
})

onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div :class="props.embedded ? 'ws-embed' : 'view'">
    <div v-if="!props.embedded" class="page-head">
      <div>
        <p class="eyebrow">Skills · {{ hub.workspaceLabel || hub.workspace }}</p>
        <h1>Skills</h1>
        <p class="lede">
          The skills this workspace carries, and where they came from. A copy lives in
          the workspace, so a backup or another machine takes it along.
        </p>
      </div>
      <div class="head-actions">
        <button class="btn" type="button" @click="tab = 'library'">
          Attach from libraries
        </button>
      </div>
    </div>

    <div class="skbar">
      <label v-if="tab === 'workspace'" class="sksearch">
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="4.3" />
          <path d="M10.3 10.3L14 14" />
        </svg>
        <input
          ref="searchEl"
          v-model="query"
          type="search"
          placeholder="Search name, description or path…"
          aria-label="Search skills in this workspace"
          spellcheck="false"
        />
        <kbd class="sksearch-key" aria-hidden="true">{{ searchKey }}</kbd>
      </label>

      <div class="sk-tabs" role="tablist" aria-label="Skill scope">
        <button
          type="button"
          role="tab"
          :aria-selected="tab === 'workspace' ? 'true' : 'false'"
          @click="tab = 'workspace'"
        >
          Workspace <span class="n">{{ items.length }}</span>
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="tab === 'library' ? 'true' : 'false'"
          @click="tab = 'library'"
        >
          Harness libraries
          <span v-if="library && !library.error" class="n">{{ library.count }}</span>
        </button>
      </div>

      <span v-if="tab === 'workspace'" class="skbar-where">
        {{ rows.length }} of {{ items.length }}
        <template v-if="hub.agents.length"> · {{ hub.agents.length }} entities can call them</template>
      </span>
      <span v-else-if="library && !library.error" class="skbar-where">
        {{ visibleLibrary.length }} of {{ library.count }}
        <template v-if="library.hostname"> · {{ library.hostname }}</template>
      </span>
    </div>

    <template v-if="tab === 'workspace'">
      <div v-if="loading" class="skt" role="table" aria-busy="true" aria-label="Skills attached to this workspace">
        <div class="row head" role="row">
          <span role="columnheader">Skill</span>
          <span role="columnheader">Files</span>
          <span role="columnheader">Updated</span>
          <span class="acts-head" role="columnheader">Actions</span>
        </div>
        <div v-for="n in 3" :key="n" class="row" role="row" aria-hidden="true">
          <span class="sk" :style="{ width: `${64 - n * 6}%`, height: '11px' }"></span>
          <span class="sk" style="width: 60px; height: 10px"></span>
          <span class="sk" style="width: 46px; height: 10px"></span>
          <span class="sk" style="width: 76px; height: 26px; margin-left: auto"></span>
        </div>
      </div>

      <div v-else-if="loadError" class="empty-note err" role="alert">
        <b>Could not read {{ hub.workspacePath }}/skills.</b>
        <span>{{ loadError }}</span>
        <div class="empty-actions">
          <button class="btn btn-sm" type="button" @click="refresh">Try again</button>
        </div>
      </div>

      <div v-else-if="!items.length" class="empty-note">
        <b>No skills in this workspace yet.</b>
        <span>
          Attaching one from a harness library copies it into this workspace, so a
          backup takes it along.
        </span>
        <div class="empty-actions">
          <button class="btn btn-sm" type="button" @click="tab = 'library'">
            Open the harness libraries
          </button>
        </div>
      </div>

      <div v-else-if="!rows.length" class="empty-note">
        <b>No skill matches “{{ query.trim() }}”.</b>
        <span>
          {{ items.length }} {{ items.length === 1 ? 'skill is' : 'skills are' }} attached here.
          Search covers name, description, path and size.
        </span>
        <div class="empty-actions">
          <button class="btn btn-sm" type="button" @click="query = ''">Clear the search</button>
        </div>
      </div>

      <template v-else>
        <div class="skt" role="table" aria-label="Skills attached to this workspace">
          <div class="row head" role="row">
            <span role="columnheader">Skill</span>
            <span role="columnheader">Files</span>
            <span role="columnheader">Updated</span>
            <span class="acts-head" role="columnheader">Actions</span>
          </div>

          <div
            v-for="item in rows"
            :key="item.name"
            class="row"
            :class="{ miss: item.missing }"
            role="row"
          >
            <div class="what" role="cell">
              <router-link
                class="nm"
                :to="{ name: 'skill', params: { workspace: hub.workspace, name: item.name } }"
              >
                <HarnessIcon :name="item.harness" :size="12" />
                <span class="t">{{ item.name }}</span>
              </router-link>
              <p class="d" :title="item.description || ''">{{ descriptionOf(item) }}</p>
            </div>
            <span class="files" role="cell">
              {{ item.missing ? '—' : `${item.files || 0} · ${item.size || '—'}` }}
            </span>
            <span class="upd" role="cell">
              {{ item.missing ? '—' : when(item.updatedAt) }}
            </span>
            <div class="acts" role="cell">
              <button
                class="btn btn-sm"
                type="button"
                :disabled="Boolean(item.missing)"
                :title="
                  item.missing
                    ? 'A missing skill has no files to copy'
                    : `Copy ${item.name} into another workspace`
                "
                :aria-label="
                  item.missing
                    ? `Copy ${item.name} to another workspace — unavailable, the entry file is missing`
                    : `Copy ${item.name} to another workspace`
                "
                @click="openCopy(item)"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
                  <rect x="2.2" y="2.2" width="8.4" height="8.4" rx="1.6" />
                  <path d="M5.6 13.8h7.1a1 1 0 001-1V5.6" />
                </svg>
                Copy…
              </button>
              <button
                class="btn btn-sm btn-ghost btn-danger btn-icon"
                :class="{ confirming: confirming === item.name }"
                type="button"
                :disabled="busy === `detach:${item.name}`"
                :title="confirming === item.name ? 'Click again to remove it here' : 'Detach from workspace'"
                :aria-label="
                  confirming === item.name
                    ? `Confirm detaching ${item.name} from this workspace`
                    : `Detach ${item.name} from this workspace`
                "
                @click="detach(item)"
                @blur="cancelConfirm"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
                  <path d="M3.2 4.4h9.6M6.1 4.4V2.8h3.8v1.6M4.4 4.4l.6 8.8h6l.6-8.8" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        <p class="skfoot">
          <span class="mono">{{ hub.workspacePath }}/skills</span>
          <span>
            {{ items.length }} {{ items.length === 1 ? 'skill' : 'skills' }} ·
            {{ bytes(totalBytes) }} · harness libraries not scanned yet
          </span>
        </p>
      </template>
    </template>

    <template v-else>
      <div v-if="!library" class="empty-note">
        <b>Scanning the harness skill libraries…</b>
      </div>

      <div v-else-if="library.error" class="empty-note">
        <b>{{ library.error }}</b>
        <button class="btn btn-sm" type="button" @click="loadLibrary({ force: true })">
          Try again
        </button>
      </div>

      <template v-else>
        <div class="lib-bar">
          <div class="hints" aria-label="Filter by harness">
            <button
              v-for="f in filters"
              :key="f.id"
              class="hint"
              type="button"
              :aria-pressed="harness === f.id ? 'true' : 'false'"
              @click="harness = f.id"
            >
              <HarnessIcon :name="f.id" />
              {{ f.label }} <span class="hint-n">{{ f.count }}</span>
            </button>
          </div>
        </div>

        <div v-if="visibleLibrary.length" class="grid3">
          <div v-for="s in visibleLibrary" :key="s.id" class="card2">
            <div class="card-top">
              <h3><HarnessIcon :name="s.harness" :size="14" />{{ s.name }}</h3>
            </div>
            <p class="p">{{ s.path }}</p>
            <p v-if="s.description" class="desc">{{ s.description }}</p>
            <div class="foot">
              <span>
                {{ s.files }} {{ s.files === 1 ? 'file' : 'files' }} · {{ s.size }}
              </span>
              <span>{{ s.version || when(s.updatedAt) }}</span>
            </div>
            <div class="card-actions">
              <router-link
                class="btn btn-sm"
                :to="{ name: 'skill', params: { workspace: hub.workspace, name: s.name }, query: { harness: s.harness } }"
              >
                Open
              </router-link>
              <button
                v-if="!isAttached(s)"
                class="btn btn-sm"
                type="button"
                :disabled="busy === `${s.harness}:${s.name}`"
                @click="attach(s)"
              >
                {{ busy === `${s.harness}:${s.name}` ? 'Attaching…' : 'Attach' }}
              </button>
              <span v-else class="meta">attached to this workspace</span>
            </div>
          </div>
        </div>

        <div v-else class="empty-note">
          <b>No skills in this harness library.</b>
          <span v-if="harness !== 'all'">Switch to All, or add a skill directory for it.</span>
          <span v-else>No harness skill directories were found on this machine.</span>
        </div>
      </template>
    </template>

    <SkillCopyDialog
      v-if="copying"
      :name="copying"
      :source="hub.workspace"
      @close="copying = ''"
    />
  </div>
</template>
