/**
 * Harness discovery and per-machine paths.
 *
 * The five CLIs are usually on PATH, but a version manager or an app bundle
 * often puts one somewhere else. This module owns the machine-wide override
 * file (`~/.entity/harnesses.json`) and the model hints each installed CLI can
 * report. A chat or run resolves its command through here before spawning, so
 * the saved path is the one actually used.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const workspaces = require('./workspace-store.cjs')
const { expandHome, tilde } = require('./frontmatter.cjs')

const HOME = os.homedir()
const CONFIG = path.join(workspaces.ROOT, 'harnesses.json')
const MODEL_TTL = 60_000

/* The one harness list. The renderer reads it through `harness.list` instead of
   carrying a copy, so adding a CLI here is the whole change. */
const META = [
  { id: 'claude', label: 'Claude Code', command: 'claude' },
  { id: 'codex', label: 'Codex CLI', command: 'codex' },
  { id: 'gemini', label: 'Gemini CLI', command: 'gemini' },
  { id: 'opencode', label: 'opencode', command: 'opencode' },
  { id: 'pi', label: 'pi', command: 'pi' },
]

const cache = new Map()

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
    return raw && typeof raw === 'object' && raw.paths && typeof raw.paths === 'object'
      ? raw
      : { schema: 1, paths: {} }
  } catch {
    return { schema: 1, paths: {} }
  }
}

function writeConfig(value) {
  const tmp = `${CONFIG}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true })
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, CONFIG)
  return value
}

function executable(file) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return false
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function which(command) {
  const name = String(command || '')
  if (!name) return ''
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
  const exts =
    process.platform === 'win32'
      ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
      : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`)
      if (executable(candidate)) return candidate
    }
  }
  return ''
}

function metaFor(id) {
  return META.find((entry) => entry.id === id) || null
}

/** The configured path wins; otherwise PATH decides. */
function resolvedPath(id) {
  const meta = metaFor(id)
  if (!meta) return ''
  const custom = String(readConfig().paths[id] || '').trim()
  if (custom) return expandHome(custom)
  return which(meta.command)
}

function binary(id) {
  const meta = metaFor(id)
  if (!meta) return ''
  return resolvedPath(id) || meta.command
}

function list() {
  const config = readConfig()
  return META.map((meta) => {
    const custom = String(config.paths[meta.id] || '').trim()
    const found = resolvedPath(meta.id)
    return {
      id: meta.id,
      label: meta.label,
      command: meta.command,
      path: found ? tilde(found) : '',
      absolutePath: found,
      installed: Boolean(found) && executable(found),
      custom: Boolean(custom),
      customPath: custom ? tilde(expandHome(custom)) : '',
    }
  })
}

function setPath({ id, path: value } = {}) {
  const meta = metaFor(String(id || ''))
  if (!meta) throw new Error('Unknown harness.')
  const wanted = String(value || '').trim()
  const config = readConfig()
  const paths = { ...(config.paths || {}) }
  if (!wanted) {
    delete paths[meta.id]
  } else {
    const absolute = expandHome(wanted)
    if (!executable(absolute)) {
      throw new Error(`${tilde(absolute)} is not an executable file.`)
    }
    paths[meta.id] = absolute
  }
  writeConfig({ schema: 1, paths })
  cache.delete(meta.id)
  return list().find((entry) => entry.id === meta.id)
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function stringAt(value, keys) {
  let current = value
  for (const key of keys) {
    if (!current || typeof current !== 'object') return ''
    current = current[key]
  }
  return typeof current === 'string' ? current.trim() : ''
}

function configuredModel(id) {
  if (id === 'claude') {
    const settings = readJson(path.join(HOME, '.claude', 'settings.json'))
    return (
      stringAt(settings, ['model']) ||
      stringAt(settings, ['env', 'ANTHROPIC_MODEL']) ||
      stringAt(settings, ['env', 'CLAUDE_CODE_MODEL'])
    )
  }
  if (id === 'codex') {
    let text = ''
    try {
      text = fs.readFileSync(path.join(HOME, '.codex', 'config.toml'), 'utf8')
    } catch {
      /* not installed or no config */
    }
    return text.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1]?.trim() || ''
  }
  if (id === 'gemini') {
    const settings = readJson(path.join(HOME, '.gemini', 'settings.json'))
    return (
      stringAt(settings, ['model']) ||
      stringAt(settings, ['model', 'name']) ||
      stringAt(settings, ['general', 'model']) ||
      ''
    )
  }
  if (id === 'pi') {
    const settings = readJson(path.join(HOME, '.pi', 'agent', 'settings.json'))
    return stringAt(settings, ['model']) || stringAt(settings, ['defaultModel'])
  }
  if (id === 'opencode') {
    return ''
  }
  return ''
}

function runModels(binaryPath, args) {
  const result = spawnSync(binaryPath, args, {
    encoding: 'utf8',
    timeout: 6000,
    maxBuffer: 4 * 1024 * 1024,
    env: process.env,
  })
  if (result.error || result.status !== 0) return ''
  return String(result.stdout || '')
}

function cliModels(id, binaryPath) {
  if (id === 'pi') {
    const text = runModels(binaryPath, ['--list-models'])
    if (!text) return []
    const out = []
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || /^provider\s+model\b/i.test(trimmed)) continue
      const match = trimmed.match(/^(\S+)\s+(\S+)/)
      if (!match) continue
      out.push(`${match[1]}/${match[2]}`)
    }
    return out
  }
  if (id === 'opencode') {
    const text = runModels(binaryPath, ['models'])
    if (!text) return []
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/\s/.test(line))
  }
  return []
}

function models({ id, force = false } = {}) {
  const meta = metaFor(String(id || ''))
  if (!meta) throw new Error('Unknown harness.')
  const cached = cache.get(meta.id)
  if (!force && cached && Date.now() - cached.at < MODEL_TTL) return cached.value

  const found = resolvedPath(meta.id)
  const detected = []
  let source = 'none'
  if (found && executable(found)) {
    const fromCli = cliModels(meta.id, found)
    if (fromCli.length) {
      detected.push(...fromCli)
      source = 'cli'
    }
  }
  const configured = configuredModel(meta.id)
  if (configured) {
    detected.unshift(configured)
    if (source !== 'cli') source = 'config'
  }
  /* No built-in names: a model is offered only when this machine can name it,
     either from the CLI's own listing or from the config the CLI already has. */
  const models = [...new Set(detected)]
  const value = {
    id: meta.id,
    models,
    default: configured || '',
    source,
    detected: detected.length > 0,
  }
  cache.set(meta.id, { at: Date.now(), value })
  return value
}

/** A read-only inventory of this machine, shaped like `machine-scan.cjs` facts. */
function snapshot() {
  const installed = list().filter((entry) => entry.installed)
  const harnesses = installed.map((entry) => {
    let detail = { models: [], default: '', source: 'none' }
    try {
      detail = models({ id: entry.id })
    } catch {
      /* one broken CLI must not hide the others */
    }
    return {
      id: entry.id,
      label: entry.label,
      path: entry.absolutePath,
      models: detail.models,
      default: detail.default,
      source: detail.source,
    }
  })
  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    harnesses,
  }
}

module.exports = {
  CONFIG,
  META,
  list,
  binary,
  resolvedPath,
  setPath,
  models,
  snapshot,
  which,
}
