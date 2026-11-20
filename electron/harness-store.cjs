/**
 * Harness discovery and per-machine paths.
 *
 * These CLIs are usually on PATH, but a version manager or an app bundle often
 * puts one somewhere else. This module owns the machine-wide override file
 * (`~/.entity/harnesses.json`) and the model hints each installed CLI can
 * report. A chat or run resolves its command through here before spawning, so
 * the saved path is the one actually used.
 *
 * The list is the six CLIs `runner-local.cjs` can actually invoke — an id with
 * no invocation would be a row whose switch spawns nothing — and it is the one
 * list: the renderer reads it through `harness.list`, `entity-store.cjs`
 * validates `harness:` against it, and the skill scan walks the same ids.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { planSpawn } = require('./exec-plan.cjs')
const workspaces = require('./workspace-store.cjs')
const { expandHome, tilde } = require('./frontmatter.cjs')

const HOME = os.homedir()
const CONFIG = path.join(workspaces.ROOT, 'harnesses.json')
const MODEL_TTL = 60_000

/* The one harness list. The renderer reads it through `harness.list` instead of
   carrying a copy, so adding a CLI here is the whole change. */
const META = [
  { id: 'claude', label: 'Claude Code', command: 'claude' },
  { id: 'codex', label: 'Codex', command: 'codex' },
  { id: 'opencode', label: 'opencode', command: 'opencode' },
  { id: 'gemini', label: 'Gemini CLI', command: 'gemini' },
  { id: 'ollama', label: 'Ollama', command: 'ollama' },
  { id: 'pi', label: 'pi', command: 'pi' },
  { id: 'antigravity', label: 'Antigravity', command: 'agy' },
  { id: 'hermes', label: 'Hermes Agent', command: 'hermes' },
]

const cache = new Map()

/* One shape for the whole file, so a write of either key cannot drop the other.
   A file with no `enabled` map means every harness is on — that is what an
   upgrade from `schema: 1` reads as, and what an unreadable file reads as. */
function configShape(value) {
  const paths = value?.paths && typeof value.paths === 'object' ? value.paths : {}
  const enabled = value?.enabled && typeof value.enabled === 'object' ? value.enabled : {}
  return { schema: 2, paths, enabled }
}

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
    return raw && typeof raw === 'object' && raw.paths && typeof raw.paths === 'object'
      ? configShape(raw)
      : configShape(null)
  } catch {
    return configShape(null)
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
      /* a missing key is on: the file predates the preference */
      enabled: config.enabled[meta.id] !== false,
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
  writeConfig({ ...configShape(config), paths })
  cache.delete(meta.id)
  return list().find((entry) => entry.id === meta.id)
}

/**
 * The machine-wide on/off switch. Never the last one: an entity or a thread
 * whose harness is off fails loudly on the next message, and zero enabled
 * harnesses would make every new-thread action fail the same way.
 */
function setEnabled({ id, enabled } = {}) {
  const meta = metaFor(String(id || ''))
  if (!meta) throw new Error('Unknown harness.')
  const config = readConfig()
  const wanted = { ...config.enabled, [meta.id]: Boolean(enabled) }
  const left = META.filter((entry) => wanted[entry.id] !== false)
  if (!left.length) {
    throw new Error(
      `${meta.label} is the only harness on. Turn another on before turning this one off.`,
    )
  }
  writeConfig({ ...configShape(config), enabled: wanted })
  return list().find((entry) => entry.id === meta.id)
}

/** Refuses to spawn a harness this machine has turned off. `binary()` is used
    for version probes too, so the guard lives at the three spawn sites. */
function assertEnabled(id) {
  const meta = metaFor(String(id || ''))
  if (!meta) throw new Error('Unknown harness.')
  if (readConfig().enabled[meta.id] !== false) return
  throw new Error(`${meta.label} is turned off on this machine. Turn it on in Account → Harnesses.`)
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
  if (id === 'ollama') {
    /* Ollama has no "default model" setting: `ollama run` requires a name, and
       whichever one was pulled last is not a choice anybody made. The first of
       its own list is the honest prefill, and `models()` already reads it. */
    return ''
  }
  if (id === 'opencode') {
    return ''
  }
  return ''
}

function configuredProvider(id) {
  if (id !== 'pi') return ''
  const settings = readJson(path.join(HOME, '.pi', 'agent', 'settings.json'))
  return stringAt(settings, ['defaultProvider']) || stringAt(settings, ['provider']) || ''
}

/**
 * pi resolves a model against every provider it has authenticated, so a bare
 * `defaultModel` without its `defaultProvider` can be ambiguous and refuse to
 * start. This turns a name into the single string pi can act on, without
 * inventing a provider for a name the local listing does not know.
 */
function resolvePiModel(model, { binaryPath = '', provider = '', models: list = null } = {}) {
  const text = String(model || '').trim()
  if (!text) return { model: '', providers: [], status: 'empty' }

  const byProvider = new Map()
  for (const row of list === null ? cliModels('pi', binaryPath || resolvedPath('pi')) : list || []) {
    const value = String(row || '')
    const cut = value.indexOf('/')
    if (cut <= 0) continue
    const name = value.slice(0, cut)
    if (!byProvider.has(name)) byProvider.set(name, new Set())
    byProvider.get(name).add(value.slice(cut + 1))
  }

  const cut = text.indexOf('/')
  const head = cut < 0 ? text : text.slice(0, cut)
  if (byProvider.has(head)) return { model: text, providers: [head], status: 'qualified' }

  const candidates = [...byProvider].filter(([, ids]) => ids.has(text)).map(([name]) => name).sort()
  if (provider && candidates.includes(provider)) {
    return { model: `${provider}/${text}`, providers: candidates, status: 'resolved' }
  }
  if (candidates.length === 1) {
    return { model: `${candidates[0]}/${text}`, providers: candidates, status: 'resolved' }
  }
  if (candidates.length > 1) {
    /* A listing-only answer hides providers pi would accept, so let pi name
       them. Never used to choose a value — the input comes back unchanged. */
    const reported = list === null ? resolverPiChoices(text, binaryPath || resolvedPath('pi')) : []
    const providers = reported.length ? [...new Set(reported.map(providerId))].sort() : candidates
    return { model: text, providers, status: 'ambiguous' }
  }
  /* A configured provider only adopts a bare id. Something already shaped as
     `provider/model` is left alone even when the listing omits that provider. */
  if (provider && cut < 0) return { model: `${provider}/${text}`, providers: [], status: 'resolved' }
  return { model: text, providers: [], status: 'unknown' }
}

/** The `provider/model` names pi lists in its ambiguity error, if it is one. */
function piModelChoices(text) {
  /* Model ids contain dots (`deepseek-v4.1-flash`), so this stops at the
     sentence end, not the first dot. */
  const match = String(text || '').match(/is ambiguous across providers:\s*(.+?)\.(?:\s|$)/s)
  if (!match) return []
  return match[1]
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
}

function providerId(qualified) {
  const value = String(qualified || '')
  const cut = value.indexOf('/')
  return cut > 0 ? value.slice(0, cut) : value
}

/**
 * pi's resolver knows providers `--list-models` omits, so the list it prints is
 * the one a chooser has to offer. Asked only when the listing already says
 * ambiguous: every listed provider is authenticated, so pi stops in its
 * resolver and no turn runs.
 */
function resolverPiChoices(model, binaryPath) {
  if (!binaryPath) return []
  const plan = planSpawn(binaryPath, ['--no-session', '--model', String(model || ''), '-p', ''])
  const result = spawnSync(plan.command, plan.args, {
    encoding: 'utf8',
    timeout: 8000,
    maxBuffer: 1024 * 1024,
    env: process.env,
    ...plan.options,
  })
  if (result.error) return []
  return piModelChoices(`${result.stderr || ''}\n${result.stdout || ''}`)
}

/** The spawn path's version: uses the cached listing, so it never spawns pi. */
function qualifyPiModel(model) {
  return resolvePiModel(model, { models: models({ id: 'pi' }).models }).model
}

function runModels(binaryPath, args) {
  if (!binaryPath) return ''
  /* A Windows harness is a `.cmd` shim; `exec-plan` names the program it runs
     so the model list is not empty just because the CLI is not an `.exe`. */
  const plan = planSpawn(binaryPath, args)
  const result = spawnSync(plan.command, plan.args, {
    encoding: 'utf8',
    timeout: 6000,
    maxBuffer: 4 * 1024 * 1024,
    env: process.env,
    ...plan.options,
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
  if (id === 'ollama') {
    /* `ollama list` is a fixed-width table: NAME, ID, SIZE, MODIFIED. The name is
       the first column and it is the part before the digest, so a line is split
       on two-or-more spaces rather than on whitespace (`gpt-oss:20b` is one
       token and a model may not be). */
    const text = runModels(binaryPath, ['list'])
    if (!text) return []
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^NAME\b/i.test(line))
      .map((line) => line.split(/\s{2,}/)[0].trim())
      .filter(Boolean)
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
  let fromCli = []
  let source = 'none'
  if (found && executable(found)) {
    fromCli = cliModels(meta.id, found)
    if (fromCli.length) {
      detected.push(...fromCli)
      source = 'cli'
    }
  }
  const raw = configuredModel(meta.id)
  /* pi's `defaultModel` is provider-relative; prefixing it with the configured
     `defaultProvider` is what keeps the prefill out of pi's ambiguity error. */
  const configured =
    meta.id === 'pi' && raw
      ? resolvePiModel(raw, { models: fromCli, provider: configuredProvider('pi') }).model
      : raw
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
  setEnabled,
  assertEnabled,
  models,
  cliModels,
  configuredProvider,
  resolvePiModel,
  qualifyPiModel,
  piModelChoices,
  snapshot,
  which,
}
