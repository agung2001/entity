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
const os = require('node:os')
const { spawnTracked, killTree } = require('./child-registry.cjs')
const workspaces = require('./workspace-store.cjs')
const mcpStore = require('./mcp-store.cjs')
const catalog = require('./connector-catalog.cjs')

const TIMEOUT_MS = 12_000
/* A definition may carry its own deadline, because a server whose first start
   downloads and builds is not slow — it is cold. The bounds are the sane ones: under
   12 s would refuse a server that is only warming up, and over two minutes is a hang
   dressed as patience. */
const MIN_TIMEOUT_MS = 12_000
const MAX_TIMEOUT_MS = 120_000
const CACHE_MS = 5 * 60_000
const MAX_TOOLS = 300
const cache = new Map()

/**
 * The deadline one definition gets, and the sentence a cold start deserves.
 *
 * A definition that declares `timeoutMs` is saying "my first run is slow"; the error
 * for it says it is starting rather than that it failed to answer, because those are
 * different things to do about. Everything else keeps the 12 s default and its
 * original sentence.
 */
function deadlineOf(definition) {
  const declared = Number(definition?.timeoutMs)
  if (!Number.isFinite(declared) || declared <= 0) return { ms: TIMEOUT_MS, cold: false }
  return { ms: Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(declared))), cold: true }
}

/** `Open Design is starting` for a definition that asked for a longer deadline. */
function coldStartSentence(definition) {
  const name = String(definition?.label || definition?.name || '').trim()
  return name ? `${name} is starting — its first run has to warm up. Try again in a moment.` : ''
}

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

/**
 * A definition, with what the catalog knows about a server it ships.
 *
 * `mcp.json` holds a binding — a command and its args — not a policy. A shipped entry
 * carries the deadline a cold start gets and the label an error sentence uses, and
 * those belong to the definition at the moment it is dialled, so they are attached
 * here rather than written into the synced pool file (where they would be a second,
 * drifting copy of the catalog).
 */
function withCatalog(name, definition) {
  const entry = catalog.entryOf(name)
  if (!definition || typeof definition !== 'object') return definition
  /* A shipped launcher is written as `$HOME/…` so the *definition* carries no home
     directory (it syncs, and `machineBoundReason` reads the token as portable). The
     token is expanded here, at the one point a process is spawned from it. */
  const expanded =
    typeof definition.command === 'string'
      ? { ...definition, command: homeExpanded(definition.command) }
      : definition
  if (!entry) return expanded
  return {
    ...expanded,
    name,
    label: definition.label || entry.label,
    ...(entry.timeoutMs ? { timeoutMs: entry.timeoutMs } : {}),
  }
}

/** `$HOME/…`, `${HOME}/…` and `~/…` → this machine's absolute path. */
function homeExpanded(command) {
  const home = os.homedir()
  for (const token of ['${HOME}', '$HOME', '~']) {
    if (command === token) return home
    if (command.startsWith(`${token}/`)) return `${home}${command.slice(token.length)}`
  }
  return command
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
    map.set(name, { name, definition: withCatalog(name, definition), source: 'workspace', enabled: true })
  }
  for (const [name, definition] of Object.entries(pool.disabled || {})) {
    if (!map.has(name)) {
      map.set(name, { name, definition: withCatalog(name, definition), source: 'workspace', enabled: false })
    }
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
            headers: server.headers,
            env: server.env,
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

/**
 * One stdio JSON-RPC session. `work` gets a `request(method, params)` that
 * resolves with the reply, so `tools/list` and `tools/call` share the handshake
 * (and the process teardown) instead of duplicating it.
 */
function stdioSession(definition, work) {
  return new Promise((resolve, reject) => {
    let child
    try {
      /* An MCP server may itself fork helpers; the tree is ours to close. */
      child = spawnTracked(String(definition.command), (definition.args || []).map(String), {
        env: {
          ...process.env,
          /* a name → value map travels with the definition; a list of names is
             already in process.env or is not there at all */
          ...(definition.env && !Array.isArray(definition.env) ? definition.env : {}),
        },
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

    const finish = (error, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      killTree(child, 'SIGTERM')
      if (error) reject(error)
      else resolve(value)
    }

    const deadline = deadlineOf(definition)
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            (deadline.cold && coldStartSentence(definition)) || 'The MCP server did not answer in time.',
          ),
        ),
      deadline.ms,
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
      send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })
      return promise
    }

    child.stdout?.on(
      'data',
      lines((message) => {
        if (message.id && pending.has(message.id)) {
          const entry = pending.get(message.id)
          pending.delete(message.id)
          if (message.error) entry.rej(new Error(message.error.message || 'MCP request failed.'))
          else entry.res(message.result)
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
        return work({ request })
      })
      .then((value) => finish(null, value))
      .catch((error) => finish(error))
  })
}

function stdioTools(definition) {
  return stdioSession(definition, async ({ request }) => {
    const tools = []
    let cursor
    for (let page = 0; page < 20; page += 1) {
      const result = await request('tools/list', cursor ? { cursor } : {})
      for (const tool of result?.tools || []) tools.push(normaliseTool(tool))
      if (!result?.nextCursor || tools.length >= MAX_TOOLS) break
      cursor = result.nextCursor
    }
    return { tools: tools.slice(0, MAX_TOOLS) }
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

/**
 * One Streamable-HTTP JSON-RPC session. Same shape as `stdioSession`, and the
 * auth headers are the reason it exists: a discovery call without the pool's
 * bearer would report "no tools" for a server the harness can use perfectly.
 */
async function httpSession(definition, work) {
  const url = String(definition.url || '')
  const auth =
    definition.headers && typeof definition.headers === 'object' && !Array.isArray(definition.headers)
      ? Object.fromEntries(
          Object.entries(definition.headers).filter(([, value]) => typeof value === 'string'),
        )
      : {}
  let session = ''
  let nextId = 1

  const request = async (method, params) => {
    const notify = method.startsWith('notifications/')
    const payload = { jsonrpc: '2.0', method, ...(params ? { params } : {}) }
    if (!notify) payload.id = nextId++

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), deadlineOf(definition).ms)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...auth,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(session ? { 'Mcp-Session-Id': session } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      session = response.headers.get('mcp-session-id') || session
      const text = await response.text()
      if (!response.ok) {
        throw new Error(`MCP server returned HTTP ${response.status}${text ? `: ${text.slice(0, 160)}` : ''}`)
      }
      const messages = parsePayload(text, response.headers.get('content-type'))
      if (notify) return null
      const reply = messages.find((entry) => entry.id === payload.id)
      if (!reply) throw new Error('The MCP server sent no JSON-RPC response.')
      if (reply.error) throw new Error(reply.error.message || 'MCP request failed.')
      return reply.result
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(
          (deadlineOf(definition).cold && coldStartSentence(definition)) ||
            'The MCP server did not answer in time.',
        )
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'entity', version: '0.1.0' },
  })
  await request('notifications/initialized').catch(() => {})
  return work({ request })
}

async function httpTools(definition) {
  return httpSession(definition, async ({ request }) => {
    const tools = []
    let cursor
    for (let page = 0; page < 20; page += 1) {
      const result = await request('tools/list', cursor ? { cursor } : {})
      for (const tool of result?.tools || []) tools.push(normaliseTool(tool))
      if (!result?.nextCursor || tools.length >= MAX_TOOLS) break
      cursor = result.nextCursor
    }
    return { tools: tools.slice(0, MAX_TOOLS) }
  })
}

/** Everything a `tools/call` reply can carry, in one predictable shape. */
function callResult(result) {
  const structured = result?.structuredContent
  if (structured && typeof structured === 'object') return structured
  const text = (result?.content || [])
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Call one tool on a server this machine knows: the workspace pool first, then
 * the harness configs. Used by the mention resolver, which needs a search
 * result, not a tool list.
 */
async function callTool({ workspace, server, tool, arguments: args = {} }) {
  const key = String(server || '').trim()
  const name = String(tool || '').trim()
  if (!key) throw new Error('An MCP server needs a name.')
  if (!name) throw new Error('An MCP tool needs a name.')
  const found = definitions(workspace).get(key)
  if (!found) throw new Error(`No MCP server called "${key}" on this machine.`)
  const definition = found.definition || {}
  if (!definition.command && !definition.url) {
    throw new Error(`${key} has neither a command nor a URL.`)
  }
  const work = ({ request }) => request('tools/call', { name, arguments: args })
  const result = definition.url ? await httpSession(definition, work) : await stdioSession(definition, work)
  return { server: key, tool: name, data: callResult(result), isError: Boolean(result?.isError) }
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

module.exports = { tools, callTool, definitions, deadlineOf }
