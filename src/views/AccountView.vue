<script setup>
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import McpAccountPanel from '@/components/McpAccountPanel.vue'
import {
  changePassword,
  credentials,
  roleById,
  toast,
  updateAccount,
} from '@/stores/hub'
import { displayNameFrom, gravatarUrl } from '@/lib/gravatar'
import { activeWorkspace } from '@/stores/workspaces'

/**
 * Account is a page, not a modal. The handle and email identify this hub; the
 * role says what this person may do inside the workspace. The password block
 * stays idle unless one of its fields is touched.
 */
const router = useRouter()
const record = credentials()
const tab = ref('profile')

const username = ref(record.username)
const email = ref(record.email || '')
const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const error = ref('')
const busy = ref(false)

const role = computed(() => roleById(record.role))
const displayName = computed(() =>
  displayNameFrom(username.value || email.value, username.value || 'Account'),
)
const avatarUrl = computed(() => gravatarUrl(email.value || record.email, 112))

const people = computed(() => {
  const members = activeWorkspace.value?.members || []
  if (members.length) return members
  return [{ name: username.value || record.username, email: email.value || record.email, role: record.role }]
})
const peopleStats = computed(() => ({
  total: people.value.length,
  owners: people.value.filter((person) => person.role === 'owner').length,
  admins: people.value.filter((person) => person.role === 'admin').length,
  members: people.value.filter((person) => person.role === 'member').length,
}))
const personName = (person) => person.name || displayNameFrom(person.email, 'Member')
const personInitials = (person) =>
  personName(person)
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || '?'
const personAvatar = (person) => gravatarUrl(person.email, 56)

function cancel() {
  router.push('/')
}

async function save() {
  if (busy.value) return
  error.value = ''

  const handle = username.value.trim()
  if (!handle) {
    error.value = 'A username is required.'
    return
  }
  if (!/^[a-z0-9._-]+$/i.test(handle)) {
    error.value = 'Use letters, numbers, dots, dashes or underscores for the username.'
    return
  }

  const mail = email.value.trim()
  if (!mail) {
    error.value = 'An email is required.'
    return
  }
  if (!/^[^\s@]+@[^\s@]+$/.test(mail)) {
    error.value = 'That email does not look right.'
    return
  }

  const changingPassword = Boolean(currentPassword.value || newPassword.value || confirmPassword.value)
  if (changingPassword) {
    if (!currentPassword.value) {
      error.value = 'Enter the current password.'
      return
    }
    if (newPassword.value.length < 6) {
      error.value = 'The new password needs at least 6 characters.'
      return
    }
    if (confirmPassword.value !== newPassword.value) {
      error.value = 'The two new passwords do not match.'
      return
    }
  }

  busy.value = true
  try {
    if (changingPassword) {
      const result = await changePassword(currentPassword.value, newPassword.value)
      if (!result.ok) {
        error.value = result.message
        busy.value = false
        return
      }
    }
    await updateAccount({ username: handle, email: mail })
    currentPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
    toast('Account updated')
  } catch (err) {
    error.value = err?.message || 'The account could not be updated.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="view">
    <div class="page-head">
      <div>
        <p class="eyebrow">Hub · this machine</p>
        <h1>Account</h1>
        <p class="lede">
          Set the handle and email for this hub, or replace the password. Your role decides what
          you can change inside a workspace.
        </p>
      </div>
    </div>

    <div class="sk-tabs" role="tablist" aria-label="Account scope">
      <button
        role="tab"
        :aria-selected="tab === 'profile' ? 'true' : 'false'"
        @click="tab = 'profile'"
      >
        Profile
      </button>
      <button
        role="tab"
        :aria-selected="tab === 'mcp' ? 'true' : 'false'"
        @click="tab = 'mcp'"
      >
        MCP
      </button>
    </div>

    <div v-if="tab === 'profile'" class="acct-page">
      <form class="acct-card" @submit.prevent="save">
        <div class="acct-card-head acct-profile-head">
          <div class="acct-id">
            <img v-if="avatarUrl" class="acct-avatar" :src="avatarUrl" alt="" />
            <div>
              <h2>Profile</h2>
              <p class="mnote">{{ displayName }} · {{ email || 'no email yet' }}</p>
            </div>
          </div>
          <span class="role-badge">{{ role.label }}</span>
        </div>

        <div class="fld">
          <label class="lbl" for="acct-username">Username</label>
          <input
            id="acct-username"
            v-model="username"
            class="acct-input"
            type="text"
            autocomplete="username"
            spellcheck="false"
            :disabled="busy"
          />
        </div>

        <div class="fld">
          <label class="lbl" for="acct-email">Email</label>
          <input
            id="acct-email"
            v-model="email"
            class="acct-input"
            type="email"
            autocomplete="email"
            spellcheck="false"
            :disabled="busy"
          />
        </div>

        <div class="fld">
          <span class="lbl">Role</span>
          <div class="role-line">
            <span class="role-badge">{{ role.label }}</span>
            <span>{{ role.desc }}</span>
          </div>
        </div>

        <div class="acct-sep">
          <span>Password</span>
          <small>leave blank to keep the current one</small>
        </div>

        <div class="fld">
          <label class="lbl" for="acct-current">Current password</label>
          <input
            id="acct-current"
            v-model="currentPassword"
            class="acct-input"
            type="password"
            autocomplete="current-password"
            :disabled="busy"
          />
        </div>

        <div class="fld">
          <label class="lbl" for="acct-new">New password</label>
          <input
            id="acct-new"
            v-model="newPassword"
            class="acct-input"
            type="password"
            autocomplete="new-password"
            :disabled="busy"
          />
        </div>

        <div class="fld">
          <label class="lbl" for="acct-confirm">Confirm new password</label>
          <input
            id="acct-confirm"
            v-model="confirmPassword"
            class="acct-input"
            type="password"
            autocomplete="new-password"
            :disabled="busy"
          />
        </div>

        <p v-if="error" class="acct-error" role="alert">{{ error }}</p>

        <div class="acct-actions">
          <button class="btn" type="button" :disabled="busy" @click="cancel">Cancel</button>
          <button class="btn btn-ink" type="submit" :disabled="busy">
            {{ busy ? 'Saving…' : 'Save changes' }}
          </button>
        </div>
      </form>

      <aside class="role-card people-card">
        <h2>People</h2>
        <p class="mnote">Members recorded in this workspace.</p>
        <div class="people-stats">
          <div><b>{{ peopleStats.total }}</b><span>members</span></div>
          <div><b>{{ peopleStats.owners }}</b><span>owners</span></div>
          <div><b>{{ peopleStats.admins }}</b><span>admins</span></div>
        </div>
        <ul class="people-list">
          <li v-for="person in people" :key="person.email || person.name">
            <img v-if="personAvatar(person)" class="people-avatar" :src="personAvatar(person)" alt="" />
            <span v-else class="people-avatar people-avatar--text">{{ personInitials(person) }}</span>
            <span class="people-id">
              <b>{{ personName(person) }}</b>
              <span>{{ person.email || 'no email' }}</span>
            </span>
            <span class="role-badge">{{ roleById(person.role).label }}</span>
          </li>
        </ul>
        <p v-if="!activeWorkspace?.members?.length" class="mnote people-note">
          This workspace has no members file yet. The signed-in account is shown.
        </p>
      </aside>
    </div>

    <McpAccountPanel v-else />
  </div>
</template>
