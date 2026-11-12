<script setup>
import { computed, onMounted, ref } from 'vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import SkillIcon from '@/components/SkillIcon.vue'
import { hub, toast } from '@/stores/hub'
import { attachSkill, loadLibrary, workspaces } from '@/stores/workspaces'

/**
 * The workspace's own skill catalog: one directory per attached skill, usually a
 * symlink into a harness library. The link's target is why a skill can be
 * `missing` — the harness removed it and the workspace kept its intent.
 *
 * The list below the grid is the machine's libraries (discovery); attaching is
 * one symlink (intent).
 */
const adding = ref(false)
const busy = ref('')

onMounted(loadLibrary)

const items = computed(() => workspaces.skills)

const attached = computed(() => new Set(items.value.map((item) => item.name.toLowerCase())))

const available = computed(() => {
  const seen = new Set()
  return (workspaces.library?.items || []).filter((item) => {
    const key = item.name.toLowerCase()
    if (attached.value.has(key) || seen.has(key)) return false
    seen.add(key)
    return true
  })
})

const when = (iso) => {
  if (!iso) return 'unknown'
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return 'unknown'
  const days = Math.floor((Date.now() - then) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days}d ago`
}

async function attach(item) {
  if (busy.value) return
  busy.value = item.name
  try {
    await attachSkill({ name: item.name, harness: item.harness })
  } catch (error) {
    toast(error?.message || 'Could not attach that skill')
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div class="view">
    <div class="page-head">
      <div>
        <p class="eyebrow">Workspace · {{ hub.workspaceLabel || hub.workspace }}</p>
        <h1>Skills</h1>
        <p class="lede">
          The skills this workspace has. Each entry is a symlink into the harness library
          that already holds it, so an update in the library shows up here — nothing is
          copied, and nothing is hidden behind a list.
        </p>
      </div>
      <div class="head-actions">
        <button class="btn" type="button" @click="adding = !adding">
          {{ adding ? 'Close' : 'Attach a skill' }}
        </button>
      </div>
    </div>

    <div class="lib-bar">
      <span class="lib-meta">
        {{ items.length }} attached
        <template v-if="workspaces.library"> · {{ workspaces.library.count }} on this machine</template>
        <template v-if="hub.agents.length"> · {{ hub.agents.length }} entities can name them</template>
      </span>
      <span class="lib-meta mono">{{ workspaces.mcp.path ? workspaces.mcp.path.replace(/mcp\.json$/, 'skills/') : '' }}</span>
    </div>

    <div v-if="items.length" class="grid3">
      <router-link
        v-for="s in items"
        :key="s.name"
        class="card2"
        :to="{ name: 'skill', params: { name: s.name } }"
      >
        <div class="card-top">
          <h3><SkillIcon />{{ s.name }}</h3>
          <span
            class="tag tag-icon"
            role="img"
            :title="s.missing ? 'link target missing' : s.harnessLabel"
            :aria-label="s.missing ? 'missing' : s.harnessLabel"
          >
            <HarnessIcon :name="s.harness" :size="12" />
          </span>
        </div>
        <p class="p">{{ s.path }}</p>
        <p v-if="s.missing" class="desc bad">Link target missing — re-attach from the library.</p>
        <p v-else-if="s.description" class="desc">{{ s.description }}</p>
        <div class="foot">
          <span>
            {{ s.missing ? '0 files' : `${s.files} ${s.files === 1 ? 'file' : 'files'} · ${s.size}` }}
          </span>
          <span>{{ s.version || (s.updatedAt ? when(s.updatedAt) : 'missing') }}</span>
        </div>
      </router-link>
    </div>

    <div v-else class="empty-note">
      <b>No skills in this workspace.</b>
      <span>Attach one from the harness libraries on this machine — it is a symlink, not a copy.</span>
    </div>

    <template v-if="adding">
      <div class="sec-head" style="margin-top: 26px">
        <h2>On this machine</h2>
        <span class="meta">{{ available.length }}</span>
      </div>
      <p v-if="!workspaces.library" class="machine-note">Reading the harness skill libraries…</p>
      <div v-else-if="available.length" class="picks picks--scroll">
        <button
          v-for="item in available"
          :key="item.id"
          class="pick"
          type="button"
          :title="item.description"
          :disabled="busy === item.name"
          @click="attach(item)"
        >
          {{ item.name }} <span class="pick-meta">{{ item.harnessLabel }}</span>
        </button>
      </div>
      <p v-else class="machine-note">Every skill on this machine is already attached.</p>
    </template>
  </div>
</template>
