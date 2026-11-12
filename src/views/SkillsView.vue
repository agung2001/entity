<script setup>
import { computed, ref, watch } from 'vue'
import HarnessIcon from '@/components/HarnessIcon.vue'
import { hub, toast } from '@/stores/hub'
import { attachSkill, loadLibrary, workspaces } from '@/stores/workspaces'

const props = defineProps({
  /* Rendered inside Workspace → Skills; the parent owns the page head. */
  embedded: { type: Boolean, default: false },
})


/**
 * One page, two scopes — workspace first.
 *
 * `workspace` is intent: the symlinks this workspace owns. It is the tab the
 * page opens on, and it is one small directory read.
 *
 * `harness libraries` is discovery: every skill each harness on this machine
 * already carries, read from `~/.pi`, `~/.claude`, `~/.codex`, … Scanning all of
 * them walks six directory trees, so it is paid for only when this tab is
 * opened, and the result is cached for the session.
 */
const tab = ref('workspace')
const harness = ref('all')
const busy = ref('')

/* lazy: nothing is scanned until the library tab is actually shown */
watch(tab, (value) => {
  if (value === 'library' && !workspaces.library) loadLibrary()
})

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
  const key = `${item.harness}:${item.name}`
  if (busy.value) return
  busy.value = key
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
  <div :class="props.embedded ? 'ws-embed' : 'view'">
    <div v-if="!props.embedded" class="page-head">
      <div>
        <p class="eyebrow">Skills · {{ hub.workspaceLabel || hub.workspace }}</p>
        <h1>Skills</h1>
        <p class="lede">
          The skills this workspace has attached, first. The harness libraries on this
          machine — <code class="mono">~/.pi</code>, <code class="mono">~/.claude</code>,
          <code class="mono">~/.codex</code>, … — are one tab away, and are only read when
          you open that tab.
        </p>
      </div>
      <div class="head-actions">
        <span class="meta">
          {{ items.length }} attached
          <template v-if="library && !library.error"> · {{ library.count }} in the libraries</template>
        </span>
      </div>
    </div>

    <div class="sk-tabs" role="tablist" aria-label="Skill scope">
      <button
        role="tab"
        :aria-selected="tab === 'workspace' ? 'true' : 'false'"
        @click="tab = 'workspace'"
      >
        Workspace <span class="n">{{ items.length }}</span>
      </button>
      <button
        role="tab"
        :aria-selected="tab === 'library' ? 'true' : 'false'"
        @click="tab = 'library'"
      >
        Harness libraries <span v-if="library && !library.error" class="n">{{ library.count }}</span>
      </button>
    </div>

    <template v-if="tab === 'workspace'">
      <div class="lib-bar">
        <span class="lib-meta">
          {{ items.length }} attached
          <template v-if="hub.agents.length"> · {{ hub.agents.length }} entities can name them</template>
        </span>
        <span class="lib-meta mono">{{ hub.workspacePath }}/skills</span>
        <button class="btn btn-sm" type="button" @click="tab = 'library'">
          Attach from libraries
        </button>
      </div>

      <div v-if="items.length" class="grid3">
        <router-link
          v-for="s in items"
          :key="s.name"
          class="card2"
          :to="{ name: 'skill', params: { workspace: hub.workspace, name: s.name } }"
        >
          <div class="card-top">
            <h3><HarnessIcon :name="s.harness" :size="14" />{{ s.name }}</h3>
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
        <b>No skills in this workspace yet.</b>
        <span>Attaching one from a harness library is a symlink, not a copy.</span>
        <div class="empty-actions">
          <button class="btn btn-sm" type="button" @click="tab = 'library'">
            Open the harness libraries
          </button>
        </div>
      </div>
    </template>

    <template v-else>
      <div v-if="!library" class="empty-note">
        <b>Scanning the harness skill libraries…</b>
      </div>

      <div v-else-if="library.error" class="empty-note">
        <b>{{ library.error }}</b>
        <button class="btn btn-sm" type="button" @click="loadLibrary({ force: true })">
          Try again
        </button>
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
          <div v-for="s in visibleLibrary" :key="s.id" class="card2">
            <div class="card-top">
              <h3><HarnessIcon :name="s.harness" :size="14" />{{ s.name }}</h3>
            </div>
            <p class="p">{{ s.path }}</p>
            <p v-if="s.description" class="desc">{{ s.description }}</p>
            <div class="foot">
              <span>
                {{ s.files }} {{ s.files === 1 ? 'file' : 'files' }} · {{ s.size }}
              </span>
              <span>{{ s.version || when(s.updatedAt) }}</span>
            </div>
            <div class="card-actions">
              <router-link
                class="btn btn-sm"
                :to="{ name: 'skill', params: { workspace: hub.workspace, name: s.name }, query: { harness: s.harness } }"
              >
                Open
              </router-link>
              <button
                v-if="!isAttached(s)"
                class="btn btn-sm"
                type="button"
                :disabled="busy === `${s.harness}:${s.name}`"
                @click="attach(s)"
              >
                {{ busy === `${s.harness}:${s.name}` ? 'Attaching…' : 'Attach' }}
              </button>
              <span v-else class="meta">attached to this workspace</span>
            </div>
          </div>
        </div>

        <div v-else class="empty-note">
          <b>No skills in this harness library.</b>
          <span v-if="harness !== 'all'">Switch to All, or add a skill directory for it.</span>
          <span v-else>No harness skill directories were found on this machine.</span>
        </div>
      </template>
    </template>
  </div>
</template>
