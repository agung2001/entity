<script setup>
/**
 * The one "+" behind the kinds a person can add.
 *
 * The row anatomy is identical for every kind (label · what it is · where its
 * credential lives), so there is one add flow with a first step rather than a verb
 * per kind. The step is two blocks, because two different questions live in it:
 *
 *   - **Sign in to an account** — a **tree** of the three accounts people add
 *     first, with `More connectors` as its fourth row. The tree is a door, not an
 *     inventory: a list that grew with the catalog would be the roster's Built-in
 *     pane again, and that pane is one row below and is still derived from it. The
 *     ids are pinned for exactly that reason, while the label, the summary and the
 *     mark still come from the catalog — so a renamed connector renames here too.
 *   - **Bring your own** — MCP server (the pool's own dialog writes `mcp.json`),
 *     a CLI already on `PATH` (it holds its own credential), a REST token, and an
 *     RSS or Atom feed (a URL and nothing else — News reads it). Each names where
 *     its credential actually lives, because that is the only thing that differs
 *     and the only thing a person cannot guess.
 */
import { computed } from 'vue'
import IntegrationMark from '@/components/IntegrationMark.vue'
import { connectors } from '@/stores/connectors'

defineProps({
  busy: { type: Boolean, default: false },
})

const emit = defineEmits(['pick', 'cancel'])

/* The three, in the order a person meets them. A fourth provider is a fifth row
   here only if somebody decides it is one of the first things a person adds;
   everything else is behind `More connectors` by design. */
const TREE_IDS = ['gmail', 'google-drive', 'youtube-studio']
const FALLBACK = {
  gmail: { label: 'Gmail', summary: 'Mail an agent may read.' },
  'google-drive': { label: 'Google Drive', summary: 'Files an agent may open.' },
  'youtube-studio': {
    label: 'YouTube Studio',
    summary: 'Views, watch time, subscribers and revenue from your own channel.',
  },
}
const TREE = computed(() =>
  TREE_IDS.map((id) => {
    const shipped = (connectors.catalog || []).find((row) => row.id === id)
    return {
      id,
      label: shipped?.label || FALLBACK[id].label,
      summary: shipped?.summary || FALLBACK[id].summary,
    }
  }),
)
</script>

<template>
  <div class="kind-groups">
    <div class="kind-group">
      <span class="kind-group-label">Sign in to an account <span class="n">{{ TREE.length }}</span></span>
      <!-- Three children under one trunk, and the fourth row is the way out of the
           tree rather than a fourth connector. -->
      <ul class="kind-tree">
        <li v-for="account in TREE" :key="account.id">
          <button class="kind-row" type="button" :disabled="busy" @click="emit('pick', account.id)">
            <span class="ki">
              <IntegrationMark :name="account.id" :size="18" />
            </span>
            <span class="kr">
              <span class="kn">{{ account.label }}</span>
              <span class="kq">{{ account.summary }}</span>
            </span>
          </button>
        </li>
        <li>
          <button class="kind-row kind-row-more" type="button" :disabled="busy" @click="emit('pick', 'builtin')">
            <span class="ki">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                <path d="M8 3.4v9.2M3.4 8h9.2" />
              </svg>
            </span>
            <span class="kr">
              <span class="kn">More connectors</span>
              <span class="kq">Every connector Entity ships — the Built-in pane</span>
            </span>
          </button>
        </li>
      </ul>
    </div>

    <div class="kind-group">
      <span class="kind-group-label">Bring your own <span class="n">4</span></span>
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

        <button class="kind" type="button" :disabled="busy" @click="emit('pick', 'rss')">
          <span class="kn">
            <span class="ki">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                <circle cx="4.2" cy="11.8" r="1.3" />
                <path d="M3 7.4a6.2 6.2 0 0 1 5.6 5.6M3 3.4a10.2 10.2 0 0 1 9.6 9.6" />
              </svg>
            </span>
            RSS or Atom feed
          </span>
          <p>A news feed, read here and shown in News.</p>
          <span class="where">feed → <b>a URL, in this workspace</b></span>
        </button>
      </div>
    </div>
  </div>
</template>
