<script setup>
import { computed, ref, watch } from 'vue'
import {
  attachMachine,
  attachSkill,
  detachMachine,
  detachSkill,
  loadHosts,
  loadLibrary,
  workspaces,
  writeMcp,
} from '@/stores/workspaces'
import { hub, toast } from '@/stores/hub'

/**
 * What the workspace owns, editable: which machines it may use, its MCP pool,
 * and which skills it has. Every write goes through the call table — the
 * renderer never touches a file.
 */
const props = defineProps({ open: { type: Boolean, default: false } })
const emit = defineEmits(['close'])

const TAB_IDS = [
  { id: 'machines', label: 'Machines' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP' },
]
const tab = ref('machines')
const mcpText = ref('')
const error = ref('')
const busy = ref('')

const attachedNames = computed(() => new Set(workspaces.skills.map((skill) => skill.name.toLowerCase())))

/** Machine-wide library, minus what this workspace already has. */
const attachableSkills = computed(() => {
  const seen = new Set()
  return (workspaces.library?.items || []).filter((item) => {
    const key = item.name.toLowerCase()
    if (attachedNames.value.has(key) || seen.has(key)) return false
    seen.add(key)
    return true
  })
})

const attachedAliases = computed(() => new Set(workspaces.machines.map((machine) => machine.id)))
const attachableHosts = computed(() =>
  (workspaces.hosts || []).filter((host) => !attachedAliases.value.has(host.alias)),
)

function syncMcp() {
  const servers = workspaces.mcp?.servers || {}
  mcpText.value = Object.keys(servers).length ? JSON.stringify(servers, null, 2) : '{\n  \n}'
  error.value = ''
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    tab.value = 'machines'
    error.value = ''
    syncMcp()
    if (!workspaces.library) loadLibrary()
    if (!workspaces.hosts.length) loadHosts()
  },
)

watch(() => workspaces.mcp, syncMcp, { deep: true })

async function withBusy(key, fn) {
  if (busy.value) return
  busy.value = key
  error.value = ''
  try {
    await fn()
  } catch (problem) {
    error.value = problem?.message || 'That did not work.'
  } finally {
    busy.value = ''
  }
}

const attachHost = (alias) => withBusy(`host:${alias}`, () => attachMachine(alias))
const removeHost = (alias) => withBusy(`host:${alias}`, () => detachMachine(alias))
const attachOne = (item) =>
  withBusy(`skill:${item.name}`, () => attachSkill({ name: item.name, harness: item.harness }))
const removeSkill = (name) => withBusy(`skill:${name}`, () => detachSkill(name))

async function saveMcp() {
  await withBusy('mcp', async () => {
    let servers
    try {
      servers = mcpText.value.trim() ? JSON.parse(mcpText.value) : {}
    } catch {
      throw new Error('That is not valid JSON.')
    }
    await writeMcp(servers)
  })
  if (!error.value) toast('MCP pool saved')
}
</script>

<template>
  <div class="modal modal-settings" :data-open="open ? '1' : '0'" role="dialog" aria-modal="true" aria-label="Workspace settings">
    <div class="mo-head">
      <h2>Workspace · {{ hub.workspaceLabel || workspaces.active }}</h2>
      <p class="mnote">{{ workspaces.mcp.path ? workspaces.mcp.path.replace(/mcp\.json$/, '') : '' }}</p>
      <button class="x mo-x" aria-label="Close" @click="emit('close')">
        <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5">
          <path d="M2 2l8 8M10 2l-8 8" />
        </svg>
      </button>
    </div>

    <div class="tabs" role="tablist">
      <button
        v-for="entry in TAB_IDS"
        :key="entry.id"
        role="tab"
        :aria-selected="tab === entry.id ? 'true' : 'false'"
        @click="tab = entry.id; error = ''"
      >
        {{ entry.label }}
      </button>
    </div>

    <div class="mo-body">
      <template v-if="tab === 'machines'">
        <p class="mnote">
          Attached machines are the ones this workspace may use. <b>local</b> is this
          Mac and is always allowed.
        </p>
        <div class="ws-list">
          <div v-for="machine in workspaces.machines" :key="machine.id" class="ws-row">
            <span class="ws-nm">
              {{ machine.label }}
              <em v-if="machine.thisMachine">this machine</em>
              <em v-else-if="machine.missing" class="bad">missing from ssh config</em>
            </span>
            <span class="ws-spec mono">{{ machine.spec || machine.id }}</span>
            <button
              v-if="!machine.thisMachine"
              class="btn btn-sm"
              type="button"
              :disabled="busy === `host:${machine.id}`"
              @click="removeHost(machine.id)"
            >
              Detach
            </button>
          </div>
        </div>
        <p class="mnote">
          A host missing from <code class="mono">~/.ssh/config</code> stays attached and shows
          as missing — the entry is your intent, not a cache.
        </p>

        <div class="sec-head" style="margin: 16px 0 6px">
          <h2 style="font-size: 12px">From the fleet</h2>
          <span class="meta">{{ attachableHosts.length }}</span>
        </div>
        <div v-if="attachableHosts.length" class="picks picks--scroll">
          <button
            v-for="host in attachableHosts"
            :key="host.id"
            class="pick"
            type="button"
            :disabled="busy === `host:${host.alias}`"
            :title="host.spec"
            @click="attachHost(host.alias)"
          >
            {{ host.alias }}
          </button>
        </div>
        <p v-else class="mnote">Every host in {{ workspaces.hosts.length ? 'the fleet' : '~/.ssh/config' }} is already attached.</p>
      </template>

      <template v-else-if="tab === 'skills'">
        <div class="ws-list">
          <div v-for="skill in workspaces.skills" :key="skill.name" class="ws-row">
            <span class="ws-nm">
              {{ skill.name }}
              <em v-if="skill.missing" class="bad">target missing</em>
              <em v-else-if="skill.copied" class="bad">copied, not linked</em>
              <em v-else>{{ skill.harnessLabel }}</em>
            </span>
            <span class="ws-spec mono">{{ skill.path }}</span>
            <button
              class="btn btn-sm"
              type="button"
              :disabled="busy === `skill:${skill.name}`"
              @click="removeSkill(skill.name)"
            >
              Detach
            </button>
          </div>
          <p v-if="!workspaces.skills.length" class="mnote">No skills attached yet.</p>
        </div>

        <div class="sec-head" style="margin: 16px 0 6px">
          <h2 style="font-size: 12px">On this machine</h2>
          <span class="meta">{{ attachableSkills.length }}</span>
        </div>
        <div v-if="attachableSkills.length" class="picks picks--scroll">
          <button
            v-for="item in attachableSkills"
            :key="item.id"
            class="pick"
            type="button"
            :disabled="busy === `skill:${item.name}`"
            :title="item.description"
            @click="attachOne(item)"
          >
            {{ item.name }} <span class="pick-meta">{{ item.harnessLabel }}</span>
          </button>
        </div>
        <p v-else class="mnote">Every skill on this machine is already attached.</p>
      </template>

      <template v-else>
        <p class="mnote">
          One pool for the workspace; an entity opts in with <code class="mono">mcp: name</code>.
          <code class="mono">env</code> holds variable <em>names</em> — values resolve from the
          environment at run time and are never written here.
        </p>
        <textarea v-model="mcpText" class="mcp-editor mono" rows="10" spellcheck="false"></textarea>
        <p class="mnote">
          Enforced for <b>claude</b> runs only (<code class="mono">--strict-mcp-config</code>:
          {{ workspaces.mcp.strict ? 'on' : 'off' }}). codex, opencode, pi and gemini manage
          MCP in their own global config.
        </p>
        <button class="btn btn-ink" type="button" :disabled="busy === 'mcp'" @click="saveMcp">
          {{ busy === 'mcp' ? 'Saving…' : 'Save pool' }}
        </button>
      </template>

      <p v-if="error" class="run-warn">{{ error }}</p>
    </div>

    <div class="mo-foot">
      <button class="btn" type="button" @click="emit('close')">Done</button>
    </div>
  </div>
</template>
