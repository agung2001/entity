import { onBeforeUnmount, watch } from 'vue'

/**
 * One Escape stack for every dismissible surface.
 *
 * A dialog that only listens for `@keydown.esc` on its own element stays open
 * whenever focus is somewhere else (the top bar, a row, the document body) —
 * which is most of the time. A dialog that installs its own document listener
 * instead fights every other listener: with two surfaces open, one Escape
 * closes both, or the wrong one.
 *
 * So there is exactly one keydown listener for the whole window, and it owns a
 * stack of open surfaces. Whatever opened last closes first: a picker inside a
 * dialog closes before the dialog; a dialog closes before the page behind it.
 *
 * Usage (a dialog, drawer, popover or zoom overlay — anything Escape should
 * dismiss):
 *
 *   useDialogDismiss({
 *     active: () => open.value,   // ref or getter
 *     close: () => emit('close'),
 *     guard: () => busy.value,    // optional: ignore Escape while true
 *   })
 *
 * The same `close` the scrim click calls, so both paths reset the same state.
 */
const stack = []
let listening = false

function onKeydown(event) {
  if (event.key !== 'Escape' || event.isComposing) return
  const entry = stack[stack.length - 1]
  if (!entry) return
  if (entry.guard && entry.guard()) return
  event.preventDefault()
  event.stopPropagation()
  entry.close()
}

function listen() {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('keydown', onKeydown, true)
}

function unlisten() {
  if (!listening) return
  listening = false
  window.removeEventListener('keydown', onKeydown, true)
}

function push(entry) {
  stack.push(entry)
  listen()
  return () => {
    const at = stack.indexOf(entry)
    if (at >= 0) stack.splice(at, 1)
    if (!stack.length) unlisten()
  }
}

/** How many surfaces are open. Exported for tests and debugging only. */
export const dialogDepth = () => stack.length

export function useDialogDismiss({ active = true, close, guard } = {}) {
  if (typeof close !== 'function') {
    throw new Error('useDialogDismiss needs a close() function.')
  }
  const entry = { close, guard }
  let remove = null

  const sync = (isActive) => {
    if (isActive && !remove) {
      remove = push(entry)
    } else if (!isActive && remove) {
      remove()
      remove = null
    }
  }

  const read = () => {
    if (typeof active === 'function') return Boolean(active())
    if (active && typeof active === 'object' && 'value' in active) return Boolean(active.value)
    return Boolean(active)
  }

  watch(read, sync, { immediate: true })
  onBeforeUnmount(() => {
    if (remove) remove()
    remove = null
  })
}
