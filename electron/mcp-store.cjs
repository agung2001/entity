/**
 * MCP configuration discovery.
 *
 * A workspace has its own pool (`<ws>/mcp.json`). This module reads the other
 * half: the MCP servers each harness already has in its own config. It is
 * read-only on purpose — editing another tool's config from here would be a
 * write the user did not ask for.
 *
 * Nothing secret is returned: `env`/`environment` are reduced to their keys,
 * never their values.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { tilde } = require('./frontmatter.cjs')

const HOME = os.homedir()
const XDG_CONFIG = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config')

const HARNESS_LABELS = {
  claude: 'Claude Code',
  pi: 'pi',
  codex: 'Codex CLI',
  opencode: 'opencode',
  gemini: 'Gemini CLI',
  antigravity: 'Antigravity',
  agents: 'Agents',
}

/* One entry per file this module knows how to read. A harness may contribute
   more than one file; the UI groups them under the harness. */
const SOURCES = [
  { harness: 'claude', file: path.join(HOME, '.claude.json'), keys: ['mcpServers'] },
  { harness: 'claude', file: path.join(HOME, '.claude', 'settings.json'), keys: ['mcpServers'] },
  { harness: 'claude', file: path.join(HOME, '.claude', 'mcp.json'), keys: ['mcpServers'] },
  { harness: 'pi', file: path.join(HOME, '.pi', 'agent', 'mcp.json'), keys: ['mcpServers'] },
  { harness: 'codex', file: path.join(HOME, '.codex', 'config.toml'), format: 'toml' },
  { harness: 'opencode', file: path.join(XDG_CONFIG, 'opencode', 'opencode.jsonc'), keys: ['mcp'] },
  { harness: 'opencode', file: path.join(XDG_CONFIG, 'opencode', 'opencode.json'), keys: ['mcp'] },
  { harness: 'opencode', file: path.join(HOME, '.opencode', 'config.json'), keys: ['mcp', 'mcpServers'] },
  { harness: 'gemini', file: path.join(HOME, '.gemini', 'settings.json'), keys: ['mcpServers'] },
  { harness: 'antigravity', file: path.join(HOME, '.gemini', 'antigravity', 'mcp_config.json'), keys: ['mcpServers', 'mcp', 'servers'] },
  { harness: 'antigravity', file: path.join(HOME, '.gemini', 'antigravity-cli', 'mcp_config.json'), keys: ['mcpServers', 'mcp', 'servers'] },
  { harness: 'agents', file: path.join(HOME, '.agents', 'mcp.json'), keys: ['mcpServers'] },
]

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** JSONC: remove comments outside strings, then tolerate trailing commas. */
function stripJsonComments(text) {
  let out = ''
  let inString = false
  let quote = ''
  let escape = false
  let lineComment = false
  let blockComment = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]

    if (lineComment) {
      if (char === '\n') {
        lineComment = false
        out += char
      }
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        i += 1
      }
      continue
    }
    if (inString) {
      out += char
      if (escape) {
        escape = false
      } else if (char === '\\') {
        escape = true
      } else if (char === quote) {
        inString = false
      }
      continue
    }
    if (char === '"' || char === "'") {
      inString = true
      quote = char
      out += char
      continue
    }
    if (char === '/' && next === '/') {
      lineComment = true
      i += 1
      continue
    }
    if (char === '/' && next === '*') {
      blockComment = true
      i += 1
      continue
    }
    out += char
  }

  return out.replace(/,\s*([}\]])/g, '$1')
}

function parseJsonFile(file) {
  const text = readText(file)
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    try {
      return JSON.parse(stripJsonComments(text))
    } catch {
      return null
    }
  }
}

function unquote(value) {
  return String(value || '')
    .trim()
    .replace(/^["']|["']$/g, '')
}

function parseTomlArray(value) {
  const args = []
  const re = /"((?:\\.|[^"])*)"/g
  let match
  while ((match = re.exec(value))) {
    args.push(match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
  }
  return args
}

function tableKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.keys(value)
}

/** Codex uses `[mcp_servers.<name>]` tables in config.toml. */
function tomlServers(file) {
  const servers = []
  const byName = new Map()
  let current = null
  let envTarget = null

  for (const line of readText(file).split(/\r?\n/)) {
    const section = line.match(/^\s*\[mcp_servers\.(.+)\]\s*$/)
    if (section) {
      const raw = section[1].trim()
      if (raw.endsWith('.env')) {
        const owner = raw.slice(0, -4).replace(/^["']|["']$/g, '')
        current = null
        envTarget = byName.get(owner) || null
        continue
      }
      const name = raw.replace(/^["']|["']$/g, '')
      current = { name, command: '', args: [], url: '', env: [] }
      envTarget = null
      byName.set(name, current)
      servers.push(current)
      continue
    }
    if (/^\s*\[/.test(line)) {
      current = null
      envTarget = null
      continue
    }

    const kv = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+)$/)
    if (!kv) continue
    const key = kv[1]
    const raw = kv[2].trim()

    if (envTarget) {
      envTarget.env.push(key)
      continue
    }
    if (!current) continue
    if (key === 'command') current.command = unquote(raw)
    else if (key === 'args') current.args = parseTomlArray(raw)
    else if (key === 'url' || key === 'server_url') current.url = unquote(raw)
    else if (key === 'env') current.env = [...new Set([...current.env, ...tableKeys(parseLooseValue(raw))])]
  }

  return servers
}

function parseLooseValue(raw) {
  const text = String(raw || '').trim()
  if (!text.startsWith('{')) return null
  try {
    return JSON.parse(text.replace(/([A-Za-z0-9_-]+)\s*=/g, '"$1":').replace(/'/g, '"'))
  } catch {
    return null
  }
}

function normaliseServer(name, raw) {
  if (!raw || typeof raw !== 'object') {
    return { name: String(name), command: '', args: [], url: '', env: [] }
  }
  let command = raw.command
  let args = raw.args

  /* opencode stores `command: ["exec", "arg"]`; most others use command+args */
  if (Array.isArray(command)) {
    const [first, ...rest] = command.map(String)
    command = first || ''
    args = rest
  }
  if (typeof args === 'string') args = [args]
  if (!Array.isArray(args)) args = []

  return {
    name: String(name),
    command: String(command || ''),
    args: args.map(String),
    url: String(raw.url || raw.serverUrl || raw.server_url || ''),
    env: tableKeys(raw.env || raw.environment),
    type: String(raw.type || ''),
  }
}

function jsonServers(file, keys) {
  const parsed = parseJsonFile(file)
  if (!parsed) return []
  for (const key of keys || []) {
    const table = parsed[key]
    if (table && typeof table === 'object' && !Array.isArray(table)) {
      return Object.entries(table).map(([name, value]) => normaliseServer(name, value))
    }
  }
  return []
}

function fileServers(source) {
  if (!fs.existsSync(source.file)) return []
  if (source.format === 'toml') return tomlServers(source.file)
  return jsonServers(source.file, source.keys)
}

function globals() {
  const groups = new Map()
  let count = 0

  for (const source of SOURCES) {
    const servers = fileServers(source)
    if (!servers.length) continue
    count += servers.length
    if (!groups.has(source.harness)) {
      groups.set(source.harness, {
        harness: source.harness,
        label: HARNESS_LABELS[source.harness] || source.harness,
        files: [],
        servers: [],
      })
    }
    const group = groups.get(source.harness)
    group.files.push({
      path: tilde(source.file),
      exists: fs.existsSync(source.file),
    })
    for (const server of servers) {
      group.servers.push({
        ...server,
        harness: source.harness,
        harnessLabel: group.label,
        configPath: tilde(source.file),
      })
    }
  }

  const list = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label))
  return {
    groups: list,
    count,
    scannedAt: new Date().toISOString(),
  }
}

module.exports = { globals, HARNESS_LABELS }
