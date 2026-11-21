<script setup>
/**
 * The one "+" behind three kinds.
 *
 * The row anatomy is identical for all three (label · kind · scope · status), so
 * there is one add flow with a first step rather than three add buttons. Each
 * kind names where its credential actually lives, because that is the only thing
 * that differs and the only thing a person cannot guess:
 *
 *   - **MCP server** — command+args or URL+headers; the pool's own dialog writes
 *     `mcp.json`, which is the runtime contract, not a settings file.
 *   - **CLI on this machine** — a binary already on `PATH`, verified by its own
 *     self-report. The CLI holds its own credential.
 *   - **REST token** — base URL and one token, never synced, so a new service is
 *     a JSON row and not a release.
 */
defineProps({
  busy: { type: Boolean, default: false },
})

const emit = defineEmits(['pick', 'cancel'])
</script>

<template>
  <div class="kinds">
    <button class="kind" type="button" :disabled="busy" @click="emit('pick', 'mcp')">
      <span class="kn">
        <span class="ki">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M6 3v10M10 3v10M2 6h12M2 10h12" />
          </svg>
        </span>
        MCP server
      </span>
      <p>Command and args, or a URL and headers. The pool's own add dialog.</p>
      <span class="where">credential → <b>mcp.json</b> on this machine</span>
    </button>

    <button class="kind" type="button" :disabled="busy" @click="emit('pick', 'cli')">
      <span class="kn">
        <span class="ki">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <rect x="2" y="3" width="12" height="9" rx="1.2" />
            <path d="M5 7l2 2-2 2M9 11h3" />
          </svg>
        </span>
        CLI on this machine
      </span>
      <p>A binary already on <span class="mono">PATH</span>, verified by its own self-report.</p>
      <span class="where">credential → <b>the CLI's own store</b></span>
    </button>

    <button class="kind" type="button" :disabled="busy" @click="emit('pick', 'rest')">
      <span class="kn">
        <span class="ki">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M8 2v8M5 7l3 3 3-3M3 13h10" />
          </svg>
        </span>
        REST token
      </span>
      <p>Base URL and one token. No per-service code in Entity, ever.</p>
      <span class="where">credential → <b>never synced</b></span>
    </button>
  </div>
</template>
