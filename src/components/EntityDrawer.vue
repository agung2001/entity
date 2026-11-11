<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import MarkPicker from '@/components/MarkPicker.vue'
import {
  agentById,
  chatFocusEntity,
  closeDrawer,
  entityMd,
  hub,
  machineById,
  openMove,
  skillMachineIds,
} from '@/stores/hub'

const router = useRouter()

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'skills', label: 'Skills' },
  { id: 'md', label: 'ENTITY.md' },
]

const agent = computed(() => agentById(hub.drawer.agentId))

function setTab(tab) {
  hub.drawer.tab = tab
}

function toChat() {
  const id = hub.drawer.agentId
  closeDrawer()
  chatFocusEntity(id)
  router.push('/chat')
}

function toMove() {
  const id = hub.drawer.agentId
  closeDrawer()
  openMove(id)
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
          <MarkPicker />
          <div>
            <h2>{{ agent.name }}</h2>
            <p>{{ agent.runtime }} · {{ agent.status }}</p>
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
          <dl class="dl">
            <dt>Runtime</dt>
            <dd>{{ agent.runtime }}</dd>
            <dt>Model</dt>
            <dd>{{ agent.model }}</dd>
            <dt>Size</dt>
            <dd>{{ agent.size }}</dd>
            <dt>Machines</dt>
            <dd>
              <template v-if="agent.machines.length">{{ agent.machines.join(', ') }}</template>
              <span v-else class="unplaced">unplaced</span>
            </dd>
            <dt>Started</dt>
            <dd>{{ agent.start }}</dd>
            <dt>Last run</dt>
            <dd>{{ agent.last }}</dd>
            <dt>Skills</dt>
            <dd>{{ agent.skills.length }} attached</dd>
          </dl>

          <div class="sec-head" style="margin: 22px 0 6px">
            <h2 style="font-size: 12px">Where it runs</h2>
          </div>
          <template v-if="agent.machines.length">
            <div v-for="m in agent.machines" :key="m" class="skill-row">
              <span>{{ m }}</span>
              <span class="p">{{ machineById(m)?.desc || '' }}</span>
            </div>
          </template>
          <p v-else class="dr-empty">Not placed yet. Move it to a machine to start it.</p>
        </template>

        <template v-else-if="hub.drawer.tab === 'skills'">
          <template v-if="agent.skills.length">
            <div v-for="s in agent.skills" :key="s" class="skill-row">
              <span>{{ s }}</span>
              <span class="p">{{ skillMachineIds(s).length }}/{{ hub.machines.length }} machines</span>
            </div>
          </template>
          <p v-else class="dr-empty">No skills attached.</p>
        </template>

        <template v-else>
          <pre class="md">{{ entityMd(agent) }}</pre>
          <p class="dr-note">copied to every machine this entity runs on</p>
        </template>
      </div>

      <div class="dr-foot">
        <button class="btn btn-ghost" @click="toChat">Chat</button>
        <button class="btn btn-ink" @click="toMove">Relocate</button>
      </div>
    </template>
  </aside>
</template>
