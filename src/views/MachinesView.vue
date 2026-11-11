<script setup>
import { hub, toast } from '@/stores/hub'

const agentsOn = (id) => hub.agents.filter((a) => a.machines.includes(id))
</script>

<template>
  <div class="view">
    <div class="page-head">
      <div>
        <p class="eyebrow">Fleet</p>
        <h1>Machines</h1>
        <p class="lede">
          entity talks to each machine over ssh. Nothing is stored in the cloud — the hub you are
          looking at runs on {{ hub.machines.find((m) => m.thisMachine)?.label || 'this machine' }}.
        </p>
      </div>
      <div class="head-actions">
        <button class="btn" @click="toast('Machine pairing needs an ssh key')">
          Connect machine
        </button>
      </div>
    </div>

    <div class="mgrid">
      <div v-for="m in hub.machines" :key="m.id" class="mcard">
        <div class="top">
          <div>
            <h3>
              {{ m.label }}
              <span v-if="m.thisMachine" class="tag">this machine</span>
            </h3>
            <p class="spec">{{ m.desc }}</p>
          </div>
          <span class="state" :data-s="m.state === 'online' ? 'live' : 'sleep'">
            <i></i>{{ m.state === 'online' ? 'online' : 'asleep' }}
          </span>
        </div>
        <div class="kv">
          <span>{{ m.ssh }}</span>
          <span>{{ agentsOn(m.id).length }} {{ agentsOn(m.id).length === 1 ? 'entity' : 'entities' }}</span>
          <span>{{ m.state === 'online' ? '12 ms' : '—' }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
