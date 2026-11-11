<script setup>
import { ref } from 'vue'
import { useDesktop } from '@/composables/useDesktop'

const count = ref(0)
const { isElectron, appInfo } = useDesktop()
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="logo">E</span>
        <div>
          <h1>Entity</h1>
          <p class="tagline">Vue 3 + Vite + Electron</p>
        </div>
      </div>

      <span class="badge" :class="{ live: isElectron }">
        {{ isElectron ? 'Desktop' : 'Browser' }}
      </span>
    </header>

    <main class="content">
      <section class="card hero">
        <h2>It runs.</h2>
        <p class="muted">
          <code>npm run dev</code> opens the renderer in a browser.
          <code>npm run dev:desktop</code> boots the same renderer inside Electron with
          hot reload.
        </p>

        <div class="counter">
          <button type="button" @click="count++">count is {{ count }}</button>
          <button type="button" class="ghost" @click="count = 0">reset</button>
        </div>
      </section>

      <section class="card">
        <h2>Environment</h2>
        <dl class="info">
          <div>
            <dt>Runtime</dt>
            <dd>{{ isElectron ? 'Electron' : 'Web browser' }}</dd>
          </div>
          <template v-if="appInfo">
            <div>
              <dt>App version</dt>
              <dd>{{ appInfo.version }}</dd>
            </div>
            <div>
              <dt>Electron</dt>
              <dd>{{ appInfo.electron }}</dd>
            </div>
            <div>
              <dt>Chromium</dt>
              <dd>{{ appInfo.chrome }}</dd>
            </div>
            <div>
              <dt>Node</dt>
              <dd>{{ appInfo.node }}</dd>
            </div>
            <div>
              <dt>Platform</dt>
              <dd>{{ appInfo.platform }} / {{ appInfo.arch }}</dd>
            </div>
          </template>
          <div v-else>
            <dt>Desktop bridge</dt>
            <dd class="muted">Not available (run <code>npm run dev:desktop</code>)</dd>
          </div>
        </dl>
      </section>
    </main>

    <footer class="footer muted">
      Renderer: <code>src/</code> · Main process: <code>electron/main.cjs</code>
    </footer>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  padding: 32px clamp(20px, 5vw, 56px) 24px;
  gap: 24px;
}

/* Leave room for the macOS traffic lights with titleBarStyle: hiddenInset. */
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  -webkit-app-region: drag;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.logo {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background: linear-gradient(150deg, var(--accent), var(--accent-strong));
  color: #0b120e;
  font-weight: 800;
}

h1 {
  font-size: 1.05rem;
  letter-spacing: 0.02em;
}

.tagline {
  font-size: 0.78rem;
  color: var(--text-muted);
}

.badge {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-muted);
  background: var(--bg-elevated);
}

.badge.live {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

.content {
  flex: 1;
  display: grid;
  gap: 20px;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  align-content: start;
}

.card {
  background: color-mix(in srgb, var(--bg-elevated) 88%, transparent);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 24px;
}

.card h2 {
  font-size: 1rem;
  margin-bottom: 10px;
}

.hero {
  grid-column: 1 / -1;
}

.muted {
  color: var(--text-muted);
}

.hero p {
  max-width: 62ch;
  font-size: 0.92rem;
}

.counter {
  display: flex;
  gap: 10px;
  margin-top: 20px;
}

.counter button {
  border: 1px solid transparent;
  border-radius: 10px;
  padding: 9px 16px;
  background: var(--accent);
  color: #0b120e;
  font-weight: 600;
  transition: transform 0.12s ease, filter 0.12s ease;
}

.counter button:hover {
  filter: brightness(1.08);
}

.counter button:active {
  transform: translateY(1px);
}

.counter .ghost {
  background: transparent;
  border-color: var(--border);
  color: var(--text-muted);
  font-weight: 500;
}

.info {
  display: grid;
  gap: 8px;
  margin: 14px 0 0;
}

.info > div {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  font-size: 0.85rem;
  padding-bottom: 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
}

.info > div:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.info dt {
  color: var(--text-muted);
}

.info dd {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8rem;
}

.footer {
  font-size: 0.75rem;
  text-align: center;
}
</style>
