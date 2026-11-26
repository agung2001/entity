import { reactive } from 'vue'
import { call } from '@/composables/localBridge'
import { hub } from '@/stores/hub'

/**
 * The Clockify connector's own state, in the renderer.
 *
 * Clockify is the one shipped dashboard whose gate is not an account list: the tab
 * needs an API key on this machine **and** a workspace chosen for this workspace,
 * and both are answered by the main process (`connector.token.status`,
 * `connector.fields`). They lived on the page until the page grew one `if` per
 * connector for the same question; they live here now, beside the dashboard that
 * asks them, and the page imports one lock instead of owning a second copy.
 *
 * The key never reaches this file — `connector.workspaces` and the reports read it
 * in the main process, which is why a page that is screenshotted or opened from
 * disk cannot leak one.
 */
export const clockify = reactive({
  /* the gate */
  configured: false,
  hint: '',
  workspaceId: '',
  loaded: false,
  /* the workspaces that key can see, for the Overview card's one control */
  spaces: [],
  spacesLoaded: false,
  spacesError: '',
  picking: false,
})

export function resetClockify() {
  clockify.configured = false
  clockify.hint = ''
  clockify.workspaceId = ''
  clockify.loaded = false
  clockify.spaces = []
  clockify.spacesLoaded = false
  clockify.spacesError = ''
  clockify.picking = false
}

/**
 * What the tab's gate is made of: is a key on this machine, and does this
 * workspace have a Clockify workspace id.
 *
 * A failed read leaves the workspace empty on purpose — the tab stays locked and
 * says what is missing, which is the state that sends a person to the card that
 * can fix it. The key half stands, because the token store answered separately.
 */
export async function readState() {
  try {
    const answer = await call('connector.token.status', { connector: 'clockify' })
    clockify.configured = Boolean(answer?.configured)
    clockify.hint = String(answer?.hint || '')
  } catch {
    clockify.configured = false
    clockify.hint = ''
  }
  try {
    const fields = await call('connector.fields', { workspace: hub.workspace, id: 'clockify' })
    clockify.workspaceId = String(fields?.workspaceId || '')
  } catch {
    clockify.workspaceId = ''
  } finally {
    clockify.loaded = true
  }
}

/** The workspaces this key can read. Read only when a key exists — the call is
    itself a read that key makes, so a person without one gets the sentence instead
    of an error about a list they cannot have. */
export async function readSpaces() {
  if (!clockify.configured) return
  try {
    const list = await call('connector.workspaces', { workspace: hub.workspace })
    clockify.spaces = Array.isArray(list) ? list : []
    clockify.spacesError = ''
  } catch (problem) {
    clockify.spaces = []
    clockify.spacesError = String(problem?.message || problem)
  } finally {
    clockify.spacesLoaded = true
  }
}

/**
 * The scope a token check needs, for the two token verbs a connector page runs.
 *
 * Clockify's `verify()` reads its reports *inside* one workspace, so the key it is
 * handed is proved against that workspace. Every other connector answers `{}` — the
 * page spreads this into the call instead of asking who it is talking to, so the one
 * connector with an extra parameter does not leave an `if` in the router.
 */
export function tokenScope(connectorId) {
  return connectorId === 'clockify' && clockify.workspaceId ? { workspaceId: clockify.workspaceId } : {}
}

/** After a key was written: the gate's key half, then the workspaces that key can
    see. Both are Clockify's own reads, so they are re-read here rather than by the
    page that happened to save the key. */
export async function afterKeySaved() {
  await readState()
  await readSpaces()
}

/** Choosing a workspace is the one thing on this page that changes *what the
    dashboard reads*, so it writes the field and re-reads the gate: the lock lifts
    under the strip without a reload. */
export async function pickSpace(space) {
  if (clockify.picking || space.id === clockify.workspaceId) return
  clockify.picking = true
  clockify.spacesError = ''
  try {
    await call('connector.setFields', {
      workspace: hub.workspace,
      id: 'clockify',
      /* The member map is per workspace — Clockify's user ids are — so a switch
         clears it rather than carrying names that now point at nobody. */
      fields: { workspaceId: space.id, members: {} },
    })
    await readState()
  } catch (problem) {
    clockify.spacesError = String(problem?.message || problem)
  } finally {
    clockify.picking = false
  }
}
