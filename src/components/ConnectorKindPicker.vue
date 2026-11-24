<script setup>
/**
 * The one "+" behind the kinds a person can add.
 *
 * The row anatomy is identical for every kind (label · kind · scope · status), so
 * there is one add flow with a first step rather than a verb per kind. The list
 * is grouped, because two different questions live in it:
 *
 *   - **Sign in to an account** — Gmail, Drive, YouTube, X. A card adds the
 *     *connector*; accounts are connected on the connector's page, so this group
 *     grows by one card per connector and never by one card per mailbox.
 *   - **Bring your own** — MCP server (the pool's own dialog writes `mcp.json`),
 *     a CLI already on `PATH` (it holds its own credential), and a REST token.
 *     Each names where its credential actually lives, because that is the only
 *     thing that differs and the only thing a person cannot guess.
 *
 * `More connectors` is a door into the roster's Built-in pane, not a fifth kind.
 */
import { computed } from 'vue'
import IntegrationMark from '@/components/IntegrationMark.vue'
import { connectors } from '@/stores/connectors'

defineProps({
  busy: { type: Boolean, default: false },
})

const emit = defineEmits(['pick', 'cancel'])

/* The account-bearing cards come from the shipped catalog, not from this file: a
   provider the app ships must appear here without a second edit, and four ids
   written into a component is how a shipped connector goes missing from its own
   add sheet. The fallback is the four this build already knows, for the frame
   before the catalog read lands. */
const ACCOUNTS = computed(() => {
  const shipped = (connectors.catalog || []).filter((entry) => entry.oauth)
  if (shipped.length) return shipped
  return [
    { id: 'gmail', label: 'Gmail', summary: 'Mail an agent may read.' },
    { id: 'google-drive', label: 'Google Drive', summary: 'Files an agent may open.' },
    { id: 'youtube', label: 'YouTube', summary: 'Channels and captions.' },
    { id: 'x', label: 'X', summary: 'Posts and threads an agent may read.' },
  ]
})
</script>

<template>
  <div class="kind-groups">
    <div class="kind-group">
      <span class="kind-group-label">Sign in to an account <span class="n">{{ ACCOUNTS.length }}</span></span>
      <div class="kinds">
        <button
          v-for="account in ACCOUNTS"
          :key="account.id"
          class="kind"
          type="button"
          :disabled="busy"
          @click="emit('pick', account.id)"
        >
          <span class="kn">
            <span class="ki">
              <IntegrationMark :name="account.id" :size="22" />
            </span>
            {{ account.label }}
          </span>
          <p>{{ account.summary }}</p>
          <span class="where">credential → <b>refresh token, this machine</b></span>
        </button>
      </div>
    </div>

    <div class="kind-group">
      <span class="kind-group-label">Bring your own <span class="n">3</span></span>
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

        <button class="kind kind-more" type="button" :disabled="busy" @click="emit('pick', 'builtin')">
          <span class="kn">
            <span class="ki">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                <path d="M8 3.4v9.2M3.4 8h9.2" />
              </svg>
            </span>
            More connectors
          </span>
          <p>Every connector Entity ships.</p>
          <span class="where">opens <b>Built-in</b></span>
        </button>
      </div>
    </div>
  </div>
</template>
