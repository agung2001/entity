<script setup>
import { computed } from 'vue'
import { SFX_CUES, SFX_THEMES, playSfx, setSfx, sfxSettings } from '@/lib/sfx'

/**
 * The sound desk. One theme, procedural cues, a master switch and a volume
 * that applies live. Previewing a cue bypasses the off switch so the choice is
 * audible before it is turned back on.
 */
const theme = computed(() => SFX_THEMES.find((item) => item.id === sfxSettings.theme) || SFX_THEMES[0])
const volumePercent = computed(() => Math.round(sfxSettings.volume * 100))

function toggle() {
  const enabled = !sfxSettings.enabled
  setSfx({ enabled })
  if (enabled) playSfx('toggle')
}

function setVolume(event) {
  setSfx({ volume: Number(event.target.value) / 100 })
}

function preview(id) {
  playSfx(id, { force: true })
}
</script>

<template>
  <div class="sfx-page">
    <section class="acct-card sfx-card">
      <div class="acct-card-head">
        <div>
          <h2>Sound effects</h2>
          <p class="mnote">Procedural cues for this interface. No audio files, no downloads.</p>
        </div>
        <span class="role-badge">{{ sfxSettings.enabled ? 'on' : 'off' }}</span>
      </div>

      <div class="sfx-row">
        <div class="sfx-copy">
          <b>Interface sound</b>
          <span>Buttons, menus, sending, replies and errors. The whole hub shares this setting.</span>
        </div>
        <button
          class="sfx-switch"
          type="button"
          role="switch"
          :aria-checked="sfxSettings.enabled ? 'true' : 'false'"
          :aria-label="sfxSettings.enabled ? 'Turn sound effects off' : 'Turn sound effects on'"
          data-sfx="off"
          @click="toggle"
        >
          <span></span>
        </button>
      </div>

      <div class="sfx-volume">
        <div class="sfx-volume-head">
          <label for="sfx-volume">Volume</label>
          <output for="sfx-volume">{{ volumePercent }}%</output>
        </div>
        <input
          id="sfx-volume"
          type="range"
          min="0"
          max="100"
          step="1"
          :value="volumePercent"
          :disabled="!sfxSettings.enabled"
          @input="setVolume"
          @change="preview('tap')"
        />
      </div>

      <div class="acct-sep">
        <span>Theme</span>
        <small>procedural · Web Audio</small>
      </div>

      <div class="sfx-theme">
        <span class="sfx-sigil" aria-hidden="true">
          <i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>
        </span>
        <span class="sfx-theme-copy">
          <b>{{ theme.name }}</b>
          <span>{{ theme.desc }}</span>
        </span>
        <span class="sfx-active">active</span>
      </div>

      <div class="acct-sep">
        <span>Sounds</span>
        <small>click any cue to preview</small>
      </div>

      <div class="sfx-cues">
        <button
          v-for="cue in SFX_CUES"
          :key="cue.id"
          class="sfx-cue"
          type="button"
          data-sfx-preview
          @click="preview(cue.id)"
        >
          <span class="sfx-play" aria-hidden="true">
            <svg viewBox="0 0 12 12" fill="currentColor"><path d="M3.2 2.1l6.2 3.9-6.2 3.9z" /></svg>
          </span>
          <span class="sfx-cue-copy">
            <b>{{ cue.name }}</b>
            <span>{{ cue.desc }}</span>
          </span>
          <span class="sfx-cue-id mono">{{ cue.id }}</span>
        </button>
      </div>
    </section>

    <aside class="role-card sfx-note">
      <h2>Pixel Area 51</h2>
      <p class="mnote">
        Designed to sound like a terminal found in a desert hangar: square-wave keys, low
        alien sweeps and a little tape static. Every cue is synthesized locally when it plays.
      </p>
      <dl class="ws-meta">
        <dt>Engine</dt>
        <dd>Web Audio</dd>
        <dt>Assets</dt>
        <dd>None · generated</dd>
        <dt>Scope</dt>
        <dd>This profile</dd>
      </dl>
      <p class="mnote account-card-note">
        Audio starts after your first click, because browsers and Electron both require a gesture.
      </p>
    </aside>
  </div>
</template>
