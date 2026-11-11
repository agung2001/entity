<script setup>
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import AskConsole from '@/components/AskConsole.vue'
import EntityMark from '@/components/EntityMark.vue'
import MachineIcon from '@/components/MachineIcon.vue'
import { fleet, loadFleet, probeState } from '@/stores/fleet'
import { hub, openDrawer, strandedSkillCount, workspaceById } from '@/stores/hub'

const router = useRouter()

onMounted(loadFleet)

const workspace = computed(() => workspaceById(hub.workspace).label)
const live = computed(() => hub.agents.filter((a) => a.status === 'running').length)
const stranded = computed(() => strandedSkillCount())
const hostCount = computed(() => (fleet.loaded ? fleet.hosts.length : hub.machines.length))

const agentsOn = (machineId) => hub.agents.filter((a) => a.machines.includes(machineId)).length

const dotState = (status) => ({ running: 'live', idle: 'idle', sleep: 'sleep' })[status] || 'idle'

const hostState = (alias) => {
  const state = probeState(alias).state
  return state === 'ok' || state === 'fail' || state === 'testing' ? state : 'idle'
}
const hostLabel = (alias) => {
  const state = hostState(alias)
  if (state === 'ok') return 'reachable'
  if (state === 'fail') return 'unreachable'
  if (state === 'testing') return 'testing'
  return 'in config'
}

function openFromKeyboard(e, id) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    openDrawer(id)
  }
}
</script>

<template>
  <div class="view">
    <div class="page-head">
      <div>
        <p class="eyebrow">Workspace · {{ workspace }}</p>
        <h1>Overview</h1>
        <p class="lede">
          {{ hub.agents.length }} entities across {{ hostCount }} machines,
          {{ live }} running now. {{ stranded }} skills are installed on a single
          machine — move an entity to carry them across.
        </p>
      </div>
    </div>

    <AskConsole />

    <div class="sec-head">
      <h2>Machines</h2>
      <span class="meta">
        {{ fleet.hosts.length > 6 ? `showing 6 of ${fleet.hosts.length}` : `${fleet.hosts.length} hosts` }}
        · {{ fleet.displayPath }}
      </span>
    </div>
    <div class="machines">
      <button
        v-for="m in fleet.hosts.slice(0, 6)"
        :key="m.id"
        class="machine"
        type="button"
        :data-probe="hostState(m.alias)"
        @click="router.push('/machines')"
      >
        <div class="row1">
          <span class="nm"><MachineIcon :size="12" />{{ m.label }}</span>
          <span class="state" :data-s="hostState(m.alias)">
            <i></i>{{ hostLabel(m.alias) }}
          </span>
        </div>
        <p class="spec">{{ m.spec }}</p>
        <div class="foot">
          <span>{{ m.source }}</span>
          <span>{{ agentsOn(m.alias) }} {{ agentsOn(m.alias) === 1 ? 'entity' : 'entities' }}</span>
        </div>
      </button>
      <p v-if="fleet.loading && !fleet.loaded" class="machine-note">
        Reading {{ fleet.displayPath }}…
      </p>
      <p v-else-if="fleet.error" class="machine-note">{{ fleet.error }}</p>
      <p v-else-if="!fleet.hosts.length" class="machine-note">
        No hosts in {{ fleet.displayPath }}.
      </p>
    </div>

    <div class="sec-head">
      <h2>Entities</h2>
      <span class="meta">sorted by last run</span>
    </div>
    <div class="tbl">
      <div class="tr th">
        <span>Entity</span><span>State</span><span class="col-machines">Machines</span>
        <span class="col-skills">Skills</span><span class="col-last">Last run</span>
      </div>
      <div
        v-for="a in hub.agents"
        :key="a.id"
        class="tr"
        tabindex="0"
        role="button"
        @click="openDrawer(a.id)"
        @keydown="openFromKeyboard($event, a.id)"
      >
        <span class="cell-agent">
          <EntityMark />
          <span>
            <span class="nm2">{{ a.name }}</span>
            <span class="sub2">{{ a.runtime }} · {{ a.model }}</span>
          </span>
        </span>
        <span class="col-state">
          <span class="state" :data-s="dotState(a.status)"><i></i>{{ a.status }}</span>
        </span>
        <span class="col-machines">
          <template v-if="a.machines.length">
            <span v-for="m in a.machines" :key="m" class="chipm">{{ m }}</span>
          </template>
          <span v-else class="unplaced">unplaced</span>
        </span>
        <span class="num col-skills">{{ a.skills.length }}</span>
        <span class="last col-last">{{ a.last }}</span>
      </div>
    </div>

    <div class="log">
      <div class="sec-head"><h2>Activity</h2><span class="meta">last 48h</span></div>
      <ol>
        <li v-for="(e, i) in hub.activity.slice(0, 5)" :key="i">
          <time>{{ e.t }} ago</time>
          <span class="who"><EntityMark mini />{{ e.who }}</span>
          <span class="what"><b>{{ e.act }}</b></span>
          <span class="where">{{ e.where }}</span>
        </li>
      </ol>
    </div>
  </div>
</template>
