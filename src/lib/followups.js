/**
 * Suggested follow-ups per thread.
 *
 * The model call happens in the main process (the thread's own harness, one
 * short prompt) and is cached there per message. This module only keeps the
 * renderer's copy of the answer, so a re-render or a switch back to the thread
 * does not start another turn.
 */
import { reactive } from 'vue'
import { call } from '@/composables/localBridge'
import { hub } from '@/stores/hub'

const EMPTY = { actions: [], messageId: '', busy: false, error: '' }
const state = reactive({})

export function followupsFor(threadId) {
  if (!threadId) return { ...EMPTY }
  return state[threadId] || { ...EMPTY }
}

export async function ensureFollowups(threadId, { force = false } = {}) {
  if (!threadId) return []
  const current = state[threadId]
  if (current?.busy) return []
  if (!force && current?.actions?.length) return current.actions
  state[threadId] = { ...(current || EMPTY), busy: true, error: '' }
  try {
    const data = await call('chat.suggest', { workspace: hub.workspace, threadId })
    state[threadId] = {
      actions: Array.isArray(data?.actions) ? data.actions : [],
      messageId: data?.messageId || '',
      busy: false,
      error: '',
    }
    return state[threadId].actions
  } catch (error) {
    state[threadId] = {
      ...(state[threadId] || EMPTY),
      busy: false,
      error: error?.message || 'No follow-ups this time.',
    }
    return []
  }
}

export function clearFollowups(threadId) {
  if (threadId) delete state[threadId]
}
