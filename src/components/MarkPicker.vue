<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import EntityMark from '@/components/EntityMark.vue'
import {
  COLORS,
  MOODS,
  colorById,
  markSettings,
  moodById,
  setMark,
} from '@/composables/entityMark'

/**
 * The drawer's character is the control: clicking it opens the two things it
 * owns — which mood it wears, and what colour it is. Moods are emoji markers,
 * not motion; the animation is identical under every one of them.
 */
const open = ref(false)
const root = ref(null)

const sub = computed(
  () => `${moodById(markSettings.mood).name} · ${colorById(markSettings.color).name}`,
)

function toggle() {
  open.value = !open.value
}

function onDocumentClick(e) {
  if (!open.value || root.value?.contains(e.target)) return
  open.value = false
}
function onDocumentKey(e) {
  if (e.key === 'Escape' && open.value) {
    open.value = false
    root.value?.querySelector('.mk-btn')?.focus()
  }
}

/** both groups are radiogroups, so arrows move between options */
function arrowNav(e, selector) {
  if (!/^Arrow(Left|Right|Up|Down)$/.test(e.key)) return
  const items = [...(root.value?.querySelectorAll(selector) || [])]
  const i = items.indexOf(document.activeElement)
  if (i < 0) return
  e.preventDefault()
  const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown'
  items[(i + (forward ? 1 : items.length - 1)) % items.length].focus()
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick)
  document.addEventListener('keydown', onDocumentKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick)
  document.removeEventListener('keydown', onDocumentKey)
})
</script>

<template>
  <div ref="root" class="mk-wrap">
    <button
      class="mk-btn"
      type="button"
      :aria-expanded="open ? 'true' : 'false'"
      aria-controls="mkpop"
      aria-label="Entity mark — mood and colour"
      @click="toggle"
    >
      <EntityMark />
    </button>

    <div id="mkpop" class="mkpop" :data-open="open ? '1' : '0'" role="group" aria-label="Entity mark">
      <div class="pv">
        <EntityMark />
        <div>
          <h3>Entity mark</h3>
          <p>{{ sub }}</p>
        </div>
      </div>

      <p class="lbl">Mood</p>
      <div class="mk-row" role="radiogroup" aria-label="Mood" @keydown="arrowNav($event, '.mk-mood')">
        <button
          v-for="m in MOODS"
          :key="m.id"
          class="mk-mood"
          type="button"
          role="radio"
          :aria-checked="markSettings.mood === m.id ? 'true' : 'false'"
          :aria-label="m.name"
          :title="m.name"
          @click="setMark({ mood: m.id })"
        >
          <template v-if="m.glyph">{{ m.glyph }}</template>
          <svg
            v-else
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            aria-hidden="true"
          >
            <path d="M1.6 5h6.8" />
          </svg>
        </button>
      </div>

      <p class="lbl">Colour</p>
      <div class="mk-sw" role="radiogroup" aria-label="Colour" @keydown="arrowNav($event, '.mk-dot')">
        <button
          v-for="c in COLORS"
          :key="c.id"
          class="mk-dot"
          type="button"
          role="radio"
          :aria-checked="markSettings.color === c.id ? 'true' : 'false'"
          :aria-label="c.name"
          :title="c.name"
          :style="{ '--mk': c.v }"
          @click="setMark({ color: c.id })"
        ></button>
      </div>

      <p class="note">One identity — every mark in the hub follows this.</p>
    </div>
  </div>
</template>
