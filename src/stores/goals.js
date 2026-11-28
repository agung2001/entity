/**
 * Goals — every goal this workspace has, read from `goals.json`.
 *
 * One store because a task is one object seen in four places: the goal page, the
 * backlog, the calendar and the rail's count all read these rows, so a tick has
 * one target and no page has to be told what another one did.
 *
 * The rail's number is a count of **open** goals, not of records: a met goal
 * keeps its row and its count until it is archived, which is why the count is
 * not `items.length`.
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

/**
 * What a row counts: `done` of the **dated** tasks, which is the pair the bar
 * will print — an undated task cannot be ahead or behind, so it is not in the
 * fraction. `open` is every task still unticked, because the backlog lists those.
 */
export function taskCounts(goal) {
  const tasks = Array.isArray(goal?.tasks) ? goal.tasks : []
  const dated = tasks.filter((task) => task.date)
  return {
    done: dated.filter((task) => task.done).length,
    total: dated.length,
    open: tasks.filter((task) => !task.done).length,
  }
}

/** The rail's number: 0 until a read lands, never a count of records. */
export const openGoalCount = () => (goals.loaded ? openGoals().length : 0)

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
