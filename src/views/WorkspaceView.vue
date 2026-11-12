<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ROLES, hub, roleById, toast } from '@/stores/hub'
import {
  activeWorkspace,
  updateWorkspace,
  workspaces,
  writeMcp,
} from '@/stores/workspaces'

/**
 * Workspace settings are a page, not a modal.
 *
 * Only the workspace's own identity lives here — name, id, member roster and the
 * MCP pool. Entities, skills and machines already have pages, so this page does
 * not grow a second copy of their controls.
 */
const router = useRouter()
const current = computed(() => activeWorkspace.value)

const form = reactive({ label: '', id: '', members: [] })
const mcpText = ref('')
const error = ref('')
const mcpError = ref('')
const busy = ref('')
const mcpBusy = ref(false)

const owner = computed(() => roleById(hub.session?.role || 'owner'))
const idChanged = computed(() => Boolean(current.value) && form.id !== current.value.id)
const createdLabel = computed(() =>
  current.value?.createdAt
    ? new Date(current.value.createdAt).toLocaleDateString()
    : '—',
)

function seedMembers(record) {
  if (record?.members?.length) return record.members.map((member) => ({ ...member }))
  return [
    {
      name: hub.session?.user || record?.label || 'owner',
      email: hub.session?.email || '',
      role: hub.session?.role || 'owner',
    },
  ]
}

function syncForm(record) {
  form.label = record?.label || ''
  form.id = record?.id || ''
  form.members = seedMembers(record)
  error.value = ''
}

function syncMcp() {
  const servers = workspaces.mcp?.servers || {}
  mcpText.value = Object.keys(servers).length
    ? JSON.stringify(servers, null, 2)
    : '{\n  \n}'
  mcpError.value = ''
}

watch(current, syncForm, { immediate: true })
watch(() => workspaces.mcp, syncMcp, { deep: true, immediate: true })

function addMember() {
  form.members.push({ name: '', email: '', role: 'member' })
}

function removeMember(index) {
  if (form.members.length <= 1) return
  form.members.splice(index, 1)
}

async function saveGeneral() {
  if (busy.value) return
  error.value = ''
  const label = form.label.trim()
  const id = form.id.trim()
  if (!label) {
    error.value = 'A workspace needs a name.'
    return
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(id)) {
    error.value = 'The id must be lowercase letters, digits and dashes.'
    return
  }

  const members = form.members
    .map((member) => ({
      name: String(member.name || '').trim(),
      email: String(member.email || '').trim(),
      role: member.role || 'member',
    }))
    .filter((member) => member.name || member.email)

  if (members.length && !members.some((member) => member.role === 'owner')) {
    error.value = 'Keep at least one owner in the member list.'
    return
  }

  busy.value = 'general'
  try {
    const record = await updateWorkspace({ label, id, members })
    syncForm(record)
    toast(`${record.label} updated`)
  } catch (problem) {
    error.value = problem?.message || 'The workspace could not be updated.'
  } finally {
    busy.value = ''
  }
}

async function saveMcp() {
  if (mcpBusy.value) return
  mcpError.value = ''
  let servers
  try {
    servers = mcpText.value.trim() ? JSON.parse(mcpText.value) : {}
  } catch {
    mcpError.value = 'That is not valid JSON.'
    return
  }
  mcpBusy.value = true
  try {
    await writeMcp(servers)
    toast('MCP pool saved')
  } catch (problem) {
    mcpError.value = problem?.message || 'The MCP pool could not be saved.'
  } finally {
    mcpBusy.value = false
  }
}
</script>

<template>
  <div class="view">
    <div class="page-head">
      <div>
        <p class="eyebrow">Workspace · {{ current?.label || workspaces.active }}</p>
        <h1>Workspace</h1>
        <p class="lede">
          The record behind this scope: its name, its directory id, who belongs to it and
          which MCP servers the workspace carries. Entities, skills and machines stay on their
          own pages.
        </p>
      </div>
      <div class="head-actions">
        <button class="btn" type="button" @click="router.push('/')">Back to overview</button>
      </div>
    </div>

    <div class="acct-page ws-page">
      <form class="acct-card" @submit.prevent="saveGeneral">
        <div class="acct-card-head">
          <h2>General</h2>
          <span class="role-badge">{{ current?.kind || 'local' }}</span>
        </div>

        <div class="fld">
          <label class="lbl" for="ws-label">Name</label>
          <input
            id="ws-label"
            v-model="form.label"
            class="acct-input"
            type="text"
            spellcheck="false"
            :disabled="busy === 'general'"
          />
          <p class="mnote">The label shown in the rail and page headings.</p>
        </div>

        <div class="fld">
          <label class="lbl" for="ws-id">Workspace ID</label>
          <input
            id="ws-id"
            v-model="form.id"
            class="acct-input mono"
            type="text"
            spellcheck="false"
            :disabled="busy === 'general'"
          />
          <p class="mnote">
            The folder name under <code class="mono">~/.entity/workspaces/</code>.
            <template v-if="idChanged">
              Saving moves the directory and updates this window's scope.
            </template>
            <template v-else>Changing it moves the whole workspace directory.</template>
          </p>
        </div>

        <div class="acct-sep">
          <span>Members</span>
          <small>at least one owner</small>
        </div>

        <div class="member-list">
          <div v-for="(member, index) in form.members" :key="index" class="member-row">
            <input
              v-model="member.name"
              class="acct-input"
              type="text"
              placeholder="Name"
              spellcheck="false"
              :disabled="busy === 'general'"
            />
            <input
              v-model="member.email"
              class="acct-input"
              type="email"
              placeholder="email@example.com"
              spellcheck="false"
              :disabled="busy === 'general'"
            />
            <select v-model="member.role" class="acct-input" :disabled="busy === 'general'">
              <option v-for="entry in ROLES" :key="entry.id" :value="entry.id">
                {{ entry.label }}
              </option>
            </select>
            <button
              class="btn btn-sm btn-ghost"
              type="button"
              :disabled="busy === 'general' || form.members.length <= 1"
              @click="removeMember(index)"
            >
              Remove
            </button>
          </div>
        </div>

        <button class="btn btn-sm" type="button" :disabled="busy === 'general'" @click="addMember">
          Add member
        </button>
        <p class="mnote" style="margin-top: 8px">
          This build signs in one account per machine. The roster is stored with the workspace,
          so a later multi-account step has the roles already in place.
        </p>

        <p v-if="error" class="acct-error" role="alert">{{ error }}</p>

        <div class="acct-actions">
          <button class="btn" type="button" :disabled="busy === 'general'" @click="router.push('/')">
            Cancel
          </button>
          <button class="btn btn-ink" type="submit" :disabled="busy === 'general'">
            {{ busy === 'general' ? 'Saving…' : 'Save changes' }}
          </button>
        </div>
      </form>

      <aside class="role-card">
        <h2>Workspace record</h2>
        <dl class="ws-meta">
          <dt>Path</dt>
          <dd class="mono">{{ current?.displayPath || '—' }}</dd>
          <dt>Kind</dt>
          <dd>{{ current?.kind || 'local' }}</dd>
          <dt>Created</dt>
          <dd>{{ createdLabel }}</dd>
          <dt>Your role</dt>
          <dd>{{ owner.label }}</dd>
        </dl>

        <div class="acct-sep"><span>Roles</span></div>
        <ul class="role-list">
          <li v-for="entry in ROLES" :key="entry.id" :data-on="entry.id === owner.id ? '1' : '0'">
            <b>{{ entry.label }}</b>
            <span>{{ entry.desc }}</span>
          </li>
        </ul>
      </aside>
    </div>

    <section class="acct-card ws-mcp">
      <div class="acct-card-head">
        <h2>MCP pool</h2>
        <span class="mnote">{{ workspaces.mcp?.path || '' }}</span>
      </div>
      <p class="mnote">
        One pool for the workspace; an entity opts in with <code class="mono">mcp: name</code>.
        <code class="mono">env</code> holds variable <em>names</em> — values resolve from the
        environment when a chat starts and are never written here.
      </p>
      <textarea
        v-model="mcpText"
        class="mcp-editor mono"
        rows="10"
        spellcheck="false"
        :disabled="mcpBusy"
      ></textarea>
      <p class="mnote">
        Enforced for <b>claude</b> conversations only (<code class="mono">--strict-mcp-config</code>:
        {{ workspaces.mcp.strict ? 'on' : 'off' }}). codex, opencode, pi and gemini manage MCP
        in their own global config.
      </p>
      <p v-if="mcpError" class="acct-error" role="alert">{{ mcpError }}</p>
      <div class="acct-actions">
        <button class="btn btn-ink" type="button" :disabled="mcpBusy" @click="saveMcp">
          {{ mcpBusy ? 'Saving…' : 'Save pool' }}
        </button>
      </div>
    </section>
  </div>
</template>
