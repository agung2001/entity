<script setup>
import { computed, onBeforeUnmount, onMounted } from 'vue'
import {
  notificationPermission,
  notificationSettings,
  notificationSupport,
  notify,
  prepareNotifications,
  refreshNotificationPermission,
  requestNotificationPermission,
  setNotifications,
} from '@/lib/notifications'
import { playSfx } from '@/lib/sfx'

/**
 * The notification desk. Browser tabs ask the Notification API for permission;
 * the desktop app posts a native notification through the preload bridge. Both
 * use the same quiet rule: only call you when the window is not focused.
 */
const support = computed(() => notificationSupport.value)
const isBrowser = computed(() => support.value === 'browser')
const isElectron = computed(() => support.value === 'electron')
const blocked = computed(() => notificationPermission.value === 'denied')
const needsPermission = computed(() => notificationPermission.value === 'default')
const permissionLabel = computed(() => {
  if (isElectron.value) return 'native'
  if (blocked.value) return 'blocked'
  if (notificationPermission.value === 'granted') return 'granted'
  if (needsPermission.value) return 'not asked yet'
  return 'unsupported'
})
const supportLabel = computed(() => {
  if (isElectron.value) return 'Desktop app · native'
  if (isBrowser.value) return 'Browser tab · Notification API'
  return 'Not available in this window'
})
const canTest = computed(
  () => notificationSettings.enabled && notificationPermission.value === 'granted',
)

function refresh() {
  refreshNotificationPermission()
}

onMounted(() => {
  refresh()
  prepareNotifications()
  window.addEventListener('focus', refresh)
})
onBeforeUnmount(() => window.removeEventListener('focus', refresh))

async function toggleMaster() {
  const enabled = !notificationSettings.enabled
  playSfx('toggle')
  if (enabled && isBrowser.value && needsPermission.value) {
    const result = await requestNotificationPermission()
    if (result !== 'granted') {
      setNotifications({ enabled: false })
      playSfx('error')
      return
    }
    prepareNotifications()
  }
  setNotifications({ enabled })
  if (enabled && notificationPermission.value === 'granted') playSfx('success')
}

function toggleOption(key) {
  setNotifications({ [key]: !notificationSettings[key] })
  playSfx('toggle')
}

async function ask() {
  playSfx('toggle')
  const result = await requestNotificationPermission()
  if (result === 'granted') {
    setNotifications({ enabled: true })
    prepareNotifications()
    playSfx('success')
  } else if (result === 'denied') {
    playSfx('error')
  }
}

async function test() {
  const shown = await notify({
    force: true,
    kind: 'reply',
    title: 'entity',
    body: 'Notifications are working. This is what a finished turn looks like.',
  })
  if (!shown) playSfx('error')
}
</script>

<template>
  <div class="notif-page">
    <section class="acct-card">
      <div class="acct-card-head">
        <div>
          <h2>Notifications</h2>
          <p class="mnote">{{ supportLabel }}</p>
        </div>
        <span class="role-badge" :data-on="notificationSettings.enabled ? '1' : '0'">
          {{ notificationSettings.enabled ? 'on' : 'off' }}
        </span>
      </div>

      <div class="sfx-row">
        <div class="sfx-copy">
          <b>Desktop notifications</b>
          <span>
            A native banner when an entity replies or a turn fails. Clicking it returns to
            the thread.
          </span>
        </div>
        <button
          class="sfx-switch"
          type="button"
          role="switch"
          :aria-checked="notificationSettings.enabled ? 'true' : 'false'"
          :aria-label="notificationSettings.enabled ? 'Turn notifications off' : 'Turn notifications on'"
          :disabled="support === 'none'"
          data-sfx="off"
          @click="toggleMaster"
        >
          <span></span>
        </button>
      </div>

      <div v-if="isBrowser" class="notif-permission" :data-tone="blocked ? 'error' : needsPermission ? 'wait' : 'ok'">
        <div>
          <b>Browser permission</b>
          <span>{{ permissionLabel }}</span>
        </div>
        <button
          v-if="needsPermission || blocked"
          class="btn btn-sm"
          type="button"
          data-sfx="off"
          @click="ask"
        >
          {{ blocked ? 'Check again' : 'Allow notifications' }}
        </button>
      </div>

      <p v-if="blocked" class="mnote notif-help">
        This site is blocked in your browser settings. Allow notifications for this address,
        then check again.
      </p>
      <p v-if="isBrowser" class="mnote notif-system-note">
        The browser also needs permission from the operating system — on macOS, System
        Settings → Notifications. Focus mode can hold banners too.
      </p>

      <div class="acct-sep">
        <span>When to call</span>
        <small>quiet by default</small>
      </div>

      <div class="notif-options">
        <div class="notif-option">
          <div class="sfx-copy">
            <b>Replies</b>
            <span>An entity finishes a turn while you are elsewhere.</span>
          </div>
          <button
            class="sfx-switch"
            type="button"
            role="switch"
            :aria-checked="notificationSettings.replies ? 'true' : 'false'"
            aria-label="Notify when an entity replies"
            :disabled="!notificationSettings.enabled"
            data-sfx="off"
            @click="toggleOption('replies')"
          >
            <span></span>
          </button>
        </div>
        <div class="notif-option">
          <div class="sfx-copy">
            <b>Failures</b>
            <span>A harness exits without an answer, or the turn cannot start.</span>
          </div>
          <button
            class="sfx-switch"
            type="button"
            role="switch"
            :aria-checked="notificationSettings.errors ? 'true' : 'false'"
            aria-label="Notify when a turn fails"
            :disabled="!notificationSettings.enabled"
            data-sfx="off"
            @click="toggleOption('errors')"
          >
            <span></span>
          </button>
        </div>
        <div class="notif-option">
          <div class="sfx-copy">
            <b>Only when I am away</b>
            <span>Stay quiet while the window is focused; post a banner otherwise.</span>
          </div>
          <button
            class="sfx-switch"
            type="button"
            role="switch"
            :aria-checked="notificationSettings.backgroundOnly ? 'true' : 'false'"
            aria-label="Only notify when the window is not focused"
            :disabled="!notificationSettings.enabled"
            data-sfx="off"
            @click="toggleOption('backgroundOnly')"
          >
            <span></span>
          </button>
        </div>
      </div>

      <div class="notif-test">
        <div>
          <b>Try it</b>
          <p class="mnote">Posts a test notification without waiting for a turn.</p>
        </div>
        <button class="btn" type="button" :disabled="!canTest" data-sfx="off" @click="test">
          Send test
        </button>
      </div>
    </section>

    <aside class="role-card notif-note">
      <h2>Signal</h2>
      <p class="mnote">
        One banner per finished turn, tagged by thread so a retry replaces the previous
        call instead of stacking. The message itself stays here; only a short excerpt
        travels to the system.
      </p>
      <dl class="ws-meta">
        <dt>Browser</dt>
        <dd>Notification API</dd>
        <dt>Desktop</dt>
        <dd>Native banner</dd>
        <dt>Click</dt>
        <dd>Returns to thread</dd>
      </dl>
      <p class="mnote account-card-note">
        Notifications carry no tokens, passwords or full transcripts. A click only
        navigates inside entity.
      </p>
    </aside>
  </div>
</template>
