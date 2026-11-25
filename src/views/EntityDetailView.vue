<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { matchesShortcut, shortcutLabel } from '@/lib/shortcuts'
import MarkPicker from '@/components/MarkPicker.vue'
import HarnessPaths from '@/components/HarnessPaths.vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import MachineIcon from '@/components/MachineIcon.vue'
import EntityCloneDialog from '@/components/EntityCloneDialog.vue'
import EntityActivity from '@/components/EntityActivity.vue'
import EntityLearnDialog from '@/components/EntityLearnDialog.vue'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import ModelInput from '@/components/ModelInput.vue'
import PickMenu from '@/components/PickMenu.vue'
import StartFromShelf from '@/components/StartFromShelf.vue'
import PixelBackdrop from '@/components/PixelBackdrop.vue'
import { useDialogDismiss } from '@/composables/useDialog'
import {
  agentById,
  ago,
  chatFocusEntity,
  ensureChats,
  harnessById,
  hub,
  machineById,
  toast,
} from '@/stores/hub'
import {
  entities,
  findEntity,
  loadEntities,
  movePreferredSkill,
  revealEntity,
  saveEntity,
  togglePreferredSkill,
} from '@/stores/entities'
import { colorById, markFor } from '@/composables/entityMark'
import { harnesses, loadHarnesses, loadModels, pickableHarnesses } from '@/stores/harnesses'

/**
 * The entity is a page, not a drawer. It is the same file the table lists —
 * opening it should feel like opening a document, with room for the skills,
 * the instructions and the working directory.
 */
const route = useRoute()
const router = useRouter()
const saving = ref(false)

const goEntities = () => router.push({ name: 'entities', params: { workspace: route.params.workspace } })

const form = reactive({ harness: '', model: '', instructions: '' })
const seeding = ref(false)
const configOpen = ref(false)
const configRoot = ref(null)
const cloneOpen = ref(false)

useDialogDismiss({ active: () => configOpen.value, close: () => (configOpen.value = false) })

const agent = computed(
  () => agentById(route.params.name) || hub.agents.find((item) => item.name === route.params.name),
)
const machineLabel = (id) => machineById(id)?.label || id
const lastChat = computed(() => {
  const thread = hub.chat.summaries.find((item) => item.entity === agent.value?.name)
  return thread ? ago(thread.updatedAt) : 'never'
})

const modelData = computed(() => harnesses.models[form.harness] || null)
/* Only what the harness itself reports; there is no built-in list to merge. */
const modelOptions = computed(() => [...new Set(modelData.value?.models || [])])
const modelLoading = computed(() => Boolean(modelData.value?.loading))
/* Only what this machine offers — plus the entity's own harness when that one is
   off, so an existing file still shows the value it carries instead of an empty
   field. Choosing it again is not offered; it is the current state, not a pick. */
const harnessOptions = computed(() => {
  const current = String(agent.value?.harness || '')
  return harnesses.items
    .filter((item) => pickableHarnesses.value.includes(item) || item.id === current)
    .map((item) => ({
      id: item.id,
      label: item.enabled ? item.label : `${item.label} · off`,
      meta: item.installed ? 'installed' : 'not found',
    }))
})
const instructionRows = computed(() =>
  Math.max(18, String(form.instructions || '').split('\n').length + 2),
)
const instructionLines = computed(() => String(form.instructions || '').split('\n').length)
const threads = computed(() =>
  hub.chat.summaries.filter((thread) => thread.entity === agent.value?.name),
)
const recentThreads = computed(() => threads.value.slice(0, 4))
const threadTurns = (thread) => (thread.queries || 0) + (thread.replies || 0)
const turnCount = computed(() =>
  threads.value.reduce((sum, thread) => sum + threadTurns(thread), 0),
)
const conversationCount = computed(() => threads.value.length)
/* Every conversation opens a chapter; every turn writes a line. */
const experience = computed(() => conversationCount.value * 20 + turnCount.value * 10)
const level = computed(() => Math.floor(experience.value / 100) + 1)
const levelXp = computed(() => experience.value % 100)
const levelLabel = computed(() => String(level.value).padStart(2, '0'))
const heroColor = computed(() => {
  if (!agent.value) return 'var(--accent)'
  const mark = markFor(route.params.workspace, agent.value.name, agent.value.mark || null)
  return colorById(mark.color, mark.custom).hex
})
const threadLink = (thread) => ({
  name: 'chat',
  params: { workspace: route.params.workspace },
  query: { thread: thread.id },
})
const statusState = computed(() =>
  agent.value?.status === 'running' ? 'live' : agent.value?.status === 'error' ? 'fail' : 'idle',
)
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/* The one sentence that kills the permission reading. The word `only` does the
   work; the empty state says the same thing in its own words. */
const noteLine = `Order only. Every workspace skill stays reachable in this entity's / menu — these just sit at the top of it.`

/* The entity's own bookmark order — file order, and the row number is the
   position the `/` menu gives it. A name the workspace does not have is a note,
   not a problem: `prefer:` is a bookmark, so a stale entry never makes the
   entity wrong, and it keeps its index. */
const preferred = computed(() =>
  (agent.value?.prefer || []).map((name) => {
    const skill = hub.skills.find((item) => item.name === name && !item.missing)
    return {
      key: name,
      name,
      present: Boolean(skill),
      /* the manifest the row links to already has both numbers */
      meta: skill ? [Number.isFinite(skill.files) ? plural(skill.files, 'file') : '', skill.size].filter(Boolean).join(' · ') : '',
      /* a gone name has no page to open: it is a note in the file, not a link */
      to: skill ? { name: 'skill', params: { workspace: route.params.workspace, name } } : null,
    }
  }),
)

/* What the picker offers: every callable skill the workspace actually has. A
   name the workspace cannot resolve would write a bookmark that does nothing, so
   it is not offered — the `/` menu uses the same grammar. */
const skillChoices = computed(() => {
  const chosen = new Set(agent.value?.prefer || [])
  return hub.skills
    .filter((skill) => !skill.missing && /^[A-Za-z0-9._-]+$/.test(skill.name))
    .map((skill) => ({
      id: skill.name,
      label: skill.name,
      meta: chosen.has(skill.name) ? 'in the / menu' : '',
      on: chosen.has(skill.name),
    }))
})

const preferBusy = ref('')
const preferError = ref(null)

/* Both the sheet and the shelf write the same `prefer:` line through the same
   store call. A rejection is reported in the shelf, next to the card it left
   unchanged — the file path is the thing a person can act on. */
async function writePrefer(fn) {
  if (!agent.value) return
  preferError.value = null
  try {
    await fn()
  } catch (error) {
    preferError.value = {
      file: agent.value.displayPath || `entities/${agent.value.name}.md`,
      message: error?.message || 'the bookmark could not be written to the file.',
    }
  } finally {
    preferBusy.value = ''
  }
}

function togglePrefer(name) {
  if (!agent.value || preferBusy.value) return
  preferBusy.value = name
  return writePrefer(() => togglePreferredSkill(agent.value.name, name))
}

function movePrefer(rowKey, direction) {
  if (!agent.value) return
  const from = (agent.value.prefer || []).indexOf(rowKey)
  const to = direction === 'up' ? from - 1 : from + 1
  if (from < 0 || to < 0 || to >= (agent.value.prefer || []).length) return
  preferBusy.value = rowKey
  return writePrefer(() => movePreferredSkill(agent.value.name, from, to))
}

/* ── config diff ──────────────────────────────────────────────────── */
const dirty = computed(
  () =>
    Boolean(agent.value) &&
    (form.harness !== agent.value.harness ||
      form.model !== (agent.value.model || '') ||
      form.instructions !== (agent.value.instructions || '')),
)

function seedForm() {
  if (!agent.value) return
  configOpen.value = false
  seeding.value = true
  form.harness = agent.value.harness || 'claude'
  form.model = agent.value.model || ''
  form.instructions = agent.value.instructions || ''
  loadModels(form.harness).catch(() => {})
  nextTick(() => {
    seeding.value = false
  })
}

watch(agent, seedForm, { immediate: true })

/* a model belongs to its harness; do not carry an incompatible name across */
watch(
  () => form.harness,
  (harness, previous) => {
    if (seeding.value || !previous || harness === previous) return
    const known = harnesses.models[harness]?.models || []
    if (form.model && !known.includes(form.model)) form.model = ''
    loadModels(harness).catch(() => {})
    loadHarnesses().catch(() => {})
  },
)

async function save() {
  if (!agent.value || saving.value) return
  const raw = findEntity(agent.value.name)
  if (!raw) {
    toast('That entity is no longer in the workspace.')
    return
  }
  saving.value = true
  try {
    const saved = await saveEntity({
      ...raw,
      harness: form.harness,
      model: form.model.trim(),
      instructions: form.instructions,
    })
    toast(`${saved.name} saved`)
  } catch (error) {
    toast(error?.message || 'The entity file could not be saved.')
  } finally {
    saving.value = false
  }
}

function toggleConfig() {
  configOpen.value = !configOpen.value
}

function onDocumentClick(event) {
  if (!configOpen.value || configRoot.value?.contains(event.target)) return
  if (event.target instanceof Element && event.target.closest('.entp-fact-btn')) return
  configOpen.value = false
}

const learnOpen = ref(false)

async function onLearned() {
  await loadEntities(hub.workspace)
  toast(`${agent.value?.name || 'Entity'} instructions updated`)
}

onMounted(() => {
  ensureChats()
  loadHarnesses().catch(() => {})
  loadModels(form.harness).catch(() => {})
  document.addEventListener('click', onDocumentClick)
})

onBeforeUnmount(() => document.removeEventListener('click', onDocumentClick))

const chatKey = shortcutLabel('entity-chat')

/* The entity-chat key is this page's, not the hub's: the capture listener takes
   it before the generic new-thread handler can open an empty dialog over it. */
function onEntityKey(event) {
  if (!matchesShortcut('entity-chat', event)) return
  if (!agent.value) return
  event.preventDefault()
  event.stopPropagation()
  chat()
}

onMounted(() => window.addEventListener('keydown', onEntityKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onEntityKey, true))

async function chat() {
  if (!agent.value) return
  try {
    await chatFocusEntity(agent.value.id)
    router.push({ name: 'chat', params: { workspace: route.params.workspace } })
  } catch (error) {
    toast(error?.message || `Could not open a thread for ${agent.value.name}`)
  }
}

async function reveal() {
  if (!agent.value) return
  try {
    await revealEntity(agent.value.name)
    toast(`Revealed ${agent.value.displayPath || `${agent.value.name}.md`}`)
  } catch (error) {
    toast(error?.message || 'Could not reveal the file')
  }
}

async function copyPath() {
  if (!agent.value) return
  const value = agent.value.displayPath || `${agent.value.name}.md`
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      toast('File path copied')
      return
    }
    toast(value)
  } catch {
    toast('The file path could not be copied.')
  }
}
</script>


<template>
  <div class="view detail-view">
    <template v-if="agent">
      <div class="entp-bar">
        <button class="back" type="button" @click="goEntities">
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7.5 2.5L4 6l3.5 3.5" /></svg>
          Entities
        </button>
        <span class="entp-crumb">{{ agent.name }}</span>
        <span class="spacer"></span>
        <div class="entp-actions">
          <button class="btn btn-ink" type="button" @click="chat">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
              <path d="M2.2 3.6h11.6v7.2H8l-3.2 2.4v-2.4H2.2z" />
            </svg>
            Chat
            <kbd class="btn-kbd">{{ chatKey }}</kbd>
          </button>
        </div>
      </div>

      <section class="entp-hero" :style="{ '--hero': heroColor }">
        <PixelBackdrop variant="hero" :color="heroColor" :count="18" />
        <div class="entp-hero-inner">
          <header class="entp-idhead">
            <MarkPicker :entity="agent.name" class="entp-picker" />
            <div class="entp-title">
              <p class="eyebrow">Entity · {{ hub.workspaceLabel || hub.workspace }}</p>
              <h1>{{ agent.name }}</h1>
              <p class="entp-desc">{{ agent.desc }}</p>
              <div class="entp-chips">
                <span class="state" :data-s="statusState"><i></i>{{ agent.status }}</span>
                <span class="entp-chip" data-kind="harness"><HarnessIcon :name="agent.harness" :size="10" />{{ agent.harnessLabel }}</span>
                <span class="entp-chip">{{ agent.model || 'harness default' }}</span>
                <span class="entp-chip">
                  all {{ hub.skills.length }} {{ hub.skills.length === 1 ? 'workspace skill' : 'workspace skills' }}
                </span>
              </div>
            </div>
          </header>

          <aside
            class="entp-xp"
            title="Every conversation and every turn earns experience."
            :aria-label="`Level ${level}, ${levelXp} of 100 experience. ${conversationCount} conversations and ${turnCount} turns.`"
          >
            <div class="entp-lv">
              <span>LV</span>
              <b>{{ levelLabel }}</b>
            </div>
            <div class="entp-xp-main">
              <div class="entp-xp-head">
                <span>Experience</span>
                <b>{{ levelXp }} / 100 XP</b>
              </div>
              <div
                class="entp-xp-track"
                role="progressbar"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-valuenow="levelXp"
                :aria-valuetext="`${levelXp} of 100 XP to level ${level + 1}`"
              >
                <i :style="{ width: `${levelXp}%` }"></i>
              </div>
              <div class="entp-xp-foot">
                <span>{{ conversationCount }} {{ conversationCount === 1 ? 'conversation' : 'conversations' }}</span>
                <span>{{ turnCount }} {{ turnCount === 1 ? 'turn' : 'turns' }}</span>
              </div>
            </div>
          </aside>
        </div>
      </section>

      <EntityActivity v-if="agent" :entity="agent.name" />

      <div class="entp-grid">
        <div class="entp-main">
          <div v-if="agent.problems.length" class="entp-problems">
            <div v-for="problem in agent.problems" :key="problem" class="entp-problem">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 2.4l6 11H2z" /><path d="M8 6.6v3.1M8 11.6v.1" /></svg>
              {{ problem }}
            </div>
          </div>

          <section class="entp-sec">
            <div class="entp-sec-head">
              <h2>Conversations</h2>
              <span class="n">{{ threads.length }} {{ threads.length === 1 ? 'thread' : 'threads' }}</span>
              <div class="entp-sec-actions">
                <button class="btn btn-sm" type="button" @click="learnOpen = true">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                    <path d="M8 1.8l1.5 3.9 3.9 1.5-3.9 1.5L8 12.6 6.5 8.7 2.6 7.2l3.9-1.5z" />
                    <path d="M12.6 11.4l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6z" />
                  </svg>
                  Learning
                </button>
                <button class="btn btn-sm" type="button" @click="chat">
                  Open chat
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                    <path d="M3.4 8h9M8.6 4.2L12.6 8l-4 3.8" />
                  </svg>
                </button>
              </div>
            </div>
            <router-link v-for="t in recentThreads" :key="t.id" class="entp-thr" :to="threadLink(t)">
              <span class="entp-tm">{{ ago(t.updatedAt) }}</span>
              <span class="entp-thrbody">
                <b>{{ t.title || t.preview || 'No question asked yet' }}</b>
                <span>
                  <MachineIcon :size="9" /> {{ machineLabel(t.machine) }}
                  <span aria-hidden="true">·</span>
                  <HarnessIcon :name="t.harness" :size="9" /> {{ harnessById(t.harness).label }}
                  <span aria-hidden="true">·</span>
                  {{ threadTurns(t) }} {{ threadTurns(t) === 1 ? 'turn' : 'turns' }}
                </span>
              </span>
              <svg class="entp-go" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 2l4 4-4 4" /></svg>
            </router-link>
            <div v-if="!recentThreads.length" class="entp-thr-empty">
              <b>No conversations yet.</b>
              <p>Nothing has been asked of {{ agent.name }} on this machine.</p>
              <button class="btn btn-sm" type="button" @click="chat">Start a thread →</button>
            </div>
          </section>

          <section class="entp-sec">
            <div class="entp-sec-head">
              <h2>Instructions</h2>
              <span class="n">{{ instructionLines }} lines</span>
              <span class="entp-path mono" :title="agent.displayPath">{{ agent.displayPath }}</span>
            </div>
            <MarkdownEditor
              v-model="form.instructions"
              :rows="instructionRows"
              :disabled="saving"
              placeholder="Write the entity instructions in Markdown…"
            />
            <div class="entp-savebar">
              <span v-if="dirty" class="entp-dirty"><i></i> Unsaved changes</span>
              <span v-else class="entp-saved">Markdown — the whole file the harness reads.</span>
              <span class="r">
                <button class="btn btn-ink btn-sm" type="button" :disabled="saving || !dirty" @click="save">
                  {{ saving ? 'Saving…' : 'Save entity' }}
                </button>
              </span>
            </div>
          </section>

          <section class="entp-sec">
            <StartFromShelf
              head="Starts from"
              :count="`${preferred.length} of ${plural(hub.skills.length, 'skill')}`"
              add-label="Add skill"
              add-head="Skills to start from"
              kind="skill"
              :pick-options="skillChoices"
              :rows="preferred"
              :loading="entities.loading"
              :disabled="saving"
              :busy="preferBusy"
              :error="preferError"
              :note="preferred.length ? noteLine : ''"
              empty-title="No starting point yet."
              :empty-body="`The / menu lists every workspace skill in its default order.`"
              @toggle="togglePrefer"
              @move="movePrefer"
              @remove="togglePrefer"
            />
          </section>
        </div>

        <aside class="entp-rail">
          <p class="entp-rail-h">This entity</p>
          <dl class="entp-facts">
            <div>
              <dt>Harness</dt>
              <dd>
                <button
                  class="entp-fact-btn"
                  type="button"
                  :aria-expanded="configOpen ? 'true' : 'false'"
                  title="Change the default harness"
                  @click.stop="toggleConfig"
                >
                  {{ agent.harnessLabel }}
                  <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2 4l3 3 3-3" /></svg>
                </button>
              </dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd class="mono">
                <button
                  class="entp-fact-btn"
                  type="button"
                  :aria-expanded="configOpen ? 'true' : 'false'"
                  title="Change the default model"
                  @click.stop="toggleConfig"
                >
                  {{ agent.model || 'default' }}
                  <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2 4l3 3 3-3" /></svg>
                </button>
              </dd>
            </div>
            <div><dt>Machines</dt><dd>{{ agent.machines.length ? agent.machines.map(machineLabel).join(', ') : 'nowhere' }}</dd></div>
            <div><dt>Directory</dt><dd class="mono" :title="agent.dir">{{ agent.dir || 'not set' }}</dd></div>
            <div><dt>File</dt><dd class="mono" :title="agent.displayPath">{{ agent.displayPath }}</dd></div>
            <div><dt>Last chat</dt><dd>{{ lastChat }}</dd></div>
          </dl>

          <Teleport to="body">
            <div
              v-if="configOpen"
              class="scrim"
              data-open="1"
              aria-hidden="true"
              @click="configOpen = false"
            ></div>
            <div
              v-if="configOpen"
              ref="configRoot"
              class="modal entp-config-modal"
              data-open="1"
              role="dialog"
              aria-modal="true"
              aria-labelledby="entp-config-title"
              @click.stop
            >
              <div class="mo-head">
                <h2 id="entp-config-title">Configuration</h2>
                <p>Default harness and model for this entity, plus the machine-wide executable that runs it.</p>
                <button class="x mo-x" type="button" aria-label="Close configuration" @click="configOpen = false">
                  <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5"><path d="M2 2l8 8M10 2l-8 8" /></svg>
                </button>
              </div>
              <div class="mo-body entp-config-body">
                <div class="fld">
                  <span class="lbl">Default harness</span>
                  <PickMenu
                    class="field-select"
                    head="Default harness"
                    icons="harness"
                    :options="harnessOptions"
                    :model-value="form.harness"
                    :disabled="saving"
                    @update:model-value="form.harness = $event"
                  />
                </div>
                <div class="fld">
                  <span class="lbl">Default model</span>
                  <ModelInput
                    :model-value="form.model"
                    :options="modelOptions"
                    :loading="modelLoading"
                    :disabled="saving"
                    label="Default model"
                    :placeholder="modelData?.default || 'harness default'"
                    @update:model-value="form.model = $event"
                  />
                </div>
                <HarnessPaths :active="form.harness" />
              </div>
              <div class="mo-foot entp-config-foot">
                <span v-if="dirty" class="entp-dirty"><i></i> Unsaved changes</span>
                <span v-else class="entp-saved">Saved with the entity file.</span>
                <button class="btn btn-ink btn-sm" type="button" :disabled="saving || !dirty" @click="save">
                  {{ saving ? 'Saving…' : 'Save entity' }}
                </button>
              </div>
            </div>
          </Teleport>
          <div class="entp-rail-actions">
            <button type="button" @click="cloneOpen = true">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                <rect x="5.4" y="5.4" width="7.6" height="7.6" rx="1.4" />
                <path d="M10.6 5.4V4.4A1.4 1.4 0 009.2 3H4.4A1.4 1.4 0 003 4.4v4.8A1.4 1.4 0 004.4 10.6h1" />
              </svg>
              <span class="nm">Clone to…</span>
            </button>
            <button type="button" @click="copyPath">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                <rect x="3.4" y="3.4" width="9.2" height="10.2" rx="1.6" />
                <path d="M6 3.4V2.6h4v.8M5.8 7.2h4.4M5.8 9.8h3.2" />
              </svg>
              <span class="nm">Copy path</span>
            </button>
            <button type="button" @click="reveal">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                <path d="M1.8 4.2h4l1.4 1.6h7v6.6H1.8z" />
                <path d="M1.8 5.8v-2h4" />
              </svg>
              <span class="nm">Reveal file</span>
            </button>
            <button type="button" @click="chat">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                <path d="M2.2 3.6h11.6v7.2H8l-3.2 2.4v-2.4H2.2z" />
              </svg>
              <span class="nm">Open chat</span>
              <span class="hint">↵</span>
            </button>
          </div>
        </aside>
      </div>

      <EntityLearnDialog
        :open="learnOpen"
        :entity="agent ? agent.name : ''"
        :threads="threads"
        @close="learnOpen = false"
        @applied="onLearned"
      />

      <EntityCloneDialog
        v-if="cloneOpen && agent"
        :entity="agent"
        :workspace="route.params.workspace"
        @close="cloneOpen = false"
        @cloned="cloneOpen = false"
      />
    </template>

    <div v-else class="empty-note">
      <b>That entity is not in this workspace.</b>
      <span>It may have been renamed or deleted on disk.</span>
      <button class="empty-link" type="button" @click="goEntities">Back to entities</button>
    </div>
  </div>
</template>
