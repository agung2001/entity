<script setup>
import { computed } from 'vue'
import EntityMark from '@/components/EntityMark.vue'
import { hub, openDrawer, toast } from '@/stores/hub'

const FILTERS = ['all', 'running', 'idle', 'sleep']

const list = computed(() =>
  hub.entityFilter === 'all'
    ? hub.agents
    : hub.agents.filter((a) => a.status === hub.entityFilter),
)

const dotState = (status) => ({ running: 'live', idle: 'idle', sleep: 'sleep' })[status] || 'idle'

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
        <p class="eyebrow">Workspace · sundoro</p>
        <h1>Entities</h1>
        <p class="lede">
          Every entity this hub knows about, wherever it runs. Open one to read its ENTITY.md or
          move it.
        </p>
      </div>
      <div class="head-actions">
        <button class="btn" @click="toast('Entity import opens a folder picker')">Add entity</button>
      </div>
    </div>

    <div class="hints" style="margin-bottom: 14px">
      <button
        v-for="f in FILTERS"
        :key="f"
        class="hint"
        :aria-pressed="hub.entityFilter === f ? 'true' : 'false'"
        @click="hub.entityFilter = f"
      >
        {{ f === 'all' ? `All ${hub.agents.length}` : f }}
      </button>
    </div>

    <div class="tbl">
      <div class="tr th">
        <span>Entity</span><span>State</span><span class="col-machines">Machines</span>
        <span class="col-skills">Skills</span><span class="col-last">Last run</span>
      </div>
      <div
        v-for="a in list"
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
            <span class="sub2" style="max-width: 38ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
              {{ a.desc }}
            </span>
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
      <div v-if="!list.length" class="tr" style="cursor: default; color: var(--muted); font-size: 12.5px">
        Nothing here.
      </div>
    </div>
  </div>
</template>
