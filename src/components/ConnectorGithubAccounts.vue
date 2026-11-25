<script setup>
import { computed, ref } from 'vue'
import { ago } from '@/stores/hub'
import { copyText } from '@/lib/clipboard'
import { github, makeActive, readLogins } from '@/composables/githubDashboard'

/**
 * Who `gh` holds on this machine, one row each.
 *
 * A separate card from `ConnectorAccountsCard` because that one is about a consent
 * this app stores and can revoke; this one is about a credential that lives in the
 * CLI's own store and can only be *read about*. There is no sign-in form, no token
 * field and no reveal — the road in is `gh auth login` in a terminal, so that
 * command is what the empty state hands over.
 *
 * The card never invents a login to fill the table. Nothing signed in is its own
 * sentence with the command that fixes it; a refused token keeps its row, because
 * a table missing the broken account is a table that hid the problem.
 */
const copied = ref('')
const busy = ref('')
const error = ref('')

const host = computed(() => github.host || 'github.com')
const named = computed(() => github.logins.filter((entry) => entry.login))
const count = computed(() =>
  github.logins.length ? `${github.logins.length} found` : 'none',
)
const stamp = computed(() => (github.checkedAt ? `checked ${ago(github.checkedAt)}` : 'not checked yet'))
const loginCommand = computed(() => `gh auth login --hostname ${host.value} --git-protocol https`)
const scopesOf = (entry) => (entry.scopes?.length ? entry.scopes.join(' · ') : 'none')

async function copy(text, what) {
  const route = await copyText(text)
  copied.value = route ? what : ''
  if (route) setTimeout(() => (copied.value = ''), 1600)
}

async function recheck() {
  if (busy.value) return
  busy.value = 'check'
  error.value = ''
  try {
    await readLogins()
  } catch (problem) {
    error.value = String(problem?.message || problem)
  } finally {
    busy.value = ''
  }
}

async function useActive(login) {
  if (busy.value) return
  busy.value = login
  error.value = ''
  try {
    await makeActive(login)
  } catch (problem) {
    error.value = String(problem?.message || problem)
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <section class="cxn-card cxn-acc" aria-labelledby="cxn-acc-head">
    <div class="cxn-card-head">
      <h2 id="cxn-acc-head">Accounts on this machine</h2>
      <span class="n">{{ count }}</span>
      <span class="spacer"></span>
      <span class="stamp">{{ stamp }}</span>
      <button class="btn btn-sm" type="button" :disabled="busy === 'check'" @click="recheck">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
        {{ busy === 'check' ? 'Checking…' : 'Re-check' }}
      </button>
    </div>

    <!-- Nobody signed in: the command is the whole answer, so it is the thing on
         screen rather than a sentence about a form that does not exist. -->
    <div v-if="!github.logins.length" class="acc-empty">
      <b>{{ github.binary?.found ? 'gh is signed in nowhere on this machine.' : 'gh is not on this machine.' }}</b>
      <p v-if="github.binary?.found">
        Entity runs <code class="mono">gh auth status</code> when this page opens. There is no
        sign-in form here because the app never handles your token — run this in a terminal,
        then press Re-check:
      </p>
      <p v-else>
        The Dashboard tab needs the CLI, and the CLI is not on this machine's PATH. Install
        <code class="mono">gh</code>, then sign in with:
      </p>
      <div class="cmdrow">
        <code>{{ loginCommand }}</code>
        <button class="btn btn-sm" type="button" @click="copy(loginCommand, 'login')">
          {{ copied === 'login' ? 'Copied' : 'Copy' }}
        </button>
      </div>
      <p v-if="github.problem" class="cxn-note">
        <code class="mono">{{ github.problem }}</code>
      </p>
    </div>

    <div v-else class="acc-box" role="table" aria-label="GitHub accounts found on this machine">
      <div class="acc acc-head" role="row">
        <span role="columnheader">Account</span>
        <span role="columnheader">Host</span>
        <span role="columnheader">Token scopes</span>
        <span role="columnheader">State</span>
        <span role="columnheader">Action</span>
      </div>
      <div
        v-for="entry in named"
        :key="`${entry.host}-${entry.login}`"
        class="acc"
        role="row"
        :data-tone="entry.refused ? 'bad' : null"
      >
        <div class="acc-who" role="cell">
          <b>@{{ entry.login }}</b>
          <span v-if="entry.tokenSource">via {{ entry.tokenSource }}</span>
        </div>
        <div class="acc-host" role="cell">{{ entry.host }}</div>
        <div class="acc-scopes" role="cell" :title="scopesOf(entry)">{{ scopesOf(entry) }}</div>
        <div class="acc-state" role="cell">
          <span class="st" :data-tone="entry.refused ? 'bad' : entry.active ? 'ok' : null">
            <i aria-hidden="true"></i>{{ entry.refused ? 'token expired' : entry.active ? 'active' : 'signed in' }}
          </span>
        </div>
        <div class="acc-act" role="cell">
          <span v-if="entry.active && !entry.refused" class="dim">—</span>
          <button
            v-else-if="!entry.refused"
            class="btn btn-sm"
            type="button"
            :disabled="Boolean(busy)"
            @click="useActive(entry.login)"
          >{{ busy === entry.login ? 'Switching…' : 'Use as active' }}</button>
          <button
            v-else
            class="btn btn-sm"
            type="button"
            @click="copy(`gh auth login --hostname ${entry.host}`, `cmd-${entry.login}`)"
          >{{ copied === `cmd-${entry.login}` ? 'Copied' : 'Show the command' }}</button>
        </div>
      </div>
    </div>

    <!-- An error row without its sentence is the thing this block exists to avoid:
         `gh` said exactly why, so it is quoted rather than summarised. -->
    <div
      v-for="failure in github.errors"
      :key="`err-${failure.login}`"
      class="acc-err"
      role="alert"
    >
      <b>{{ failure.login ? `@${failure.login} was refused.` : 'The login on this machine was refused.' }}</b>
      <code class="mono">{{ failure.message }}</code>
    </div>
    <div v-if="error" class="acc-err" role="alert"><code class="mono">{{ error }}</code></div>

    <p class="cxn-note">
      Detected with <code class="mono">gh auth status</code> — no token is read, copied or
      stored. Add a second login in a terminal and press Re-check; Entity does not sign you
      in. An expired token keeps its row so you know which login broke.
    </p>
  </section>
</template>
