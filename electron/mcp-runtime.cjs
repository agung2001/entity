/**
 * The MCP servers one harness process receives.
 *
 * The workspace has one pool (`<ws>/mcp.json`) and every entity gets it; an
 * entity may narrow it (`mcp: a, b`) or opt out (`mcp: none`). This module turns
 * that pool into whatever the harness under it can consume, and hands back the
 * argv/env to spawn with — nothing is written into the user's own config.
 *
 * Every strategy below was checked against the CLI installed on a real machine:
 *
 *   claude    --mcp-config <file> --strict-mcp-config        replaces the set
 *   opencode  OPENCODE_CONFIG=<file>                         merges over its own
 *   codex     -c mcp_servers.<n>.* overrides                 merges; token rides
 *                                                            in an env var, not
 *                                                            in the process list
 *   pi        PI_CODING_AGENT_DIR=<temp> with a merged mcp.json, every other
 *             file in the real agent dir symlinked through — or, on pi >= 0.99,
 *             a generated `--extension` calling pi.registerMcpServer(), which
 *             leaves the agent dir alone
 *   gemini    GEMINI_CLI_HOME=<temp> with a merged settings.json, the rest of
 *             ~/.gemini symlinked through, plus --skip-trust (gemini refuses
 *             user-level MCP servers in an untrusted folder)
 *
 * Two rules make it safe:
 *
 *   - an empty pool, or a turn where nothing resolves, changes nothing; the
 *     harness keeps whatever it already had;
 *   - a temp file/dir is created 0600, deleted when the process exits, and any
 *     left behind by a killed turn is pruned on the next one.
 *
 * Secrets never leave the file they were pasted into: `${NAME}` is expanded from
 * the app's environment when the file is written, and no verb returns a value.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const workspaces = require('./workspace-store.cjs')
const harnesses = require('./harness-store.cjs')

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000

/** `${VAR}` in a string → the value, recording the name when it is unset. */
function expandText(value, missing) {
  return String(value).replace(ENV_REF, (whole, name) => {
    const found = process.env[name]
    if (found === undefined) {
      if (!missing.includes(name)) missing.push(name)
      return whole
    }
    return found
  })
}

/**
 * One pool entry in the shape a harness consumes, with secrets resolved.
 * `env` may be a list of names (read from the app's environment) or a
 * name → value map pasted from a harness config; both end up as values here.
 */
function buildEntry(entry, missing = []) {
  const out = {}
  if (typeof entry.command === 'string') out.command = expandText(entry.command, missing)
  if (Array.isArray(entry.args)) out.args = entry.args.map((arg) => expandText(arg, missing))
  if (typeof entry.url === 'string') out.url = expandText(entry.url, missing)
  if (entry.headers && typeof entry.headers === 'object' && !Array.isArray(entry.headers)) {
    out.headers = {}
    for (const [header, value] of Object.entries(entry.headers)) {
      out.headers[header] = expandText(value, missing)
    }
  }
  if (typeof entry.type === 'string' && entry.type) out.type = entry.type

  const env = {}
  const raw = entry.env
  if (Array.isArray(raw)) {
    for (const name of raw) {
      if (typeof name !== 'string' || !name) continue
      const value = process.env[name]
      if (value === undefined) {
        if (!missing.includes(name)) missing.push(name)
        continue
      }
      env[name] = value
    }
  } else if (raw && typeof raw === 'object') {
    for (const [name, value] of Object.entries(raw)) {
      if (typeof value !== 'string') continue
      env[name] = expandText(value, missing)
    }
  }
  if (Object.keys(env).length) out.env = env
  return out
}

function readPool(record) {
  try {
    return workspaces.mcp(record.id)
  } catch {
    return { servers: {}, disabled: {} }
  }
}

/**
 * Which servers a turn asks for. The pool applies to every entity; an entity
 * narrows it with `mcp:` and opts out with `mcp: none`.
 */
function wantedNames(pool, entity, only = null) {
  if (only) return [only]
  const declared = (Array.isArray(entity?.mcp) ? entity.mcp : [])
    .map((name) => String(name || '').trim())
    .filter(Boolean)
  if (declared.some((name) => name.toLowerCase() === 'none')) return []
  if (declared.length) return declared
  return Object.keys(pool.servers || {})
}

/** The pool entries a turn will use, plus names it asked for and did not get. */
function resolveServers(record, entity, only = null) {
  const pool = readPool(record)
  const servers = {}
  const missing = []
  for (const name of wantedNames(pool, entity, only)) {
    const entry = pool.servers[name]
    if (!entry) {
      missing.push(name)
      continue
    }
    servers[name] = entry
  }
  return { servers, missing }
}

/* ── the temp workspace ───────────────────────────────────────────── */

function runsDir(record) {
  return path.join(record.path, 'runs')
}

/** Drop temp config files and mirrored dirs a quit or crash left behind. */
function prune(dir) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  const cutoff = Date.now() - PRUNE_AFTER_MS
  for (const entry of entries) {
    if (!entry.name.startsWith('.mcp-')) continue
    const target = path.join(dir, entry.name)
    try {
      if (fs.statSync(target).mtimeMs < cutoff) fs.rmSync(target, { recursive: true, force: true })
    } catch {
      /* a file that vanished between readdir and stat is already gone */
    }
  }
}

function tempName() {
  return `.mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function writeFile0600(file, payload) {
  return writeText0600(file, `${JSON.stringify(payload, null, 2)}\n`)
}

function writeText0600(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* a filesystem without modes */
  }
  return file
}

/** A `.mcp-*` file in the workspace's own `runs/` directory. */
function writeConfig(record, payload) {
  const dir = runsDir(record)
  fs.mkdirSync(dir, { recursive: true })
  prune(dir)
  return writeFile0600(path.join(dir, `${tempName()}.json`), payload)
}

/** A `.mcp-*` directory, for the two harnesses that need a mirrored config dir. */
function makeTempDir(record) {
  const dir = runsDir(record)
  fs.mkdirSync(dir, { recursive: true })
  prune(dir)
  const target = path.join(dir, tempName())
  fs.mkdirSync(target, { recursive: true })
  return target
}

/** Symlink every entry of a real config dir into the temp one, except `skip`. */
function mirror(source, target, skip = []) {
  fs.mkdirSync(target, { recursive: true })
  let entries = []
  try {
    entries = fs.readdirSync(source, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (skip.includes(entry.name)) continue
    try {
      fs.symlinkSync(
        path.join(source, entry.name),
        path.join(target, entry.name),
        entry.isDirectory() ? 'dir' : 'file',
      )
    } catch {
      /* a filesystem without symlinks: the copy is simply not mirrored */
    }
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/* ── per-harness shapes ───────────────────────────────────────────── */

/** opencode's MCP shape, which is not the Claude one. */
function opencodeServers(built) {
  const out = {}
  for (const [name, entry] of Object.entries(built)) {
    if (entry.command) {
      out[name] = { type: 'local', command: [entry.command, ...(entry.args || [])], enabled: true }
      if (entry.env) out[name].environment = entry.env
    } else if (entry.url) {
      out[name] = { type: 'remote', url: entry.url, enabled: true }
      if (entry.headers) out[name].headers = entry.headers
    }
  }
  return out
}

/** A TOML basic string. JSON's escaping is a valid subset for these values. */
function tomlString(value) {
  return JSON.stringify(String(value))
}

/** The token half of an `Authorization: Bearer …` header, or ''. */
function bearerOf(headers) {
  if (!headers || typeof headers !== 'object') return ''
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'authorization') continue
    const match = String(value).match(/^bearer\s+(.+)$/i)
    return match ? match[1].trim() : ''
  }
  return ''
}

function codexEnvName(name) {
  return `ENTITY_MCP_${String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_TOKEN`
}

/**
 * codex takes overrides on the command line. The bearer token is handed over
 * through an environment variable so it does not appear in `ps`.
 */
function codexSpec(built, result) {
  const names = []
  for (const [name, entry] of Object.entries(built)) {
    const prefix = `mcp_servers.${name}`
    if (entry.command) {
      result.argv.push('-c', `${prefix}.command=${tomlString(entry.command)}`)
      if (entry.args?.length) {
        result.argv.push('-c', `${prefix}.args=${JSON.stringify(entry.args)}`)
      }
      for (const [key, value] of Object.entries(entry.env || {})) {
        result.argv.push('-c', `${prefix}.env.${key}=${tomlString(value)}`)
      }
      names.push(name)
      continue
    }
    if (!entry.url) continue
    result.argv.push('-c', `${prefix}.url=${tomlString(entry.url)}`)
    const bearer = bearerOf(entry.headers)
    if (bearer) {
      const envName = codexEnvName(name)
      result.env[envName] = bearer
      result.argv.push('-c', `${prefix}.bearer_token_env_var=${tomlString(envName)}`)
    } else if (entry.headers && Object.keys(entry.headers).length) {
      result.notes.push(`${name}: codex only carries a bearer token for HTTP servers; other headers are dropped`)
    }
    names.push(name)
  }
  return names
}

/**
 * pi has no config-file flag. It reads `mcp.json` out of its agent directory, so
 * the run gets a temp directory: everything the real one holds is symlinked
 * through (auth, models, extensions, sessions) and only `mcp.json` is ours.
 */
/**
 * pi has two ways in. Since 0.99 an extension can call `pi.registerMcpServer()`
 * at load time, which leaves the agent directory completely alone — so that is
 * the first choice, and the mirrored config dir stays as the fallback for an
 * older pi or one whose version cannot be read.
 */
function piSpec(record, built, result, home, piVersion = null) {
  const source = path.join(home, '.pi', 'agent')
  const globalNames = Object.keys(readJson(path.join(source, 'mcp.json'))?.mcpServers || {})
  for (const name of Object.keys(built)) {
    /* pi gives its own mcp.json precedence over an extension registration */
    if (globalNames.includes(name)) {
      result.notes.push(`pi: “${name}” is also in your own mcp.json, which takes precedence`)
    }
  }

  if (piSupportsMcpExtension(piVersion)) {
    const file = writeText0600(
      path.join(runsDir(record), `${tempName()}.mjs`),
      piExtension(built),
    )
    result.argv.push('--extension', file)
    result.files.push(file)
    return Object.keys(built)
  }
  return piSpecMirror(record, built, result, home)
}

let piVersionCache = null

function probePiVersion() {
  if (piVersionCache === null) {
    try {
      const out = execFileSync(harnesses.binary('pi') || 'pi', ['--version'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      piVersionCache = String(out).match(/(\d+\.\d+\.\d+)/)?.[1] || ''
    } catch {
      piVersionCache = ''
    }
  }
  return piVersionCache
}

/** >= 0.99 is where the built-in MCP extension and `registerMcpServer` landed. */
function piSupportsMcpExtension(explicit = null) {
  const version = explicit === null ? probePiVersion() : String(explicit)
  /* an unreadable version falls back to the mirror, which works everywhere */
  return version ? atLeast(version, '0.99.0') : false
}

function atLeast(version, minimum) {
  const left = String(version).split('.').map(Number)
  const right = String(minimum).split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    const a = Number.isFinite(left[i]) ? left[i] : 0
    const b = Number.isFinite(right[i]) ? right[i] : 0
    if (a > b) return true
    if (a < b) return false
  }
  return true
}

/** The generated extension: one JSON payload, one registration per server. */
function piExtension(built) {
  const payload = JSON.stringify(JSON.stringify(built))
  return [
    '// generated by Entity for one turn; deleted when the run ends',
    '// registers the workspace MCP pool without touching ~/.pi/agent',
    `const servers = JSON.parse(${payload});`,
    '',
    'export default function (pi) {',
    '  if (typeof pi.registerMcpServer !== "function") {',
    '    throw new Error("Entity MCP delivery needs a pi version with registerMcpServer");',
    '  }',
    '  for (const [name, config] of Object.entries(servers)) {',
    '    try {',
    '      /* direct exposure: the pool is an explicit choice, and its tools should',
    '         be usable without going through codemode first */',
    '      pi.registerMcpServer(name, { exposure: "direct", ...config });',
    '    } catch (error) {',
    '      const reason = error instanceof Error ? error.message : String(error);',
    '      console.error("[entity] could not register MCP server " + JSON.stringify(name) + ": " + reason);',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n')
}

/** Fallback for pi before 0.99: a mirrored agent dir with only mcp.json replaced. */
function piSpecMirror(record, built, result, home) {
  const source = path.join(home, '.pi', 'agent')
  const dir = makeTempDir(record)
  mirror(source, dir, ['mcp.json'])
  const existing = readJson(path.join(source, 'mcp.json'))
  const servers = { ...(existing?.mcpServers || {}), ...built }
  writeFile0600(path.join(dir, 'mcp.json'), { mcpServers: servers })
  result.env.PI_CODING_AGENT_DIR = dir
  result.files.push(dir)
  return Object.keys(built)
}

/**
 * gemini reads `settings.json` from `$GEMINI_CLI_HOME/.gemini`, and refuses
 * user-level MCP servers in an untrusted folder — hence `--skip-trust`.
 */
function geminiSpec(record, built, result, home) {
  const source = path.join(home, '.gemini')
  const dir = makeTempDir(record)
  const target = path.join(dir, '.gemini')
  mirror(source, target, ['settings.json'])
  const existing = readJson(path.join(source, 'settings.json')) || {}
  const servers = { ...(existing.mcpServers || {}), ...built }
  writeFile0600(path.join(target, 'settings.json'), { ...existing, mcpServers: servers })
  result.env.GEMINI_CLI_HOME = dir
  result.argv.push('--skip-trust')
  result.files.push(dir)
  return Object.keys(built)
}

/* ── entry point ──────────────────────────────────────────────────── */

/**
 * @param {{ record: object, entity: object, harness: string,
 *           only?: string|null, home?: string }} args
 * @returns {{
 *   servers: string[],
 *   files: string[],
 *   argv: string[],
 *   env: Record<string,string>,
 *   notes: string[],
 *   cleanup: () => void,
 * }}
 */
function materialise({ record, entity, harness, only = null, home = os.homedir(), piVersion = null } = {}) {
  const result = { servers: [], files: [], argv: [], env: {}, notes: [], cleanup: () => {} }
  if (!record) return result

  const { servers, missing } = resolveServers(record, entity, only)
  if (!missing.length && !Object.keys(servers).length) return result

  for (const name of missing) {
    result.notes.push(`“${name}” is not in this workspace's MCP pool`)
  }

  const built = {}
  for (const name of Object.keys(servers).sort()) {
    const unset = []
    const entry = buildEntry(servers[name], unset)
    if (unset.length) {
      result.notes.push(`${name} needs ${unset.join(', ')} set in the app's environment`)
      continue
    }
    if (!entry.command && !entry.url) continue
    built[name] = entry
  }

  const usable = Object.keys(built)
  if (!usable.length) {
    /* Fail soft: the turn still runs, and the note says why the tools it named
       are missing instead of pretending the pool was applied. */
    if (!result.notes.length) result.notes.push('No MCP server from this entity could be started')
    return result
  }

  if (harness === 'claude') {
    const file = writeConfig(record, { mcpServers: built })
    result.files.push(file)
    result.argv.push('--mcp-config', file, '--strict-mcp-config')
    result.servers = usable
  } else if (harness === 'opencode') {
    const file = writeConfig(record, { mcp: opencodeServers(built) })
    result.files.push(file)
    result.env.OPENCODE_CONFIG = file
    result.servers = usable
  } else if (harness === 'codex') {
    result.servers = codexSpec(built, result)
  } else if (harness === 'pi') {
    result.servers = piSpec(record, built, result, home, piVersion)
  } else if (harness === 'gemini') {
    result.servers = geminiSpec(record, built, result, home)
  } else {
    result.notes.push(`${harness} has no known MCP configuration surface`)
    return result
  }

  result.cleanup = () => {
    for (const file of result.files) {
      try {
        fs.rmSync(file, { recursive: true, force: true })
      } catch {
        /* the run directory is disposable */
      }
    }
    result.files.length = 0
  }
  return result
}

module.exports = { materialise, resolveServers, wantedNames, buildEntry, expandText }
