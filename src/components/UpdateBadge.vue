<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useDialogDismiss } from '@/composables/useDialog'
import { hasDesktopBridge } from '@/composables/localBridge'
import { playSfx } from '@/lib/sfx'
import { hub, toast } from '@/stores/hub'
import {
  downloadUpdate,
  ensureUpdateStream,
  installUpdate,
  loadUpdates,
  sizeLabel,
  updates,
} from '@/stores/updates'

/**
 * The update tile at the bottom of the rail.
 *
 * Six states, and `idle` is `display: none`: the spacer above the tile absorbs
 * the whole 42 × 38 box, so no other rail icon moves when an update appears.
 * That is also why this component renders its own wrapper instead of living
 * inside the nav — a nav full of icons must not be able to scroll it away.
 *
 * Click routing: `available` starts the download, `downloading` does nothing
 * (the updater has no cancel, so the tile must not pretend it has one), `error`
 * opens Account → Updates, `ready` opens the restart popover. There is never a
 * second primary action on the tile.
 */
const router = useRouter()
const root = ref(null)
const tile = ref(null)
const restart = ref(null)
const popoverOpen = ref(false)

/* The tile exists in the packaged window only: a checkout has no version to
   install from, and the page says so instead. */
const bridge = hasDesktopBridge()
const state = computed(() => {
  if (!bridge) return 'idle'
  const status = updates.status || 'idle'
  return ['checking', 'available', 'downloading', 'ready', 'error'].includes(status) ? status : 'idle'
})
const version = computed(() => updates.latest || '')
const percent = computed(() => Math.round(Number(updates.percent) || 0))

/* The tooltip is decoration on top of the label; the label is the sentence. */
const label = computed(() => {
  const target = version.value ? `Entity ${version.value}` : 'an update'
  switch (state.value) {
    case 'checking':
      return 'Checking for updates'
    case 'available':
      return `${target} available — download`
    case 'downloading':
      return `Downloading ${target} — ${percent.value} percent`
    case 'ready':
      return `Restart to finish updating to ${target}`
    case 'error':
      return 'Update failed — open Account, Updates'
    default:
      return 'No update available'
  }
})
const tip = computed(() => {
  switch (state.value) {
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return `${version.value || 'An update'} available · download`
    case 'downloading':
      return `Downloading ${version.value || 'an update'} · ${percent.value}%`
    case 'ready':
      return `Restart to finish ${version.value}`
    case 'error':
      return 'Download stopped · open Updates'
    default:
      return ''
  }
})

/* The chat store already knows which turns are live, so the popover names the
   count instead of keeping one of its own. */
const runningTurns = computed(
  () => (hub.chat.summaries || []).filter((thread) => thread.working).length,
)
const popover = computed(() => popoverOpen.value && state.value === 'ready')

async function onTile() {
  if (state.value === 'available') {
    await downloadUpdate()
    return
  }
  if (state.value === 'error') {
    router.push('/account/updates')
    return
  }
  if (state.value === 'ready') {
    popoverOpen.value = true
    return
  }
  /* `checking` and `downloading` are states, not buttons: the six-hourly check
     does not flash the rail, and the updater has no cancel to offer. */
}

/** `Esc`, *Not now* and a click outside are one close; focus goes back. */
function closePopover(refocus = true) {
  if (!popoverOpen.value) return
  popoverOpen.value = false
  if (refocus) nextTick(() => tile.value?.focus())
}

useDialogDismiss({ active: () => popoverOpen.value, close: () => closePopover(true) })

function onDocumentClick(event) {
  if (!popoverOpen.value || root.value?.contains(event.target)) return
  closePopover()
}

/* Focus moves to the decision on open and back to the tile on close, so the
   keyboard path is the same as a pointer's. */
watch(popoverOpen, (open) => {
  if (open) nextTick(() => restart.value?.focus())
})

async function doInstall() {
  await installUpdate()
  closePopover()
  if (updates.actionError) toast(updates.actionError)
}

/* A download that finished while the window was elsewhere still tells the
   person once — text only, no action, because an action that expires is a trap. */
let lastStatus = ''
watch(
  () => updates.status,
  (next) => {
    const finished = lastStatus === 'downloading' && next === 'ready'
    lastStatus = next
    if (!finished) return
    playSfx('signal')
    toast(`Update ${version.value} downloaded. Restart when you're free.`)
  },
)

onMounted(async () => {
  if (!bridge) return
  document.addEventListener('click', onDocumentClick)
  ensureUpdateStream()
  await loadUpdates()
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick)
  popoverOpen.value = false
})
</script>

<template>
  <div v-if="bridge" ref="root" class="rail-upd" :data-state="state">
    <button
      ref="tile"
      class="upd-tile"
      type="button"
      :aria-label="label"
      :data-tip="tip"
      data-sfx="download"
      @click="onTile"
    >
      <svg
        v-if="state === 'available'"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M8 2.4v7.4M4.9 7l3.1 3.1L11.1 7M2.9 13.4h10.2" />
      </svg>
      <svg
        v-else-if="state === 'ready'"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M13.4 8a5.4 5.4 0 11-1.7-3.9" />
        <path d="M13.6 2.6v3.4h-3.4" />
      </svg>
      <svg
        v-else-if="state === 'error'"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="5.9" />
        <path d="M8 4.9v3.7M8 11.1v.1" />
      </svg>
      <span v-else-if="state === 'downloading'" class="upd-pct">{{ percent }}%</span>
      <span v-else-if="state === 'checking'" class="upd-spin" aria-hidden="true"></span>
    </button>

    <div v-if="popover" class="upd-pop" role="dialog" :aria-label="`Update ${version} is ready`">
      <h3>{{ version }} is ready</h3>
      <p>Installs the next time entity quits.</p>
      <div v-if="runningTurns" class="upd-pop-warn">
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="5.9" />
          <path d="M8 4.9v3.7M8 11.1v.1" />
        </svg>
        <span>
          {{ runningTurns === 1 ? '1 turn is running' : `${runningTurns} turns are running` }}.
          Restarting stops {{ runningTurns === 1 ? 'it' : 'them' }}.
        </span>
      </div>
      <p v-if="updates.total" class="upd-pop-foot">{{ sizeLabel(updates.total) }} · verified</p>
      <div class="upd-pop-actions">
        <button class="btn" type="button" data-sfx="off" @click="closePopover()">Not now</button>
        <button ref="restart" class="btn btn-primary" type="button" @click="doInstall">
          Restart now
        </button>
      </div>
    </div>
  </div>
</template>
