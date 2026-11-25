import { artifacts } from '@/stores/artifacts'
import { hub, liveSummaries } from '@/stores/hub'

/**
 * The five destinations, in order, for both the rail and the phone tab bar.
 *
 * Two of them are panels rather than routes: Entities and Artifacts open the
 * second tier where they were opened from, so they carry `panel` instead of
 * `name`. The rest are ordinary links.
 */
export const NAV = [
  { name: 'overview', view: 'overview', label: 'Overview', icon: 'grid' },
  { panel: 'entities', view: 'entities', label: 'Entities', icon: 'agent', count: () => hub.agents.length },
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
  if (panelOpen) return item.panel ? hub.rail[item.panel] : false
  if (item.panel === 'entities') return route.name === 'entity'
  if (item.panel === 'artifacts') return route.name === 'artifact' || route.name === 'artifacts'
  if (item.view === 'configurations') return CONFIG_ROUTES.has(String(route.name || ''))
  return route.name === item.name
}
