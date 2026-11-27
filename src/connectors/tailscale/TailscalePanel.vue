<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watchEffect } from 'vue'
import { copyText } from '@/lib/clipboard'
import { call } from '@/composables/localBridge'
import { qrFor } from '@/lib/qr'

/**
 * Tailscale's page body: the daemon read, and the one thing this connector
 * gates — a web server this app owns (a checkout's `npm run dev:lan`, or the app's
 * own built renderer when there is no checkout: read `mode`, never assume).
 *
 * Two cards where a `cli` row's cards would be, because this connector holds no
 * credential and resolves no mention: the first card is the tailnet this machine
 * is on, the second is a server this app starts and reaps. The page mounts
 * this for `tailscale` alone, so this is the one file that knows the
 * `tailscale.*` call names.
 *
 * Three rules it keeps, all of them paid for:
 *
 *   1. **The verb says why it is off, in words.** A disabled primary whose reason
 *      lives in a tooltip is a dead end (`DESIGN.md` §3): the sentence sits under
 *      the card's own copy and `aria-describedby` points at it, so a screen
 *      reader hears the reason on the button.
 *   2. **A read that answered nothing is a sentence, never a zero.** `absent`,
 *      `signed out` and `unreadable` each say what happened and name the one
 *      thing that fixes it.
 *   3. **Nothing moves when the answer lands.** The facts show skeleton bars in
 *      their own tracks and the verb keeps its width while it says `Reading…` /
 *      `Starting…` / `Stopping…`.
 *
 * Nothing here writes to Tailscale: the verbs are `status`, `start`, `stop`,
 * `serve` and `open`, and `open` reveals the Tailscale app rather than running
 * one of its commands.
 */
const DEFAULT_PORT = 5183
const MIN_PORT = 1024
const MAX_PORT = 65535
/* A server this page started can still stop on its own: main stops it when the
   tailnet drops, and the Vite child can exit. Polled only while serving, so the
   card never shows a code for a port nothing answers on. */
const POLL_MS = 5000
const COPY_MS = 1800

const tailnet = ref(null)
const serving = ref(null)
const reading = ref(true)
const step = ref('')
const problem = ref(null)
const copied = ref(false)
const useIp = ref(false)
const portInvalid = ref(false)
const portText = ref(String(DEFAULT_PORT))
const lastGood = ref(DEFAULT_PORT)
const readAt = ref('')
const now = ref(Date.now())
const portField = ref(null)
const urlText = ref(null)
let poll = null
let clock = null
let copyTimer = null

/* The hero above this page states the same three facts this card does, and it is
   the first thing on screen — so the read is published upward rather than made
   twice. One call, one answer, two places that cannot disagree. */
const emit = defineEmits(['read'])

/* ── the read ───────────────────────────────────────────────────────── */

const state = computed(() => (reading.value ? 'reading' : tailnet.value?.state || 'unreadable'))
const stateWord = computed(() => (state.value === 'signed-out' ? 'signed out' : state.value))
const stateTone = computed(() => {
  if (state.value === 'running') return 'ok'
  if (state.value === 'reading') return 'sleep'
  /* A daemon that says `Starting` is the one thing on the page that is still
     changing on its own, and spec §5 row 5 asks the dot to say so. */
  if (state.value === 'starting') return 'testing'
  return 'fail'
})

const clockOf = (value) => {
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return ''
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/* Four facts and the time they were read. `CurrentTailnet.Name` is deliberately
   absent: Tailscale fills it with the account address when the tailnet has no org
   domain, so a card that printed it would print somebody's mailbox. The suffix is
   the same fact with nothing personal in it. */
const facts = computed(() => {
  const read = tailnet.value
  if (!read) return []
  return [
    { k: 'version', v: read.version || '—', mono: true },
    {
      k: 'magicdns',
      v: read.dnsName || (read.magicdnsEnabled ? 'on, no address yet' : 'off for this tailnet'),
      mono: Boolean(read.dnsName),
      title: read.dnsName,
    },
    { k: 'tailnet', v: read.magicdnsSuffix || '—', mono: true, title: read.magicdnsSuffix },
    { k: 'ipv4', v: read.ipv4 || '—', mono: true },
    { k: 'probed', v: readAt.value || '—' },
  ]
})

async function refresh() {
  reading.value = !tailnet.value
  problem.value = null
  try {
    const [answer, server] = await Promise.all([call('tailscale.status'), call('tailscale.serve')])
    tailnet.value = answer
    readAt.value = clockOf(new Date())
    adopt(server)
  } catch (reason) {
    /* The call table itself refused. That is not the daemon's answer, so it is
       still a sentence — the page never prints a state it did not read. */
    tailnet.value = { state: 'unreadable', error: String(reason?.message || reason) }
  } finally {
    reading.value = false
  }
}

/** Take main's report of a running child as this page's state. */
function adopt(report) {
  serving.value = report?.running ? report : null
  if (!serving.value) {
    stopPoll()
    return
  }
  portText.value = String(serving.value.port)
  lastGood.value = serving.value.port
  portInvalid.value = false
  useIp.value = false
  startPoll()
}

/* ── the server ─────────────────────────────────────────────────────── */

const isServing = computed(() => Boolean(serving.value?.running))
/* What a Start would do here, read from main rather than guessed: a checkout runs
   `npm run dev:lan`, a packaged app serves its own build. `''` until the first
   answer lands, so no copy promises a server this build does not have. */
const mode = computed(() => tailnet.value?.mode || '')
const canRun = computed(() => state.value === 'running' && mode.value !== 'none')
const portNumber = computed(() => Number(portText.value))
const portValid = computed(
  () => Number.isInteger(portNumber.value) && portNumber.value >= MIN_PORT && portNumber.value <= MAX_PORT,
)
const serveTone = computed(() => {
  if (step.value === 'start') return 'testing'
  if (step.value === 'stop' || reading.value) return 'sleep'
  return isServing.value ? 'live' : 'sleep'
})
const serveWord = computed(() => {
  if (step.value === 'start') return 'starting'
  if (step.value === 'stop') return 'stopping'
  return isServing.value ? 'serving' : 'off'
})

const verbLabel = computed(() => {
  if (step.value === 'start') return 'Starting…'
  if (step.value === 'stop') return 'Stopping…'
  if (isServing.value) return 'Stop server'
  if (reading.value) return 'Reading…'
  return 'Start server'
})
const verbDisabled = computed(() => {
  if (step.value) return true
  if (isServing.value) return false
  return reading.value || !canRun.value || !portValid.value
})

/* Main's port-clash sentence names the port and, best effort, its holder. Turning
   it into the one-liner a person can paste is the only reading of it that helps. */
function asProblem(reason) {
  const text = String(reason?.message || reason || '')
  const clash = text.match(/Port (\d+) is already taken/i)
  if (clash) {
    return {
      tone: 'bad',
      head: `Port ${clash[1]} is taken.`,
      text: 'Something else is listening there — pick another port, or find the process:',
      mono: `lsof -nP -iTCP:${clash[1]} -sTCP:LISTEN`,
      action: 'port',
    }
  }
  return { tone: 'bad', head: 'The server did not start.', text, mono: '', action: '' }
}

async function start() {
  if (!portValid.value) {
    outOfRange()
    return
  }
  step.value = 'start'
  problem.value = null
  try {
    adopt(await call('tailscale.start', { port: portNumber.value }))
  } catch (reason) {
    problem.value = asProblem(reason)
    if (problem.value.action === 'port') portInvalid.value = true
  } finally {
    step.value = ''
  }
}

async function stop() {
  step.value = 'stop'
  problem.value = null
  try {
    adopt(await call('tailscale.stop'))
  } catch (reason) {
    problem.value = { tone: 'bad', head: 'The server did not stop.', text: String(reason?.message || reason), mono: '', action: '' }
  } finally {
    step.value = ''
  }
}

function verb() {
  if (verbDisabled.value) return
  return isServing.value ? stop() : start()
}

/* While serving: main has already stopped the child if the tailnet dropped, and
   the Vite child can exit on its own. Either way the code above is for an address
   that no longer answers, so this asks again every few seconds. */
function startPoll() {
  if (poll) return
  poll = setInterval(async () => {
    try {
      if ((await call('tailscale.serve'))?.running) return
      stopPoll()
      serving.value = null
      tailnet.value = await call('tailscale.status')
      problem.value = {
        tone: 'wait',
        head: tailnet.value?.state === 'running' ? 'The dev server exited.' : 'Tailscale went down, so the server stopped.',
        text: 'Nothing answers on that port any more, so the code would not open. Start it again when you are ready.',
        mono: '',
        action: '',
      }
    } catch {
      /* the next tick asks again */
    }
  }, POLL_MS)
  poll.unref?.()
}

function stopPoll() {
  if (poll) clearInterval(poll)
  poll = null
}

/* ── the address, the code, and the three ways to use it ────────────── */

const port = computed(() => (isServing.value ? serving.value.port : portNumber.value))
const nameUrl = computed(() => (tailnet.value?.dnsName ? `http://${tailnet.value.dnsName}:${port.value}` : ''))
const ipUrl = computed(() => (tailnet.value?.ipv4 ? `http://${tailnet.value.ipv4}:${port.value}` : ''))
/* Main has already proven the served URL answers on that `Host` header, so it is
   what the card shows; the IP is the same server with no name to resolve. */
const url = computed(() => {
  if (useIp.value && ipUrl.value) return ipUrl.value
  return serving.value?.url || nameUrl.value || ipUrl.value
})
const canUseIp = computed(() => Boolean(serving.value?.addressKind === 'magicdns' && tailnet.value?.ipv4))

const qr = computed(() => {
  if (!isServing.value || !url.value) return null
  try {
    return qrFor(url.value)
  } catch {
    return null
  }
})

const urlHint = computed(() => {
  if (!tailnet.value?.dnsName) {
    return {
      text: 'MagicDNS is off for this tailnet, so there is no name to put in the code — the address is the IPv4 one. It works; it is only harder to say out loud',
      mono: '',
    }
  }
  if (useIp.value) {
    return {
      text: 'The IPv4 address needs no name lookup and works anywhere the tailnet reaches; the name is what the code above reads back',
      mono: '',
    }
  }
  return { text: 'The name resolves on your tailnet only. Off the tailnet, use', mono: tailnet.value.ipv4 || '' }
})

const boundAt = computed(() => `http://0.0.0.0:${port.value}`)
const servedSince = computed(() => clockOf(serving.value?.startedAt))
const upFor = computed(() => {
  const minutes = Math.floor((now.value - new Date(serving.value?.startedAt || 0).getTime()) / 60000)
  if (!Number.isFinite(minutes) || minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
})

async function copy() {
  problem.value = null
  if (await copyText(url.value)) {
    copied.value = true
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => (copied.value = false), COPY_MS)
    return
  }
  problem.value = {
    tone: 'wait',
    head: 'The clipboard refused.',
    text: 'Selecting the address works where the clipboard does not:',
    mono: '',
    action: 'select',
  }
}

/* The fallback for a refused clipboard, and the only "fixing action" that fits:
   the address row becomes a text selection a person can copy from. */
function selectAddress() {
  const node = urlText.value
  if (!node) return
  const range = document.createRange()
  range.selectNodeContents(node)
  const pick = window.getSelection()
  pick?.removeAllRanges()
  pick?.addRange(range)
}

/* The same address in the app that is already open — how a person checks the
   server before handing the code to a phone. */
function openHere() {
  window.open(url.value, '_blank', 'noopener,noreferrer')
}

/* ── the states that are not errors ─────────────────────────────────── */

const why = computed(() => {
  if (problem.value) return problem.value
  if (reading.value) return null
  const read = tailnet.value || {}
  if (read.state === 'running' && mode.value === 'none') {
    return {
      tone: 'bad',
      head: 'This build has nothing to serve.',
      text: 'A start needs either a checkout with Vite or a built renderer beside the app. Build it in the repository, then',
      mono: 'npm run build',
      action: 'refresh',
    }
  }
  if (read.state === 'running') {
    /* Running is the one state with nothing to fix — unless the tailnet has no
       MagicDNS name, where the code still works but the address is a number a
       person cannot say out loud. That is worth one sentence, not a block. */
    if (read.dnsName) return null
    return {
      tone: 'wait',
      head: 'MagicDNS is off for this tailnet.',
      text: 'There is no name to put in the code, so both the link and the QR use the IPv4 address. It works — it is only harder to read out. Turn MagicDNS on in the admin console, then',
      mono: '',
      action: 'refresh',
    }
  }
  if (read.state === 'absent') {
    return {
      tone: 'bad',
      head: 'No Tailscale on this machine.',
      text: 'Install the app and sign in, then Refresh. Nothing else on this page can run without it.',
      mono: '',
      action: 'download',
    }
  }
  if (read.state === 'stopped') {
    return {
      tone: 'bad',
      head: 'Tailscale is stopped.',
      text: 'Start it in the Tailscale app, then Refresh — the address is what your phone will use.',
      mono: '',
      action: 'open',
    }
  }
  if (read.state === 'signed-out') {
    return {
      tone: 'bad',
      head: 'Tailscale is running but signed out.',
      text: 'Sign in in the Tailscale app. This page cannot open the sign-in page for you, and it never runs a command against your tailnet.',
      mono: '',
      action: 'open',
    }
  }
  if (read.state === 'starting') {
    return {
      tone: 'wait',
      head: 'Tailscale is starting.',
      text: 'Refresh in a moment — the address appears as soon as the daemon has one.',
      mono: '',
      action: 'refresh',
    }
  }
  return {
    tone: 'bad',
    head: 'Tailscale answered, but not in a shape this page can read.',
    text: 'Refresh once it settles, or ask it yourself in a terminal:',
    mono: read.error || 'tailscale status --json',
    action: 'refresh',
  }
})

const whyVerb = computed(
  () =>
    ({
      port: 'Change the port',
      select: 'Select the address',
      refresh: 'Refresh',
      open: 'Open Tailscale',
      download: 'Get Tailscale',
    })[why.value?.action] || 'Refresh',
)

async function openApp() {
  const answer = await call('tailscale.open').catch(() => ({ opened: false }))
  if (answer?.opened) return
  problem.value = {
    tone: 'bad',
    head: 'Entity could not open the Tailscale app.',
    text: 'Open it from the menu bar or the Start menu, sign in, then Refresh.',
    mono: '',
    action: 'refresh',
  }
}

function fix(action) {
  if (action === 'refresh') return refresh()
  if (action === 'open') return openApp()
  if (action === 'select') return selectAddress()
  if (action === 'port') {
    portField.value?.focus()
    portField.value?.select?.()
    return undefined
  }
  window.open('https://tailscale.com/download', '_blank', 'noopener,noreferrer')
  return undefined
}

/* ── the port field ─────────────────────────────────────────────────── */

/* Digits only: a port is five characters at most, and a field that accepts
   letters can only be told off later. */
function onPortInput(event) {
  const digits = String(event.target.value).replace(/\D+/g, '').slice(0, 5)
  portText.value = digits
  event.target.value = digits
  portInvalid.value = false
  problem.value = null
}

function outOfRange() {
  portInvalid.value = true
  problem.value = {
    tone: 'wait',
    head: 'Ports run from 1024 to 65535.',
    text: 'That value is out of range, so the field went back to the last port that worked.',
    mono: '',
    action: 'port',
  }
}

/* Blur is where a range is checked: a half-typed `51` must not be told off while
   the person is still typing `5183`. */
function onPortBlur() {
  if (!portText.value) {
    portText.value = String(lastGood.value)
    return
  }
  if (portValid.value) {
    lastGood.value = portNumber.value
    return
  }
  portText.value = String(lastGood.value)
  outOfRange()
}

function onPortKey(event) {
  if (event.key === 'Enter') {
    event.preventDefault()
    verb()
    return
  }
  /* Escape is the same "undo this edit" every field in the app has, and it reverts
     to the served value — the one the code above is actually for. */
  if (event.key === 'Escape' && portText.value !== String(lastGood.value)) {
    event.stopPropagation()
    portText.value = String(lastGood.value)
    portInvalid.value = false
    problem.value = null
  }
}

onMounted(() => {
  clock = setInterval(() => (now.value = Date.now()), 30_000)
  clock.unref?.()
  refresh()
})

watchEffect(() =>
  emit('read', {
    word: stateWord.value,
    tone: stateTone.value,
    version: tailnet.value?.version || '',
    magicdns: Boolean(tailnet.value?.magicdnsEnabled),
    serving: isServing.value,
    port: port.value,
    mode: mode.value,
  }),
)

onBeforeUnmount(() => {
  stopPoll()
  if (clock) clearInterval(clock)
  if (copyTimer) clearTimeout(copyTimer)
})
</script>

<template>
  <section class="cxn-card ts-tailnet">
    <div class="cxn-card-head">
      <h2>Tailnet</h2>
      <span class="state" :data-s="stateTone"><i aria-hidden="true" />{{ stateWord }}</span>
      <span class="spacer" />
      <button class="btn btn-sm" type="button" :disabled="reading" @click="refresh">
        {{ reading ? 'Reading…' : 'Refresh' }}
      </button>
    </div>

    <p class="cxn-note ts-note">
      Read from <code class="mono">tailscale status --json</code> — one call. Nothing on this page
      writes to Tailscale: no <code class="mono">up</code>, no settings, no
      <code class="mono">serve</code>.
    </p>

    <dl class="cxn-facts ts-facts">
      <template v-if="reading">
        <dt>version</dt>
        <dd><span class="ts-skel ts-skel-sm" /></dd>
        <dt>magicdns</dt>
        <dd><span class="ts-skel ts-skel-lg" /></dd>
        <dt>tailnet</dt>
        <dd><span class="ts-skel ts-skel-md" /></dd>
        <dt>ipv4</dt>
        <dd><span class="ts-skel ts-skel-md" /></dd>
      </template>
      <template v-for="fact in facts" v-else :key="fact.k">
        <dt>{{ fact.k }}</dt>
        <dd :class="{ mono: fact.mono }" :title="fact.title || undefined">{{ fact.v }}</dd>
      </template>
    </dl>
  </section>

  <section class="cxn-card ts-lan">
    <div class="cxn-card-head">
      <h2>LAN web server</h2>
      <span class="state" :data-s="serveTone"><i aria-hidden="true" />{{ serveWord }}</span>
      <span class="spacer" />
      <button
        class="btn"
        :class="{ 'btn-primary': !isServing }"
        type="button"
        :aria-disabled="verbDisabled ? 'true' : undefined"
        :aria-describedby="why && verbDisabled ? 'ts-why' : undefined"
        @click="verb"
      >
        <!-- The play mark stays in both states: a disabled verb that loses its icon
             reflows the card head the moment the tailnet comes up (spec 15). -->
        <svg v-if="!isServing && !step" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
          <path d="M5 3.6l7.4 4.4L5 12.4z" />
        </svg>
        {{ verbLabel }}
      </button>
    </div>

    <div v-if="isServing" class="ts-serve">
      <div v-if="qr" class="ts-qr" role="img" :aria-label="`QR code for ${url}`">
        <svg :viewBox="`0 0 ${qr.size} ${qr.size}`" shape-rendering="crispEdges" aria-hidden="true">
          <rect :width="qr.size" :height="qr.size" fill="#ffffff" />
          <path :d="qr.path" fill="#0a0a0a" />
        </svg>
      </div>

      <div class="ts-qr-side">
        <div class="ts-copy">
          <b>Open it on your phone</b>
          <span>
            Point the camera at the code, or send yourself the link. Nothing is installed on the
            phone — both devices have to be signed in to the same tailnet.
          </span>
        </div>

        <div class="ts-url" :title="url">
          <span ref="urlText">{{ url }}</span>
          <button class="btn btn-sm" type="button" @focus="problem = null" @click="copy">
            {{ copied ? 'Copied' : 'Copy' }}
          </button>
        </div>

        <div class="ts-url-acts">
          <button class="btn btn-sm" type="button" @click="openHere">Open in this browser</button>
          <button v-if="canUseIp" class="btn btn-sm" type="button" @click="useIp = !useIp">
            {{ useIp ? 'Use the tailnet name' : 'Use the IP instead' }}
          </button>
        </div>

        <p class="field-hint">
          <template v-if="!qr">
            That address is too long for one code, so the link above is the only way in.
          </template>
          <template v-else-if="urlHint.mono">
            {{ urlHint.text }} <code class="mono">{{ urlHint.mono }}</code>.
          </template>
          <template v-else>{{ urlHint.text }}.</template>
        </p>

        <p class="ts-caution">
          <b>This binds every interface, not just the tailnet.</b>
          On a café or office wifi the port is open to that whole network. Stop the server when you
          leave, and keep the machine's firewall on.
        </p>
      </div>
    </div>

    <div v-else class="ts-row">
      <div class="ts-copy">
        <b>Serve this workspace on the LAN</b>
        <span v-if="mode === 'build'">
          Serves this app's own build — the page you are looking at, bound to every interface — so a
          phone on your tailnet can open it. No dev server to install and no
          <code class="mono">npm</code>; the code is the first thing you get.
        </span>
        <span v-else>
          Runs <code class="mono">npm run dev:lan</code> — the same Vite app, bound to every
          interface — so a phone on your tailnet can open it. Takes about a second; the code is the
          first thing you get.
        </span>
      </div>
    </div>

    <p v-if="why" id="ts-why" class="ts-why" :data-tone="why.tone">
      <span>
        <b>{{ why.head }}</b> {{ why.text }}
        <code v-if="why.mono" class="mono">{{ why.mono }}</code>
      </span>
      <span class="spacer" />
      <button class="btn btn-sm" type="button" @click="fix(why.action)">{{ whyVerb }}</button>
    </p>

    <div class="ts-port">
      <div class="ts-port-field">
        <label class="ts-port-lbl" for="ts-port">Port</label>
        <input
          id="ts-port"
          ref="portField"
          class="ts-port-input"
          type="text"
          inputmode="numeric"
          autocomplete="off"
          spellcheck="false"
          :value="portText"
          :disabled="isServing || Boolean(step) || !canRun"
          :aria-invalid="portInvalid ? 'true' : undefined"
          aria-describedby="ts-port-hint"
          @input="onPortInput"
          @blur="onPortBlur"
          @keydown="onPortKey"
        />
      </div>
      <p id="ts-port-hint" class="ts-port-hint">
        <template v-if="isServing">
          Locked while the server runs — stop it, change the port, start it again. Serving at
          <code class="mono">{{ boundAt }}</code> since {{ servedSince }} ({{ upFor }}).
        </template>
        <template v-else-if="step === 'stop'">
          The port stays locked until the process is gone, or it would be edited into a running
          server.
        </template>
        <template v-else>
          1024–65535. Default <code class="mono">5183</code><template v-if="mode !== 'build'">, the port
          <code class="mono">npm run dev:lan</code> already uses</template> — change it only if
          something else holds that port. It is checked before the server starts, so a clash is a
          sentence rather than a silent 5184.
        </template>
      </p>
    </div>
  </section>
</template>
