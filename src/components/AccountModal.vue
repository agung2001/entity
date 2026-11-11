<script setup>
import { ref, watch } from 'vue'
import {
  changePassword,
  closeAccount,
  credentials,
  DEFAULT_ADMIN,
  hub,
  toast,
  updateAccount,
} from '@/stores/hub'

/* One form for the three things the rail menu promises: handle, email, password.
   The password block stays idle unless one of its fields is touched. */
const username = ref('')
const email = ref('')
const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const error = ref('')
const busy = ref(false)

function reset() {
  const record = credentials()
  username.value = record.username
  email.value = record.email || ''
  currentPassword.value = ''
  newPassword.value = ''
  confirmPassword.value = ''
  error.value = ''
  busy.value = false
}

watch(
  () => hub.account.open,
  (open) => {
    if (open) reset()
  },
)

function close() {
  if (busy.value) return
  closeAccount()
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
    if (newPassword.value === DEFAULT_ADMIN.password) {
      error.value = 'That is the password this hub shipped with — choose a different one.'
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
    updateAccount({ username: handle, email: mail })
    toast('Account updated')
    busy.value = false
    closeAccount()
  } catch (err) {
    error.value = err?.message || 'The account could not be updated.'
    busy.value = false
  }
}
</script>

<template>
  <form
    class="modal acct-modal"
    :data-open="hub.account.open ? '1' : '0'"
    role="dialog"
    aria-modal="true"
    aria-label="Account settings"
    @submit.prevent="save"
  >
    <div class="mo-head">
      <h2>Account</h2>
      <p>Set the handle and email for this hub, or replace the password.</p>
    </div>

    <div class="mo-body">
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
    </div>

    <div class="mo-foot">
      <button class="btn" type="button" :disabled="busy" @click="close">Cancel</button>
      <button class="btn btn-ink" type="submit" :disabled="busy">
        {{ busy ? 'Saving…' : 'Save changes' }}
      </button>
    </div>
  </form>
</template>
