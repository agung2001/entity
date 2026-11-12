<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BrandMark from '@/components/BrandMark.vue'
import {
  DEFAULT_ACCOUNT_EMAIL,
  DEFAULT_ADMIN,
  adoptWorkspaceOwner,
  credentials,
  loadAccount,
  registerAccount,
  setPassword,
  signIn,
  verifyCredentials,
} from '@/stores/hub'
import { claimActiveWorkspaceOwner, loadWorkspaces, workspaces } from '@/stores/workspaces'

/**
 * One account per hub, tied to the first workspace creator. A hub with no
 * workspace yet can bootstrap with an email; the first sign-in registers that
 * email as the owner. The documented default password is 123456.
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
const pendingEmail = ref('')
const pendingRole = ref('')
const bootstrap = ref(false)
const accountHint = ref('')
const identPlaceholder = ref('admin')

const identEl = ref(null)
const pwEl = ref(null)
const newEl = ref(null)
const confirmEl = ref(null)

const year = new Date().getFullYear()

/* Deterministic pixel field: no random layout on every mount. */
function starStyle(n) {
  const x = (n * 37 + 11) % 100
  const y = (n * 29 + 7) % 62
  const size = n % 9 === 0 ? 3 : n % 4 === 0 ? 2 : 1
  return {
    left: `${x}%`,
    top: `${y}%`,
    width: `${size}px`,
    height: `${size}px`,
    animationDelay: `${(n % 11) * 0.31}s`,
    animationDuration: `${2.6 + (n % 5) * 0.7}s`,
  }
}

function dustStyle(n) {
  const x = (n * 43 + 5) % 100
  return {
    left: `${x}%`,
    '--drift': `${(n % 2 ? 1 : -1) * (8 + (n % 5) * 5)}px`,
    animationDelay: `${(n % 9) * 0.9}s`,
    animationDuration: `${7 + (n % 6) * 1.5}s`,
  }
}

const credLabel = computed(() => (done.value ? 'Signed in' : busy.value ? 'Signing in…' : 'Sign in'))
const changeLabel = computed(() => (busy.value ? 'Saving…' : 'Update password'))

let timer = 0
onBeforeUnmount(() => clearTimeout(timer))

onMounted(async () => {
  try {
    if (!workspaces.loaded) await loadWorkspaces()
  } catch {
    /* a broken profile still gets the login screen */
  }
  const status = await loadAccount({ force: true })
  if (status.exists) {
    /* Deliberately generic: the account email is not a login hint. */
    identPlaceholder.value = 'Email or handle'
    accountHint.value = `Credentials are stored on this machine in ${status.path || 'auth.json'}.`
    return
  }

  const owner = workspaces.items[0]?.owner
  if (owner?.email) {
    try {
      await adoptWorkspaceOwner(owner)
    } catch {
      /* the form below reports any real failure */
    }
    identPlaceholder.value = 'Email or handle'
    accountHint.value = `First creator of this workspace. Default password ${DEFAULT_ADMIN.password}.`
    return
  }

  if (!workspaces.items.length) {
    bootstrap.value = true
    identPlaceholder.value = 'you@example.com'
    accountHint.value = 'No account or workspace yet. Use your email as the password; this works once.'
    return
  }

  /* A workspace from an old build with no readable owner still needs an
     account; keep the documented default rather than a dead login screen. */
  try {
    await adoptWorkspaceOwner({ name: DEFAULT_ADMIN.username, email: DEFAULT_ACCOUNT_EMAIL })
  } catch {
    /* the form below reports any real failure */
  }
  identPlaceholder.value = 'Email or handle'
  accountHint.value = `This machine still uses the default account. Password ${DEFAULT_ADMIN.password}.`
})

function finish() {
  busy.value = true
  timer = setTimeout(() => {
    signIn(
      pendingUser.value,
      pendingEmail.value || credentials().email,
      pendingRole.value || credentials().role,
    )
    claimActiveWorkspaceOwner({
      name: pendingUser.value,
      email: pendingEmail.value || credentials().email,
    })
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
    error.value = bootstrap.value ? 'Enter your email.' : 'Enter the email or handle for this hub.'
    identEl.value?.focus()
    return
  }
  if (!password.value) {
    error.value = 'Enter your password.'
    pwEl.value?.focus()
    return
  }

  busy.value = true
  if (bootstrap.value) {
    const mail = handle.value.trim()
    if (!/^[^\s@]+@[^\s@]+$/.test(mail)) {
      busy.value = false
      error.value = 'Enter a valid email address.'
      identEl.value?.focus()
      return
    }
    if (password.value !== mail && password.value !== DEFAULT_ADMIN.password) {
      busy.value = false
      error.value = `Use the email as the password, or ${DEFAULT_ADMIN.password}.`
      pwEl.value?.focus()
      return
    }
    try {
      const account = await registerAccount({ email: mail, password: password.value })
      pendingUser.value = account.username
      pendingEmail.value = account.email
      pendingRole.value = account.role
      finish()
    } catch (problem) {
      busy.value = false
      error.value = problem?.message || 'The account could not be created.'
    }
    return
  }

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
  pendingEmail.value = result.email || ''
  pendingRole.value = result.role || 'owner'
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
  <main class="auth login">
    <div class="a51" aria-hidden="true">
      <div class="a51-stars">
        <i v-for="n in 54" :key="`star-${n}`" :style="starStyle(n)"></i>
      </div>
      <div class="a51-sun"></div>
      <div class="a51-ufo">
        <span class="a51-dome"></span>
        <span class="a51-saucer"></span>
        <span class="a51-light a51-light--1"></span>
        <span class="a51-light a51-light--2"></span>
        <span class="a51-light a51-light--3"></span>
        <span class="a51-beam"></span>
      </div>
      <div class="a51-ridge a51-ridge--far"></div>
      <div class="a51-grid"></div>
      <div class="a51-ridge a51-ridge--near"></div>
      <div class="a51-dust">
        <i v-for="n in 18" :key="`dust-${n}`" :style="dustStyle(n)"></i>
      </div>
      <div class="a51-search a51-search--left"></div>
      <div class="a51-search a51-search--right"></div>
      <div class="a51-scan"></div>
      <span class="a51-stamp">Area 51 · local only</span>
    </div>

    <div class="stack">
      <div class="bouncer">
        <BrandMark class="brand-mark--lg" hop />
      </div>

      <section class="auth-card">
        <p class="kicker">entity</p>

        <template v-if="step === 'credentials'">
          <h1>Sign in</h1>
          <p class="sub">
            Continue to your hub. The first workspace creator owns this account; your agents,
            skills and ENTITY.md stay where they are.
          </p>
          <p v-if="accountHint" class="auth-hint">{{ accountHint }}</p>

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
                  :placeholder="identPlaceholder"
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
