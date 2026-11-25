import { artifacts } from '@/stores/artifacts'
import { hub, liveSummaries } from '@/stores/hub'

/**
 * The five destinations, in order, for both the rail and the phone tab bar.
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
  {
    name: 'workspace',
    view: 'configurations',
    label: 'Configurations',
    icon: 'sliders',
  },
]

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
  if (item.panel === 'artifacts') return route.name === 'artifact'
  if (item.view === 'configurations') return CONFIG_ROUTES.has(String(route.name || ''))
  return route.name === item.name
}
