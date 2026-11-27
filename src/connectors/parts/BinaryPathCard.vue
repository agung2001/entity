<script setup>
import { computed, onMounted, ref } from 'vue'
import { call } from '@/composables/localBridge'

/**
 * Where a local CLI connector's binary is, and the one field that overrides the
 * search.
 *
 * Two connectors ship as a command on the person's machine — Orca and the GitHub
 * CLI — and their resolvers (`electron/connectors/_binary.cjs`, behind each
 * connector's `path.cjs`) already know the install locations for this platform, the
 * user's own bin and PATH. Most machines never touch this card. It exists for the
 * one that does: a portable install, a checkout, a package manager with its own
 * prefix — where the only alternative was an environment variable on the app's
 * launch, which is not a setting a person has.
 *
 * One component for both, because the field, the refusal and the reset are the same
 * behaviour; what differs is a heading, an environment variable's name, and which
 * calls the connector answers. Passing those in is what keeps the two pages from
 * drifting.
 *
 * The path is machine state, never workspace state: it is read and written through
 * the connector's own two calls (`<fn>.path` / `<fn>.setPath`), so nothing here
 * travels with the workspace and no teammate inherits a path that only exists on
 * this computer.
 *
 * Saving is on commit, not on keystroke: a half-typed path is not a setting, and
 * every save is a real write with a real refusal to report. What the card shows
 * afterwards is the resolution *after* the write — clearing the field answers
 * "automatic" in the same answer as a save, so the two cannot disagree.
 */
const props = defineProps({
  /** The call prefix this connector's own two verbs answer to (`orca`, `github`). */
  fn: { type: String, required: true },
  /** The row's own name, so the heading is the page's, not a second literal. */
  label: { type: String, default: '' },
  /** The variable a process is launched with, shown as where a path came from. */
  environment: { type: String, required: true },
})

/* `source` is the resolver's word for *why* this binary. Printed as prose, because
   `app` or `package` alone means nothing. */
const SOURCE = {
  stored: 'the path set on this page',
  environment: props.environment,
  app: "the app's own install on this machine",
  package: "a package manager's install on this machine",
  home: 'your own bin directory',
  system: 'a system directory',
  path: 'PATH — the search found nothing, so it is looked up like a terminal would',
}

const state = ref({ binary: '', source: '', searched: [] })
const draft = ref('')
const busy = ref(false)
const error = ref('')
const notice = ref('')

const source = computed(() => {
  const why = String(state.value.source || '')
  if (why === 'environment') return `${SOURCE.environment}, from the environment the app was started with`
  return SOURCE[why] || why || 'not read yet'
})
const custom = computed(() => state.value.source === 'stored')
/* A binary the search never found is the one case that needs saying out loud: the
   card would otherwise print a bare name and look like it had resolved. */
const missing = computed(() => state.value.source === 'path')

async function load() {
  try {
    state.value = await call(`${props.fn}.path`)
    draft.value = custom.value ? state.value.binary : ''
  } catch (failure) {
    error.value = String(failure?.message || failure)
  }
}

async function save() {
  if (busy.value) return
  error.value = ''
  notice.value = ''
  busy.value = true
  try {
    const next = await call(`${props.fn}.setPath`, { binary: draft.value })
    const cleared = !String(draft.value || '').trim()
    state.value = next
    draft.value = next.source === 'stored' ? next.binary : ''
    notice.value = cleared
      ? 'Cleared — the connector searches for its binary again.'
      : `Saved — this machine runs ${next.binary}.`
  } catch (failure) {
    /* The field keeps what was typed: the message says what to fix, and retyping a
       long path to fix one word of it is the wrong tax. */
    error.value = String(failure?.message || failure)
  } finally {
    busy.value = false
  }
}

/** Back to the automatic search, which is a write of an empty path. */
function clear() {
  draft.value = ''
  return save()
}

onMounted(load)
</script>

<template>
  <section class="cxn-card">
    <h2>{{ label }} binary</h2>
    <dl class="cxn-facts">
      <dt>binary</dt>
      <!-- A whole path ellipsizes in a rail that has to hold a Windows path; the
           title keeps the cut end reachable without widening the page. -->
      <dd class="mono" :title="state.binary">{{ state.binary || '—' }}</dd>
      <dt>found via</dt>
      <dd>{{ source }}</dd>
    </dl>
    <div class="cxn-fields">
      <!-- The placeholder is the shape rather than a guess at the path: this app
           ships on macOS, Windows and Linux, and a real example would be wrong on
           two of them. -->
      <label>
        binary path
        <input
          v-model="draft"
          class="mono"
          type="text"
          placeholder="the whole path to the binary, or its name on PATH"
          autocomplete="off"
          spellcheck="false"
          :title="state.binary"
          :disabled="busy"
          @change="save"
        />
      </label>
    </div>
    <div class="cxn-acts">
      <button v-if="custom" class="btn btn-sm" type="button" :disabled="busy" @click="clear">
        Use the automatic search
      </button>
    </div>
    <p v-if="error" class="cxn-error">{{ error }}</p>
    <p v-else-if="notice" class="cxn-ok">{{ notice }}</p>
    <p class="cxn-note">
      The field saves when you leave it. Cleared, the connector searches the way it does by
      default: a package manager's or the app's own install on this platform, then
      <code class="mono">~/.local/bin</code> and <code class="mono">~/bin</code>, then the system
      directories, then <code class="mono">PATH</code>. A whole path here wins over all of it.
      <template v-if="missing">
        Nothing answered that search on this machine — name the binary above, then press
        <b>Test connection</b> below.
      </template>
      <template v-else>
        <b>Test connection</b> below asks this binary for its own answer.
      </template>
    </p>
  </section>
</template>
