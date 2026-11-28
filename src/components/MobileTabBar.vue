<script setup>
/**
 * The phone tab bar — the seven destinations the rail carries on a desktop
 * window, in the thumb zone. Two of them (Entities, Artifacts) are panels, not
 * routes: tapping one opens its list in the drawer, the same way the rail opens
 * it beside the page.
 */
import { useRoute } from 'vue-router'
import NavIcon from '@/components/NavIcon.vue'
import { hub } from '@/stores/hub'
import { NAV, isActive as isActiveNav, linkFor } from '@/lib/nav'

const route = useRoute()

function isActive(item) {
  return isActiveNav(item, route)
}

/* Re-tapping the tab you are already on opens that section's list — the drawer
   is the second tier, so on /overview this is the only way in without the
   appbar. A different tab is a plain navigation, and the route watch in
   AppRail clears the drawer for us. */
function onTab(item, event) {
  if (isActive(item)) {
    event.preventDefault()
    hub.rail.drawer = true
    return
  }
  hub.rail.entities = false
  hub.rail.artifacts = false
}

function openPanel(item) {
  hub.rail.entities = item.panel === 'entities'
  hub.rail.artifacts = item.panel === 'artifacts'
  hub.rail.drawer = true
}
</script>

<template>
  <nav class="tabbar" aria-label="Sections">
    <div class="tab-track">
      <template v-for="item in NAV" :key="item.view">
        <router-link
          v-if="item.name"
          class="tab"
          :to="linkFor(item)"
          :aria-current="isActive(item) ? 'page' : undefined"
          @click="onTab(item, $event)"
        >
          <NavIcon :name="item.icon" />
          <span class="tab-lb">
            <span class="tab-lb-full">{{ item.label }}</span>
            <!-- Seven cells share 360 px: `Configurations` would only ever reach
                 its ellipsis there, so the thumb bar says `Config`. -->
            <span class="tab-lb-short">{{ item.short || item.label }}</span>
          </span>
          <span v-if="item.count && item.count()" class="rail-badge tab-n">{{ item.count() }}</span>
        </router-link>
        <button
          v-else
          class="tab"
          type="button"
          :aria-current="isActive(item) ? 'page' : undefined"
          @click="openPanel(item)"
        >
          <NavIcon :name="item.icon" />
          <span class="tab-lb">
            <span class="tab-lb-full">{{ item.label }}</span>
            <!-- Seven cells share 360 px: `Configurations` would only ever reach
                 its ellipsis there, so the thumb bar says `Config`. -->
            <span class="tab-lb-short">{{ item.short || item.label }}</span>
          </span>
          <span v-if="item.count && item.count()" class="rail-badge tab-n">{{ item.count() }}</span>
        </button>
      </template>
    </div>
  </nav>
</template>
