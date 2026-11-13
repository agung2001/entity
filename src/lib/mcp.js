/** Shape helpers shared by the MCP inventory and the account status panel. */

export function definitionOf(server) {
  if (!server) return null
  const value = {}
  if (server.url) value.url = String(server.url)
  if (server.command) value.command = String(server.command)
  if (Array.isArray(server.args) && server.args.length) value.args = server.args.map(String)
  const env = server.env
  if (Array.isArray(env) && env.length) value.env = env.map(String)
  else if (env && typeof env === 'object' && Object.keys(env).length) value.env = { ...env }
  if (server.headers && typeof server.headers === 'object' && Object.keys(server.headers).length) {
    value.headers = { ...server.headers }
  }
  if (!value.url && !value.command) return null
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
  const env = definition?.env
  if (Array.isArray(env)) return env.map(String)
  if (env && typeof env === 'object') return Object.keys(env)
  return []
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
