<script setup>
import { hub, skillMachineIds, skillOwners } from '@/stores/hub'
</script>

<template>
  <div class="view">
    <div class="page-head">
      <div>
        <p class="eyebrow">Library</p>
        <h1>Skills</h1>
        <p class="lede">
          Skills live in one library and are copied to the machines that need them. A skill is
          only portable if every machine has the runtime it expects.
        </p>
      </div>
    </div>

    <div class="grid3">
      <router-link
        v-for="s in hub.skills"
        :key="s.name"
        class="card2"
        :to="`/skills/${s.name}`"
      >
        <h3>{{ s.name }}</h3>
        <p class="p">~/.entity/skills/{{ s.name }}</p>
        <div class="foot">
          <span>{{ skillOwners(s.name).length }} agent{{ skillOwners(s.name).length === 1 ? '' : 's' }}</span>
          <span class="dots" :title="skillMachineIds(s.name).join(', ') || 'none'">
            <i
              v-for="m in hub.machines"
              :key="m.id"
              :data-on="skillMachineIds(s.name).includes(m.id) ? '1' : '0'"
            ></i>
          </span>
        </div>
      </router-link>
    </div>
  </div>
</template>
