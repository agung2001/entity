<script setup>
import { useRouter } from 'vue-router'
import { chatFocusEntity, closeDrawer, openDrawer, toast } from '@/stores/hub'
import { revealEntity } from '@/stores/entities'

/**
 * Three quick actions for a table row. The row itself still opens the drawer;
 * every control here stops propagation so clicking an action never also opens
 * the detail panel.
 */
const props = defineProps({
  entity: { type: Object, required: true },
})

const router = useRouter()

function stop(event) {
  event.stopPropagation()
}

function run(event) {
  stop(event)
  openDrawer(props.entity.id, 'run')
}

function chat(event) {
  stop(event)
  closeDrawer()
  chatFocusEntity(props.entity.id)
  router.push('/chat')
}

async function reveal(event) {
  stop(event)
  try {
    await revealEntity(props.entity.name)
    toast(`Revealed ${props.entity.name}.md`)
  } catch (error) {
    toast(error?.message || 'Could not reveal the file')
  }
}
</script>

<template>
  <span class="row-actions" @click.stop @keydown.stop>
    <button
      class="row-act"
      type="button"
      :title="`Run ${entity.name}`"
      :aria-label="`Run ${entity.name}`"
      @click="run"
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <path d="M5.2 3.4l7.2 4.6-7.2 4.6z" />
      </svg>
    </button>
    <button
      class="row-act"
      type="button"
      :title="`Chat with ${entity.name}`"
      :aria-label="`Chat with ${entity.name}`"
      @click="chat"
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <path d="M2.6 3.2h10.8v7.2H8l-3.1 2.4v-2.4H2.6z" />
      </svg>
    </button>
    <button
      class="row-act"
      type="button"
      :title="`Reveal ${entity.name}.md`"
      :aria-label="`Reveal ${entity.name}.md`"
      @click="reveal"
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <path d="M2 4.4h4.1l1.2 1.5H14v6.3H2z" />
        <path d="M2 7.1h12" />
      </svg>
    </button>
  </span>
</template>
