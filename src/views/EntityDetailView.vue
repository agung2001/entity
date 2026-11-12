<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import MarkPicker from '@/components/MarkPicker.vue'
import SkillIcon from '@/components/SkillIcon.vue'
import {
  agentById,
  ago,
  chatFocusEntity,
  ensureChats,
  entityMd,
  hub,
  machineById,
  toast,
} from '@/stores/hub'
import { revealEntity } from '@/stores/entities'

/**
 * The entity is a page, not a drawer. It is the same file the table lists —
 * opening it should feel like opening a document, with room for the skills,
 * the instructions and the working directory.
 */
const route = useRoute()
const router = useRouter()
const tab = ref('overview')

const agent = computed(
  () => agentById(route.params.name) || hub.agents.find((item) => item.name === route.params.name),
)
const machineLabel = (id) => machineById(id)?.label || id
const lastChat = computed(() => {
  const thread = hub.chat.summaries.find((item) => item.entity === agent.value?.name)
  return thread ? ago(thread.updatedAt) : 'never'
})

onMounted(ensureChats)

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
        <button
          role="tab"
          :aria-selected="tab === 'md' ? 'true' : 'false'"
          @click="tab = 'md'"
        >
          ENTITY.md
        </button>
      </div>

      <template v-if="tab === 'overview'">
        <div class="grid2">
          <section class="acct-card">
            <div class="acct-card-head">
              <h2>Identity</h2>
              <span class="state" :data-s="agent.status === 'running' ? 'live' : agent.status === 'error' ? 'fail' : 'idle'">
                <i></i>{{ agent.status }}
              </span>
            </div>
            <dl class="dl">
              <dt>Harness</dt>
              <dd>{{ agent.harnessLabel }}</dd>
              <dt>Model</dt>
              <dd>{{ agent.model || 'harness default' }}</dd>
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

          <section class="acct-card">
            <div class="acct-card-head">
              <h2>The file</h2>
              <span class="mnote">frontmatter + instructions</span>
            </div>
            <pre class="code">{{ agent.displayPath }}</pre>
            <p class="dr-note">
              Frontmatter is the config; the body is what the harness receives as a system
              prompt (claude, pi) or as prompt text (codex, opencode, gemini).
            </p>
            <p v-if="agent.mcp.length" class="dr-note">
              {{
                agent.harness === 'claude'
                  ? `MCP: ${agent.mcp.join(', ')} — injected for a claude conversation only (strict).`
                  : `MCP applies to claude conversations; ${agent.harness} ignores the list.`
              }}
            </p>
          </section>
        </div>

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

      <template v-else>
        <pre class="md">{{ entityMd(agent) }}</pre>
        <p class="dr-note">
          Read from {{ agent.displayPath }} before the harness answers — never copied into the hub.
        </p>
      </template>
    </template>

    <div v-else class="empty-note">
      <b>That entity is not in this workspace.</b>
      <span>It may have been renamed or deleted on disk.</span>
      <router-link to="/entities">Back to entities</router-link>
    </div>
  </div>
</template>
