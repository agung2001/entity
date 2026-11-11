<script setup>
import { onMounted } from 'vue'

/**
 * Root component. The only job here is marking the platform on <body> so the
 * rail can leave room for the macOS traffic lights when the renderer runs
 * inside Electron with `titleBarStyle: hiddenInset`.
 */
onMounted(async () => {
  document.body.classList.toggle('is-desktop', Boolean(globalThis.desktop?.isElectron))
  if (!globalThis.desktop?.isElectron) return
  const info = await globalThis.desktop.getAppInfo()
  document.body.classList.toggle('is-mac', info.platform === 'darwin')
})
</script>

<template>
  <router-view />
</template>
