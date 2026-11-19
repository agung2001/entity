<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { call, onRunEvent } from '@/composables/localBridge'
import { useDialogDismiss } from '@/composables/useDialog'
import { loadTerminal, terminalTheme } from '@/lib/terminal'
import { shortcutLabel } from '@/lib/shortcuts'

/**
 * A shell beside the conversation, on this machine or on the thread's host.
 *
 * It is a *sheet*, not a dialog: it takes height from the transcript, the
 * composer stays where it is, and the shortcut that opened it hides it again
 * without killing the shell. Closing the window ends it — a terminal is not a
 * daemon (see README → Ceilings).
 *
 * Escape is the one exception to "every dismissible surface closes on Esc": a
 * shell needs that key for readline and for vim. The panel therefore registers
 * on the Escape stack with a guard that stands down while the caret is inside
 * the terminal, and the close button always works.
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  /* the thread's machine: 'local' or an ssh alias from ~/.ssh/config */
  machine: { type: String, default: 'local' },
  /* the thread's base directory; local threads only */
  dir: { type: String, default: '' },
  workspace: { type: String, default: '' },
  /* the conversation this shell belongs to: reattaching is per thread, so two
     threads in one directory do not share a scrollback */
  threadId: { type: String, default: '' },
})

const emit = defineEmits(['close'])

const host = ref(null)
const status = ref('idle')
const note = ref('')
const sessionId = ref('')
const mounted = ref(false)
const focused = ref(false)

let term = null
let fit = null
let alive = true
let offEvent = null

const shortcut = shortcutLabel('terminal')
const target = computed(() => (props.machine && props.machine !== 'local' ? props.machine : 'this machine'))

useDialogDismiss({
  active: () => props.open,
  close: () => emit('close'),
  /* While typing into the shell, Esc belongs to the shell. */
  guard: () => focused.value,
})

function say(text) {
  note.value = text
}

/**
 * Size the emulator against the box it actually has.
 *
 * The panel grows over 0.16s, so a single `fit()` at open measures a box that is
 * still collapsing to nothing and settles on two rows. Coalescing into a frame
 * and re-measuring from a ResizeObserver means the emulator follows the
 * transition, the dock growing under it, and the window resizing — one path
 * instead of three timers.
 */
let fitFrame = 0
function measure() {
  if (!props.open || fitFrame) return
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0
    try {
      fit?.fit()
    } catch {
      /* a hidden or zero-width box cannot be measured; the next frame retries */
    }
  })
}

let boxObserver = null
function watchBox() {
  if (!host.value || typeof ResizeObserver !== 'function') return
  boxObserver?.disconnect()
  boxObserver = new ResizeObserver(() => measure())
  boxObserver.observe(host.value)
}

/**
 * Can this build, on this host, start a shell at all? Asked before xterm is
 * downloaded: a missing pty relay (no python3 on a Mac, a Windows build, the
 * shared server) should read as one sentence, not as a broken terminal.
 */
async function canOpen() {
  const local = !props.machine || props.machine === 'local'
  let cap = null
  try {
    cap = await call('terminal.available', {})
  } catch {
    return true /* an older bridge: let `terminal.open` be the one to complain */
  }
  if (cap && cap.ok === false) {
    status.value = 'error'
    say(cap.reason || 'This build has no terminal.')
    return false
  }
  if (cap && local && !cap.local) {
    status.value = 'error'
    say(cap.reason || 'This host cannot start a local shell.')
    return false
  }
  return true
}

async function start() {
  if (term) {
    mountDone()
    return
  }
  if (!(await canOpen())) return
  status.value = 'loading'
  let Terminal
  let FitAddon
  try {
    ;({ Terminal, FitAddon } = await loadTerminal())
  } catch (error) {
    status.value = 'error'
    say(`The terminal emulator could not be loaded: ${String(error?.message || error)}`)
    return
  }
  if (!alive) return

  const style = getComputedStyle(document.documentElement)
  term = new Terminal({
    convertEol: false,
    cursorBlink: true,
    fontSize: 12,
    lineHeight: 1.3,
    scrollback: 8000,
    fontFamily:
      style.getPropertyValue('--mono').trim() ||
      'ui-monospace, SFMono-Regular, Menlo, monospace',
    theme: terminalTheme(),
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  /* The element exists only after `mounted` flips, so let Vue paint first. */
  mounted.value = true
  await nextTick()
  if (!alive || !host.value) return
  term.open(host.value)
  watchBox()
  measure()

  term.onData((data) => {
    if (!sessionId.value) return
    call('terminal.write', { id: sessionId.value, data }).catch(() => {
      /* the shell exited; `say` already told the reader */
    })
  })
  term.onResize(({ cols, rows }) => {
    if (!sessionId.value) return
    call('terminal.resize', { id: sessionId.value, cols, rows }).catch(() => {})
  })

  try {
    const session = await call('terminal.open', {
      workspace: props.workspace,
      threadId: props.threadId,
      machine: props.machine || 'local',
      dir: props.machine === 'local' || !props.machine ? props.dir : '',
      cols: term.cols,
      rows: term.rows,
    })
    if (!alive) return
    sessionId.value = session.id
    if (session.replay) term.write(session.replay)
    status.value = 'ready'
    say(session.reused ? 'Reattached to the shell that was already open.' : '')
  } catch (error) {
    status.value = 'error'
    say(String(error?.message || error))
    return
  }
  /* Reattached or new, the keyboard belongs in the shell: the panel only ever
     opens on purpose, and a focused composer would swallow the first keystroke. */
  focus()
}

function focus() {
  nextTick(() => {
    term?.focus()
    measure()
  })
}

function mountDone() {
  status.value = 'ready'
  focus()
}

/** Hide without killing: the shell keeps running until the app closes. */
async function stop({ kill = false } = {}) {
  if (kill && sessionId.value) {
    try {
      await call('terminal.close', { id: sessionId.value })
    } catch {
      /* already gone */
    }
  }
  sessionId.value = ''
  status.value = 'idle'
  note.value = ''
  boxObserver?.disconnect()
  boxObserver = null
  term?.dispose()
  term = null
  fit = null
  mounted.value = false
}

async function restart() {
  await stop({ kill: true })
  if (props.open) await start()
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    if (!term) await start()
    else {
      mounted.value = true
      focus()
    }
  },
  { immediate: true },
)

/* A different host, directory or conversation is a different shell; the old one
   is closed so a window does not accumulate one process per thread switch. */
watch(
  () => [props.machine, props.machine === 'local' ? props.dir : '', props.threadId],
  async (next, previous) => {
    if (!previous || next.join('|') === previous.join('|')) return
    await restart()
  },
)

function onEvent(event) {
  if (event?.kind !== 'terminal') return
  if (!sessionId.value || event.id !== sessionId.value) return
  if (event.type === 'data' || event.type === 'exit') {
    term?.write(String(event.data || ''))
    if (event.type === 'exit') {
      sessionId.value = ''
      status.value = 'error'
      say('The shell has exited. Press the shortcut twice, or the close button, to start a new one.')
    }
  }
}

onMounted(() => {
  offEvent = onRunEvent(onEvent)
  window.addEventListener('resize', measure)
})

onBeforeUnmount(() => {
  alive = false
  offEvent?.()
  offEvent = null
  window.removeEventListener('resize', measure)
  boxObserver?.disconnect()
  boxObserver = null
  if (fitFrame) cancelAnimationFrame(fitFrame)
  if (sessionId.value) call('terminal.close', { id: sessionId.value }).catch(() => {})
  term?.dispose()
  term = null
  fit = null
})
</script>

<template>
  <section
    class="term-panel"
    :data-open="open ? '1' : '0'"
    :aria-hidden="open ? 'false' : 'true'"
    aria-label="Terminal"
    @focusin="focused = true"
    @focusout="focused = false"
  >
    <header class="term-head">
      <span class="term-title">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.8" />
          <path d="M4.4 6.4l2 1.7-2 1.7M8.6 10h3" stroke-linecap="round" />
        </svg>
        Terminal
      </span>
      <span class="term-host" :title="dir || undefined">{{ target }}</span>
      <span v-if="status === 'loading'" class="term-live">starting…</span>
      <span class="term-gap"></span>
      <span class="term-hint">{{ shortcut }}</span>
      <button
        class="term-x"
        type="button"
        aria-label="Close terminal"
        title="Close the terminal"
        @click="emit('close')"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M2 2l8 8M10 2l-8 8" />
        </svg>
      </button>
    </header>
    <div v-if="mounted" ref="host" class="term-body" :data-state="status"></div>
    <p v-if="note" class="term-note">{{ note }}</p>
  </section>
</template>
