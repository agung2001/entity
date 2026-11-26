<script setup>
import { computed } from 'vue'
import ConnectorDashboard from '@/connectors/github/GithubDashboard.vue'
import LynkDashboard from '@/connectors/lynk/LynkDashboard.vue'
import ConnectorClockifyDashboard from '@/connectors/clockify/ClockifyDashboard.vue'
import ConnectorFitbitDashboard from '@/connectors/fitbit/FitbitDashboard.vue'
import ConnectorHabitifyDashboard from '@/connectors/habitify/HabitifyDashboard.vue'
import ConnectorStudioDashboard from '@/connectors/youtube-studio/StudioDashboard.vue'
import GoogleCalendarDashboard from '@/connectors/google-calendar/CalendarDashboard.vue'
import { readState as readClockifyState } from '@/connectors/clockify/useClockify'

/**
 * The Dashboard tab's body, and the one place that knows which connector draws it.
 *
 * It was a seven-link `v-if` chain inline in `ConnectorPageView`, beside the
 * Overview pane it falls through to — the last piece of per-connector knowledge
 * still in the router. The page now renders one component and passes the two
 * things a body cannot ask for itself: which dashboard it is, and the day from the
 * address. Everything else — the read, the strip, the gate — is the connector's
 * own (`connectors/dashboards`).
 *
 * **One dashboard, one id.** `$attrs` carries the pane's `id`, `role` and
 * `aria-labelledby` from the page, and every body wears them: a body that named
 * itself would make the strip's `aria-controls` a different id per connector. That
 * is why the fall-through chain lives here rather than as seven siblings — a
 * standalone block beside it would let the Overview pane render underneath.
 *
 * **A locked body is absent, not empty.** Fitbit's and Lynk.id's dashboard bodies
 * are gated on their own lock (the page decides, because it is the same gate the
 * tab reads), and a locked one falls through to Overview: a mounted dashboard
 * reads on mount, so a body that should not be there would spend an account's
 * budget it has no grant for.
 */
const props = defineProps({
  /** Which dashboard this is: `github` | `calendar` | `studio` | `clockify` |
      `habitify` | `fitbit` | `lynk`. Empty is not a body, and the page does not
      mount this component for it. */
  kind: { type: String, default: '' },
  /** The civil day from the address, for Habitify's week. */
  day: { type: String, default: '' },
  /** Fitbit's day: `''` (today), `yesterday`, or `YYYY-MM-DD`. */
  fitbitDay: { type: String, default: '' },
})
const emit = defineEmits(['overview', 'select-day', 'pick'])

/* The chain's own read order, kept as a value so the template is a list of bodies
   rather than a puzzle about which `v-else-if` wins. */
const body = computed(() => props.kind)
</script>

<template>
  <ConnectorClockifyDashboard
    v-if="body === 'clockify'"
    v-bind="$attrs"
    @overview="emit('overview')"
    @changed="readClockifyState"
  />
  <ConnectorDashboard v-else-if="body === 'github'" v-bind="$attrs" />
  <LynkDashboard v-else-if="body === 'lynk'" v-bind="$attrs" />
  <GoogleCalendarDashboard v-else-if="body === 'calendar'" v-bind="$attrs" @overview="emit('overview')" />
  <ConnectorStudioDashboard v-else-if="body === 'studio'" v-bind="$attrs" @overview="emit('overview')" />
  <ConnectorHabitifyDashboard
    v-else-if="body === 'habitify'"
    v-bind="$attrs"
    :day="day"
    @select-day="emit('select-day', $event)"
  />
  <ConnectorFitbitDashboard
    v-else-if="body === 'fitbit'"
    v-bind="$attrs"
    :day="fitbitDay"
    @pick="emit('pick', $event)"
  />
</template>
