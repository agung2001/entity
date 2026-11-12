<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import MarkPicker from '@/components/MarkPicker.vue'
import HarnessPaths from '@/components/HarnessPaths.vue'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import ModelInput from '@/components/ModelInput.vue'
import PickMenu from '@/components/PickMenu.vue'
import SkillIcon from '@/components/SkillIcon.vue'
import { HARNESSES, MODELS } from '@/data/mock'
import {
  agentById,
  ago,
  chatFocusEntity,
  ensureChats,
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
const tab = ref('overview')
const saving = ref(false)
const form = reactive({ harness: '', model: '', instructions: '' })
const seeding = ref(false)

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
const dirty = computed(
  () =>
    Boolean(agent.value) &&
    (form.harness !== agent.value.harness ||
      form.model !== (agent.value.model || '') ||
      form.instructions !== (agent.value.instructions || '')),
)

function seedForm() {
  if (!agent.value) return
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

onMounted(() => {
  ensureChats()
  loadHarnesses().catch(() => {})
  loadModels(form.harness).catch(() => {})
})

async function chat() {
  if (!agent.value) return
  try {
    await chatFocusEntity(agent.value.id)
    router.push('/chat')
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
</script>

<template>
  <div class="view">
    <template v-if="agent">
      <div class="page-head">
        <div class="entity-head">
          <MarkPicker :entity="agent.name" />
          <div>
            <p class="eyebrow">Entity · {{ hub.workspaceLabel || hub.workspace }}</p>
            <h1>{{ agent.name }}</h1>
            <p class="lede">{{ agent.desc }}</p>
          </div>
        </div>
        <div class="head-actions">
          <button class="btn" type="button" @click="router.push('/entities')">All entities</button>
          <button class="btn" type="button" @click="reveal">Reveal file</button>
          <button class="btn btn-ink" type="button" @click="chat">Chat</button>
        </div>
      </div>

      <div class="sk-tabs" role="tablist" aria-label="Entity scope">
        <button
          role="tab"
          :aria-selected="tab === 'overview' ? 'true' : 'false'"
          @click="tab = 'overview'"
        >
          Overview
        </button>
        <button
          role="tab"
          :aria-selected="tab === 'skills' ? 'true' : 'false'"
          @click="tab = 'skills'"
        >
          Skills <span class="n">{{ agent.skills.length }}</span>
        </button>
      </div>

      <template v-if="tab === 'overview'">
        <section class="acct-card">
          <div class="acct-card-head">
            <h2>Identity</h2>
            <div class="entity-head-actions">
              <span class="state" :data-s="agent.status === 'running' ? 'live' : agent.status === 'error' ? 'fail' : 'idle'">
                <i></i>{{ agent.status }}
              </span>
              <button class="btn btn-sm" type="button" :disabled="saving || !dirty" @click="save">
                {{ saving ? 'Saving…' : 'Save' }}
              </button>
            </div>
          </div>

          <div class="entity-edit-grid">
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
              <p class="mnote">Used by new threads and by runs from this page.</p>
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
              <p class="mnote">
                <template v-if="modelData?.detected">
                  Detected from {{ form.harness }}<template v-if="modelData.default"> · default
                  <code class="mono">{{ modelData.default }}</code></template>.
                </template>
                Leave blank to let the harness choose.
              </p>
            </div>
          </div>

          <HarnessPaths :active="form.harness" />

          <dl class="dl">
            <dt>Directory</dt>
            <dd class="mono">{{ agent.dir || 'not set' }}</dd>
            <dt>Machines</dt>
            <dd>
              <template v-if="agent.machines.length">
                {{ agent.machines.map(machineLabel).join(', ') }}
              </template>
              <span v-else class="unplaced">nowhere yet</span>
            </dd>
            <dt>Last chat</dt>
            <dd>{{ lastChat }}</dd>
            <dt>MCP</dt>
            <dd>{{ agent.mcp.length ? agent.mcp.join(', ') : 'none' }}</dd>
          </dl>
        </section>

        <section class="acct-card entity-source">
          <div class="acct-card-head">
            <h2>Source file</h2>
            <span class="mnote">frontmatter + instructions</span>
          </div>
          <div class="source-label-row">
            <span class="lbl">Full instructions</span>
            <span class="source-path mono" :title="agent.displayPath">{{ agent.displayPath }}</span>
          </div>
          <MarkdownEditor
            v-model="form.instructions"
            :rows="instructionRows"
            :disabled="saving"
            placeholder="Write the entity instructions in Markdown…"
          />
          <p class="dr-note">
            The body above is the full file content the harness receives as a system prompt
            (claude, pi) or as prompt text (codex, opencode, gemini).
          </p>
          <p v-if="agent.mcp.length" class="dr-note">
            {{
              agent.harness === 'claude'
                ? `MCP: ${agent.mcp.join(', ')} — injected for a claude conversation only (strict).`
                : `MCP applies to claude conversations; ${agent.harness} ignores the list.`
            }}
          </p>
          <div class="acct-actions">
            <span v-if="dirty" class="mnote">Unsaved changes</span>
            <button class="btn btn-ink" type="button" :disabled="saving || !dirty" @click="save">
              {{ saving ? 'Saving…' : 'Save entity' }}
            </button>
          </div>
        </section>

        <section v-if="agent.problems.length" class="dr-problems" style="margin-top: 16px">
          <p class="lbl">Problems</p>
          <ul>
            <li v-for="problem in agent.problems" :key="problem">{{ problem }}</li>
          </ul>
        </section>
      </template>

      <template v-else-if="tab === 'skills'">
        <template v-if="agent.skills.length">
          <div class="acct-card">
            <div class="acct-card-head">
              <h2>Declared skills</h2>
              <span class="mnote">{{ agent.skills.length }} names in frontmatter</span>
            </div>
            <div v-for="name in agent.skills" :key="name" class="skill-row">
              <span>{{ name }}</span>
              <span class="p">
                {{
                  hub.skills.some((skill) => skill.name === name && !skill.missing)
                    ? 'in this workspace'
                    : 'missing from this workspace'
                }}
              </span>
            </div>
          </div>
        </template>

        <section class="acct-card" style="margin-top: 16px">
          <div class="acct-card-head">
            <h2>In this workspace</h2>
            <span class="mnote">{{ hub.skills.length }}</span>
          </div>
          <div v-if="hub.skills.length" class="skill-picks">
            <button
              v-for="skill in hub.skills"
              :key="skill.name"
              class="skill-pick"
              :class="{ missing: skill.missing }"
              type="button"
              :disabled="skill.missing"
              @click="router.push({ name: 'skill', params: { name: skill.name } })"
            >
              <span class="skill-pick-top">
                <span class="skill-pick-name"><SkillIcon :size="13" />{{ skill.name }}</span>
                <span class="skill-pick-meta">
                  {{ skill.missing ? 'link missing' : `${skill.files} ${skill.files === 1 ? 'file' : 'files'}` }}
                </span>
              </span>
              <span class="skill-pick-desc">
                {{ skill.missing ? 'The link target is gone — re-attach it from the machine library.' : skill.description || skill.harnessLabel }}
              </span>
            </button>
          </div>
          <p v-else class="dr-empty">No skills in this workspace yet.</p>
        </section>
      </template>

    </template>

    <div v-else class="empty-note">
      <b>That entity is not in this workspace.</b>
      <span>It may have been renamed or deleted on disk.</span>
      <router-link to="/entities">Back to entities</router-link>
    </div>
  </div>
</template>
