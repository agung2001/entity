import { artifacts } from '@/stores/artifacts'
import { openGoalCount } from '@/stores/goals'
import { hub, liveSummaries } from '@/stores/hub'

/**
 * The seven destinations, in order, for both the rail and the phone tab bar.
 *
 * One of them is a panel rather than a route: Artifacts opens the second tier
 * where it was opened from, so it carries `panel` instead of `name`. Entities
 * was one too until the index got a page of its own; its `panel` survives only
 * as the create dialog's owner and the rail's shelf. The rest are ordinary
 * links.
 */
export const NAV = [
  { name: 'overview', view: 'overview', label: 'Overview', icon: 'grid' },
  { name: 'entities', view: 'entities', label: 'Entities', icon: 'agent', count: () => hub.agents.length },
  {
    panel: 'artifacts',
    view: 'artifacts',
    label: 'Artifacts',
    icon: 'artifact',
    count: () => artifacts.items.length,
  },
  { name: 'chat', view: 'chat', label: 'Chat', icon: 'chat', count: () => liveSummaries().length },
  /* News is a destination, not a setting: a member reads it and never adds a
     feed here — a feed is a connector, created on the Connectors surface. So it
     carries no count and no route in CONFIG_ROUTES. */
  { name: 'news', view: 'news', label: 'News', icon: 'news' },
  {
    name: 'goals',
    view: 'goals',
    label: 'Goals',
    icon: 'goal',
    /* The only count in the rail that counts *goals*: a met one keeps its row
       until it is archived, and 0 until the store has read (§2.7). */
    count: () => openGoalCount(),
  },
  {
    name: 'workspace',
    view: 'configurations',
    label: 'Configurations',
    /* Seven cells share a 360 px thumb bar at 51 px each; `Configurations`
       there is an ellipsis and nothing else. The short word is the tab
       bar's alone. */
    short: 'Config',
    icon: 'sliders',
  },
]

/** Goals is one destination with four child routes: the index, one goal, the
    create step, the backlog and the calendar. All five keep the rail cell
    pressed — a goal page that released it would read as a different section. */
const GOAL_ROUTES = new Set(['goals', 'goal', 'goal-new', 'goals-backlog', 'goals-calendar'])

/** Everything that belongs to the workspace settings drawer, not to a destination. */
export const CONFIG_ROUTES = new Set([
  'workspace',
  'skills',
  'skill',
  'mcp',
  'connector-page',
  'machines',
  'machine',
  'activity',
])

/** The chat icon is "the conversation", so it carries the one to open. Without
    the id the address landed on /chat and only sometimes gained ?thread. */
function newestThreadId() {
  const rows = [...(hub.chat.summaries || [])].sort((a, b) =>
    String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
  )
  return rows[0]?.id || ''
}

export function linkFor(item) {
  const base = { name: item.name, params: { workspace: hub.workspace } }
  if (item.name !== 'chat') return base
  const thread = hub.chat.active || newestThreadId()
  return thread ? { ...base, query: { thread } } : base
}

/** The active destination, which is also which tab carries `aria-current`. */
export function isActive(item, route) {
  const panelOpen = hub.rail.entities || hub.rail.artifacts
  /* Entities is a page now, and its shelf is a panel that is opened *over* a
     page. An open shelf wins, so the rail's own row keeps its pressed state;
     closed, the entry is current on the index and on one entity's page. */
  if (panelOpen) return item.panel ? hub.rail[item.panel] : false
  if (item.name === 'entities') return route.name === 'entities' || route.name === 'entity'
  if (item.panel === 'artifacts') return route.name === 'artifact' || route.name === 'artifacts'
  if (item.name === 'goals') return GOAL_ROUTES.has(String(route.name || ''))
  if (item.view === 'configurations') return CONFIG_ROUTES.has(String(route.name || ''))
  return route.name === item.name
}
