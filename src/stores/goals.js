/**
 * Goals — every goal this workspace has, read from `goals.json`.
 *
 * One store because a task is one object seen in four places: the goal page, the
 * backlog, the calendar and the rail's count all read these rows, so a tick has
 * one target and no page has to be told what another one did. Every write answers
 * with the whole list, which is what keeps those four views agreeing without a
 * Refresh.
 *
 * The rail's number is a count of **open** goals, not of records: a met goal keeps
 * its row and its count until it is archived.
 */
import { reactive } from 'vue'
import { call } from '@/composables/localBridge'
import { hub } from '@/stores/hub'

export const goals = reactive({
  loading: false,
  loaded: false,
  error: '',
  workspace: '',
  items: [],
})

/** A goal stops being open when it is archived, not when it is met (§F5). */
export const openGoals = () => goals.items.filter((goal) => !goal.archivedAt)

/** The rail's number: 0 until a read lands, never a count of records. */
export const openGoalCount = () => (goals.loaded ? openGoals().length : 0)

/** Every open task across every open goal — the backlog and the calendar's rows. */
export const openTasks = () =>
  openGoals().flatMap((goal) =>
    (goal.tasks || []).filter((task) => !task.done).map((task) => ({ goal, task })),
  )

export function resetGoals() {
  goals.loading = false
  goals.loaded = false
  goals.error = ''
  goals.workspace = ''
  goals.items = []
}

/** Adopt the whole list a read or a write answered with, so there is one path. */
export function applyGoals(workspace, answer) {
  goals.workspace = workspace
  goals.loaded = true
  goals.error = ''
  goals.items = Array.isArray(answer?.goals) ? answer.goals : []
  return goals.items
}

export async function loadGoals(workspace = hub.workspace) {
  if (!workspace) {
    resetGoals()
    return []
  }
  /* A different workspace is a different list; a failed re-read of the same one
     is not, and it keeps the rows it already had. */
  if (goals.workspace !== workspace) {
    goals.items = []
    goals.loaded = false
  }
  goals.loading = true
  goals.error = ''
  try {
    return applyGoals(workspace, await call('goals.read', { workspace }))
  } catch (problem) {
    goals.error = problem?.message || 'The goals could not be read.'
    return goals.items
  } finally {
    goals.loading = false
  }
}

/* ── writes ────────────────────────────────────────────────────────────────
   One door: the call, then the list the main process answered with. A refusal
   carries `.code` and reaches the caller; what is on screen is untouched. */
async function write(fn, args, workspace = hub.workspace) {
  const answer = await call(fn, { workspace, ...args })
  applyGoals(workspace, answer)
  return answer
}

export const createGoal = (goal, workspace) => write('goals.create', { goal }, workspace)

export const updateGoal = (id, patch, workspace) => write('goals.update', { id, ...patch }, workspace)

/**
 * A tick is one task and one boolean — and it lands in the row first, because the
 * tick is the action the whole surface exists for. The answer replaces the list a
 * moment later, so a failed write puts the row back exactly as the file has it.
 */
export async function tickTask(id, task, done, workspace = hub.workspace) {
  const goal = goals.items.find((entry) => entry.id === id)
  const row = goal?.tasks?.find((entry) => entry.id === task)
  const previous = row?.done
  if (row) row.done = done === true
  try {
    return await write('goals.tick', { id, task, done: done === true }, workspace)
  } catch (error) {
    if (row && previous !== undefined) row.done = previous
    throw error
  }
}

export const archiveGoal = (id, workspace) => write('goals.remove', { id }, workspace)

/** The one call that may put a new figure on the page (§F5). */
export const refreshGoal = (id, workspace) => write('goals.refresh', { id }, workspace)
