<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import EntityMark from '@/components/EntityMark.vue'
import {
  COLORS,
  EMOJI_GROUPS,
  MOODS,
  SHAPES,
  colorById,
  hexToHsl,
  hslToHex,
  markFor,
  moodById,
  moodGlyph,
  setMark,
  shapeById,
} from '@/composables/entityMark'
import { hub } from '@/stores/hub'

/**
 * The drawer's character is the control: clicking it opens the two things it
 * owns — which mood it wears, and what colour it is. Moods are emoji markers,
 * not motion; the animation is identical under every one of them.
 *
 * The mood belongs to this entity, not the hub: picking one never repaints
 * another entity's mark. The shortlist is six tiles; the drawer behind it is
 * the searchable library.
 */
const props = defineProps({
  entity: { type: String, default: '' },
})

const open = ref(false)
const drawerOpen = ref(false)
const query = ref('')
const group = ref('all')
const root = ref(null)
const searchInput = ref(null)
const wheel = ref(null)
const dragging = ref(false)
const wheelHue = ref(78)
const wheelSat = ref(0.78)
const wheelLight = ref(0.62)

const mark = computed(() =>
  markFor(
    hub.workspace,
    props.entity,
    hub.agents.find((agent) => agent.name === props.entity)?.mark || null,
  ),
)
const activeGlyph = computed(() => moodGlyph(mark.value.mood))
const activeShape = computed(() => shapeById(mark.value.shape))
const currentColor = computed(() => colorById(mark.value.color, mark.value.custom))
const sub = computed(
  () =>
    `${activeShape.value.name} · ${moodById(mark.value.mood).name} · ${currentColor.value.name}`,
)
const wheelHex = computed(() => hslToHex(wheelHue.value, wheelSat.value, wheelLight.value))
const wheelDot = computed(() => {
  const radians = (wheelHue.value * Math.PI) / 180
  const radius = wheelSat.value * 43
  return {
    left: `${50 + Math.cos(radians) * radius}%`,
    top: `${50 + Math.sin(radians) * radius}%`,
    background: wheelHex.value,
  }
})

function syncWheel() {
  if (dragging.value) return
  if (mark.value.color === 'custom' && mark.value.custom) {
    const hsl = hexToHsl(mark.value.custom)
    wheelHue.value = hsl.h
    wheelSat.value = hsl.s
    wheelLight.value = hsl.l
    return
  }
  const preset = colorById(mark.value.color, mark.value.custom)
  const hsl = hexToHsl(preset.hex)
  wheelHue.value = hsl.h
  wheelSat.value = hsl.s
  wheelLight.value = hsl.l
}

watch(
  () => [mark.value.color, mark.value.custom],
  syncWheel,
  { immediate: true },
)

const groups = computed(() => [
  { id: 'all', label: 'All' },
  ...EMOJI_GROUPS.map((item) => ({ id: item.id, label: item.label })),
])

const results = computed(() => {
  const q = query.value.trim().toLowerCase()
  return EMOJI_GROUPS.filter((item) => group.value === 'all' || item.id === group.value)
    .flatMap((item) => item.items.map((emoji) => ({ ...emoji, groupLabel: item.label })))
    .filter((emoji) => {
      if (!q) return true
      return (
        emoji.name.toLowerCase().includes(q) ||
        emoji.keywords.toLowerCase().includes(q) ||
        emoji.glyph === q
      )
    })
})

function toggle() {
  open.value = !open.value
  if (!open.value) drawerOpen.value = false
}

async function toggleFinder() {
  drawerOpen.value = !drawerOpen.value
  if (drawerOpen.value) {
    await nextTick()
    searchInput.value?.focus()
  }
}

function chooseMood(id) {
  setMark({ mood: id, workspace: hub.workspace, entity: props.entity })
}

function chooseEmoji(item) {
  const builtin = MOODS.find((m) => m.glyph === item.glyph)
  chooseMood(builtin ? builtin.id : item.glyph)
}

function chooseShape(id) {
  setMark({ shape: id, workspace: hub.workspace, entity: props.entity })
}

function applyWheel(persist = true) {
  setMark({
    color: 'custom',
    custom: wheelHex.value,
    workspace: hub.workspace,
    entity: props.entity,
    persist,
  })
}

function setFromWheel(event) {
  const el = wheel.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const x = event.clientX - (rect.left + rect.width / 2)
  const y = event.clientY - (rect.top + rect.height / 2)
  const max = rect.width / 2 - 8
  wheelHue.value = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
  wheelSat.value = Math.min(1, Math.max(0, Math.hypot(x, y) / max))
  applyWheel(false)
}

function onWheelDown(event) {
  event.preventDefault()
  dragging.value = true
  wheel.value?.setPointerCapture?.(event.pointerId)
  setFromWheel(event)
}

function onWheelMove(event) {
  if (!dragging.value) return
  setFromWheel(event)
}

function onWheelUp(event) {
  if (!dragging.value) return
  dragging.value = false
  wheel.value?.releasePointerCapture?.(event.pointerId)
  applyWheel(true)
}

function onLight(event) {
  wheelLight.value = Number(event.target.value) / 100
  applyWheel(false)
}

function onLightCommit() {
  applyWheel(true)
}

function onDocumentClick(e) {
  if (!open.value || root.value?.contains(e.target)) return
  open.value = false
  drawerOpen.value = false
}
function onDocumentKey(e) {
  if (e.key === 'Escape' && open.value) {
    if (drawerOpen.value) {
      drawerOpen.value = false
      return
    }
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
      aria-label="Entity mark — shape, mood and colour"
      @click="toggle"
    >
      <EntityMark :entity="entity" />
    </button>

    <div id="mkpop" class="mkpop" :data-open="open ? '1' : '0'" role="group" aria-label="Entity mark">
      <div class="pv">
        <EntityMark :entity="entity" />
        <div>
          <h3>Entity mark</h3>
          <p>{{ sub }}</p>
        </div>
      </div>

      <p class="lbl">Shape</p>
      <div class="mk-shapes" role="radiogroup" aria-label="Shape" @keydown="arrowNav($event, '.mk-shape')">
        <button
          v-for="s in SHAPES"
          :key="s.id"
          class="mk-shape"
          type="button"
          role="radio"
          :aria-checked="activeShape.id === s.id ? 'true' : 'false'"
          :aria-label="s.name"
          :title="s.name"
          @click="chooseShape(s.id)"
        >
          <EntityMark mini :entity="entity" :shape="s.id" :badge="false" />
          <span>{{ s.name }}</span>
        </button>
      </div>

      <div class="mk-mood-head">
        <p class="lbl">Mood</p>
        <button
          class="mk-finder-btn"
          type="button"
          :aria-expanded="drawerOpen ? 'true' : 'false'"
          aria-controls="mkfinder"
          @click="toggleFinder"
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <circle cx="7" cy="7" r="4.4" />
            <path d="M10.4 10.4L14 14" />
          </svg>
          {{ drawerOpen ? 'Hide drawer' : 'Emoji drawer' }}
        </button>
      </div>
      <div class="mk-row" role="radiogroup" aria-label="Mood" @keydown="arrowNav($event, '.mk-mood')">
        <button
          v-for="m in MOODS"
          :key="m.id"
          class="mk-mood"
          type="button"
          role="radio"
          :aria-checked="activeGlyph === m.glyph ? 'true' : 'false'"
          :aria-label="m.name"
          :title="m.name"
          @click="chooseMood(m.id)"
        >
          <span v-if="m.glyph" class="mk-glyph">{{ m.glyph }}</span>
          <svg
            v-else
            width="14"
            height="14"
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

      <div v-if="drawerOpen" id="mkfinder" class="mk-finder">
        <label class="mk-find">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <circle cx="7" cy="7" r="4.6" />
            <path d="M10.5 10.5L14 14" />
          </svg>
          <input
            ref="searchInput"
            v-model="query"
            type="text"
            placeholder="Find an emoji — cat, rocket, brain…"
            spellcheck="false"
            aria-label="Find an emoji"
          />
          <button
            v-if="query"
            class="mk-clear"
            type="button"
            aria-label="Clear the emoji search"
            @click="query = ''"
          >
            <svg width="10" height="10" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <path d="M2 2l8 8M10 2l-8 8" />
            </svg>
          </button>
        </label>

        <div class="mk-cats" role="group" aria-label="Emoji groups">
          <button
            v-for="g in groups"
            :key="g.id"
            class="mk-cat"
            type="button"
            :aria-pressed="group === g.id ? 'true' : 'false'"
            @click="group = g.id"
          >
            {{ g.label }}
          </button>
        </div>

        <div
          v-if="results.length"
          class="mk-emoji-grid"
          role="radiogroup"
          aria-label="Emoji"
          @keydown="arrowNav($event, '.mk-emoji')"
        >
          <button
            v-for="item in results"
            :key="item.glyph"
            class="mk-emoji"
            type="button"
            role="radio"
            :aria-checked="activeGlyph === item.glyph ? 'true' : 'false'"
            :aria-label="item.name"
            :title="`${item.name} · ${item.groupLabel}`"
            @click="chooseEmoji(item)"
          >
            {{ item.glyph }}
          </button>
        </div>
        <p v-else class="mk-none">No emoji matches “{{ query }}”. Try a mood, an animal or a tool.</p>
      </div>

      <p class="lbl">Colour</p>
      <div class="mk-sw" role="radiogroup" aria-label="Colour" @keydown="arrowNav($event, '.mk-dot')">
        <button
          v-for="c in COLORS"
          :key="c.id"
          class="mk-dot"
          type="button"
          role="radio"
          :aria-checked="mark.color === c.id ? 'true' : 'false'"
          :aria-label="c.name"
          :title="c.name"
          :style="{ '--mk': c.v }"
          @click="setMark({ color: c.id, workspace: hub.workspace, entity })"
        ></button>
      </div>

      <div class="mk-wheel-row">
        <div
          ref="wheel"
          class="mk-wheel"
          role="slider"
          tabindex="0"
          aria-label="Custom colour wheel"
          aria-valuemin="0"
          aria-valuemax="360"
          :aria-valuenow="Math.round(wheelHue)"
          @pointerdown="onWheelDown"
          @pointermove="onWheelMove"
          @pointerup="onWheelUp"
          @pointercancel="onWheelUp"
        >
          <span class="mk-wheel-dot" :style="wheelDot"></span>
        </div>
        <div class="mk-wheel-side">
          <span class="mk-wheel-hex">{{ wheelHex }}</span>
          <label class="mk-light">
            <span>Light</span>
            <input
              type="range"
              min="20"
              max="85"
              :value="Math.round(wheelLight * 100)"
              :style="{ accentColor: wheelHex }"
              aria-label="Colour lightness"
              @input="onLight"
              @change="onLightCommit"
            />
          </label>
          <button class="mk-wheel-use" type="button" @click="applyWheel(true)">Use colour</button>
        </div>
      </div>

      <p class="note">
        {{
          entity
            ? 'Shape, mood and colour belong to this entity only. Other entities keep their own.'
            : 'The hub brand mark. Entities keep their own shape, mood and colour.'
        }}
      </p>
    </div>
  </div>
</template>
