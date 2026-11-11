import { onMounted, ref } from 'vue'

/**
 * Thin wrapper over the preload bridge. Everything degrades to `null` when the
 * renderer runs in a plain browser (`npm run dev`), so components never need
 * to branch on the environment.
 */
export function useDesktop() {
  const isElectron = Boolean(globalThis.desktop?.isElectron)
  const appInfo = ref(null)

  onMounted(async () => {
    if (!isElectron) return
    appInfo.value = await globalThis.desktop.getAppInfo()
  })

  return { isElectron, appInfo }
}
