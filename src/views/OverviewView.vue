<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import AskConsole from '@/components/AskConsole.vue'
import EntityMark from '@/components/EntityMark.vue'
import { hub, openDrawer, strandedSkillCount, toast, workspaceById } from '@/stores/hub'

const router = useRouter()

const workspace = computed(() => workspaceById(hub.workspace).label)
const live = computed(() => hub.agents.filter((a) => a.status === 'running').length)
const stranded = computed(() => strandedSkillCount())
const online = computed(() => hub.machines.filter((m) => m.state === 'online').length)
const asleep = computed(() => hub.machines.filter((m) => m.state === 'sleep').length)

const agentsOn = (machineId) => hub.agents.filter((a) => a.machines.includes(machineId)).length

const dotState = (status) => ({ running: 'live', idle: 'idle', sleep: 'sleep' })[status] || 'idle'

function openFromKeyboard(e, id) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    openDrawer(id)
  }
}

function addAgent() {
  toast('Agent import opens a folder picker')
}
</script>

<template>
  <div class="view">
    <div class="page-head">
      <div>
        <p class="eyebrow">Workspace · {{ workspace }}</p>
        <h1>Overview</h1>
        <p class="lede">
          {{ hub.agents.length }} agents across {{ hub.machines.length }} machines,
          {{ live }} running now. {{ stranded }} skills are installed on a single
          machine — move an agent to carry them across.
        </p>
      </div>
      <div class="head-actions">
        <button class="btn" @click="addAgent">Add agent</button>
      </div>
    </div>

    <AskConsole />

    <div class="sec-head">
      <h2>Machines</h2>
      <span class="meta">{{ online }} online · {{ asleep }} asleep</span>
    </div>
    <div class="machines">
      <button
        v-for="m in hub.machines"
        :key="m.id"
        class="machine"
        @click="router.push('/machines')"
      >
        <div class="row1">
          <span class="nm">{{ m.label }}</span>
          <span class="state" :data-s="m.state === 'online' ? 'live' : 'sleep'">
            <i></i>{{ m.state === 'online' ? 'online' : 'asleep' }}
          </span>
        </div>
        <p class="spec">{{ m.desc }}</p>
        <div class="foot">
          <span>{{ agentsOn(m.id) }} agent{{ agentsOn(m.id) === 1 ? '' : 's' }}</span>
          <span v-if="m.thisMachine" class="tag">this machine</span>
        </div>
      </button>
    </div>

    <div class="sec-head">
      <h2>Entities</h2>
      <span class="meta">sorted by last run</span>
    </div>
    <div class="tbl">
      <div class="tr th">
        <span>Agent</span><span>State</span><span class="col-machines">Machines</span>
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
