import { computed, reactive, ref } from 'vue'
import { playSfx } from './sfx'

/**
 * Desktop notifications — the browser's Notification API in a tab, a native
 * Notification in Electron. The copy and the click target are the same on both
 * sides: an entity finished a turn, and clicking takes you back to that thread.
 *
 * Preferences are per profile and stored next to the theme and sound choices.
 * The default is deliberately quiet: only when the window is not focused.
 */
const KEY = 'entity.notifications'
const defaults = { enabled: true, replies: true, errors: true, backgroundOnly: false }
const desktop = () => globalThis.desktop

function permissionAvailable() {
  if (globalThis.desktop?.isElectron) return true
  if (typeof Notification !== 'undefined') return Notification.permission === 'granted'
  return false
}

function stored() {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || 'null')
    const base = value && typeof value === 'object'
      ? {
          enabled: value.enabled !== false,
          replies: value.replies !== false,
          errors: value.errors !== false,
          /* New: a finished turn is announced while you are reading it too.
             Quiet is opt-in, and an old stored `true` is still honoured. */
          backgroundOnly: value.backgroundOnly === true,
        }
      : { ...defaults }
    /* A browser that has not been asked yet should show the switch off, not
       promise delivery the Notification API has not agreed to. Electron has no
       browser permission step. */
    base.enabled = base.enabled && permissionAvailable()
    return base
  } catch {
    return { ...defaults, enabled: defaults.enabled && permissionAvailable() }
  }
}

export const notificationSettings = reactive(stored())

export const notificationSupport = computed(() => {
  if (desktop()?.isElectron && typeof desktop()?.notify === 'function') return 'electron'
  if (typeof Notification !== 'undefined') return 'browser'
  return 'none'
})

export const notificationPermission = ref(permissionNow())

function permissionNow() {
  if (notificationSupport.value === 'electron') return 'granted'
  if (notificationSupport.value === 'browser') return Notification.permission
  return 'unsupported'
}

export function refreshNotificationPermission() {
  notificationPermission.value = permissionNow()
  return notificationPermission.value
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(notificationSettings))
  } catch {
    /* private mode — the choice still holds for this window */
  }
}

export function setNotifications(patch = {}) {
  if (typeof patch.enabled === 'boolean') notificationSettings.enabled = patch.enabled
  if (typeof patch.replies === 'boolean') notificationSettings.replies = patch.replies
  if (typeof patch.errors === 'boolean') notificationSettings.errors = patch.errors
  if (typeof patch.backgroundOnly === 'boolean') {
    notificationSettings.backgroundOnly = patch.backgroundOnly
  }
  persist()
  syncSettings()
}

export async function requestNotificationPermission() {
  refreshNotificationPermission()
  if (notificationSupport.value === 'electron') return 'granted'
  if (notificationSupport.value !== 'browser') return 'unsupported'
  if (Notification.permission === 'granted') return 'granted'
  if (Notification.permission === 'denied') return 'denied'
  try {
    const result = await Notification.requestPermission()
    notificationPermission.value = result
    return result
  } catch {
    return refreshNotificationPermission()
  }
}

const activationListeners = new Set()
const activeNotes = new Set()
let desktopHook = false
let workerHook = false
let workerRegistration = null

function emitActivation(route) {
  if (route) playSfx('nav')
  for (const listener of activationListeners) {
    try {
      listener(route || '')
    } catch {
      /* one bad listener must not starve the others */
    }
  }
}

function hookDesktop() {
  if (desktopHook) return
  const bridge = desktop()
  if (typeof bridge?.onNotificationClick !== 'function') return
  desktopHook = true
  bridge.onNotificationClick((payload) => emitActivation(payload?.route || ''))
}

function assetUrl(name) {
  const base = import.meta.env.BASE_URL || '/'
  try {
    return new URL(`${base}${name}`, location.origin).href
  } catch {
    return `/${name}`
  }
}

function workerUrl() {
  return assetUrl('notify-sw.js')
}

async function ensureWorker() {
  if (workerRegistration) return workerRegistration
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
  try {
    workerRegistration = await navigator.serviceWorker.register(workerUrl())
    /* `register` resolves before the worker is necessarily active. A short
       race keeps the first test from waiting forever on a broken worker. */
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ])
    return workerRegistration
  } catch {
    return null
  }
}

function hookWorker() {
  if (workerHook || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  workerHook = true
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'entity:notification-click') {
      emitActivation(event.data.route || '')
    }
  })
  ensureWorker().catch(() => {})
}

/** Warm the browser notification worker once permission exists. */
function syncSettings() {
  const bridge = desktop()
  if (typeof bridge?.syncNotificationSettings !== 'function') return
  bridge
    .syncNotificationSettings({
      enabled: notificationSettings.enabled,
      replies: notificationSettings.replies,
      errors: notificationSettings.errors,
      backgroundOnly: notificationSettings.backgroundOnly,
    })
    .catch(() => {})
}

export function prepareNotifications() {
  syncSettings()
  if (notificationSupport.value !== 'browser') return
  if (notificationPermission.value !== 'granted') return
  hookWorker()
}

function keepNote(note) {
  activeNotes.add(note)
  const release = () => activeNotes.delete(note)
  note.onclose = release
  note.onerror = release
  return release
}

async function showBrowserNotification(title, body, tag, route, silent = false) {
  hookWorker()
  const options = {
    body,
    tag,
    silent: Boolean(silent),
    requireInteraction: true,
    icon: assetUrl('icon-192.png'),
    data: { route },
  }
  const registration = await ensureWorker()
  if (registration) {
    try {
      await registration.showNotification(title, options)
      return true
    } catch {
      /* fall back to a page notification */
    }
  }
  const note = new Notification(title, options)
  const release = keepNote(note)
  note.onclick = () => {
    window.focus()
    note.close()
    release()
    emitActivation(route)
  }
  return true
}

/** The root listens once; browser clicks and Electron clicks both land here. */
export function onNotificationActivate(cb) {
  activationListeners.add(cb)
  hookDesktop()
  hookWorker()
  return () => activationListeners.delete(cb)
}

function focused() {
  if (typeof document === 'undefined') return true
  return document.visibilityState === 'visible' && document.hasFocus()
}

function allowed(kind, payload = {}) {
  if (!notificationSettings.enabled) return false
  if (kind === 'error' && !notificationSettings.errors) return false
  if (kind === 'reply' && !notificationSettings.replies) return false
  /* Quiet only when the thread that finished is the one on screen. Another
     thread in the same focused window still deserves a banner. */
  if (notificationSettings.backgroundOnly && focused() && payload.active) return false
  return true
}

function titleOf(payload) {
  return String(payload.title || 'entity')
}

function bodyOf(payload) {
  return String(payload.body || '').replace(/\s+/g, ' ').trim()
}

/**
 * Show one notification. `force` is for the test button: it ignores the quiet
 * rules, but still obeys the browser's permission decision.
 */
export async function notify(payload = {}) {
  if (!payload.force && !allowed(payload.kind || 'reply', payload)) {
    return { shown: false, reason: 'Notifications are quiet right now.' }
  }
  refreshNotificationPermission()
  if (notificationPermission.value !== 'granted') {
    return { shown: false, reason: 'Notification permission is not granted.' }
  }

  const title = titleOf(payload)
  const body = bodyOf(payload)
  const route = String(payload.route || '')
  const tag = String(payload.tag || 'entity')

  if (notificationSupport.value === 'electron') {
    try {
      const result = await desktop().notify({
        title,
        body,
        route,
        tag,
        silent: Boolean(payload.silent),
        probe: Boolean(payload.force),
      })
      if (result?.shown) playSfx('signal')
      return result && typeof result === 'object'
        ? result
        : { shown: Boolean(result), reason: '' }
    } catch (error) {
      return { shown: false, reason: String(error?.message || error) }
    }
  }

  if (notificationSupport.value !== 'browser') {
    return { shown: false, reason: 'Notifications are not available in this window.' }
  }
  try {
    const shown = await showBrowserNotification(
      title,
      body,
      tag,
      route,
      Boolean(payload.silent),
    )
    if (shown) playSfx('signal')
    return shown
      ? { shown: true, reason: '' }
      : { shown: false, reason: 'The notification could not be shown.' }
  } catch (error) {
    return { shown: false, reason: String(error?.message || error) }
  }
}
