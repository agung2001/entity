/** Shape helpers shared by the MCP inventory and the account status panel. */

export function definitionOf(server) {
  if (!server) return null
  if (server.url) return { url: String(server.url) }
  if (!server.command) return null
  const value = { command: String(server.command) }
  if (Array.isArray(server.args) && server.args.length) value.args = server.args.map(String)
  if (Array.isArray(server.env) && server.env.length) value.env = server.env.map(String)
  return value
}

export function commandLine(definition) {
  const value = definition || {}
  if (value.command) return [value.command, ...(value.args || [])].join(' ')
  return value.url || 'no command or URL'
}

export function transportOf(definition) {
  return definition?.url ? 'http' : 'stdio'
}

export function envNames(definition) {
  return Array.isArray(definition?.env) ? definition.env.map(String) : []
}

/** Enabled pool first, then the disabled pile. */
export function poolEntries(pool) {
  const map = new Map()
  for (const [name, definition] of Object.entries(pool?.servers || {})) {
    map.set(name, { name, definition, enabled: true })
  }
  for (const [name, definition] of Object.entries(pool?.disabled || {})) {
    if (!map.has(name)) map.set(name, { name, definition, enabled: false })
  }
  return [...map.values()]
}

export function parametersOf(tool) {
  const properties = tool?.inputSchema?.properties
  return properties && typeof properties === 'object' ? Object.keys(properties) : []
}
