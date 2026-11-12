<script setup>
import { onMounted } from 'vue'
import { loadHarnesses } from '@/stores/harnesses'

/**
 * Root component. It marks the platform on <body> so the rail can leave room for
 * the macOS traffic lights when the renderer runs inside Electron with
 * `titleBarStyle: hiddenInset`, and primes the machine-wide harness list every
 * label and picker reads.
 */
onMounted(async () => {
  loadHarnesses().catch(() => {})
  document.body.classList.toggle('is-desktop', Boolean(globalThis.desktop?.isElectron))
  if (!globalThis.desktop?.isElectron) return
  const info = await globalThis.desktop.getAppInfo()
  document.body.classList.toggle('is-mac', info.platform === 'darwin')
})
</script>

<template>
  <router-view />
</template>
