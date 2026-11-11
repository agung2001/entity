<script setup>
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import CopySkillModal from '@/components/CopySkillModal.vue'
import EntityMark from '@/components/EntityMark.vue'
import { HARNESSES } from '@/data/mock'
import {
  hub,
  openDrawer,
  skillByName,
  skillCoverage,
  skillDetail,
  skillOwners,
  toast,
} from '@/stores/hub'

const route = useRoute()
const name = computed(() => String(route.params.name || ''))
const skill = computed(() => skillByName(name.value))
const detail = computed(() => skillDetail(name.value))

const coverage = computed(() => skillCoverage(name.value))
const usedBy = computed(() => skillOwners(name.value))
const version = computed(() => detail.value?.version || null)

const synced = computed(() => coverage.value.filter((c) => c.state === 'sync').length)
const installed = computed(() => coverage.value.filter((c) => c.state !== 'none').length)
const behind = computed(() => coverage.value.filter((c) => c.state === 'behind').length)
const thisMachine = computed(() => hub.machines.find((m) => m.thisMachine) || hub.machines[0])

const tab = ref('overview')
const fileIndex = ref(0)
const copyOpen = ref(false)
const copyPreset = ref(null)

const tabs = computed(() => {
  const list = [{ id: 'overview', label: 'Overview' }]
  if (detail.value) {
    list.push({ id: 'md', label: 'SKILL.md' })
    list.push({ id: 'files', label: `Files`, count: detail.value.files.length })
    list.push({ id: 'runs', label: 'Runs', count: detail.value.runTotal })
  }
  return list
})

const currentFile = computed(() => detail.value?.files[fileIndex.value] || null)
const copyOf = computed(() => detail.value?.md || '')

/* a new skill is a new page: tabs and file selection start over */
watch(name, () => {
  tab.value = 'overview'
  fileIndex.value = 0
  copyOpen.value = false
  copyPreset.value = null
})

function selectTab(id) {
  tab.value = id
}

function onTabKey(e) {
  const list = tabs.value
  const i = list.findIndex((t) => t.id === tab.value)
  if (e.key === 'Home' || e.key === 'End' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault()
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? list.length - 1
          : (i + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length
    tab.value = list[next].id
  }
}

function openCopy(machineId = null) {
  copyPreset.value = machineId
  copyOpen.value = true
}

function copyMd() {
  const text = detail.value?.md || ''
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(
      () => toast('SKILL.md copied'),
      () => toast('Copy blocked by the browser'),
    )
  } else {
    toast('Copy blocked by the browser')
  }
}

const versionLabel = (row) => {
  if (row.state === 'none') return '—'
  return row.version && row.version !== 'installed' ? row.version : '—'
}
</script>

<template>
  <div class="view">
    <template v-if="skill">
      <header class="sk-head">
        <div>
          <p class="eyebrow">Skill <span class="sep">·</span> Library</p>
          <div class="sk-title">
            <h1>{{ name }}</h1>
            <span v-if="version" class="vtag">{{ version }}</span>
          </div>
          <p class="sk-path">~/.entity/skills/{{ name }}</p>
          <p class="lede">
            {{
              detail
                ? detail.lede
                : 'This skill is in the library, but no entry file, manifest or run history has been recorded for it yet.'
            }}
          </p>
        </div>
        <div class="sk-actions">
          <button v-if="detail" class="btn btn-ink" type="button" @click="openCopy()">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
              <rect x="2.2" y="2.2" width="8.4" height="8.4" rx="1.6" />
              <path d="M5.6 13.8h7.1a1 1 0 001-1V5.6" />
            </svg>
            Copy to machine
          </button>
        </div>
      </header>

      <div class="meta-strip">
        <div>
          <span class="k">Version</span>
          <span class="v mono">{{ version ? `${version} · latest` : 'not recorded' }}</span>
        </div>
        <div>
          <span class="k">Runtime</span>
          <span class="v mono">{{ detail?.runtime || 'not recorded' }}</span>
        </div>
        <div>
          <span class="k">Installed</span>
          <span class="v">{{ installed }} of {{ hub.machines.length }} machines</span>
        </div>
        <div>
          <span class="k">Used by</span>
          <span class="v">{{ usedBy.length }} {{ usedBy.length === 1 ? 'entity' : 'entities' }}</span>
        </div>
        <div>
          <span class="k">Last run</span>
          <span class="v">{{ detail?.runs?.[0]?.t || '—' }}</span>
        </div>
      </div>

      <div class="sk-tabs" role="tablist" aria-label="Skill sections" @keydown="onTabKey">
        <button
          v-for="t in tabs"
          :key="t.id"
          role="tab"
          :aria-selected="tab === t.id ? 'true' : 'false'"
          :tabindex="tab === t.id ? 0 : -1"
          @click="selectTab(t.id)"
        >
          {{ t.label }}<span v-if="t.count" class="n">{{ t.count }}</span>
        </button>
      </div>

      <!-- overview -->
      <section v-show="tab === 'overview'" class="panel" role="tabpanel">
        <div class="ov">
          <div>
            <template v-if="detail">
              <div class="blk">
                <h2>What it does <span class="k">— {{ detail.behaviours.length }} behaviours</span></h2>
                <p>{{ detail.what }}</p>
                <ul class="caps">
                  <li v-for="b in detail.behaviours" :key="b.k">
                    <b>{{ b.k }}</b><span>{{ b.d }}</span>
                  </li>
                </ul>
              </div>

              <div class="blk">
                <h2>How entities call it <span class="k">— slash command</span></h2>
                <pre class="code">{{ detail.invoke.cmd }}

<span class="cm">{{ detail.invoke.out }}</span></pre>
                <div class="harness" aria-label="Harnesses that expose the command">
                  <span v-for="h in HARNESSES" :key="h.id">{{ h.label }}</span>
                </div>
              </div>
            </template>

            <div class="blk">
              <h2>Machines <span class="k">— where the directory lives</span></h2>
              <div class="cov">
                <div class="row head" aria-hidden="true">
                  <span>Machine</span><span class="ver">Version</span><span>State</span>
                  <span class="sync">Last sync</span><span></span>
                </div>
                <div
                  v-for="row in coverage"
                  :key="row.machine.id"
                  class="row"
                >
                  <div class="m">
                    <div class="nm">
                      {{ row.machine.label }}
                      <span v-if="row.machine.thisMachine" style="color: var(--muted)">· this machine</span>
                    </div>
                    <div class="d">{{ row.machine.desc }}</div>
                  </div>
                  <span class="ver">{{ versionLabel(row) }}</span>
                  <span>
                    <span class="st" :data-s="row.state">
                      <i></i>{{
                        row.state === 'sync'
                          ? 'in sync'
                          : row.state === 'behind'
                            ? 'behind'
                            : row.state === 'installed'
                              ? 'installed'
                              : 'not installed'
                      }}
                    </span>
                  </span>
                  <span class="sync">{{ row.last }}</span>
                  <span class="actcell">
                    <button
                      v-if="detail && row.state !== 'sync'"
                      class="btn btn-sm"
                      type="button"
                      @click="openCopy(row.machine.id)"
                    >
                      Copy
                    </button>
                  </span>
                </div>
              </div>
              <p class="tnote">
                <span v-if="detail">
                  {{ synced }} in sync · {{ behind }} behind ·
                  {{ detail.manifest.files.split(' · ')[1] }} per copy
                </span>
                <span v-else>
                  {{ installed }} of {{ hub.machines.length }} machines · no version recorded
                </span>
                <span>copied over ssh</span>
              </p>
            </div>

            <div class="blk">
              <h2>Used by <span class="k">— {{ usedBy.length }} entities</span></h2>
              <div class="ents">
                <button
                  v-for="a in usedBy"
                  :key="a.id"
                  class="ent"
                  type="button"
                  @click="openDrawer(a.id)"
                >
                  <EntityMark />
                  <span class="who">
                    <span class="nm">{{ a.name }}</span>
                    <span class="rt">{{ a.runtime }} · {{ a.model }}</span>
                  </span>
                  <span class="where" :data-empty="a.machines.length ? undefined : '1'">
                    {{ a.machines.length ? a.machines.join(', ') : 'no machine yet' }}
                  </span>
                </button>
              </div>
              <p class="tnote">
                <span>A skill is only portable if the machine has the runtime it expects.</span>
                <span>{{ detail?.requires.runtime || 'runtime not recorded' }}</span>
              </p>
            </div>
          </div>

          <aside>
            <template v-if="detail">
              <div class="skill-card">
                <h3>Manifest</h3>
                <dl class="kv">
                  <dt>Entry</dt><dd>{{ detail.manifest.entry }}</dd>
                  <dt>Files</dt><dd>{{ detail.manifest.files }}</dd>
                  <dt>License</dt><dd>{{ detail.manifest.license }}</dd>
                  <dt>Source</dt><dd>{{ detail.manifest.source }}</dd>
                </dl>
              </div>

              <div class="skill-card">
                <h3>Requires</h3>
                <dl class="kv">
                  <dt>Runtime</dt><dd>{{ detail.requires.runtime }}</dd>
                  <dt>Network</dt><dd>{{ detail.requires.network }}</dd>
                  <dt>Browser</dt><dd>{{ detail.requires.browser }}</dd>
                  <dt>Memory</dt><dd>{{ detail.requires.memory }}</dd>
                </dl>
              </div>

              <div class="skill-card">
                <h3>Works with</h3>
                <div class="chips2">
                  <span v-for="r in detail.related" :key="r">{{ r }}</span>
                </div>
              </div>
            </template>

            <div v-else class="skill-card">
              <h3>Manifest</h3>
              <dl class="kv">
                <dt>Path</dt><dd>~/.entity/skills/{{ name }}</dd>
                <dt>Owners</dt><dd>{{ usedBy.length }}</dd>
                <dt>Machines</dt><dd>{{ installed }}</dd>
                <dt>License</dt><dd>not recorded</dd>
              </dl>
            </div>
          </aside>
        </div>
      </section>

      <!-- SKILL.md -->
      <section v-if="detail && tab === 'md'" class="panel" role="tabpanel">
        <div class="doc">
          <div class="doc-head">
            <span class="fn">SKILL.md <span>2.4 KB · edited 6 days ago</span></span>
            <button class="btn btn-sm" type="button" @click="copyMd">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
                <rect x="2.2" y="2.2" width="8.4" height="8.4" rx="1.6" />
                <path d="M5.6 13.8h7.1a1 1 0 001-1V5.6" />
              </svg>
              Copy
            </button>
          </div>
          <pre>{{ copyOf }}</pre>
        </div>
      </section>

      <!-- files -->
      <section v-if="detail && tab === 'files'" class="panel" role="tabpanel">
        <div class="files">
          <div class="flist" role="group" aria-label="Skill files">
            <button
              v-for="(f, i) in detail.files"
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
            <pre>{{ currentFile?.body }}</pre>
          </div>
        </div>
        <p class="tnote">
          <span>The whole directory is what moves — references and scripts travel with the entry file.</span>
          <span>{{ detail.files.length }} files · 8.8 KB</span>
        </p>
      </section>

      <!-- runs -->
      <section v-if="detail && tab === 'runs'" class="panel" role="tabpanel">
        <div class="runs">
          <div class="run head" aria-hidden="true">
            <span>Started</span><span>Entity</span><span>Machine</span><span class="har">Harness</span>
            <span class="dur" style="text-align: right">Time</span>
            <span style="text-align: right">Result</span>
          </div>
          <div v-for="(r, i) in detail.runs" :key="i" class="run">
            <span class="t">{{ r.t }}</span>
            <span class="who">{{ r.who }}</span>
            <span class="mach">{{ r.mach }}</span>
            <span class="har">{{ r.har }}</span>
            <span class="dur">{{ r.dur }}</span>
            <span class="res" :data-s="r.res === 'ok' ? 'ok' : r.res === 'fail' ? 'fail' : undefined">
              <i></i>{{ r.res === 'fail' ? 'stopped' : r.res }}
            </span>
          </div>
        </div>
        <p class="tnote">
          <span>Last {{ detail.runs.length }} of {{ detail.runTotal }} runs · 1 stopped at the 40-page cap.</span>
          <span>runs are local, never uploaded</span>
        </p>
      </section>

      <p class="page-foot">
        <span>{{ name }}{{ version ? ` ${version}` : '' }} · one directory, copied over ssh</span>
        <span>sample workspace · {{ hub.agents.length }} entities, {{ hub.machines.length }} machines</span>
      </p>

      <CopySkillModal
        v-if="detail"
        :open="copyOpen"
        :skill-name="name"
        :preset="copyPreset"
        @close="copyOpen = false"
      />
    </template>

    <div v-else class="empty-note">
      <b>No skill called “{{ name }}” in this library.</b>
      <router-link to="/skills">Back to skills</router-link>
    </div>
  </div>
</template>
