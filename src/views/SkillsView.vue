<script setup>
import { computed, onMounted, ref } from 'vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import SkillIcon from '@/components/SkillIcon.vue'
import { hub, toast } from '@/stores/hub'
import { attachSkill, loadLibrary, workspaces } from '@/stores/workspaces'

/**
 * Two scopes, one page.
 *
 * `library` is discovery: every skill each harness on this machine already
 * carries, read from `~/.pi`, `~/.claude`, `~/.codex`, … — the same reading as
 * before workspaces existed, with the harness as the filter axis.
 *
 * `workspace` is intent: the symlinks this workspace owns. Attaching is one
 * symlink from the library, so an update in the library flows through here.
 */
const tab = ref('library')
const harness = ref('all')
const busy = ref('')

onMounted(loadLibrary)

const library = computed(() => workspaces.library)
const items = computed(() => workspaces.skills)

const attachedNames = computed(
  () => new Set(items.value.map((item) => item.name.toLowerCase())),
)

const filters = computed(() => [
  { id: 'all', label: 'All', count: library.value?.count || 0 },
  ...(library.value?.harnesses || [])
    .filter((entry) => entry.count > 0)
    .map((entry) => ({ id: entry.id, label: entry.label, count: entry.count })),
])

const visibleLibrary = computed(() => {
  const all = library.value?.items || []
  if (harness.value === 'all') return all
  return all.filter((item) => item.harness === harness.value)
})

const available = computed(() => {
  const seen = new Set()
  return (library.value?.items || []).filter((item) => {
    const key = item.name.toLowerCase()
    if (attachedNames.value.has(key) || seen.has(key)) return false
    seen.add(key)
    return true
  })
})

const isAttached = (item) => attachedNames.value.has(item.name.toLowerCase())

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
        <p class="eyebrow">Skills · {{ hub.workspaceLabel || hub.workspace }}</p>
        <h1>Skills</h1>
        <p class="lede">
          Every skill installed on this machine, read from each harness’s own library, plus
          the ones this workspace has attached. The same skill can live in more than one
          place, so filter by harness to see the copy that runtime actually loads.
        </p>
      </div>
      <div class="head-actions">
        <button
          class="btn"
          type="button"
          @click="tab = tab === 'workspace' ? 'library' : 'workspace'"
        >
          {{ tab === 'workspace' ? 'Browse library' : 'Workspace skills' }}
        </button>
      </div>
    </div>

    <div class="sk-tabs" role="tablist" aria-label="Skill scope">
      <button
        role="tab"
        :aria-selected="tab === 'library' ? 'true' : 'false'"
        @click="tab = 'library'"
      >
        Library <span class="n">{{ library?.count ?? 0 }}</span>
      </button>
      <button
        role="tab"
        :aria-selected="tab === 'workspace' ? 'true' : 'false'"
        @click="tab = 'workspace'"
      >
        Workspace <span class="n">{{ items.length }}</span>
      </button>
    </div>

    <template v-if="tab === 'library'">
      <div v-if="!library" class="empty-note">
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
            {{ visibleLibrary.length }} of {{ library.count }}
            <template v-if="library.hostname"> · {{ library.hostname }}</template>
          </span>
        </div>

        <div v-if="visibleLibrary.length" class="grid3">
          <router-link
            v-for="s in visibleLibrary"
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
              <span>
                {{ s.files }} {{ s.files === 1 ? 'file' : 'files' }} · {{ s.size }}
                <template v-if="isAttached(s)"> · attached</template>
              </span>
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
    </template>

    <template v-else>
      <div class="lib-bar">
        <span class="lib-meta">
          {{ items.length }} attached
          <template v-if="library"> · {{ library.count }} on this machine</template>
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

      <div class="sec-head" style="margin-top: 26px">
        <h2>Attach from this machine</h2>
        <span class="meta">{{ available.length }}</span>
      </div>
      <p v-if="!library" class="machine-note">Reading the harness skill libraries…</p>
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
