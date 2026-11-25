<script setup>
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import StartFromShelf from '@/components/StartFromShelf.vue'
import SkillCopyDialog from '@/components/SkillCopyDialog.vue'
import PixelBackdrop from '@/components/PixelBackdrop.vue'
import VoxelMark from '@/components/VoxelMark.vue'
import { COLORS, heroColorFor } from '@/composables/entityMark'
import { readSkillEntry } from '@/composables/localBridge'
import { copyText } from '@/lib/clipboard'
import { entities, movePreferredSkill, togglePreferredSkill } from '@/stores/entities'
import { hub, toast } from '@/stores/hub'
import {
  attachSkill,
  detachSkill,
  loadLibrary,
  readWorkspaceSkill,
  workspaces,
} from '@/stores/workspaces'

/**
 * One skill page for two scopes. An attached skill is read from the workspace's
 * own `skills/` directory; a skill opened from the library is read through the
 * harness that carries it. `?harness=` selects the copy when several harnesses
 * hold the same name.
 *
 * The shell is the connector page's (`McpServerView`'s `.entp-*`): a bar with
 * the way back, a hero that says what this is and how to call it, then the two
 * or three things a skill actually has. Nothing here is a tab — a skill's body
 * is one prose file and a short file list, which is a disclosure, not a nav.
 */
const route = useRoute()
const router = useRouter()
const name = computed(() => String(route.params.name || ''))
const wantedHarness = computed(() => String(route.query.harness || ''))

const workspaceItem = computed(
  () => workspaces.skills.find((skill) => skill.name.toLowerCase() === name.value.toLowerCase()) || null,
)

const libraryItem = computed(() => {
  const target = name.value.toLowerCase()
  const items = workspaces.library?.items || []
  if (wantedHarness.value) {
    return (
      items.find(
        (item) => item.harness === wantedHarness.value && item.name.toLowerCase() === target,
      ) || null
    )
  }
  return items.find((item) => item.name.toLowerCase() === target) || null
})

const item = computed(() => workspaceItem.value || libraryItem.value)
const inWorkspace = computed(() => Boolean(workspaceItem.value))
const attached = computed(() =>
  workspaces.skills.some((skill) => skill.name.toLowerCase() === name.value.toLowerCase()),
)

const entry = ref(null)
const loading = ref(false)
const error = ref('')
const busy = ref(false)
const copying = ref(false)
const confirming = ref(false)
/* The entry file leads `files` (the reader sorts it first) and is the one body
   that opens by itself: it is the skill. */
const openFile = ref('')
let token = 0

const files = computed(() => entry.value?.files || [])

/* Every entity that names this skill in its own `prefer:` line — in the order
   the workspace lists them, because each row's number is that entity's own file
   order, and sorting by it would interleave twelve unrelated lines. */
const starters = computed(() =>
  hub.agents
    .map((a) => {
      const at = Array.isArray(a.prefer) ? a.prefer.indexOf(name.value) : -1
      return at < 0 ? null : { ...a, at }
    })
    .filter(Boolean),
)

/* The shelf rows: one per entity, the arrows following *that* entity's own
   `prefer:` line — an up arrow on the first name in the file is disabled even
   when nine other entities sit above it in this list. */
const starterRows = computed(() =>
  starters.value.map((a) => ({
    key: a.name,
    name: a.name,
    present: true,
    position: a.at + 1,
    meta: [a.harnessLabel, a.model].filter(Boolean).join(' · '),
    to: { name: 'entity', params: { workspace: hub.workspace, name: a.name } },
    up: a.at > 0,
    down: a.at < (Array.isArray(a.prefer) ? a.prefer.length : 0) - 1,
  })),
)

/* Everyone who does not name it, which is the half that makes this a bookmark
   and not a grant: they all still get the skill in their own `/` menu. */
const others = computed(() => {
  const named = new Set(starters.value.map((a) => a.name))
  return hub.agents.filter((a) => !named.has(a.name)).map((a) => ({ name: a.name }))
})

/* The same picker, seen from the other side: choose the entities that should
   name this skill first. It writes each entity's own `prefer:` line — there is
   no skill-side record, which is why the sheet is a per-entity write. */
const entityChoices = computed(() => {
  const target = name.value
  return hub.agents.map((a) => ({
    id: a.name,
    label: a.name,
    meta: a.harnessLabel,
    on: Array.isArray(a.prefer) && a.prefer.includes(target),
  }))
})

const preferBusy = ref('')
const preferError = ref(null)

/* A rejection is reported in the shelf, beside the card it left unchanged. The
   file is the entity's own, not this skill's — that is where the write went. */
async function writePrefer(entityName, fn) {
  if (!name.value) return
  preferError.value = null
  try {
    await fn()
  } catch (problem) {
    preferError.value = {
      file: `entities/${entityName}.md`,
      message: problem?.message || 'the bookmark could not be written to the file.',
    }
  } finally {
    preferBusy.value = ''
  }
}

function togglePrefer(entityName) {
  if (!name.value || preferBusy.value) return
  preferBusy.value = entityName
  return writePrefer(entityName, () => togglePreferredSkill(entityName, name.value))
}

function movePrefer(entityName, direction) {
  if (preferBusy.value) return
  const agent = hub.agents.find((a) => a.name === entityName)
  const list = Array.isArray(agent?.prefer) ? agent.prefer : []
  const from = list.indexOf(name.value)
  if (from < 0) return
  const to = direction === 'up' ? from - 1 : from + 1
  if (to < 0 || to >= list.length) return
  preferBusy.value = entityName
  return writePrefer(entityName, () => movePreferredSkill(entityName, from, to))
}

const version = computed(() => item.value?.version || '')
/* the composer's `/` menu uses the same grammar; a name with a space is not a
   callable reference, so the page does not advertise one */
const refCallable = computed(() => /^[A-Za-z0-9._-]+$/.test(item.value?.name || ''))
const callRoute = computed(
  () => `${inWorkspace.value ? 'workspace' : item.value?.harness || 'workspace'}:${item.value?.name || ''}`,
)
const callSign = computed(() => `/${callRoute.value}`)
const description = computed(() => item.value?.description || '')
/* The hero prints the description once, whole — the board measures 246px on it,
   which is three lines at `58ch`. An earlier cut printed only the first
   sentence; that measured 20px and left the hero 42px short on any skill whose
   description opens short. Nothing is duplicated: the section below splits the
   same text one sentence per paragraph, which is a different reading job. */
/* One paragraph per sentence, because the description is written as three and
   a single 409-character block is a wall. `.skp-prose + .skp-prose` already
   carries the 9px gap, so the list needs no wrapper. */
const sentences = computed(() => {
  const text = description.value.trim()
  if (!text) return []
  return text
    .split(/(?<=\.)\s+/)
    .map((line) => line.trim())
    .filter(Boolean)
})
const missing = computed(() => Boolean(item.value?.missing))
const heroColor = computed(() => heroColorFor(name.value))
/* `--mk-h` is the hue `brand.css` mixes the voxel's shade stops against; the
   hex carries the colour but not the angle, so it comes off the same ladder the
   hex was picked from — one name, one tone, on both variables. */
const heroHue = computed(() => COLORS.find((c) => c.hex === heroColor.value)?.h ?? 78)

/* One verb per state, and it is the same verb the roster's rows carry. */
const state = computed(() => {
  if (missing.value) {
    return {
      tone: 'bad',
      label: 'missing',
      note: '',
      why: 'The workspace skill is incomplete — its entry file is gone. Re-attach it from the harness library, or restore it from a backup.',
    }
  }
  if (!inWorkspace.value) {
    return {
      tone: 'mute',
      label: 'library copy',
      note: '',
      why: `${item.value?.harnessLabel || 'A harness'} keeps this copy on this machine. Attach it to copy the files into the workspace.`,
    }
  }
  const n = item.value?.files || 0
  return {
    tone: 'ok',
    label: 'attached',
    note: `${n} ${n === 1 ? 'file' : 'files'}`,
    why: '',
  }
})

const updated = computed(() => {
  if (!item.value?.updatedAt) return 'not recorded'
  const date = new Date(item.value.updatedAt)
  if (Number.isNaN(date.getTime())) return 'not recorded'
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
})

const share = computed(() =>
  hub.agents.length ? Math.round((starters.value.length / hub.agents.length) * 100) : 0,
)

async function load() {
  entry.value = null
  error.value = ''
  openFile.value = ''
  /* a workspace skill is read from `skills/`; only a library skill needs the
     machine-wide scan, which is why it is not paid for here */
  if (!inWorkspace.value && !workspaces.library) await loadLibrary()
  if (!item.value || missing.value) return

  const ticket = ++token
  loading.value = true
  try {
    const data = inWorkspace.value
      ? await readWorkspaceSkill(item.value.name)
      : await readSkillEntry(item.value.harness, item.value.name)
    if (ticket !== token) return
    entry.value = data
    openFile.value = data?.files?.[0]?.name || ''
  } catch (problem) {
    if (ticket !== token) return
    error.value = problem?.message || 'Could not read the skill directory.'
  } finally {
    if (ticket === token) loading.value = false
  }
}

watch([name, wantedHarness, () => workspaces.active], load, { immediate: true })

function back() {
  router.push({ name: 'skills', params: { workspace: hub.workspace } })
}

async function copyCall() {
  if (!refCallable.value) return
  if (await copyText(callSign.value)) toast(`${callSign.value} copied`)
  else toast('The invocation could not be copied.')
}

async function copyBody(name0) {
  const file = files.value.find((f) => f.name === name0)
  if (await copyText(file?.body || '')) toast(`${name0} copied`)
  else toast(`${name0} could not be copied.`)
}

async function detach() {
  if (busy.value || !workspaceItem.value) return
  busy.value = true
  try {
    await detachSkill(workspaceItem.value.name)
    router.push({ name: 'skills', params: { workspace: hub.workspace } })
  } catch (problem) {
    toast(problem?.message || 'Could not detach that skill')
  } finally {
    busy.value = false
    confirming.value = false
  }
}

async function attach() {
  if (busy.value || !libraryItem.value) return
  busy.value = true
  try {
    await attachSkill({ name: libraryItem.value.name, harness: libraryItem.value.harness })
    router.push({ name: 'skill', params: { workspace: hub.workspace, name: libraryItem.value.name } })
  } catch (problem) {
    toast(problem?.message || 'Could not attach that skill')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="view detail-view">
    <div class="entp-bar">
      <button class="back" type="button" @click="back">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7.5 2.5L4 6l3.5 3.5" /></svg>
        Skills
      </button>
      <span class="entp-crumb">{{ hub.workspaceLabel || hub.workspace }} · skill</span>
      <span class="spacer"></span>
      <div class="entp-actions">
        <button
          v-if="inWorkspace"
          class="btn btn-sm"
          type="button"
          :disabled="busy || missing"
          :title="missing ? 'A missing skill has no files to copy' : 'Copy this workspace\'s files into another workspace'"
          @click="copying = true"
        >
          Copy to workspace…
        </button>
        <button
          v-else-if="item"
          class="btn btn-sm btn-ink"
          type="button"
          :disabled="busy || attached"
          @click="attach"
        >
          {{ attached ? 'Already attached' : busy ? 'Attaching…' : 'Attach to workspace' }}
        </button>
      </div>
    </div>

    <template v-if="item">
      <section class="entp-hero" :style="{ '--hero': heroColor }">
        <PixelBackdrop variant="hero" :color="heroColor" :count="18" />
        <div class="entp-hero-inner">
          <header class="entp-idhead">
            <div
              class="cxn-hero-mark"
              :style="{ '--mk': heroColor, '--mk-h': heroHue }"
              aria-hidden="true"
            >
              <VoxelMark shape="blade" />
            </div>
            <div class="entp-title">
              <p class="eyebrow">
                Skill <span class="sep">·</span>
                {{ inWorkspace ? hub.workspaceLabel || hub.workspace : `library · ${item.harnessLabel}` }}
              </p>
              <h1>{{ item.name }}</h1>
              <p class="entp-desc" :title="description || null">
                {{
                  description ||
                  (missing
                    ? 'This link points at a directory that no longer exists. Re-attach it from the library.'
                    : 'This skill’s frontmatter carries no description.')
                }}
              </p>
              <div class="mcpp-cmd-row">
                <code v-if="refCallable" class="mcpp-cmd" :title="callSign">{{ callSign }}</code>
                <code v-else class="mcpp-cmd" title="A name with a space is not a slash reference">no slash form</code>
                <button
                  class="mcpp-cmd-copy"
                  type="button"
                  data-primary="1"
                  :disabled="!refCallable"
                  :title="refCallable ? 'Copy the invocation' : 'A name with a space has no slash form to copy'"
                  @click="copyCall"
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                    <rect x="3.4" y="3.4" width="9.2" height="10.2" rx="1.6" />
                    <path d="M6 3.4V2.6h4v.8M5.8 7.2h4.4M5.8 9.8h3.2" />
                  </svg>
                  <span>copy</span>
                </button>
              </div>
              <div class="entp-chips">
                <span class="mcpp-chip" :data-tone="state.tone" :title="state.why || state.label">
                  <i aria-hidden="true"></i>{{ state.label
                  }}<span v-if="state.note" class="mcpp-chip-note">{{ state.note }}</span>
                </span>
                <span class="entp-chip">{{ inWorkspace ? 'workspace' : 'this machine' }}</span>
                <span v-if="inWorkspace" class="entp-chip">every entity</span>
                <span v-if="inWorkspace" class="entp-chip">
                  {{ starters.length }} of {{ hub.agents.length }} start from it
                </span>
              </div>
            </div>
          </header>

          <!-- The entity page's panel, one question over: this skill is not a
               grant, so the bar measures who reaches for it first, not who may
               use it. The library copy has no workspace membership at all, so it
               says `—` instead of drawing a 0 that reads like a real answer. -->
          <aside
            class="entp-xp"
            :aria-label="
              inWorkspace
                ? `${hub.agents.length} entities in this workspace, ${starters.length} start from this skill, ${others.length} reach it from their / menu`
                : 'A library copy belongs to no workspace, so no entity starts from it here'
            "
          >
            <div class="entp-lv">
              <span>CREW</span>
              <b>{{ inWorkspace ? hub.agents.length : '—' }}</b>
            </div>
            <div class="entp-xp-main">
              <div class="entp-xp-head">
                <span>start from it</span>
                <b>{{ inWorkspace ? starters.length : '—' }}</b>
              </div>
              <div class="entp-xp-track">
                <i :style="{ width: inWorkspace ? `${share}%` : '0%' }"></i>
              </div>
              <div class="entp-xp-foot">
                <span>everyone else</span>
                <span>{{ inWorkspace ? others.length : '—' }}</span>
              </div>
            </div>
          </aside>
        </div>
      </section>

      <div class="entp-grid">
        <div class="entp-main">
          <section class="entp-sec">
            <div class="entp-sec-head">
              <h2>What it does</h2>
              <span class="n">01</span>
              <span class="entp-path">from SKILL.md</span>
            </div>
            <p v-for="(line, i) in sentences" :key="i" class="skp-prose">{{ line }}</p>
            <!-- Only the description belongs here. What the old page also said
                 in this column — where the copy lives, whether a backup carries
                 it, the path it was read from — is already in the rail's facts
                 and in the one verb above them, and repeating it turned a
                 76px section into a 168px one that read like a second abstract.
                 A skill with no frontmatter description is the one case the
                 file list cannot speak for, so it keeps a line. -->
            <p v-if="!sentences.length" class="skp-prose">
              No description in the skill frontmatter. Open the entry file below for the full
              instructions.
            </p>
          </section>

          <section class="entp-sec">
            <div class="entp-sec-head">
              <h2>{{ files.length === 1 ? 'Entry file' : 'Files' }}</h2>
              <span class="n">02</span>
              <span v-if="!missing" class="entp-path">
                {{ item.entry || 'no entry file' }} · {{ item.size }}
              </span>
              <!-- One copy verb for the open file, in the section head where the
                   shared grammar puts a section action (`.entp-sec-head .r`). A
                   per-file button inside each disclosure cost a 33px strip on
                   every row, and the summary already has one job: toggle. -->
              <button
                v-if="!missing && openFile"
                class="r"
                type="button"
                :title="`Copy ${openFile} to the clipboard`"
                @click="copyBody(openFile)"
              >
                Copy {{ openFile }}
              </button>
            </div>

            <p v-if="loading" class="skp-skel" aria-live="polite">
              <span class="skp-skel-row"></span>
              <span class="skp-skel-row"></span>
              <span class="skp-skel-row"></span>
              <span class="skp-skel-note">Reading {{ item.entry || 'the directory' }}…</span>
            </p>

            <div v-else-if="error" class="empty-note err" role="alert">
              <b>The skill directory could not be read.</b>
              <span class="mono">{{ error }}</span>
              <span class="mono">{{ item.path }}</span>
              <div class="empty-actions">
                <button class="btn btn-sm" type="button" @click="load">Try again</button>
              </div>
            </div>

            <div v-else-if="missing" class="empty-note">
              <b>There is no entry file to show.</b>
              <span>The directory is gone, so nothing was read. Re-attach the skill to get a copy back.</span>
              <div class="empty-actions">
                <router-link class="btn btn-sm" :to="{ name: 'skills', params: { workspace: hub.workspace } }">
                  Back to skills
                </router-link>
              </div>
            </div>

            <template v-else>
              <details
                v-for="f in files"
                :key="f.name"
                class="skf"
                :open="f.name === openFile"
                @toggle="$event.target.open && (openFile = f.name)"
              >
                <summary class="entp-thr">
                  <span class="entp-tm">{{ f.name.includes('.') ? f.name.split('.').pop() : 'txt' }}</span>
                  <span class="entp-thrbody">
                    <b>{{ f.name }}</b>
                    <span>{{ f.size }}<template v-if="f.name === item.entry"> · the skill itself</template></span>
                  </span>
                  <span class="entp-go">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                      <path d="M6 3.5L10.5 8 6 12.5" />
                    </svg>
                  </span>
                </summary>
                <pre class="codebox">{{ f.body || 'No text preview for this file.' }}</pre>
              </details>
            </template>
          </section>

          <!-- Read-only evidence, never a permission list: every entity in the
               workspace gets this skill. This only shows who names it as a
               starting point in their own file — the same shelf the entity page
               draws, seen from the other side. -->
          <StartFromShelf
            v-if="inWorkspace && !missing"
            head="Who starts from it"
            :count="`${starters.length} of ${hub.agents.length} ${hub.agents.length === 1 ? 'entity' : 'entities'}`"
            add-label="Add entity"
            add-head="Entities to start from this skill"
            kind="entity"
            :pick-options="entityChoices"
            :rows="starterRows"
            :loading="entities.loading"
            :rest="{ route: callRoute, items: others }"
            :busy="preferBusy"
            :error="preferError"
            empty-title="No entity starts from this one."
            empty-body="Every entity still gets it in their / menu — this only says who reaches for it first."
            @toggle="togglePrefer"
            @move="movePrefer"
            @remove="togglePrefer"
          />
        </div>

        <aside class="entp-rail">
          <p class="entp-rail-h">This skill</p>
          <dl class="entp-facts skp-facts">
            <div>
              <dt>Harness</dt>
              <dd>{{ item.missing ? '—' : item.harnessLabel }}</dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>{{ version || 'not recorded' }}</dd>
            </div>
            <div>
              <dt>Files</dt>
              <dd>{{ item.missing ? '—' : `${item.files} · ${item.size}` }}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>{{ updated }}</dd>
            </div>
            <div>
              <dt>Entry</dt>
              <dd class="mono">{{ item.entry || 'not recorded' }}</dd>
            </div>
            <div>
              <dt>License</dt>
              <dd>{{ item.license || 'not recorded' }}</dd>
            </div>
            <div>
              <dt>Requires</dt>
              <dd>{{ item.runtime || 'not recorded' }}</dd>
            </div>
            <div>
              <dt>Scope</dt>
              <dd>{{ inWorkspace ? 'this workspace' : 'this machine' }}</dd>
            </div>
            <div>
              <dt>Path</dt>
              <dd class="mono trunc" :title="item.path">{{ item.path }}</dd>
            </div>
          </dl>

          <template v-if="inWorkspace">
            <p class="entp-rail-h">Starters</p>
            <div class="mcpp-places">
              <div :data-off="starters.length ? null : '1'">
                <span class="dot" aria-hidden="true"></span>
                <span class="pn">
                  {{ starters.length }} of {{ hub.agents.length }}
                </span>
                <code class="pp" :title="starters.length ? starters.map((a) => a.name).join(', ') : `no entity names ${name} in its prefer: line`">
                  {{ starters.length ? starters.map((a) => a.name).join(', ') : 'no prefer: line names it' }}
                </code>
              </div>
            </div>
          </template>

          <p class="entp-rail-h">Manage</p>
          <div class="entp-rail-actions">
            <button
              v-if="inWorkspace"
              class="tall"
              type="button"
              :disabled="busy || missing"
              :title="missing ? 'A missing skill has no files to copy' : 'Copy these files into another workspace'"
              @click="copying = true"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                <rect x="2.6" y="2.6" width="8.8" height="8.8" rx="1.6" />
                <path d="M5.6 12.4a1.6 1.6 0 001.6 1h6.2V7.2a1.6 1.6 0 00-1.6-1.6" />
              </svg>
              <span class="row2">
                <span class="nm">Copy to workspace…</span>
                <i>into another workspace, files and frontmatter as they are</i>
              </span>
              <span class="hint">{{ item.files }} {{ item.files === 1 ? 'file' : 'files' }}</span>
            </button>
            <button
              v-else
              class="tall"
              type="button"
              :disabled="busy || attached"
              :title="
                attached
                  ? 'This workspace already has a skill of that name'
                  : 'Copy the harness library’s files into this workspace'
              "
              @click="attach"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                <path d="M8 2.8v5.6M5.6 6L8 8.4 10.4 6M3 11.2v1.6a1 1 0 001 1h8a1 1 0 001-1v-1.6" />
              </svg>
              <span class="row2">
                <span class="nm">{{ attached ? 'Already attached' : busy ? 'Attaching…' : 'Attach to workspace' }}</span>
                <i>{{ item.harnessLabel }}’s copy — for every entity in this workspace</i>
              </span>
              <span class="hint">{{ item.files }} {{ item.files === 1 ? 'file' : 'files' }}</span>
            </button>

            <template v-if="inWorkspace">
              <div class="sep" aria-hidden="true"></div>
              <button
                type="button"
                data-danger="1"
                :disabled="busy"
                :aria-label="
                  confirming
                    ? 'Click again to detach this skill from the workspace, for every entity'
                    : 'Detach this skill from the workspace, for every entity'
                "
                @click="confirming ? detach() : (confirming = true)"
                @blur="confirming = false"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                  <path d="M3.2 4.6h9.6M6.2 4.6V3.2h3.6v1.4M4.6 4.6l.6 8.4h5.6l.6-8.4" />
                </svg>
                <span class="nm">Detach</span>
                <span class="hint">{{ confirming ? 'click again' : 'click twice' }}</span>
              </button>
            </template>
          </div>
        </aside>
      </div>
    </template>

    <div v-else-if="!workspaces.library" class="empty-note">
      <b>Reading the harness libraries…</b>
    </div>

    <div v-else class="empty-note">
      <b>No skill called “{{ name }}” on this machine.</b>
      <span>It may live in a different harness library, or the workspace link may be stale.</span>
      <div class="empty-actions">
        <router-link class="btn btn-sm" :to="{ name: 'skills', params: { workspace: hub.workspace } }">
          Back to skills
        </router-link>
      </div>
    </div>

    <SkillCopyDialog
      v-if="copying && workspaceItem"
      :name="workspaceItem.name"
      :source="hub.workspace"
      @close="copying = false"
    />
  </div>
</template>
