<script setup>
import EntityMark from '@/components/EntityMark.vue'
import { hub } from '@/stores/hub'
</script>

<template>
  <div class="view">
    <div class="page-head">
      <div>
        <p class="eyebrow">Journal</p>
        <h1>Activity</h1>
        <p class="lede">
          Every copy, sync and restart, with the machine it landed on. Newest first.
        </p>
      </div>
    </div>

    <div class="tbl">
      <div class="jrn-row jrn-th">
        <span>Time</span><span>Entity</span><span>Event</span><span class="rt">Detail</span>
      </div>
      <div v-for="(e, i) in hub.activity" :key="i" class="jrn-row">
        <time>{{ e.t }} ago</time>
        <span class="jrn-ent"><EntityMark /><span class="nm2">{{ e.who }}</span></span>
        <span class="jrn-act"><b>{{ e.act }}</b></span>
        <span class="jrn-det">{{ e.where }}</span>
      </div>
    </div>
  </div>
</template>
