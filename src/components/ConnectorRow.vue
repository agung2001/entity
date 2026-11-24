<script setup>
/**
 * One connector row: who it is, whether it answers, and the one verb it owns.
 *
 * Three cells, in this order, at every width — the head and the row read one
 * `--ct-tracks`, so there is no state in which a column disappears and the head
 * keeps its label (`DESIGN.md` → "A roster is a table").
 *
 * **Kind and scope are stated once**, in the mono line under the name, and never
 * again as a pill: twenty bordered pills saying `mcp` and `workspace` beside a
 * line that already said both was 40 boxes of noise (measured on the live page).
 * The scope is still per row — that is the line's job — and it is still the only
 * condition for `Copy here`.
 *
 * The name is the only link and the row is not — a row-wrapped anchor around the
 * verbs would nest two interactive elements (`DESIGN.md`).
 */
import HarnessIcon from '@/components/HarnessIcon.vue'
import IntegrationMark from '@/components/IntegrationMark.vue'
import { hub } from '@/stores/hub'

/* A built-in connector wears its own brand mark, and so does an account-bearing
   one whose id *is* its mark (`gmail`, `google-drive`, `youtube`, `x`); anything
   else wears its initial. `builtIn` comes from the store, which is the only thing
   that knows what the app ships with. */
const brandOf = (row) => String(row?.builtIn || (row?.oauth ? row.id : ''))

defineProps({
  row: { type: Object, required: true },
  busy: { type: Boolean, default: false },
})

const emit = defineEmits(['adopt', 'copy', 'uninstall', 'connect'])

/* The name is the link, the row is not (`DESIGN.md`). One roster, one address:
   an MCP server and a cli/rest row open the same `connectors/:id` page, and the
   view switches on the row's own `kind`. */
const pageFor = (row) => ({ name: 'connector-page', params: { workspace: hub.workspace, id: row.id } })

/* `ok | fail | off | warn`, the four dots the row may wear. */
const toneOf = (row) => {
  const word = String(row?.status || '')
  if (/fail|missing|needs sign-in/i.test(word)) return 'fail'
  if (/unmanaged|untracked|parked|not probed|not set up/i.test(word)) return 'warn'
  if (/found|connected|in the pool|ok/i.test(word)) return 'ok'
  return 'off'
}

/* The definition's home: the workspace pool, a harness file, or the CLI itself. */
const sourceOf = (row) => row?.binding || row?.statusDetail || ''
/* Kind and scope have their own columns where there is room. The meta line still
   carries them, hidden by CSS in the wide state and shown again below 560px — one
   string, so the two states cannot disagree about what the row says. */
const metaOf = (row) => {
  const parts = [row?.kind, row?.scope]
  /* An account-bearing row says `oauth` where a token row names its binding: the
     binding is the consent, not a file. The count is the last thing on the line,
     because the roster still draws one row per connector (spec §3). */
  if (row?.oauth) parts.push('oauth')
  else if (!machineRow(row)) parts.push(sourceOf(row))
  parts.push(row?.mention, row?.accountsLabel)
  return parts.filter(Boolean).join(' · ')
}

/* A machine connector is often declared by several harnesses, and the *files* are
   what a person needs when they go looking for the MCP — so the status cell wears
   one harness mark per source, each carrying its own path in the tooltip. The
   list of harness names in the meta line is gone: it said "in 3 harnesses" where
   three marks say the same thing and name them.
 */
const sourcesOf = (row) => (Array.isArray(row?.sources) ? row.sources : [])
/* A machine row's path lives in each mark's tooltip, so the two text slots that
   used to carry it stay quiet. */
const machineRow = (row) => sourcesOf(row).length > 0
const scopeTitle = (row) => {
  const list = Array.isArray(row?.sources) ? row.sources.map((entry) => entry.file).filter(Boolean) : []
  return list.length ? `${row.scope} · ${list.join(', ')}` : row?.scope || ''
}
</script>

<template>
  <div class="ct-row" role="row">
    <router-link class="ct-who" role="cell" :to="pageFor(row)" :title="row.label">
      <span class="ct-mk" :data-brand="brandOf(row) || row.kind === 'mcp' ? '1' : '0'" aria-hidden="true">
        <IntegrationMark v-if="brandOf(row)" :name="brandOf(row)" :size="18" />
        <template v-else>{{ row.initial }}</template>
      </span>
      <span class="ct-copy">
        <span class="ct-name" :title="row.label">{{ row.label }}</span>
        <span class="ct-line" :title="metaOf(row)">{{ metaOf(row) }}</span>
      </span>
    </router-link>

    <span class="ct-kind" role="cell" :title="row.kind">{{ row.kind }}</span>
    <span class="ct-scope" role="cell" :title="scopeTitle(row)">{{ row.scope }}</span>

    <span class="ct-status" role="cell" :data-s="toneOf(row)">
      <span class="ct-s1">
        <span class="dot" aria-hidden="true"></span>
        <span class="ct-word" :title="row.status">{{ row.status }}</span>
        <!-- one mark per harness that declares it; hover names the file -->
        <span v-if="sourcesOf(row).length" class="ct-srcs">
          <span
            v-for="source in sourcesOf(row)"
            :key="source.file"
            class="ct-src"
            :title="`${source.label || source.harness} · ${source.file}`"
          >
            <HarnessIcon :name="source.harness" :size="12" />
          </span>
        </span>
      </span>
      <small v-if="row.statusDetail && !machineRow(row)" class="ct-detail-line" :title="row.statusDetail">
        {{ row.statusDetail }}
      </small>
      <small v-if="row.verified" class="ct-when" :title="row.verified">{{ row.verified }}</small>
    </span>

    <span class="ct-act" role="cell">
      <button
        v-if="row.scope === 'machine'"
        class="btn btn-sm"
        type="button"
        :disabled="busy"
        title="Copies the definition into this workspace. Credentials do not travel."
        @click="emit('copy', row)"
      >
        Copy here
      </button>
      <button
        v-else-if="row.unmanaged"
        class="btn btn-sm"
        type="button"
        :disabled="busy"
        title="Creates a workspace connector from this server. The token is not copied."
        @click="emit('adopt', row)"
      >
        Adopt
      </button>
      <button
        v-else-if="row.oauth && row.accountCount === 0"
        class="btn btn-sm"
        type="button"
        :disabled="busy"
        :aria-label="`Connect account, ${row.label}`"
        title="Opens this connector's page, where the account is connected."
        @click="emit('connect', row)"
      >
        Connect account
      </button>
      <button
        v-else-if="row.builtIn || row.oauth"
        class="btn btn-sm btn-ghost"
        type="button"
        :disabled="busy"
        title="Removes it from this workspace. The CLI's own sign-in stays on this machine."
        @click="emit('uninstall', row)"
      >
        Uninstall
      </button>
    </span>
  </div>
</template>
