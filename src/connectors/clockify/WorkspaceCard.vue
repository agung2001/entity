<script setup>
import { clockify, pickSpace, readSpaces } from '@/connectors/clockify/useClockify'
import { onMounted } from 'vue'

/**
 * The one control Clockify's dashboard is gated on: which workspace its reports
 * are read inside.
 *
 * It was a block in the middle of `ConnectorPageView`'s Overview column, `v-if`'d
 * on the connector's name — a piece of Clockify's page living in the router. The
 * page now draws this card for the one connector that has it and owns none of its
 * state: the read, the write and the failure sentence are all in
 * `composables/clockifyConnector.js`.
 *
 * Without a key the list is not asked for — reading it *is* a read the key makes,
 * so the card says so rather than offering a list it cannot have.
 */
onMounted(() => {
  readSpaces().catch(() => {})
})
</script>

<template>
  <section class="cxn-card">
    <div class="cxn-card-head">
      <h2>Workspace</h2>
      <span class="spacer"></span>
      <span class="n">{{ clockify.workspaceId ? 'chosen' : 'not chosen' }}</span>
    </div>
    <p class="cxn-note">
      Every read happens inside one Clockify workspace — its reports, its people
      and its projects. Choosing one here is what unlocks the dashboard tab.
    </p>
    <p v-if="!clockify.configured" class="cxn-note">
      Paste a key first: the list of workspaces is one of the reads that key makes.
    </p>
    <template v-else>
      <div
        v-if="clockify.spaces.length"
        class="seg ck-seg"
        role="group"
        aria-label="Which Clockify workspace to read"
      >
        <button
          v-for="space in clockify.spaces"
          :key="space.id"
          type="button"
          :title="space.name"
          :aria-pressed="space.id === clockify.workspaceId"
          :aria-busy="clockify.picking ? 'true' : undefined"
          :disabled="clockify.picking"
          @click="pickSpace(space)"
        ><span class="nm">{{ space.name }}</span></button>
      </div>
      <p v-else-if="!clockify.spacesLoaded && !clockify.spacesError" class="cxn-note">
        Reading the workspaces this key can see…
      </p>
      <p v-else-if="!clockify.spacesError" class="cxn-note">
        This key can read no workspace. Its owner needs to be a member of one.
      </p>
      <p class="cxn-note">
        The reports are read inside the chosen workspace only; the key itself
        never leaves this machine.
      </p>
    </template>
    <div v-if="clockify.spacesError" class="cxn-error" role="alert">{{ clockify.spacesError }}</div>
  </section>
</template>
