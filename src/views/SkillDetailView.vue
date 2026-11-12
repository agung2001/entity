<script setup>
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import EntityMark from '@/components/EntityMark.vue'
import { readSkillEntry } from '@/composables/localBridge'
import { hub, skillOwners, toast } from '@/stores/hub'
import {
  attachSkill,
  detachSkill,
  loadLibrary,
  readWorkspaceSkill,
  workspaces,
} from '@/stores/workspaces'

/**
 * One skill page for two scopes. An attached skill is read from the workspace's
 * own `skills/` directory; a skill opened from the library is read through the
 * harness that carries it. `?harness=` selects the copy when several harnesses
 * hold the same name.
 */
const route = useRoute()
const router = useRouter()
const name = computed(() => String(route.params.name || ''))
const wantedHarness = computed(() => String(route.query.harness || ''))

const workspaceItem = computed(
  () => workspaces.skills.find((skill) => skill.name.toLowerCase() === name.value.toLowerCase()) || null,
)

const libraryItem = computed(() => {
  const target = name.value.toLowerCase()
  const items = workspaces.library?.items || []
  if (wantedHarness.value) {
    return (
      items.find(
        (item) => item.harness === wantedHarness.value && item.name.toLowerCase() === target,
      ) || null
    )
  }
  return items.find((item) => item.name.toLowerCase() === target) || null
})

const item = computed(() => workspaceItem.value || libraryItem.value)
const inWorkspace = computed(() => Boolean(workspaceItem.value))
const attached = computed(() =>
  workspaces.skills.some((skill) => skill.name.toLowerCase() === name.value.toLowerCase()),
)

const entry = ref(null)
const loading = ref(false)
const error = ref('')
const tab = ref('overview')
const fileIndex = ref(0)
const busy = ref(false)
let token = 0

const files = computed(() => entry.value?.files || [])
const currentFile = computed(() => files.value[fileIndex.value] || null)
const usedBy = computed(() => skillOwners(name.value))
const version = computed(() => item.value?.version || '')
/* the composer's `/` menu uses the same grammar; a name with a space is not a
   callable reference, so the page does not advertise one */
const refCallable = computed(() => /^[A-Za-z0-9._-]+$/.test(item.value?.name || ''))
const description = computed(() => item.value?.description || '')
const missing = computed(() => Boolean(item.value?.missing))

const tabs = computed(() => {
  const list = [{ id: 'overview', label: 'Overview' }]
  if (entry.value?.md) list.push({ id: 'md', label: 'SKILL.md' })
  if (files.value.length) list.push({ id: 'files', label: 'Files', count: files.value.length })
  return list
})

const updated = computed(() => {
  if (!item.value?.updatedAt) return '—'
  const date = new Date(item.value.updatedAt)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
})

async function load() {
  tab.value = 'overview'
  fileIndex.value = 0
  entry.value = null
  error.value = ''
  /* a workspace skill is read from `skills/`; only a library skill needs the
     machine-wide scan, which is why it is not paid for here */
  if (!inWorkspace.value && !workspaces.library) await loadLibrary()
  if (!item.value || missing.value) return

  const ticket = ++token
  loading.value = true
  try {
    const data = inWorkspace.value
      ? await readWorkspaceSkill(item.value.name)
      : await readSkillEntry(item.value.harness, item.value.name)
    if (ticket !== token) return
    entry.value = data
  } catch (problem) {
    if (ticket !== token) return
    error.value = problem?.message || 'Could not read the skill directory.'
  } finally {
    if (ticket === token) loading.value = false
  }
}

watch([name, wantedHarness, () => workspaces.active], load, { immediate: true })

function copyMd() {
  const text = entry.value?.md || ''
  if (!navigator.clipboard?.writeText) {
    toast('Copy blocked by the browser')
    return
  }
  navigator.clipboard.writeText(text).then(
    () => toast('SKILL.md copied'),
    () => toast('Copy blocked by the browser'),
  )
}

async function detach() {
  if (busy.value || !workspaceItem.value) return
  busy.value = true
  try {
    await detachSkill(workspaceItem.value.name)
    router.push({ name: 'skills', params: { workspace: hub.workspace } })
  } catch (problem) {
    toast(problem?.message || 'Could not detach that skill')
  } finally {
    busy.value = false
  }
}

async function attach() {
  if (busy.value || !libraryItem.value) return
  busy.value = true
  try {
    await attachSkill({ name: libraryItem.value.name, harness: libraryItem.value.harness })
    router.push({ name: 'skill', params: { workspace: hub.workspace, name: libraryItem.value.name } })
  } catch (problem) {
    toast(problem?.message || 'Could not attach that skill')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="view">
    <template v-if="item">
      <header class="sk-head">
        <div>
          <p class="eyebrow">
            Skill <span class="sep">·</span>
            {{ inWorkspace ? hub.workspaceLabel || hub.workspace : 'library · this machine' }}
          </p>
          <div class="sk-title">
            <h1>{{ item.name }}</h1>
            <span v-if="version" class="vtag">{{ version }}</span>
            <span class="tag">{{ item.missing ? 'missing' : item.harnessLabel }}</span>
          </div>
          <p class="sk-path">{{ item.path }}</p>
          <p v-if="!item.missing && refCallable" class="sk-path">
            call it with /{{ inWorkspace ? 'workspace' : item.harness }}:{{ item.name }}
          </p>
          <p class="lede">
            {{
              description ||
              (missing
                ? 'This link points at a directory that no longer exists. Re-attach it from the library.'
                : 'Attached skill. Its frontmatter has no description.')
            }}
          </p>
        </div>
        <div class="sk-actions">
          <button v-if="inWorkspace" class="btn" type="button" :disabled="busy" @click="detach">
            {{ busy ? 'Detaching…' : 'Detach from workspace' }}
          </button>
          <button
            v-else
            class="btn btn-ink"
            type="button"
            :disabled="busy || attached"
            @click="attach"
          >
            {{ attached ? 'Already attached' : busy ? 'Attaching…' : 'Attach to workspace' }}
          </button>
        </div>
      </header>

      <div class="meta-strip">
        <div>
          <span class="k">Harness</span>
          <span class="v">{{ item.missing ? '—' : item.harnessLabel }}</span>
        </div>
        <div>
          <span class="k">Version</span>
          <span class="v mono">{{ version || 'not recorded' }}</span>
        </div>
        <div>
          <span class="k">Files</span>
          <span class="v">{{ item.missing ? '—' : `${item.files} · ${item.size}` }}</span>
        </div>
        <div>
          <span class="k">Updated</span>
          <span class="v">{{ updated }}</span>
        </div>
        <div>
          <span class="k">Entry</span>
          <span class="v mono">{{ item.entry || '—' }}</span>
        </div>
      </div>

      <div class="sk-tabs" role="tablist" aria-label="Skill sections">
        <button
          v-for="t in tabs"
          :key="t.id"
          role="tab"
          :aria-selected="tab === t.id ? 'true' : 'false'"
          :tabindex="tab === t.id ? 0 : -1"
          @click="tab = t.id"
        >
          {{ t.label }}<span v-if="t.count" class="n">{{ t.count }}</span>
        </button>
      </div>

      <section v-show="tab === 'overview'" class="panel" role="tabpanel">
        <div class="ov">
          <div>
            <div class="blk">
              <h2>What it does <span class="k">— from SKILL.md</span></h2>
              <p>
                {{
                  description ||
                  'No description in the skill frontmatter. Read the entry file for the full instructions.'
                }}
              </p>
            </div>

            <div class="blk">
              <h2>
                {{ inWorkspace ? 'Attached here' : 'In the harness library' }}
                <span class="k">— {{ inWorkspace ? 'workspace link' : item.harnessLabel }}</span>
              </h2>
              <p v-if="missing" class="bad">
                The symlink is still in the workspace, but its target is gone. That is the
                truthful state: re-attach it when the harness library has it again.
              </p>
              <p v-else-if="!inWorkspace">
                This copy lives in {{ item.harnessLabel }}’s own library. Attach it to this
                workspace to add a symlink here — the files stay where they are.
              </p>
              <p v-else>
                {{ item.copied ? 'This is a copy, because this filesystem cannot symlink.' : 'This is a symlink into the harness library, so updates flow through.' }}
              </p>
              <pre class="code">{{ item.path }}</pre>
              <p v-if="item.sourcePath" class="tnote"><span>→ {{ item.sourcePath }}</span></p>
              <p v-if="loading" class="tnote"><span>Reading SKILL.md…</span></p>
              <p v-else-if="error" class="tnote"><span>{{ error }}</span></p>
            </div>

            <div class="blk">
              <h2>Used by <span class="k">— {{ usedBy.length }} entities</span></h2>
              <div v-if="usedBy.length" class="ents">
                <button
                  v-for="a in usedBy"
                  :key="a.id"
                  class="ent"
                  type="button"
                  @click="router.push({ name: 'entity', params: { workspace: hub.workspace, name: a.name } })"
                >
                  <EntityMark :entity="a.name" />
                  <span class="who">
                    <span class="nm">{{ a.name }}</span>
                    <span class="rt">{{ a.harnessLabel }}</span>
                  </span>
                  <span class="where">{{ a.dir }}</span>
                </button>
              </div>
              <p v-else class="tnote">
                <span>No entity names this skill in its <code class="mono">skills:</code> line yet.</span>
              </p>
            </div>
          </div>

          <aside>
            <div class="skill-card">
              <h3>Manifest</h3>
              <dl class="kv">
                <dt>Entry</dt><dd>{{ item.entry || '—' }}</dd>
                <dt>Files</dt><dd>{{ item.missing ? '—' : `${item.files} · ${item.size}` }}</dd>
                <dt>License</dt><dd>{{ item.license || 'not recorded' }}</dd>
                <dt>Path</dt><dd>{{ item.path }}</dd>
              </dl>
            </div>
            <div class="skill-card">
              <h3>Runtime</h3>
              <dl class="kv">
                <dt>Requires</dt><dd>{{ item.runtime || 'not recorded' }}</dd>
                <dt>Harness</dt><dd>{{ item.missing ? '—' : item.harnessLabel }}</dd>
                <dt>Scope</dt><dd>{{ inWorkspace ? 'this workspace' : 'this machine' }}</dd>
              </dl>
            </div>
          </aside>
        </div>
      </section>

      <section v-if="entry?.md && tab === 'md'" class="panel" role="tabpanel">
        <div class="doc">
          <div class="doc-head">
            <span class="fn">SKILL.md <span>{{ item.size }}</span></span>
            <button class="btn btn-sm" type="button" @click="copyMd">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
                <rect x="2.2" y="2.2" width="8.4" height="8.4" rx="1.6" />
                <path d="M5.6 13.8h7.1a1 1 0 001-1V5.6" />
              </svg>
              Copy
            </button>
          </div>
          <pre>{{ entry.md }}</pre>
        </div>
      </section>

      <section v-if="files.length && tab === 'files'" class="panel" role="tabpanel">
        <div class="files">
          <div class="flist" role="group" aria-label="Skill files">
            <button
              v-for="(f, i) in files"
              :key="f.name"
              class="frow"
              type="button"
              :aria-current="i === fileIndex ? 'true' : 'false'"
              :title="f.name"
              @click="fileIndex = i"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
                <path d="M3.6 1.9h5.2l3.6 3.6v8.6H3.6z" />
                <path d="M8.6 1.9v3.8h3.8" />
              </svg>
              <span class="fn">{{ f.name }}</span>
              <span class="fs">{{ f.size }}</span>
            </button>
          </div>
          <div class="fprev">
            <div class="fh">
              <span>{{ currentFile?.name }}</span>
              <span>{{ currentFile?.size }}</span>
            </div>
            <pre>{{ currentFile?.body ?? 'No text preview for this file.' }}</pre>
          </div>
        </div>
        <p class="tnote">
          <span>{{ files.length }} files · {{ item.size }}</span>
          <span>read from {{ item.path }}</span>
        </p>
      </section>

      <p class="page-foot">
        <span>{{ item.name }}{{ version ? ` ${version}` : '' }} · {{ inWorkspace ? 'workspace skill' : 'library skill' }}</span>
        <span>{{ hub.agents.length }} entities · {{ workspaces.skills.length }} skills in this workspace</span>
      </p>
    </template>

    <div v-else-if="!workspaces.library" class="empty-note">
      <b>Reading the harness libraries…</b>
    </div>

    <div v-else class="empty-note">
      <b>No skill called “{{ name }}” on this machine.</b>
      <span>It may live in a different harness library, or the workspace link may be stale.</span>
      <router-link :to="{ name: 'skills', params: { workspace: hub.workspace } }">Back to skills</router-link>
    </div>
  </div>
</template>
