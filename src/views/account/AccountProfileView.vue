<script setup>
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  changePassword,
  credentials,
  initials,
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
/* The crest is the *saved* address's Gravatar: typing must not fire a request
   per keystroke, and a save is what changes this identity. */
const savedEmail = computed(() => credentials().email || '')
const avatarUrl = computed(() => gravatarUrl(savedEmail.value, 224))
/* Gravatar can 404, be blocked or not exist; the tile then keeps its size and
   shows the initials, so the hero never reflows between the two states. */
const avatarOk = ref(true)
watch(avatarUrl, () => {
  avatarOk.value = true
})
/* `initials(displayName)` — except for an account with neither a handle nor an
   address: it displays as `Account`, which would initial to `ac`, while the
   issue's state 4 asks for `as` (the rail's own default mark, AppRail.vue:294). */
const initialsOf = computed(() =>
  username.value || email.value ? initials(displayName.value) : 'as',
)

/* The address is a secret on screen — this page is recorded for tutorials. */
const emailShown = ref(false)

/* the plural pattern is `OverviewView.vue:50`'s: `1 workspace`, `0 workspaces` */
const plural = (n, one, many) => (n === 1 ? one : many)
/* `plural` returns the word alone; a label needs the count in front of it */
const countLabel = (n, one, many) => `${n} ${plural(n, one, many)}`
const workspaceChip = computed(() => countLabel(workspaces.items.length, 'workspace', 'workspaces'))

/* ── the profile's experience ─────────────────────────────────────────────
   A person has no turns of their own here — the account page is not a
   workspace — so the number describes the hub this account signs in on: what it
   holds, not how much carnage is in it. It reads only what `workspace.list`
   already returned (`counts.entities` / `counts.skills`), so the hero paints
   with no request of its own, and it keeps the app's one rung
   (`floor(xp / 100) + 1`, the same as Activity and the crew) so `LV 03` means
   one thing everywhere.

   The weights say content is worth more than containers: a workspace alone is
   10, each entity 5, each attached skill 2 — so 14 empty workspaces is LV 02,
   and the same 14 full of work is not.
   ponytail: an entity or a skill attached in three workspaces counts three
   times, because the hub genuinely holds three copies. The ceiling is that a
   bigger hub levels faster; it is not a measure of how much someone shipped. */
const experience = computed(() =>
  (workspaces.items || []).reduce(
    (sum, entry) =>
      sum + 10 + (entry?.counts?.entities || 0) * 5 + (entry?.counts?.skills || 0) * 2,
    0,
  ),
)
const level = computed(() => Math.floor(experience.value / 100) + 1)
const levelXp = computed(() => experience.value % 100)
const levelLabel = computed(() => String(level.value).padStart(2, '0'))
const entityTotal = computed(() =>
  (workspaces.items || []).reduce((sum, entry) => sum + (entry?.counts?.entities || 0), 0),
)
/* No address is interpolated here: the page is recorded, and the saved address
   is already four lines below in its own field. */
const lede = computed(() =>
  savedEmail.value
    ? "Signed in on this machine. Your handle, portrait and password live here; which workspaces you belong to is each workspace's business."
    : 'No email on this account yet — add one below and the portrait follows from Gravatar.',
)

function cancel() {
  router.push({ name: 'overview', params: { workspace: workspaces.active } })
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
    emailShown.value = false
    toast('Account updated')
  } catch (err) {
    error.value = err?.message || 'The account could not be updated.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="acct-shelf">
    <section class="acct-hero" aria-labelledby="acct-name">
      <div class="acct-hero-in">
        <span class="acct-crest">
          <img v-if="avatarOk && avatarUrl" :src="avatarUrl" alt="" @error="avatarOk = false" />
          <span v-else class="acct-initials" aria-hidden="true">{{ initialsOf }}</span>
        </span>
        <div class="acct-title">
          <p class="eyebrow">Account <span class="sep">·</span> this machine</p>
          <h1 id="acct-name">{{ displayName }}</h1>
          <p class="acct-lede">{{ lede }}</p>
          <div class="acct-chips">
            <span class="acct-chip">{{ role.label }}</span>
            <span v-if="savedEmail" class="acct-chip" data-ok="1">Email set</span>
            <span v-else class="acct-chip" data-ok="0">No email</span>
            <span class="acct-chip">{{ workspaceChip }}</span>
          </div>
        </div>
        <aside
          class="acct-lv"
          :aria-label="`Level ${level}, ${levelXp} of 100 experience. ${workspaceChip}, ${countLabel(
            entityTotal,
            'entity',
            'entities',
          )}.`"
        >
          <div class="acct-lv-box">
            <span>LV</span>
            <b>{{ levelLabel }}</b>
          </div>
          <div class="acct-lv-main">
            <div class="acct-lv-head">
              <span>Experience</span>
              <b>{{ levelXp }} / 100 XP</b>
            </div>
            <div
              class="acct-lv-track"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="levelXp"
              :aria-valuetext="`${levelXp} of 100 XP to level ${level + 1}`"
            >
              <i :style="{ width: `${levelXp}%` }"></i>
            </div>
            <div class="acct-lv-foot">
              <span>{{ countLabel(entityTotal, 'entity', 'entities') }}</span>
              <span>{{ workspaceChip }}</span>
            </div>
          </div>
        </aside>
      </div>
    </section>

    <div class="acct-page">
      <form class="acct-card" @submit.prevent="save">
        <div class="acct-card-head">
          <div>
            <h2>Profile</h2>
            <p class="mnote">Handle and email are how this hub signs you in.</p>
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
          <div class="acct-email" :data-revealed="emailShown ? '1' : '0'">
            <input
              id="acct-email"
              v-model="email"
              class="acct-input"
              :type="emailShown ? 'text' : 'password'"
              autocomplete="email"
              spellcheck="false"
              :disabled="busy"
            />
            <button
              class="btn acct-eye"
              type="button"
              :aria-pressed="emailShown ? 'true' : 'false'"
              :aria-label="emailShown ? 'Hide email address' : 'Show email address'"
              :disabled="busy"
              @click="emailShown = !emailShown"
            >
              <svg
                class="eye-on"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
                aria-hidden="true"
              >
                <path d="M1.4 8s2.3-4.3 6.6-4.3S14.6 8 14.6 8s-2.3 4.3-6.6 4.3S1.4 8 1.4 8Z" />
                <circle cx="8" cy="8" r="2.2" />
              </svg>
              <svg
                class="eye-off"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
                aria-hidden="true"
              >
                <path d="M1.4 8s2.3-4.3 6.6-4.3S14.6 8 14.6 8s-2.3 4.3-6.6 4.3S1.4 8 1.4 8Z" />
                <circle cx="8" cy="8" r="2.2" />
                <path d="M2.6 13.4 13.4 2.6" />
              </svg>
            </button>
          </div>
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
          <dd class="acct-mail-hidden">
            <span class="dots" aria-hidden="true">•••••••••••</span>
            <span class="sr-only">Hidden — reveal in the Email field</span>
          </dd>
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
  </div>
</template>
