<script setup>
/**
 * The connector page's `Overview | Dashboard` strip, for the shell that has to
 * mount it by hand.
 *
 * The `cli` connectors draw this same strip inline in `ConnectorPageView`, and it
 * stays there: that branch is where the github dashboard and its lock already
 * live, and re-pointing it would put a second edit between a working tab and the
 * page that renders it. This component exists for the other shell — an `mcp`
 * server, which is a `McpServerView` with no strip and no slot to inject one into
 * — so the four things a locked tab needs (reachable, announced as disabled,
 * described by the reason, and inert when activated) are written once instead of
 * being re-derived on the page that mounts them.
 *
 * **The lock is a line, not a tooltip.** A `disabled` button takes itself out of
 * the tab order, which is how a reason nobody can focus goes unread; so a locked
 * tab stays reachable, says `aria-disabled="true"`, and the sentence under the
 * strip is what activating it lands on. Activating it does nothing at all: it
 * does not animate, it does not navigate, and it does not move focus somewhere
 * the person did not ask to go.
 *
 * The strip decides nothing about *why* a connector is locked — the reason is
 * passed in whole, because the sentence for a missing `mcp.json` entry and the
 * sentence for a `gh` binary that is not on PATH are different facts, and a
 * computed reason would drift from the state it describes.
 */
const props = defineProps({
  /* `overview` or `dashboard` — the parent already read it out of the address. */
  tab: { type: String, default: 'overview' },
  /* `null` when the Dashboard can be opened; otherwise `{ before, code, after,
     code2, after2, title }`, with the `code` parts optional. */
  lock: { type: Object, default: null },
  /* The unlocked tab's tooltip: each connector's dashboard answers a different
     question, so the sentence is the page's, not this component's. */
  title: { type: String, default: '' },
})
const emit = defineEmits(['select'])

const TABS = ['overview', 'dashboard']
const canOpen = (name) => name === 'overview' || !props.lock

function pick(name) {
  if (!canOpen(name)) return
  emit('select', name)
}

/* Roving tabindex, the pattern the app's other strips use: one stop for the whole
   strip and the arrows walk it. A locked tab keeps `tabindex="0"` so the reason
   under the strip is reachable by Tab. */
function onKey(event) {
  const delta = { ArrowLeft: -1, ArrowRight: 1 }[event.key]
  if (delta === undefined) return
  event.preventDefault()
  const next = TABS[(TABS.indexOf(props.tab) + delta + TABS.length) % TABS.length]
  if (canOpen(next)) emit('select', next)
}
</script>

<template>
  <nav class="sk-tabs cxn-tabs" role="tablist" aria-label="Connector sections" @keydown="onKey">
    <button
      id="cxn-tab-overview"
      type="button"
      role="tab"
      :aria-selected="tab === 'overview'"
      :tabindex="tab === 'overview' ? 0 : -1"
      aria-controls="cxn-pane-overview"
      @click="pick('overview')"
    >Overview</button>
    <!-- A locked tab is not `disabled`: it keeps its place in the tab order so the
         reason under the strip is reachable, and activating it does nothing. -->
    <button
      id="cxn-tab-dashboard"
      type="button"
      role="tab"
      :aria-selected="tab === 'dashboard'"
      :tabindex="tab === 'dashboard' || lock ? 0 : -1"
      aria-controls="cxn-pane-dashboard"
      :aria-disabled="lock ? 'true' : undefined"
      :aria-describedby="lock ? 'cxn-tab-why' : undefined"
      :title="lock ? lock.title : title"
      @click="pick('dashboard')"
    >
      <svg
        v-if="lock"
        class="lk"
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      ><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
      Dashboard
    </button>
    <!-- The reason is a line, not a tooltip: it stays on screen for as long as the
         tab is locked, which is the only way it can be read by somebody who never
         hovers. The mono parts are the names a person has to type or paste. -->
    <p v-if="lock" id="cxn-tab-why" class="tab-why">
      {{ lock.before }}<code v-if="lock.code" class="mono">{{ lock.code }}</code>{{ lock.after
      }}<template v-if="lock.code2"><code class="mono">{{ lock.code2 }}</code>{{ lock.after2 }}</template>
    </p>
  </nav>
</template>
