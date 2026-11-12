<script setup>
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  changePassword,
  credentials,
  roleById,
  toast,
  updateAccount,
} from '@/stores/hub'
import { displayNameFrom, gravatarUrl } from '@/lib/gravatar'
import { workspaces } from '@/stores/workspaces'

/**
 * Profile is the identity half of the account: handle, email, role and
 * password. Workspace membership belongs to the workspace, not here.
 */
const router = useRouter()
const record = credentials()

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
  <div class="acct-page">
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

    <aside class="role-card account-card">
      <h2>This account</h2>
      <dl class="ws-meta">
        <dt>Handle</dt>
        <dd>{{ username || '—' }}</dd>
        <dt>Email</dt>
        <dd>{{ email || '—' }}</dd>
        <dt>Role</dt>
        <dd>{{ role.label }}</dd>
        <dt>Workspaces</dt>
        <dd>{{ workspaces.items.length }}</dd>
      </dl>
      <p class="mnote account-card-note">
        Workspace membership is managed in <b>Workspace → Members</b>. This page only
        changes the account signed in on this machine.
      </p>
    </aside>
  </div>
</template>
