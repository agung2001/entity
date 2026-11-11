<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { fleet, loadFleet } from '@/stores/fleet'
import { library, loadLibrary } from '@/stores/library'
import { hub, initials, openDrawer } from '@/stores/hub'

/**
 * Jump-to palette. Items are the three things a hub is made of — machines,
 * skills and entities — filtered by label.
 */
const router = useRouter()
const input = ref(null)

onMounted(() => {
  loadFleet()
  loadLibrary()
})

const items = computed(() => {
  const q = hub.palette.query.trim().toLowerCase()
  const hosts = fleet.loaded ? fleet.hosts : hub.machines
  const skills = library.loaded ? library.items : hub.skills
  const list = [
    ...hosts.map((m) => ({
      kind: 'machine',
      id: m.id || m.alias,
      label: m.label || m.name,
      act: () => router.push('/machines'),
    })),
    ...skills.map((s) => ({
      kind: 'skill',
      id: s.id || s.name,
      label: s.name,
      act: () =>
        s.harness
          ? router.push({ name: 'skill', params: { name: s.name }, query: { harness: s.harness } })
          : router.push('/skills'),
    })),
    ...hub.agents.map((a) => ({ kind: 'entity', id: a.id, label: a.name, act: () => openDrawer(a.id) })),
  ]
  return list.filter((i) => i.label.toLowerCase().includes(q))
})

watch(
  () => hub.palette.open,
  async (open) => {
    if (!open) return
    await nextTick()
    input.value?.focus()
  },
)

function close() {
  hub.palette.open = false
}

function run(item) {
  if (!item) return
  close()
  item.act()
}

function onInput() {
  hub.palette.active = 0
}

function onKey(e) {
  const list = items.value
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const next =
      e.key === 'ArrowDown'
        ? Math.min(list.length - 1, hub.palette.active + 1)
        : Math.max(0, hub.palette.active - 1)
    hub.palette.active = next
  } else if (e.key === 'Enter') {
    e.preventDefault()
    run(list[hub.palette.active])
  }
}
</script>

<template>
  <div
    class="palette"
    :data-open="hub.palette.open ? '1' : '0'"
    role="dialog"
    aria-modal="true"
    aria-label="Command palette"
  >
    <div class="pin">
      <span>›</span>
      <input
        ref="input"
        :value="hub.palette.query"
        placeholder="Jump to an entity, skill or machine…"
        autocomplete="off"
        spellcheck="false"
        @input="hub.palette.query = $event.target.value; onInput()"
        @keydown="onKey"
      />
      <kbd>esc</kbd>
    </div>
    <div class="plist" role="listbox" aria-label="Results">
      <template v-if="items.length">
        <div
          v-for="(item, i) in items"
          :key="item.kind + item.id"
          class="pitem"
          :data-on="i === hub.palette.active ? '1' : '0'"
          role="option"
          :aria-selected="i === hub.palette.active ? 'true' : 'false'"
          @click="run(item)"
        >
          <span class="sq">{{ initials(item.label) }}</span>{{ item.label
          }}<span class="k">{{ item.kind }}</span>
        </div>
      </template>
      <div v-else class="pempty">No matches</div>
    </div>
  </div>
</template>
