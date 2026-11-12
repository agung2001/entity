/**
 * MCP tool discovery.
 *
 * The config readers only know how to start a server; they do not know what the
 * server can do. This module opens the JSON-RPC handshake a harness would open,
 * asks for `tools/list`, and closes it again. Only stdio and Streamable HTTP are
 * attempted; a server that needs OAuth or a private header reports that error
 * instead of pretending to have no tools.
 *
 * Nothing secret is returned: env values are never included in the response,
 * and stderr is reduced to the last line of a failure.
 */
const { spawnTracked, killTree } = require('./child-registry.cjs')
const workspaces = require('./workspace-store.cjs')
const mcpStore = require('./mcp-store.cjs')

const TIMEOUT_MS = 12_000
const CACHE_MS = 5 * 60_000
const MAX_TOOLS = 300
const cache = new Map()

function cached(key) {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_MS) {
    cache.delete(key)
    return null
  }
  return hit.value
}

function remember(key, value) {
  cache.set(key, { at: Date.now(), value })
  return value
}

/** Workspace pool first, then the disabled pile, then harness globals. */
function definitions(workspace) {
  const map = new Map()
  let pool = { servers: {}, disabled: {} }
  if (workspace) {
    try {
      pool = workspaces.mcp(workspace)
    } catch {
      pool = { servers: {}, disabled: {} }
    }
  }
  for (const [name, definition] of Object.entries(pool.servers || {})) {
    map.set(name, { name, definition, source: 'workspace', enabled: true })
  }
  for (const [name, definition] of Object.entries(pool.disabled || {})) {
    if (!map.has(name)) map.set(name, { name, definition, source: 'workspace', enabled: false })
  }
  try {
    for (const group of mcpStore.globals().groups) {
      for (const server of group.servers) {
        if (map.has(server.name)) continue
        map.set(server.name, {
          name: server.name,
          definition: {
            command: server.command,
            args: server.args,
            url: server.url,
          },
          source: server.harness,
          enabled: false,
        })
      }
    }
  } catch {
    /* a broken harness config must not hide the workspace pool */
  }
  return map
}

function normaliseTool(tool) {
  return {
    name: String(tool?.name || ''),
    description: String(tool?.description || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    inputSchema: tool?.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : null,
  }
}

function lines(onMessage) {
  let buffer = ''
  return (chunk) => {
    buffer += String(chunk)
    let at
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).replace(/\r$/, '')
      buffer = buffer.slice(at + 1)
      if (!line.trim()) continue
      try {
        onMessage(JSON.parse(line))
      } catch {
        /* MCP stdio is newline-delimited JSON; ignore non-JSON chatter */
      }
    }
  }
}

function stdioTools(definition) {
  return new Promise((resolve, reject) => {
    let child
    try {
      /* An MCP server may itself fork helpers; the tree is ours to close. */
      child = spawnTracked(String(definition.command), (definition.args || []).map(String), {
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        kind: 'mcp',
        label: String(definition.name || definition.command || 'mcp'),
      })
    } catch (error) {
      reject(error)
      return
    }

    let done = false
    let stderr = ''
    let nextId = 1
    const pending = new Map()
    const tools = []

    const finish = (error, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      killTree(child, 'SIGTERM')
      if (error) reject(error)
      else resolve(value)
    }

    const timer = setTimeout(
      () => finish(new Error('The MCP server did not answer tools/list in time.')),
      TIMEOUT_MS,
    )

    child.on('error', (error) => {
      finish(
        new Error(
          error?.code === 'ENOENT'
            ? `${definition.command} is not installed, or not on PATH.`
            : String(error?.message || error),
        ),
      )
    })
    child.on('close', (code) => {
      if (!done) {
        finish(
          new Error(
            stderr.trim().split(/\r?\n/).pop() ||
              `The MCP server exited before answering (code ${code ?? 'unknown'}).`,
          ),
        )
      }
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
    })

    const send = (payload) => {
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`)
      } catch (error) {
        finish(error)
      }
    }

    const request = (method, params) => {
      const id = nextId++
      const promise = new Promise((res, rej) => pending.set(id, { res, rej }))
      send({ jsonrpc: '2.0', id, method, params })
      return promise
    }

    const askTools = async () => {
      let cursor
      for (let page = 0; page < 20; page += 1) {
        const result = await request('tools/list', cursor ? { cursor } : {})
        for (const tool of result?.tools || []) tools.push(normaliseTool(tool))
        if (!result?.nextCursor || tools.length >= MAX_TOOLS) break
        cursor = result.nextCursor
      }
      finish(null, { tools: tools.slice(0, MAX_TOOLS) })
    }

    child.stdout?.on(
      'data',
      lines((message) => {
        if (message.id && pending.has(message.id)) {
          const entry = pending.get(message.id)
          pending.delete(message.id)
          if (message.error) entry.rej(new Error(message.error.message || 'MCP request failed.'))
          else entry.res(message.result)
          return
        }
        /* servers may send notifications after initialize; nothing to do */
      }),
    )

    child.stdin?.on('error', () => {
      /* process may have exited before stdin was written */
    })

    request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'entity', version: '0.1.0' },
    })
      .then(() => {
        send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        return askTools()
      })
      .catch((error) => finish(error))
  })
}

function parsePayload(text, contentType) {
  if (String(contentType || '').includes('text/event-stream')) {
    const messages = []
    for (const block of String(text).split(/\n\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n')
      if (!data) continue
      try {
        messages.push(JSON.parse(data))
      } catch {
        /* an SSE comment or partial frame */
      }
    }
    return messages
  }
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

async function httpTools(definition) {
  const url = String(definition.url || '')
  let session = ''
  const call = async (message) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(session ? { 'Mcp-Session-Id': session } : {}),
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      })
      session = response.headers.get('mcp-session-id') || session
      const text = await response.text()
      if (!response.ok) {
        throw new Error(`MCP server returned HTTP ${response.status}${text ? `: ${text.slice(0, 160)}` : ''}`)
      }
      const messages = parsePayload(text, response.headers.get('content-type'))
      const reply = messages.find((entry) => entry.id === message.id)
      if (!reply) {
        if (!message.id) return null
        throw new Error('The MCP server sent no JSON-RPC response.')
      }
      if (reply.error) throw new Error(reply.error.message || 'MCP request failed.')
      return reply.result
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('The MCP server did not answer in time.')
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  await call({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'entity', version: '0.1.0' },
    },
  })
  await call({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {})

  const tools = []
  let cursor
  for (let page = 0; page < 20; page += 1) {
    const id = page + 2
    const result = await call({
      jsonrpc: '2.0',
      id,
      method: 'tools/list',
      params: cursor ? { cursor } : {},
    })
    for (const tool of result?.tools || []) tools.push(normaliseTool(tool))
    if (!result?.nextCursor || tools.length >= MAX_TOOLS) break
    cursor = result.nextCursor
  }
  return { tools: tools.slice(0, MAX_TOOLS) }
}

async function tools({ workspace, name }) {
  const key = String(name || '').trim()
  if (!key) throw new Error('An MCP server needs a name.')
  const hit = cached(`${workspace || ''}:${key}`)
  if (hit) return hit
  const found = definitions(workspace).get(key)
  if (!found) throw new Error(`No MCP server called "${key}" on this machine.`)
  const definition = found.definition || {}
  if (!definition.command && !definition.url) {
    throw new Error(`${key} has neither a command nor a URL.`)
  }
  const result = definition.url
    ? await httpTools(definition)
    : await stdioTools(definition)
  return remember(`${workspace || ''}:${key}`, {
    name: key,
    source: found.source,
    enabled: found.enabled,
    tools: result.tools,
    readAt: new Date().toISOString(),
  })
}

module.exports = { tools, definitions }
