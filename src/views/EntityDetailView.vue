<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import MarkPicker from '@/components/MarkPicker.vue'
import HarnessPaths from '@/components/HarnessPaths.vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import MachineIcon from '@/components/MachineIcon.vue'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import ModelInput from '@/components/ModelInput.vue'
import PickMenu from '@/components/PickMenu.vue'
import { HARNESSES, MODELS } from '@/data/mock'
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
import { findEntity, revealEntity, saveEntity } from '@/stores/entities'
import { harnesses, loadHarnesses, loadModels } from '@/stores/harnesses'

/**
 * The entity is a page, not a drawer. It is the same file the table lists —
 * opening it should feel like opening a document, with room for the skills,
 * the instructions and the working directory.
 */
const route = useRoute()
const router = useRouter()
const saving = ref(false)

async function goEntities() {
  await router.push({ name: 'overview', params: { workspace: route.params.workspace } })
  hub.rail.entities = true
}

const form = reactive({ harness: '', model: '', instructions: '' })
const seeding = ref(false)
const configOpen = ref(false)
const configRoot = ref(null)

const agent = computed(
  () => agentById(route.params.name) || hub.agents.find((item) => item.name === route.params.name),
)
const machineLabel = (id) => machineById(id)?.label || id
const lastChat = computed(() => {
  const thread = hub.chat.summaries.find((item) => item.entity === agent.value?.name)
  return thread ? ago(thread.updatedAt) : 'never'
})

const modelData = computed(() => harnesses.models[form.harness] || null)
const modelOptions = computed(() => [
  ...new Set([...(modelData.value?.models || []), ...(MODELS[form.harness] || [])]),
])
const modelLoading = computed(() => Boolean(modelData.value?.loading))
const harnessOptions = computed(() =>
  HARNESSES.map((item) => {
    const found = harnesses.items.find((entry) => entry.id === item.id)
    return {
      id: item.id,
      label: item.label,
      meta: found ? (found.installed ? 'installed' : 'not found') : '',
    }
  }),
)
const instructionRows = computed(() =>
  Math.max(18, String(form.instructions || '').split('\n').length + 2),
)
const instructionLines = computed(() => String(form.instructions || '').split('\n').length)
const threads = computed(() =>
  hub.chat.summaries.filter((thread) => thread.entity === agent.value?.name),
)
const recentThreads = computed(() => threads.value.slice(0, 4))
const threadTurns = (thread) => (thread.queries || 0) + (thread.replies || 0)
const threadLink = (thread) => ({
  name: 'chat',
  params: { workspace: route.params.workspace },
  query: { thread: thread.id },
})
const statusState = computed(() =>
  agent.value?.status === 'running' ? 'live' : agent.value?.status === 'error' ? 'fail' : 'idle',
)
const declaredSkills = computed(() =>
  (agent.value?.skills || []).map((name) => ({
    name,
    present: hub.skills.some((skill) => skill.name === name && !skill.missing),
  })),
)
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
    const known = [
      ...(harnesses.models[harness]?.models || []),
      ...(MODELS[harness] || []),
    ]
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

onMounted(() => {
  ensureChats()
  loadHarnesses().catch(() => {})
  loadModels(form.harness).catch(() => {})
  document.addEventListener('click', onDocumentClick)
})

onBeforeUnmount(() => document.removeEventListener('click', onDocumentClick))

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
  <div class="view entp-view">
    <template v-if="agent">
      <div class="entp-bar">
        <button class="back" type="button" @click="goEntities">
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7.5 2.5L4 6l3.5 3.5" /></svg>
          Entities
        </button>
        <span class="entp-crumb">{{ agent.name }}</span>
        <span class="spacer"></span>
        <div class="entp-actions">
          <button class="btn btn-sm" type="button" @click="copyPath">Copy path</button>
          <button class="btn btn-sm" type="button" @click="reveal">Reveal file</button>
          <button class="btn btn-ink" type="button" @click="chat">Chat</button>
        </div>
      </div>

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
            <span class="entp-chip">{{ agent.skills.length }} {{ agent.skills.length === 1 ? 'skill' : 'skills' }}</span>
          </div>
        </div>
      </header>

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
              <button class="r" type="button" @click="chat">Open chat →</button>
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
            <div class="entp-sec-head">
              <h2>Skills</h2>
              <span class="n">{{ declaredSkills.length }} declared · {{ hub.skills.length }} in this workspace</span>
            </div>
            <div class="entp-skills">
              <router-link
                v-for="skill in declaredSkills"
                :key="skill.name"
                class="entp-skchip"
                :data-missing="skill.present ? '0' : '1'"
                :to="{ name: 'skill', params: { workspace: route.params.workspace, name: skill.name } }"
              >
                <i></i>{{ skill.name }}<template v-if="!skill.present"> · link missing</template>
              </router-link>
              <span v-if="!declaredSkills.length" class="entp-skchip"><i></i>none declared</span>
            </div>
            <p class="entp-note">
              {{ agent.mcp.length ? `MCP: ${agent.mcp.join(', ')}` : 'No MCP servers on this entity.' }}
            </p>
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
            <div><dt>MCP</dt><dd>{{ agent.mcp.length ? agent.mcp.join(', ') : 'none' }}</dd></div>
            <div><dt>File</dt><dd class="mono" :title="agent.displayPath">{{ agent.displayPath }}</dd></div>
            <div><dt>Last chat</dt><dd>{{ lastChat }}</dd></div>
          </dl>

          <div v-if="configOpen" ref="configRoot" class="entp-config-pop" @click.stop>
            <div class="entp-config-head">
              <h3>Configuration</h3>
              <button class="x" type="button" aria-label="Close configuration" @click="configOpen = false">
                <svg width="11" height="11" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5"><path d="M2 2l8 8M10 2l-8 8" /></svg>
              </button>
            </div>
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
            <div class="entp-config-foot">
              <span v-if="dirty" class="entp-dirty"><i></i> Unsaved changes</span>
              <span v-else class="entp-saved">Saved with the entity file.</span>
              <button class="btn btn-ink btn-sm" type="button" :disabled="saving || !dirty" @click="save">
                {{ saving ? 'Saving…' : 'Save entity' }}
              </button>
            </div>
          </div>
          <div class="entp-rail-actions">
            <button type="button" @click="copyPath">Copy file path <span>file</span></button>
            <button type="button" @click="chat">Open chat <span>↵</span></button>
          </div>
        </aside>
      </div>
    </template>

    <div v-else class="empty-note">
      <b>That entity is not in this workspace.</b>
      <span>It may have been renamed or deleted on disk.</span>
      <button class="empty-link" type="button" @click="goEntities">Back to entities</button>
    </div>
  </div>
</template>
