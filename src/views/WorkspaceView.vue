<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ActivityView from '@/views/ActivityView.vue'
import SkillsView from '@/views/SkillsView.vue'
import McpView from '@/views/McpView.vue'
import MachinesView from '@/views/MachinesView.vue'
import { ROLES, hub, roleById, toast } from '@/stores/hub'
import { activeWorkspace, updateWorkspace } from '@/stores/workspaces'

/**
 * Workspace settings are a page, not a modal. General and Members are separate
 * tabs because they are different jobs: one changes the record, the other
 * manages who belongs to it.
 */
const router = useRouter()
const route = useRoute()
const current = computed(() => activeWorkspace.value)
const TABS = ['general', 'members', 'skills', 'mcp', 'machines', 'activity']
const tab = ref(TABS.includes(String(route.query.tab)) ? String(route.query.tab) : 'general')

/* The tab is part of the URL, so a link can land on Activity and Back works. */
function setTab(next) {
  tab.value = next
  error.value = ''
  const query = { ...route.query }
  if (next === 'general') delete query.tab
  else query.tab = next
  router.replace({ name: 'workspace', params: { workspace: route.params.workspace }, query })
}

watch(
  () => route.query.tab,
  (value) => {
    const next = TABS.includes(String(value)) ? String(value) : 'general'
    if (next !== tab.value) tab.value = next
  },
)

const form = reactive({ label: '', id: '', members: [] })
const error = ref('')
const busy = ref('')

const owner = computed(() => roleById(hub.session?.role || 'owner'))

const idChanged = computed(() => Boolean(current.value) && form.id !== current.value.id)
const createdLabel = computed(() =>
  current.value?.createdAt
    ? new Date(current.value.createdAt).toLocaleDateString()
    : '—',
)

function seedMembers(record) {
  if (record?.members?.length) {
    const members = record.members.map((member) => ({ ...member }))
    /* Older workspaces were created under the bootstrap admin identity before
       this machine had a real account. Once someone is signed in, show them as
       the owner rather than carrying that placeholder into the members form. */
    const bootstrap =
      members.length === 1 &&
      members[0].name === 'admin' &&
      members[0].email === 'admin@studio-mac'
    if (bootstrap && hub.session?.email && hub.session.email !== members[0].email) {
      return [{ name: hub.session.user, email: hub.session.email, role: 'owner' }]
    }
    return members
  }
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

watch(current, syncForm, { immediate: true })

function addMember() {
  form.members.push({ name: '', email: '', role: 'member' })
}

function removeMember(index) {
  if (form.members.length <= 1) return
  form.members.splice(index, 1)
}

async function save() {
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

  let members
  if (tab.value === 'members') {
    members = form.members
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
  }

  busy.value = tab.value
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
</script>

<template>
  <div class="view">
    <div v-if="tab === 'general' || tab === 'members'" class="acct-page ws-page">
      <form class="acct-card" @submit.prevent="save">
        <template v-if="tab === 'general'">
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
        </template>

        <template v-else>
          <div class="acct-card-head">
            <h2>Members</h2>
            <span class="mnote">at least one owner</span>
          </div>

          <div class="member-list">
            <div v-for="(member, index) in form.members" :key="index" class="member-row">
              <input
                v-model="member.name"
                class="acct-input"
                type="text"
                placeholder="Name"
                spellcheck="false"
                :disabled="busy === 'members'"
              />
              <input
                v-model="member.email"
                class="acct-input"
                type="email"
                placeholder="email@example.com"
                spellcheck="false"
                :disabled="busy === 'members'"
              />
              <select v-model="member.role" class="acct-input" :disabled="busy === 'members'">
                <option v-for="entry in ROLES" :key="entry.id" :value="entry.id">
                  {{ entry.label }}
                </option>
              </select>
              <button
                class="btn btn-sm btn-ghost"
                type="button"
                :disabled="busy === 'members' || form.members.length <= 1"
                @click="removeMember(index)"
              >
                Remove
              </button>
            </div>
          </div>

          <button class="btn btn-sm" type="button" :disabled="busy === 'members'" @click="addMember">
            Add member
          </button>
          <p class="mnote" style="margin-top: 8px">
            This build signs in one account per machine. The roster is stored with the
            workspace, so a later multi-account step has the roles already in place.
          </p>
        </template>

        <p v-if="error" class="acct-error" role="alert">{{ error }}</p>

        <div class="acct-actions">
          <button class="btn" type="button" :disabled="busy" @click="router.push({ name: 'overview', params: { workspace: route.params.workspace } })">
            Cancel
          </button>
          <button class="btn btn-ink" type="submit" :disabled="busy">
            {{ busy ? 'Saving…' : tab === 'general' ? 'Save general' : 'Save members' }}
          </button>
        </div>
      </form>

      <aside class="role-card">
        <template v-if="tab === 'general'">
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
        </template>

        <template v-else>
          <h2>Roles</h2>
          <p class="mnote">What each role may change in this workspace.</p>
          <ul class="role-list">
            <li v-for="entry in ROLES" :key="entry.id" :data-on="entry.id === owner.id ? '1' : '0'">
              <b>{{ entry.label }}</b>
              <span>{{ entry.desc }}</span>
            </li>
          </ul>
        </template>
      </aside>
    </div>

    <SkillsView v-else-if="tab === 'skills'" embedded />
    <McpView v-else-if="tab === 'mcp'" embedded />
    <MachinesView v-else-if="tab === 'machines'" embedded />
    <ActivityView v-else embedded />
  </div>
</template>
