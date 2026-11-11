<script setup>
import { computed, onMounted, ref } from 'vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import SkillIcon from '@/components/SkillIcon.vue'
import { library, loadLibrary } from '@/stores/library'

/* The library is read from the harnesses installed on this machine, so the
   same skill appears once per harness that carries a copy. */
const harness = ref('all')

onMounted(loadLibrary)

const filters = computed(() => [
  { id: 'all', label: 'All', count: library.count },
  ...library.harnesses.filter((h) => h.count > 0),
])

const visible = computed(() =>
  harness.value === 'all'
    ? library.items
    : library.items.filter((item) => item.harness === harness.value),
)

function when(iso) {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return 'unknown'
  const days = Math.floor((Date.now() - then) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days}d ago`
}
</script>

<template>
  <div class="view">
    <div class="page-head">
      <div>
        <p class="eyebrow">Library · this machine</p>
        <h1>Skills</h1>
        <p class="lede">
          Every skill installed on this machine, read from each harness’s own library. The same
          skill can live in more than one place, so filter by harness to see the copy that
          runtime actually loads.
        </p>
      </div>
    </div>

    <div v-if="library.loading && !library.loaded" class="empty-note">
      <b>Scanning the harness skill libraries…</b>
    </div>

    <div v-else-if="library.error" class="empty-note">
      <b>{{ library.error }}</b>
      <button class="btn btn-sm" type="button" @click="loadLibrary()">Try again</button>
    </div>

    <template v-else>
      <div class="lib-bar">
        <div class="hints" aria-label="Filter by harness">
          <button
            v-for="f in filters"
            :key="f.id"
            class="hint"
            type="button"
            :aria-pressed="harness === f.id ? 'true' : 'false'"
            @click="harness = f.id"
          >
            <HarnessIcon :name="f.id" />
            {{ f.label }} <span class="hint-n">{{ f.count }}</span>
          </button>
        </div>
        <span class="lib-meta">
          {{ visible.length }} of {{ library.count }}
          <template v-if="library.hostname"> · {{ library.hostname }}</template>
        </span>
      </div>

      <div v-if="visible.length" class="grid3">
        <router-link
          v-for="s in visible"
          :key="s.id"
          class="card2"
          :to="{ name: 'skill', params: { name: s.name }, query: { harness: s.harness } }"
        >
          <div class="card-top">
            <h3><SkillIcon />{{ s.name }}</h3>
            <span
              class="tag tag-icon"
              role="img"
              :title="s.harnessLabel"
              :aria-label="s.harnessLabel"
            >
              <HarnessIcon :name="s.harness" :size="12" />
            </span>
          </div>
          <p class="p">{{ s.path }}</p>
          <p v-if="s.description" class="desc">{{ s.description }}</p>
          <div class="foot">
            <span>{{ s.files }} {{ s.files === 1 ? 'file' : 'files' }} · {{ s.size }}</span>
            <span>{{ s.version || when(s.updatedAt) }}</span>
          </div>
        </router-link>
      </div>

      <div v-else class="empty-note">
        <b>No skills in this harness library.</b>
        <span v-if="harness !== 'all'">Switch to All, or add a skill directory for it.</span>
        <span v-else>No harness skill directories were found on this machine.</span>
      </div>
    </template>
  </div>
</template>
