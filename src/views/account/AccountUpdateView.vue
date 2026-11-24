<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { ago } from '@/stores/hub'
import { RELEASES_URL } from '@/lib/releases'
import {
  checkUpdates,
  downloadUpdate,
  ensureUpdateStream,
  installUpdate,
  loadUpdates,
  saveUpdateSettings,
  sizeLabel,
  updates,
} from '@/stores/updates'

/**
 * Account → Updates.
 *
 * One card, one aside, one action per state — exactly one `.btn-primary` is on
 * screen whichever state the updater is in. The state lives in
 * `electron/update-store.cjs`; this page only reads it and asks for the three
 * things a person can do: check, download, restart.
 *
 * The `manual` state is not an edge case to hide: this repository's release
 * workflow builds unsigned, so macOS cannot apply an update by itself and the
 * honest answer is a link and two named steps.
 */
const NOTES_CUT = 12

const status = computed(() => updates.status || '')
const pending = computed(() => !updates.loaded)
const dev = computed(() => updates.loaded && status.value === 'dev')
const manual = computed(() => updates.loaded && updates.manual)
const latest = computed(() => updates.latest || '')
const current = computed(() => updates.current || '—')
const downloading = computed(() => status.value === 'downloading')
const ready = computed(() => status.value === 'ready')
const available = computed(() => status.value === 'available')
/* A failed *download* is the person's own action and gets a retry; a failed
   *check* is silent everywhere and only says so here. */
const failedDownload = computed(() => status.value === 'error' && updates.error?.kind === 'download')
const checking = computed(() => status.value === 'checking' || updates.busy === 'check')
const percent = computed(() => Math.round(Number(updates.percent) || 0))

/* A dropped socket and a 404 both arrive as `kind: 'download'`, so the wording
   follows the updater's own code instead of assuming the network. */
const failedDownloadNote = computed(() =>
  /ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EPIPE/.test(String(updates.error?.code || ''))
    ? 'The connection dropped while the installer was downloading.'
    : 'The installer could not be fetched from the release page — use "Download from GitHub" below.',
)

/* A body over ~12 bullets is cut, and the cut is stated rather than silent. */
const notes = computed(() => updates.notes.slice(0, NOTES_CUT))
const notesCut = computed(() => Math.max(0, updates.notes.length - NOTES_CUT))

const badge = computed(() => {
  if (pending.value) return null
  if (dev.value) return { word: 'dev build', tone: 'plain' }
  if (manual.value) return { word: 'manual on macOS', tone: 'plain' }
  if (failedDownload.value) return { word: 'failed', tone: 'danger' }
  if (downloading.value) return { word: 'downloading', tone: '' }
  if (ready.value) return { word: 'ready to restart', tone: '' }
  if (available.value) return { word: `${latest.value} available`, tone: '' }
  return { word: 'up to date', tone: 'ok' }
})

const headNote = computed(() => {
  if (pending.value) return 'Entity — · —'
  return `Entity ${current.value} · ${dev.value ? 'development' : 'stable'}`
})

const stateSentence = computed(() => {
  if (pending.value) return ''
  if (dev.value) return 'Updates ship with the packaged app. This checkout has nothing to update from here.'
  if (failedDownload.value) {
    return `The download stopped at ${percent.value}%. The version you have still works.`
  }
  if (status.value === 'error') return 'The last check failed. The version you have still works.'
  if (downloading.value) return 'Keeps downloading if you close this page. It installs when you restart.'
  if (ready.value) return 'Installs the next time entity quits.'
  if (manual.value) {
    return latest.value
      ? `${latest.value} is available. This build is not signed, so macOS will not install an update by itself.`
      : 'This build is not signed, so macOS will not install an update by itself.'
  }
  const checked = updates.checkedAt ? ` · checked ${ago(updates.checkedAt)}` : ''
  if (available.value) return `${latest.value} is available${checked}.`
  return `You're on the latest version${checked}.`
})

/* What the number beside the kicker describes. */
const kicker = computed(() => {
  if (dev.value) return 'running'
  if (downloading.value || failedDownload.value) return 'incoming'
  if (ready.value) return 'downloaded'
  return 'installed'
})
const rowVersion = computed(() =>
  downloading.value || ready.value || failedDownload.value || (available.value && latest.value)
    ? latest.value || current.value
    : current.value,
)

const releaseUrl = computed(() => updates.notesUrl || RELEASES_URL)

/* What the update is delivered as, read from the running build. */
const buildLabel = computed(() => {
  const platform = updates.platform || ''
  if (!platform) return '—'
  const os = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[platform] || platform
  const shape = platform === 'darwin' ? ' · universal' : updates.arch ? ` · ${updates.arch}` : ''
  const kind = { darwin: 'zip', win32: 'nsis' }[platform] || 'AppImage'
  return `${os}${shape} · ${kind}`
})

/* When the release landed, in `ago()`'s own words. */
const publishedLabel = computed(() => {
  const parts = [ago(updates.publishedAt)]
  if (updates.total) parts.push(sizeLabel(updates.total))
  return parts.filter((part) => part && part !== 'never').join(' · ')
})

/* The bar's fill measures 1.6:1 against its track, so it is decoration next to
   the printed number. Ten steps is what a screen reader can follow; 200
   progress events would read 200 times. */
const announced = ref('')
watch(
  () => (downloading.value ? Math.floor(percent.value / 10) * 10 : -1),
  (step) => {
    if (step < 0) return
    announced.value = `Downloading Entity ${latest.value} — ${step} percent`
  },
)

function openRelease() {
  window.open(releaseUrl.value, '_blank', 'noopener')
}

onMounted(async () => {
  ensureUpdateStream()
  if (!updates.loaded) await loadUpdates()
})
</script>

<template>
  <div class="acct-page">
    <section class="acct-card" aria-labelledby="upd-title">
      <div class="acct-card-head">
        <div>
          <h2 id="upd-title">Updates</h2>
          <p class="mnote">{{ headNote }}</p>
        </div>
        <span v-if="badge" class="role-badge" :data-tone="badge.tone || undefined">{{ badge.word }}</span>
      </div>

      <div class="upd-row">
        <div class="upd-id">
          <span class="upd-name">
            <span class="upd-kicker">{{ kicker }}</span>
            Entity <b>{{ rowVersion }}</b>
            <template v-if="manual">· unsigned</template>
          </span>
          <span class="upd-meta">
            <span v-if="available && !manual" class="dot" aria-hidden="true"></span>
            {{ stateSentence }}
          </span>
        </div>

        <div class="upd-actions">
          <!-- a checkout has nothing to install from -->
          <button v-if="dev" class="btn" type="button" @click="openRelease">
            Releases on GitHub
          </button>

          <!-- unsigned macOS: the release page is the only path that can work -->
          <button v-else-if="manual && latest" class="btn btn-primary" type="button" @click="openRelease">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M8 2.4v7.4M4.9 7l3.1 3.1L11.1 7M2.9 13.4h10.2" />
            </svg>
            Download {{ latest }}
          </button>

          <!-- a download is arriving: the button is a state, not a missing control -->
          <button v-else-if="downloading" class="btn" type="button" disabled aria-disabled="true">
            Downloading…
          </button>

          <!-- on disk: restart is the primary, the notes are the secondary -->
          <template v-else-if="ready">
            <button class="btn" type="button" @click="openRelease">Release notes</button>
            <button class="btn btn-primary" type="button" @click="installUpdate">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M13.4 8a5.4 5.4 0 11-1.7-3.9" />
                <path d="M13.6 2.6v3.4h-3.4" />
              </svg>
              Restart now
            </button>
          </template>

          <!-- a download the person started and that failed: retry it here -->
          <button v-else-if="failedDownload" class="btn btn-primary" type="button" @click="downloadUpdate">
            Try again
          </button>

          <!-- a newer version exists: one primary -->
          <button v-else-if="available && !manual" class="btn btn-primary" type="button" @click="downloadUpdate">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M8 2.4v7.4M4.9 7l3.1 3.1L11.1 7M2.9 13.4h10.2" />
            </svg>
            Download {{ latest }}
          </button>

          <!-- nothing to install: a check is the only thing left to do -->
          <button v-else class="btn" type="button" :disabled="pending || checking" @click="checkUpdates">
            {{ checking ? 'Checking…' : 'Check again' }}
          </button>
        </div>
      </div>

      <!-- the number is always printed: the 4px fill is decoration next to it -->
      <div v-if="downloading" class="upd-progress">
        <div
          class="progress"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="percent"
          :aria-label="`Downloading Entity ${latest}`"
        ><i :style="{ width: `${percent}%` }"></i></div>
        <span class="upd-progress-meta">
          <span><b>{{ percent }}%</b> · {{ sizeLabel(updates.bytesPerSecond) }}/s</span>
          <span>{{ sizeLabel(updates.transferred) }} of {{ sizeLabel(updates.total) }}</span>
        </span>
        <span class="upd-live" aria-live="polite">{{ announced }}</span>
      </div>

      <template v-if="notes.length">
        <div class="acct-sep">
          <span>{{ latest ? `What's new in ${latest}` : "What's new" }}</span>
          <small>{{ publishedLabel }}</small>
        </div>
        <ul class="upd-log">
          <li v-for="(line, index) in notes" :key="index">{{ line }}</li>
        </ul>
        <p v-if="notesCut" class="mnote upd-note">
          {{ notesCut }} more line{{ notesCut === 1 ? '' : 's' }} on the release page.
        </p>
      </template>
      <a v-if="!dev" class="upd-link" :href="releaseUrl" target="_blank" rel="noopener noreferrer">
        Read the full release on GitHub
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
          <path d="M6 2.6h7.4V10M13.4 2.6L6.6 9.4M3 5.2v8.2h8.2V9.6" />
        </svg>
      </a>

      <!-- the two steps that replace a button macOS cannot honour -->
      <template v-if="manual">
        <div class="acct-sep">
          <span>How to install</span>
          <small>one minute</small>
        </div>
        <ul class="upd-log">
          <li>Open the DMG and drag Entity into Applications, replacing the old copy.</li>
          <li>Your workspaces, threads and settings stay in place — they live outside the app.</li>
        </ul>
      </template>

      <!-- the updater's own code stays verbatim, then one plain sentence -->
      <div v-if="failedDownload || updates.actionError" class="acct-error" role="alert">
        <b v-if="updates.error">{{ updates.error.code }} · {{ updates.error.message }}</b>
        <b v-else>The updater could not finish.</b>
        {{
          failedDownload
            ? failedDownloadNote
            : updates.actionError || 'Check again when the network is back.'
        }}
        <div class="acct-error-actions">
          <button class="btn" type="button" @click="openRelease">Download from GitHub</button>
        </div>
      </div>

      <template v-if="!dev && !pending">
        <div class="acct-sep">
          <span>When to check</span>
          <small>quiet by default</small>
        </div>
        <div class="sfx-row">
          <div class="sfx-copy">
            <b>Check for updates automatically</b>
            <span>Every six hours, and once at launch. A check that finds nothing says nothing.</span>
          </div>
          <button
            class="sfx-switch"
            type="button"
            role="switch"
            :aria-checked="updates.settings.auto ? 'true' : 'false'"
            aria-label="Check for updates automatically"
            :disabled="updates.busy === 'settings'"
            data-sfx="off"
            @click="saveUpdateSettings({ auto: !updates.settings.auto })"
          ><span></span></button>
        </div>
        <div class="sfx-row">
          <div class="sfx-copy">
            <b>Install when entity quits</b>
            <span>A downloaded update is applied as the app closes, so the next launch is the new version.</span>
          </div>
          <button
            class="sfx-switch"
            type="button"
            role="switch"
            :aria-checked="updates.settings.installOnQuit ? 'true' : 'false'"
            aria-label="Install when entity quits"
            :disabled="updates.busy === 'settings'"
            data-sfx="off"
            @click="saveUpdateSettings({ installOnQuit: !updates.settings.installOnQuit })"
          ><span></span></button>
        </div>
      </template>
    </section>

    <aside class="role-card">
      <h2>Release</h2>
      <dl class="ws-meta">
        <dt>version</dt>
        <dd>{{ current }}</dd>
        <dt>channel</dt>
        <dd>stable</dd>
        <dt>build</dt>
        <dd>{{ buildLabel }}</dd>
        <dt>checked</dt>
        <dd>{{ updates.checkedAt ? ago(updates.checkedAt) : 'never' }}</dd>
        <dt>feed</dt>
        <dd>github.com/agung2001/entity</dd>
      </dl>
      <p class="mnote">
        Updates download from the public GitHub release and are verified before they are installed.
        Nothing about this machine is sent.
      </p>
    </aside>
  </div>
</template>
