/**
 * Entity's own MCP server.
 *
 * A loopback-only Streamable HTTP endpoint that exposes this workspace repo to
 * an MCP client (Claude Code, pi, Codex, an IDE). It is not the workspace MCP
 * pool: that pool is what Entity consumes. This is the opposite direction.
 *
 *   POST http://127.0.0.1:4781/mcp
 *   Authorization: Bearer <token>
 *
 * The token and port live in ~/.entity/mcp-server.json, mode 0600. Writes are
 * opt-in; with them off, every tool is a read.
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const workspaces = require('./workspace-store.cjs')
const entities = require('./entity-store.cjs')
const chats = require('./chat-store.cjs')
const artifacts = require('./artifact-store.cjs')

const CONFIG_FILE = path.join(workspaces.ROOT, 'mcp-server.json')
const DEFAULT_PORT = 4781
const MAX_BODY = 2 * 1024 * 1024
const PROTOCOL = '2024-11-05'
const NAME = 'entity'

const workspaceArg = {
  type: 'string',
  description: 'Workspace id. Optional when this machine has only one workspace.',
}

const TOOL_DEFS = [
  {
    name: 'list_workspaces',
    title: 'List workspaces',
    description: 'List every Entity workspace on this machine, with its id, label, path and counts.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_workspace',
    title: 'Get workspace',
    description: 'Read one workspace record, including its shared context and MCP strictness.',
    inputSchema: {
      type: 'object',
      properties: { workspace: workspaceArg },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_entities',
    title: 'List entities',
    description: 'List the entity files in a workspace with harness, model, summary and problems.',
    inputSchema: {
      type: 'object',
      properties: { workspace: workspaceArg },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_entity',
    title: 'Get entity',
    description: 'Read one entity file: instructions, rules, harness, model, skills and MCP servers.',
    inputSchema: {
      type: 'object',
      properties: { workspace: workspaceArg, name: { type: 'string', description: 'Entity file name.' } },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'create_entity',
    title: 'Create entity',
    description:
      'Create a new entity Markdown file. Requires writes to be enabled in Account → MCP.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: workspaceArg,
        name: { type: 'string', description: 'Lowercase file name, e.g. review-scout.' },
        harness: {
          type: 'string',
          description: 'claude, codex, opencode, pi or gemini.',
          enum: ['claude', 'codex', 'opencode', 'pi', 'gemini'],
        },
        model: { type: 'string', description: 'Harness model; blank uses its default.' },
        description: { type: 'string', description: 'Short brief for the new entity.' },
        instructions: { type: 'string', description: 'Full Markdown body; blank writes the brief and a Rules heading.' },
        dir: { type: 'string', description: 'Working directory, e.g. ~/code/project.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'list_chats',
    title: 'List chats',
    description: 'List every conversation in a workspace, newest first, with title, entity and turn counts.',
    inputSchema: {
      type: 'object',
      properties: { workspace: workspaceArg },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_chat',
    title: 'Read chat',
    description: 'Read one conversation file, including its messages and recorded execution steps.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: workspaceArg,
        id: { type: 'string', description: 'Thread id from list_chats.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_artifacts',
    title: 'List artifacts',
    description: 'List files on the workspace artifact shelf with kind, size and modified time.',
    inputSchema: {
      type: 'object',
      properties: { workspace: workspaceArg },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
]

function newToken() {
  return crypto.randomBytes(32).toString('hex')
}

function validPort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null
}

function loadConfig() {
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    raw = null
  }
  const token = /^[a-f0-9]{64}$/i.test(String(raw?.token || '')) ? String(raw.token) : newToken()
  const cfg = {
    schema: 1,
    enabled: raw?.enabled === true,
    port: validPort(raw?.port) || DEFAULT_PORT,
    allowWrite: raw?.allowWrite === true,
    token,
  }
  if (!raw || raw.token !== token) writeConfig(cfg)
  return cfg
}

function writeConfig(cfg) {
  fs.mkdirSync(workspaces.ROOT, { recursive: true })
  const file = `${CONFIG_FILE}.${process.pid}.tmp`
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(file, CONFIG_FILE)
  try {
    fs.chmodSync(CONFIG_FILE, 0o600)
  } catch {
    /* platforms without POSIX modes */
  }
}

let config = loadConfig()
let server = null
let state = { running: false, error: '', startedAt: '' }

function urlFor(port = config.port) {
  return `http://127.0.0.1:${port}/mcp`
}

function status() {
  return {
    name: NAME,
    enabled: config.enabled,
    running: state.running,
    bound: state.running,
    port: config.port,
    url: urlFor(),
    token: config.token,
    allowWrite: config.allowWrite,
    error: state.error,
    startedAt: state.startedAt,
    protocol: PROTOCOL,
    tools: TOOL_DEFS,
    workspaceCount: workspaces.list().length,
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function authorized(req) {
  const header = String(req.headers.authorization || '')
  const match = header.match(/^Bearer\s+(.+)$/i)
  return Boolean(match && safeEqual(match[1].trim(), config.token))
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    connection: 'close',
    'access-control-allow-origin': '*',
  })
  res.end(body)
}

function respond(req, res, payload) {
  const accept = String(req.headers.accept || '')
  if (accept.includes('text/event-stream') && !accept.includes('application/json')) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'close',
      'access-control-allow-origin': '*',
    })
    res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`)
    return
  }
  sendJson(res, 200, payload)
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function resolveWorkspace(value) {
  const id = String(value || '').trim()
  if (id) return workspaces.open(id).id
  const list = workspaces.list()
  if (list.length === 1) return list[0].id
  if (!list.length) throw new Error('There is no workspace yet.')
  throw new Error(
    `workspace is required. Available: ${list.map((workspace) => workspace.id).join(', ')}.`,
  )
}

function requireWrite() {
  if (!config.allowWrite) {
    throw new Error('Writes are disabled. Enable "Allow writes" in Account → MCP first.')
  }
}

function summaryOf(entity) {
  return {
    name: entity.name,
    harness: entity.harness,
    model: entity.model,
    summary: entity.summary,
    ok: entity.ok,
    problems: entity.problems,
  }
}

function callTool(name, args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('Tool arguments must be an object.')
  }
  switch (name) {
    case 'list_workspaces':
      return workspaces.list().map((workspace) => ({
        id: workspace.id,
        label: workspace.label,
        kind: workspace.kind,
        path: workspace.displayPath,
        createdAt: workspace.createdAt,
        counts: workspace.counts,
      }))

    case 'get_workspace': {
      const record = workspaces.open(resolveWorkspace(args.workspace))
      return {
        id: record.id,
        label: record.label,
        kind: record.kind,
        path: record.displayPath,
        createdAt: record.createdAt,
        context: record.context || '',
        mcpStrict: Boolean(record.mcpStrict),
        counts: record.counts,
      }
    }

    case 'list_entities':
      return entities.list(resolveWorkspace(args.workspace)).map(summaryOf)

    case 'get_entity': {
      const workspace = resolveWorkspace(args.workspace)
      const entity = entities.read(workspace, args.name)
      if (!entity) throw new Error(`No entity called "${args.name}".`)
      return {
        ...summaryOf(entity),
        dir: entity.dir,
        skills: entity.skills,
        mcp: entity.mcp,
        instructions: entity.instructions,
        rules: entity.rules,
        path: entity.displayPath,
      }
    }

    case 'create_entity': {
      requireWrite()
      const workspace = resolveWorkspace(args.workspace)
      const harness = String(args.harness || 'claude')
      if (!entities.HARNESSES.includes(harness)) {
        throw new Error(`harness must be one of ${entities.HARNESSES.join(', ')}.`)
      }
      let created = entities.scaffold({
        workspace,
        name: args.name,
        harness,
        model: args.model || '',
        description: args.description || '',
      })
      if (args.dir || args.instructions) {
        created = entities.write({
          ...created,
          ...(args.dir ? { dir: String(args.dir) } : {}),
          ...(args.instructions ? { instructions: String(args.instructions) } : {}),
        })
      }
      return summaryOf(created)
    }

    case 'list_chats':
      return chats.list({ workspace: resolveWorkspace(args.workspace) })

    case 'read_chat': {
      const thread = chats.read({
        workspace: resolveWorkspace(args.workspace),
        id: args.id,
      })
      if (!thread) throw new Error(`No chat called "${args.id}".`)
      return thread
    }

    case 'list_artifacts':
      return artifacts.list({ workspace: resolveWorkspace(args.workspace) })

    default:
      throw new Error(`Unknown tool "${name}".`)
  }
}

function toolResult(name, args) {
  try {
    const data = callTool(name, args)
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      structuredContent: data,
      isError: false,
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: String(error?.message || error) }],
      isError: true,
    }
  }
}

function handleRpc(message) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
    return rpcError(message?.id, -32600, 'Invalid Request')
  }
  const id = message.id
  if (id === undefined) return null

  switch (message.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: NAME, version: '0.1.0' },
          instructions:
            'Entity exposes this workspace repo: workspaces, entities, chats and artifacts. Writes require Allow writes in Account → MCP.',
        },
      }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOL_DEFS } }
    case 'tools/call': {
      const name = String(message.params?.name || '')
      return {
        jsonrpc: '2.0',
        id,
        result: toolResult(name, message.params?.arguments || {}),
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${message.method}`)
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('Request body too large.'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, GET, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, accept, mcp-protocol-version',
      'access-control-max-age': '600',
    })
    res.end()
    return
  }

  const url = new URL(req.url || '/', 'http://127.0.0.1')

  if (req.method === 'GET' && url.pathname === '/') {
    sendJson(res, 200, { name: NAME, endpoint: '/mcp', auth: 'Bearer token required' })
    return
  }

  if (url.pathname !== '/mcp') {
    sendJson(res, 404, { error: 'Not found.' })
    return
  }
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST, OPTIONS')
    sendJson(res, 405, { error: 'Use POST for MCP JSON-RPC.' })
    return
  }
  if (!authorized(req)) {
    res.setHeader('www-authenticate', 'Bearer')
    sendJson(res, 401, { error: 'Unauthorized. Use the bearer token from Account → MCP.' })
    return
  }

  let raw
  try {
    raw = await readBody(req)
  } catch (error) {
    sendJson(res, 413, rpcError(null, -32600, String(error?.message || error)))
    return
  }

  let parsed
  try {
    parsed = JSON.parse(raw || '{}')
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'))
    return
  }

  if (Array.isArray(parsed)) {
    const responses = parsed.map(handleRpc).filter(Boolean)
    if (!responses.length) {
      res.writeHead(202, { 'access-control-allow-origin': '*' })
      res.end()
      return
    }
    respond(req, res, responses)
    return
  }

  const response = handleRpc(parsed)
  if (!response) {
    res.writeHead(202, { 'access-control-allow-origin': '*' })
    res.end()
    return
  }
  respond(req, res, response)
}

function start() {
  if (server) return Promise.resolve(status())
  if (!config.enabled) return Promise.resolve(status())
  state.error = ''
  return new Promise((resolve) => {
    const next = http.createServer((req, res) => {
      handler(req, res).catch((error) => {
        if (!res.headersSent) sendJson(res, 500, { error: String(error?.message || error) })
        else res.end()
      })
    })
    next.once('error', (error) => {
      state.running = false
      state.startedAt = ''
      state.error =
        error?.code === 'EADDRINUSE'
          ? `Port ${config.port} is already in use. Pick another port.`
          : String(error?.message || error)
      server = null
      try {
        next.close()
      } catch {
        /* never listened */
      }
      resolve(status())
    })
    next.once('listening', () => {
      server = next
      state.running = true
      state.error = ''
      state.startedAt = new Date().toISOString()
      resolve(status())
    })
    try {
      next.listen(config.port, '127.0.0.1')
    } catch (error) {
      state.running = false
      state.error = String(error?.message || error)
      server = null
      resolve(status())
    }
  })
}

function stop() {
  const current = server
  server = null
  state.running = false
  state.startedAt = ''
  if (!current) return Promise.resolve()
  return new Promise((resolve) => {
    try {
      current.close(() => resolve())
    } catch {
      resolve()
    }
  })
}

async function save({ enabled, port, allowWrite } = {}) {
  const nextPort = validPort(port)
  if (port !== undefined && nextPort === null) {
    throw new Error('The port must be a number between 1024 and 65535.')
  }
  if (enabled !== undefined) config.enabled = Boolean(enabled)
  if (nextPort !== null) config.port = nextPort
  if (allowWrite !== undefined) config.allowWrite = Boolean(allowWrite)
  if (!/^[a-f0-9]{64}$/i.test(config.token)) config.token = newToken()
  writeConfig(config)
  await stop()
  if (config.enabled) await start()
  return status()
}

async function rotate() {
  config.token = newToken()
  writeConfig(config)
  return status()
}

async function test() {
  if (!state.running) {
    return { ok: false, error: 'The MCP server is not running.' }
  }
  const started = Date.now()
  try {
    const response = await fetch(urlFor(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
    const tools = Array.isArray(payload?.result?.tools) ? payload.result.tools.length : 0
    return { ok: true, tools, latencyMs: Date.now() - started }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}

if (config.enabled) start().catch(() => {})

module.exports = {
  CONFIG_FILE,
  DEFAULT_PORT,
  TOOL_DEFS,
  status,
  start,
  stop,
  save,
  rotate,
  test,
  callTool,
}
