<script setup>
import { computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import MarkPicker from '@/components/MarkPicker.vue'
import SkillIcon from '@/components/SkillIcon.vue'
import {
  agentById,
  ago,
  closeDrawer,
  ensureChats,
  entityMd,
  hub,
  machineById,
} from '@/stores/hub'

const router = useRouter()

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'skills', label: 'Skills' },
  { id: 'md', label: 'ENTITY.md' },
]

const agent = computed(() => agentById(hub.drawer.agentId))
const machineLabel = (id) => machineById(id)?.label || id
const lastChat = computed(() => {
  const thread = hub.chat.summaries.find((item) => item.entity === agent.value?.name)
  return thread ? ago(thread.updatedAt) : 'never'
})

watch(
  () => hub.drawer.open,
  (open) => {
    if (open) ensureChats()
  },
)

function setTab(tab) {
  hub.drawer.tab = tab
}

function goSkills() {
  closeDrawer()
  router.push('/skills')
}

function openSkill(name) {
  closeDrawer()
  router.push({ name: 'skill', params: { name } })
}
</script>

<template>
  <aside
    class="drawer"
    :data-open="hub.drawer.open ? '1' : '0'"
    role="dialog"
    aria-modal="true"
    aria-label="Entity details"
  >
    <template v-if="agent">
      <div class="dr-head">
        <div class="dr-id">
          <MarkPicker :entity="agent.name" />
          <div>
            <h2>{{ agent.name }}</h2>
            <p>{{ agent.harnessLabel }} · {{ agent.status }}</p>
          </div>
        </div>
        <button class="x" aria-label="Close" @click="closeDrawer">
          <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5">
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>

      <div class="tabs" role="tablist">
        <button
          v-for="tab in TABS"
          :key="tab.id"
          role="tab"
          :aria-selected="hub.drawer.tab === tab.id ? 'true' : 'false'"
          @click="setTab(tab.id)"
        >
          {{ tab.label }}
        </button>
      </div>

      <div class="dr-body">
        <template v-if="hub.drawer.tab === 'overview'">
          <p style="margin: 0 0 16px; font-size: 13px; color: var(--ink-2)">{{ agent.desc }}</p>

          <div v-if="agent.problems.length" class="dr-problems">
            <p class="lbl">Problems</p>
            <ul>
              <li v-for="problem in agent.problems" :key="problem">{{ problem }}</li>
            </ul>
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
            <dt>Skills</dt>
            <dd>{{ agent.skills.length }} attached</dd>
            <dt>MCP</dt>
            <dd>{{ agent.mcp.length ? agent.mcp.join(', ') : 'none' }}</dd>
          </dl>

          <div class="sec-head" style="margin: 22px 0 6px">
            <h2 style="font-size: 12px">The file</h2>
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
        </template>

        <template v-else-if="hub.drawer.tab === 'skills'">
          <template v-if="agent.skills.length">
            <div v-for="s in agent.skills" :key="s" class="skill-row">
              <span>{{ s }}</span>
              <span class="p">
                {{
                  hub.skills.some((skill) => skill.name === s && !skill.missing)
                    ? 'in this workspace'
                    : 'missing from this workspace'
                }}
              </span>
            </div>
            <button class="btn skill-browse" type="button" @click="goSkills">
              Browse workspace skills
            </button>
          </template>

          <template v-else>
            <p class="dr-empty">
              No skills attached to {{ agent.name }} yet. These skills are in this workspace —
              open one, then name it in the entity's <code class="mono">skills:</code> line.
            </p>

            <div class="sec-head" style="margin: 18px 0 8px">
              <h2 style="font-size: 12px">In this workspace</h2>
              <span class="meta">{{ hub.skills.length }}</span>
            </div>

            <div v-if="hub.skills.length" class="skill-picks">
              <button
                v-for="s in hub.skills"
                :key="s.name"
                class="skill-pick"
                :class="{ missing: s.missing }"
                type="button"
                :disabled="s.missing"
                @click="openSkill(s.name)"
              >
                <span class="skill-pick-top">
                  <span class="skill-pick-name"><SkillIcon :size="13" />{{ s.name }}</span>
                  <span class="skill-pick-meta">
                    {{ s.missing ? 'link missing' : `${s.files} ${s.files === 1 ? 'file' : 'files'}` }}
                  </span>
                </span>
                <span class="skill-pick-desc">
                  {{ s.missing ? 'The link target is gone — re-attach it from the machine library.' : s.description || s.harnessLabel }}
                </span>
              </button>
            </div>
            <p v-else class="dr-empty" style="margin-top: 2px">
              No skills in this workspace yet. Attach one from the machine library.
            </p>

            <button class="btn skill-browse" type="button" @click="goSkills">
              {{ hub.skills.length ? 'Go to Skills' : 'Attach a skill' }}
            </button>
          </template>
        </template>

        <template v-else>
          <pre class="md">{{ entityMd(agent) }}</pre>
          <p class="dr-note">
            Read from {{ agent.displayPath }} before the harness answers — never copied into the hub.
          </p>
        </template>
      </div>
    </template>
  </aside>
</template>
