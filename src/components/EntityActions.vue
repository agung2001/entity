<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import EntityCloneDialog from '@/components/EntityCloneDialog.vue'
import { forgetMark, markFor } from '@/composables/entityMark'
import { duplicateEntity, removeEntity, revealEntity } from '@/stores/entities'
import { chatFocusEntity, hub, toast } from '@/stores/hub'

/**
 * The row's rare actions live behind one three-dot menu: chat, reveal,
 * duplicate, clone and delete. The row itself opens the entity page; every
 * control here stops propagation so clicking an action never also opens it.
 */
const props = defineProps({
  entity: { type: Object, required: true },
})

const router = useRouter()
const root = ref(null)
const trigger = ref(null)
const menuEl = ref(null)
const menuOpen = ref(false)
const menuPos = ref({ top: '0px', left: '0px' })
const confirming = ref(false)
const cloneOpen = ref(false)
let confirmTimer = 0

const WIDTH = 184
const HEIGHT = 186

function stop(event) {
  event.stopPropagation()
}

function closeMenu() {
  menuOpen.value = false
  confirming.value = false
  clearTimeout(confirmTimer)
}

function toggleMenu(event) {
  stop(event)
  if (menuOpen.value) {
    closeMenu()
    return
  }
  const rect = event.currentTarget.getBoundingClientRect()
  const left = Math.max(8, Math.min(rect.right - WIDTH, window.innerWidth - WIDTH - 8))
  let top = rect.bottom + 6
  if (top + HEIGHT > window.innerHeight - 8) top = Math.max(8, rect.top - HEIGHT - 6)
  menuPos.value = { top: `${top}px`, left: `${left}px` }
  menuOpen.value = true
  nextTick(() => menuEl.value?.querySelector('button')?.focus())
}

async function chat() {
  closeMenu()
  try {
    await chatFocusEntity(props.entity.id)
  } catch (error) {
    toast(error?.message || `Could not open a thread for ${props.entity.name}`)
    return
  }
  router.push({ name: 'chat', params: { workspace: hub.workspace } })
}

async function reveal() {
  closeMenu()
  try {
    await revealEntity(props.entity.name)
    toast(`Revealed ${props.entity.displayPath || `${props.entity.name}.md`}`)
  } catch (error) {
    toast(error?.message || 'Could not reveal the file')
  }
}

function openClone() {
  closeMenu()
  cloneOpen.value = true
}

async function duplicate() {
  closeMenu()
  try {
    const mark = markFor(hub.workspace, props.entity.name, props.entity.mark || null)
    const copy = await duplicateEntity(props.entity.name, {
      shape: mark.shape,
      color: mark.color,
      mood: mark.mood,
    })
    toast(`${copy.name}.md duplicated`)
    router.push({ name: 'entity', params: { workspace: hub.workspace, name: copy.name } })
  } catch (error) {
    toast(error?.message || 'The entity could not be duplicated.')
  }
}

async function remove() {
  if (!confirming.value) {
    confirming.value = true
    clearTimeout(confirmTimer)
    confirmTimer = setTimeout(() => {
      if (menuOpen.value) confirming.value = false
    }, 2800)
    return
  }
  const name = props.entity.name
  closeMenu()
  try {
    await removeEntity(name)
    forgetMark(hub.workspace, name)
    toast(`${name}.md deleted`)
  } catch (error) {
    toast(error?.message || 'The entity could not be deleted.')
  }
}

function onDocumentClick(event) {
  if (!menuOpen.value) return
  const target = event.target
  if (target instanceof Element && target.closest('.row-menu-pop')) return
  if (root.value?.contains(target)) return
  closeMenu()
}

function onKeydown(event) {
  if (event.key !== 'Escape' || !menuOpen.value) return
  closeMenu()
  trigger.value?.focus()
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick, true)
  document.addEventListener('keydown', onKeydown)
  window.addEventListener('resize', closeMenu)
  window.addEventListener('scroll', closeMenu, true)
})
onBeforeUnmount(() => {
  clearTimeout(confirmTimer)
  document.removeEventListener('click', onDocumentClick, true)
  document.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', closeMenu)
  window.removeEventListener('scroll', closeMenu, true)
})
</script>

<template>
  <span ref="root" class="row-actions" @click.stop @keydown.stop>
    <button
      ref="trigger"
      class="row-act row-menu-btn"
      type="button"
      title="Entity actions"
      aria-label="Entity actions"
      aria-haspopup="menu"
      :aria-expanded="menuOpen ? 'true' : 'false'"
      @click="toggleMenu"
    >
      <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <circle cx="8" cy="3.2" r="1.2" />
        <circle cx="8" cy="8" r="1.2" />
        <circle cx="8" cy="12.8" r="1.2" />
      </svg>
    </button>
  </span>

  <Teleport to="body">
    <div
      v-if="menuOpen"
      ref="menuEl"
      class="row-menu-pop"
      role="menu"
      aria-label="Entity actions"
      :style="menuPos"
      @click.stop
    >
      <button class="row-menu-item" type="button" role="menuitem" @click="chat">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M2.6 3.2h10.8v7.2H8l-3.1 2.4v-2.4H2.6z" />
        </svg>
        Chat with entity
      </button>
      <button class="row-menu-item" type="button" role="menuitem" @click="reveal">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M2 4.4h4.1l1.2 1.5H14v6.3H2z" />
          <path d="M2 7.1h12" />
        </svg>
        Reveal file
      </button>
      <button class="row-menu-item" type="button" role="menuitem" @click="duplicate">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <rect x="5.2" y="5.2" width="8" height="8" rx="1" />
          <path d="M10.8 5.2V3.6a1 1 0 00-1-1H3.6a1 1 0 00-1 1v6.2a1 1 0 001 1h1.6" />
        </svg>
        Duplicate entity
      </button>
      <button class="row-menu-item" type="button" role="menuitem" @click="openClone">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M3.2 5.2h4.2l1.2 1.5h4.2v6H3.2z" />
          <path d="M5.2 3.2h4.2l1.2 1.5h2.2" />
        </svg>
        Clone to workspace…
      </button>
      <button
        class="row-menu-item row-menu-danger"
        type="button"
        role="menuitem"
        :class="{ confirming }"
        @click="remove"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <path d="M3.2 4.4h9.6M6.1 4.4V2.8h3.8v1.6M4.4 4.4l.6 8.8h6l.6-8.8" />
        </svg>
        {{ confirming ? 'Click again to delete' : 'Delete entity' }}
      </button>
    </div>
  </Teleport>

  <EntityCloneDialog
    v-if="cloneOpen"
    :entity="entity"
    :workspace="hub.workspace"
    @close="cloneOpen = false"
    @cloned="cloneOpen = false"
  />
</template>
