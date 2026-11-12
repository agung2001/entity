<script setup>
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BrandMark from '@/components/BrandMark.vue'
import { DEFAULT_ADMIN, setPassword, signIn, verifyCredentials } from '@/stores/hub'

/**
 * One account per hub: `admin`. The shipped password only gets you as far as the
 * change-password step — it is refused for good once a new one is stored.
 */
const route = useRoute()
const router = useRouter()

const step = ref('credentials') // 'credentials' | 'change'
/* no default value: the handle field only carries a placeholder */
const handle = ref('')
const password = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const showPassword = ref(false)
const showNew = ref(false)
const error = ref('')
const busy = ref(false)
const done = ref(false)
const pendingUser = ref('')

const identEl = ref(null)
const pwEl = ref(null)
const newEl = ref(null)
const confirmEl = ref(null)

const year = new Date().getFullYear()

const credLabel = computed(() => (done.value ? 'Signed in' : busy.value ? 'Signing in…' : 'Sign in'))
const changeLabel = computed(() => (busy.value ? 'Saving…' : 'Update password'))

let timer = 0
onBeforeUnmount(() => clearTimeout(timer))

function finish() {
  busy.value = true
  timer = setTimeout(() => {
    signIn(pendingUser.value)
    done.value = true
    busy.value = false
    timer = setTimeout(() => {
      const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
      router.push(redirect)
    }, 420)
  }, 600)
}

async function submitCredentials() {
  if (busy.value || done.value) return
  error.value = ''
  if (!handle.value.trim()) {
    error.value = 'Enter the admin handle for this hub.'
    identEl.value?.focus()
    return
  }
  if (!password.value) {
    error.value = 'Enter your password.'
    pwEl.value?.focus()
    return
  }

  busy.value = true
  let result
  try {
    result = await verifyCredentials(handle.value, password.value)
  } catch {
    busy.value = false
    error.value = 'This browser context cannot hash the password, so sign-in is unavailable.'
    return
  }

  if (!result.ok) {
    busy.value = false
    error.value = result.message
    pwEl.value?.focus()
    pwEl.value?.select?.()
    return
  }

  pendingUser.value = result.username
  if (result.mustChange) {
    busy.value = false
    password.value = ''
    step.value = 'change'
    await nextTick()
    newEl.value?.focus()
    return
  }
  finish()
}

async function submitChange() {
  if (busy.value) return
  error.value = ''
  if (newPassword.value.length < 6) {
    error.value = 'Use at least 6 characters.'
    newEl.value?.focus()
    return
  }
  if (newPassword.value === DEFAULT_ADMIN.password) {
    error.value = 'That is the password this hub shipped with — choose a different one.'
    newEl.value?.focus()
    return
  }
  if (confirmPassword.value !== newPassword.value) {
    error.value = 'The two passwords do not match.'
    confirmEl.value?.focus()
    return
  }

  busy.value = true
  try {
    await setPassword(newPassword.value)
  } catch {
    busy.value = false
    error.value = 'The new password could not be stored on this machine.'
    return
  }
  finish()
}

function backToSignIn() {
  step.value = 'credentials'
  password.value = ''
  newPassword.value = ''
  confirmPassword.value = ''
  showNew.value = false
  error.value = ''
  nextTick(() => pwEl.value?.focus())
}
</script>

<template>
  <main class="auth">
    <div class="stack">
      <div class="bouncer">
        <BrandMark class="brand-mark--lg" hop />
      </div>

      <section class="auth-card">
        <p class="kicker">entity</p>

        <template v-if="step === 'credentials'">
          <h1>Sign in</h1>
          <p class="sub">
            Continue to your hub. Your agents, skills and ENTITY.md stay where they are.
          </p>

          <form novalidate @submit.prevent="submitCredentials">
            <div class="field">
              <label for="ident">Email or handle</label>
              <div class="control">
                <input
                  id="ident"
                  ref="identEl"
                  v-model="handle"
                  name="ident"
                  type="text"
                  autocomplete="username"
                  placeholder="admin"
                  spellcheck="false"
                  :disabled="busy || done"
                  :aria-invalid="error && !password ? 'true' : 'false'"
                  @input="error = ''"
                />
              </div>
            </div>

            <div class="field">
              <label for="pw">Password</label>
              <div class="control has-toggle">
                <input
                  id="pw"
                  ref="pwEl"
                  v-model="password"
                  name="pw"
                  :type="showPassword ? 'text' : 'password'"
                  autocomplete="current-password"
                  placeholder="••••••••"
                  :disabled="busy || done"
                  :aria-invalid="error && password ? 'true' : 'false'"
                  @input="error = ''"
                />
                <button
                  class="toggle"
                  type="button"
                  :aria-pressed="showPassword ? 'true' : 'false'"
                  :aria-label="showPassword ? 'Hide password' : 'Show password'"
                  @click="showPassword = !showPassword; pwEl?.focus()"
                >
                  {{ showPassword ? 'Hide' : 'Show' }}
                </button>
              </div>
            </div>

            <div class="slot" :data-on="error ? '1' : '0'" aria-live="polite">
              <p class="msg">{{ error }}</p>
            </div>

            <button
              class="btn-primary"
              type="submit"
              :data-busy="busy ? '1' : '0'"
              :disabled="busy || done"
            >
              <span class="spinner" aria-hidden="true"></span>
              <span class="label">{{ credLabel }}</span>
            </button>
          </form>
        </template>

        <template v-else>
          <h1>Set a new password</h1>
          <p class="sub">
            <b>{{ pendingUser }}</b> still uses the password this hub shipped with. Choose your
            own to continue.
          </p>

          <form novalidate @submit.prevent="submitChange">
            <div class="field">
              <label for="new-pw">New password</label>
              <div class="control has-toggle">
                <input
                  id="new-pw"
                  ref="newEl"
                  v-model="newPassword"
                  name="new-pw"
                  :type="showNew ? 'text' : 'password'"
                  autocomplete="new-password"
                  placeholder="At least 6 characters"
                  :disabled="busy"
                  @input="error = ''"
                />
                <button
                  class="toggle"
                  type="button"
                  :aria-pressed="showNew ? 'true' : 'false'"
                  :aria-label="showNew ? 'Hide passwords' : 'Show passwords'"
                  @click="showNew = !showNew; newEl?.focus()"
                >
                  {{ showNew ? 'Hide' : 'Show' }}
                </button>
              </div>
            </div>

            <div class="field">
              <label for="confirm-pw">Confirm new password</label>
              <div class="control">
                <input
                  id="confirm-pw"
                  ref="confirmEl"
                  v-model="confirmPassword"
                  name="confirm-pw"
                  :type="showNew ? 'text' : 'password'"
                  autocomplete="new-password"
                  placeholder="Repeat it"
                  :disabled="busy"
                  @input="error = ''"
                />
              </div>
            </div>

            <div class="slot" :data-on="error ? '1' : '0'" aria-live="polite">
              <p class="msg">{{ error }}</p>
            </div>

            <button class="btn-primary" type="submit" :data-busy="busy ? '1' : '0'" :disabled="busy">
              <span class="spinner" aria-hidden="true"></span>
              <span class="label">{{ changeLabel }}</span>
            </button>
          </form>

          <p class="alt">
            <button type="button" :disabled="busy" @click="backToSignIn">Back to sign in</button>
          </p>
        </template>
      </section>

      <p class="meta">
        <span class="copyright">© {{ year }} Agung Sundoro</span>
      </p>
    </div>
  </main>
</template>
