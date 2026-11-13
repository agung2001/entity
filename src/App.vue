<script setup>
import { onBeforeUnmount, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { onRunEvent } from '@/composables/localBridge'
import { notify, onNotificationActivate, prepareNotifications } from '@/lib/notifications'

/**
 * Root component. It marks the platform on <body> so the rail can leave room for
 * the macOS traffic lights when the renderer runs inside Electron with
 * `titleBarStyle: hiddenInset`, primes the machine-wide harness list every
 * label and picker reads, and turns finished turns into notifications even
 * when the chat view is not the one currently mounted.
 */
const router = useRouter()
let offRun = null
let offNotice = null

function notificationFor(event) {
  if (!event || event.kind !== 'chat.turn' || event.phase !== 'done') return
  const message = event.data?.message
  if (!message) return
  if (message.who === 'sys' && !message.error) return
  const entity = event.entity || 'Entity'
  const text = String(message.text || message.error || '').replace(/\s+/g, ' ').trim()
  const body = text.length > 160 ? `${text.slice(0, 159)}…` : text
  const route = `/${event.workspace}/chat?thread=${encodeURIComponent(event.threadId)}`
  notify({
    title: message.error ? `${entity} needs attention` : `${entity} replied`,
    body: body || (message.error ? 'The turn failed.' : 'A new reply is ready.'),
    route,
    tag: `chat:${event.threadId}`,
    kind: message.error ? 'error' : 'reply',
  }).catch(() => {})
}

onMounted(async () => {
  document.body.classList.toggle('is-desktop', Boolean(globalThis.desktop?.isElectron))
  if (globalThis.desktop?.isElectron) {
    const info = await globalThis.desktop.getAppInfo()
    document.body.classList.toggle('is-mac', info.platform === 'darwin')
  }
  offRun = onRunEvent(notificationFor)
  offNotice = onNotificationActivate((route) => {
    if (route && router.currentRoute.value.fullPath !== route) router.push(route)
  })
  prepareNotifications()
})

onBeforeUnmount(() => {
  offRun?.()
  offNotice?.()
})
</script>

<template>
  <router-view />
</template>
