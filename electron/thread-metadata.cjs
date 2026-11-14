/**
 * Thread metadata: the links and paths a conversation mentions.
 *
 * This is derived from the thread's own transcript — the prompts, the answers,
 * the tool calls and their output, resolved mentions and attachments — so there
 * is no second copy of anything to go stale. A link that scrolled out of view
 * is still in the transcript; a path that was only in a tool result is still
 * metadata.
 *
 * Two rules shape the parser:
 *
 *   1. A path is only listed when it exists (local threads). The panel's rows
 *      are meant to be opened, and a row that cannot be opened is a bug in a
 *      list of things to open. Remote threads cannot be stat'ed from here, so
 *      they keep the candidates and say so.
 *   2. The renderer never names a path it will open. `path.open` re-derives the
 *      metadata and only acts on a member of that set, so a component cannot
 *      ask the main process to open an arbitrary file.
 *
 * URLs and paths are capped and scanned newest-first: a long thread's recent
 * work is what someone opens this panel for.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const MAX_LINKS = 120
const MAX_PATHS = 160
const MAX_PATH_CANDIDATES = 600
const MAX_SCAN_CHARS = 500_000
const MAX_TOKEN = 400
const MAX_FLAT_STRINGS = 400
const MAX_UNIT_CHARS = 20_000

/* A URL ends at whitespace or one of the characters a transcript wraps it in. */
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi
const MARKDOWN_LINK = /\[([^\]\n]{1,180})\]\((https?:\/\/[^\s)]+)\)/g

/* Relative paths are accepted freely and filtered by `fs.statSync`; the
   extension test is what keeps prose such as `and/or` out when there is no
   filesystem to check against (a remote thread). */
const HAS_EXTENSION = /\.[A-Za-z0-9]{1,10}$/

/* Files people name without an extension. Only accepted when the mention is
   quoted, so the word "readme" in prose does not become a path. */
const BARE_FILES = new Set([
  'makefile',
  'dockerfile',
  'gemfile',
  'rakefile',
  'procfile',
  'license',
  'licence',
  'readme',
  'changelog',
  'codeowners',
  '.gitignore',
  '.gitattributes',
  '.env',
  '.editorconfig',
  '.npmrc',
  '.nvmrc',
])

/* Splitting on these leaves a path token intact: paths rarely contain spaces
   unquoted, and every wrapper a transcript puts around them is a delimiter. */
const TOKEN_SPLIT = /[\s"'`<>()[\]{}|,;=]+/

const QUOTED = /`([^`\n]{1,300})`|"([^"\n]{1,300})"/g

function nowIso() {
  return new Date().toISOString()
}

function expandHome(value) {
  const text = String(value || '')
  if (text === '~') return os.homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(os.homedir(), text.slice(2))
  return text
}

/* `~/Documents/app.ts` reads better than the absolute path in a narrow panel;
   the copy button still copies the absolute one. */
function tildePath(value) {
  const home = os.homedir()
  const text = String(value || '')
  if (text === home) return '~'
  if (text.startsWith(`${home}${path.sep}`)) return `~${text.slice(home.length)}`
  return text
}

/**
 * Trailing punctuation is prose, not the URL. A closing paren belongs to the
 * URL only when the URL opened more parens than it closed — Wikipedia links.
 */
function trimUrl(raw) {
  let url = String(raw || '').trim()
  while (/[.,;:!?'"”’\]\}]$/.test(url)) url = url.slice(0, -1)
  while (url.endsWith(')')) {
    const open = (url.match(/\(/g) || []).length
    const close = (url.match(/\)/g) || []).length
    if (close <= open) break
    url = url.slice(0, -1)
  }
  return url
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}

/** A readable row title: the markdown label, else the issue/PR, else the tail. */
function friendlyLabel(url, explicit) {
  const label = String(explicit || '').trim()
  if (label) return label.slice(0, 160)
  try {
    const parsed = new URL(url)
    const parts = parsed.pathname.split('/').filter(Boolean)
    const last = parts[parts.length - 1] || ''
    const host = parsed.hostname.replace(/^www\./i, '')
    const pullAt = parts.findIndex((part) => ['pull', 'pulls', 'merge_requests'].includes(part))
    if (pullAt > 0 && parts[pullAt + 1]) return `${parts[pullAt - 1]}#${parts[pullAt + 1]}`
    const browseAt = parts.findIndex((part) => ['issue', 'issues', 'browse', 'tickets'].includes(part))
    const id = browseAt >= 0 ? parts[browseAt + 1] || last : last
    if (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(id)) return id
    return last ? `${host}/${last}` : host
  } catch {
    return url
  }
}

/* ── links ────────────────────────────────────────────────────────── */

function urlsIn(text) {
  const source = String(text || '')
  const labels = new Map()
  for (const match of source.matchAll(MARKDOWN_LINK)) {
    const url = trimUrl(match[2])
    if (url) labels.set(url, String(match[1] || '').trim())
  }
  const out = []
  for (const match of source.matchAll(URL_RE)) {
    const url = trimUrl(match[0])
    if (!url || url.length > 2000) continue
    out.push({ url, label: labels.get(url) || '' })
  }
  return out
}

/* ── paths ────────────────────────────────────────────────────────── */

/**
 * Strip the wrappers a path picks up in prose and tool output: trailing
 * punctuation, a `#L12` anchor, and an `:12:3` line/column suffix.
 */
function cleanToken(raw) {
  let value = String(raw || '').trim()
  value = value.replace(/^[([{<]+/, '')
  value = value.replace(/[)\]}>]+$/, '')
  value = value.replace(/^[-–—>+]+/, '')
  value = value.replace(/[.,;:!?'"”’]+$/, '')

  const lined = value.match(/^(.*?):\d+(?::\d+)?$/)
  if (lined && /[\\/]/.test(lined[1])) value = lined[1]

  const hash = value.indexOf('#')
  if (hash > 0 && /[\\/]/.test(value.slice(0, hash))) value = value.slice(0, hash)

  return value
}

function isPathLike(raw, { quoted = false, strict = false } = {}) {
  const value = String(raw || '')
  if (!value || value.length > MAX_TOKEN) return false
  if (/[\0\n\r]/.test(value)) return false
  if (value.includes('://') || /^https?:/i.test(value)) return false
  if (value.startsWith('@') || value.startsWith('#') || value.startsWith('--')) return false
  if (value === '/' || value === '//' || value === '.' || value === '..' || value === '~') return false
  if (/^[./\\]+$/.test(value)) return false

  const winAbsolute = /^[A-Za-z]:[\\/]/.test(value)
  const absolute = value.startsWith('/') || value.startsWith('~/') || winAbsolute
  const hasSep = /[\\/]/.test(value)
  const extension = HAS_EXTENSION.test(value)
  const bareName = !hasSep && BARE_FILES.has(value.toLowerCase())

  /* `localhost:3000/api` is a URL without its scheme, not a path. */
  if (!absolute && /^[A-Za-z0-9.-]+:\d+\//.test(value)) return false
  /* `1/2`, `2024/01/02`, `10:30/12` are numbers and times. */
  if (!absolute && /^[\d.:/]+$/.test(value)) return false

  if (absolute) return true
  if (!hasSep) return quoted && (extension || bareName)
  if (strict) {
    return extension || bareName || value.endsWith('/') || value.startsWith('./') || value.startsWith('../')
  }
  /* Local threads get the benefit of the doubt here; `fs.statSync` in
     `resolvePath` is the filter that keeps prose out of the list. */
  return true
}

/** The quoted spans and bare tokens of one block of text, cleaned. */
function pathTokensIn(text, { strict = false } = {}) {
  const source = String(text || '')
  if (!source) return []
  const out = []

  for (const match of source.matchAll(QUOTED)) {
    const value = cleanToken(match[1] !== undefined ? match[1] : match[2])
    if (isPathLike(value, { quoted: true, strict })) out.push(value)
  }

  /* A URL's path segments are not files; blank URLs before the bare scan. */
  const blank = source.replace(URL_RE, ' ')
  for (const chunk of blank.split(TOKEN_SPLIT)) {
    const value = cleanToken(chunk)
    if (isPathLike(value, { quoted: false, strict })) out.push(value)
  }
  return out
}

function baseDirs(messages, workspacePath, entityDir) {
  const bases = []
  const push = (value) => {
    const expanded = expandHome(value)
    if (!expanded || !path.isAbsolute(expanded)) return
    const normalized = path.normalize(expanded)
    if (!bases.includes(normalized)) bases.push(normalized)
  }
  /* Newest turn first: a thread's cwd is the directory its paths are relative
     to, and the most recent turn is the best answer if an entity moved. */
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const cwd = messages[i]?.execution?.cwd
    if (typeof cwd === 'string' && cwd) push(cwd)
  }
  push(entityDir)
  push(workspacePath)
  /* The home directory is deliberately not a base: a relative path belongs to
     the turn's cwd (or the entity/workspace), and resolving `Library/Caches`
     against `~` would list a real directory the conversation never meant. An
     explicit `~/…` still resolves — that is what `expandHome` is for. */
  return bases
}

/** First existing candidate wins; a directory is as good as a file. */
function resolvePath(raw, bases) {
  const value = cleanToken(raw)
  if (!value) return null
  const expanded = expandHome(value)
  const attempts = path.isAbsolute(expanded)
    ? [path.normalize(expanded)]
    : bases.map((base) => path.resolve(base, expanded))
  for (const candidate of attempts) {
    try {
      const stat = fs.statSync(candidate)
      if (stat.isDirectory()) return { path: candidate, kind: 'directory' }
      if (stat.isFile()) return { path: candidate, kind: 'file' }
    } catch {
      /* not this one */
    }
  }
  return null
}

/* ── transcript walk ──────────────────────────────────────────────── */

function flattenStrings(value, out = [], depth = 0) {
  if (out.length >= MAX_FLAT_STRINGS) return out
  if (typeof value === 'string') {
    if (value) out.push(value)
    return out
  }
  if (!value || typeof value !== 'object' || depth > 4) return out
  if (Array.isArray(value)) {
    for (const entry of value) flattenStrings(entry, out, depth + 1)
    return out
  }
  for (const entry of Object.values(value)) flattenStrings(entry, out, depth + 1)
  return out
}

/**
 * Build the metadata for one thread.
 *
 * `thread` is the normalised thread from `chat-store` (messages with `text`,
 * `steps`, `mentions`, `attachments`, `execution`). `workspacePath` and
 * `entityDir` are fallbacks for relative paths when a turn has no `cwd` yet.
 */
function build({ thread, workspacePath = '', entityDir = '', machine = 'local' } = {}) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : []
  const remote = String(machine || 'local') !== 'local'
  const bases = baseDirs(messages, workspacePath, entityDir)
  const links = new Map()
  const paths = new Map()
  let order = 0
  let scanned = 0
  let candidates = 0

  const addLink = (raw, { label = '', at = '', source = 'message' } = {}) => {
    const url = trimUrl(raw)
    if (!url || url.length > 2000) return
    const existing = links.get(url)
    if (existing) {
      existing.count += 1
      /* A resolved mention carries a richer label (`AC-9 — login bug`) than the
         bare URL seen in the answer; keep the more descriptive one. */
      const next = friendlyLabel(url, label)
      if (next && next !== url && (!existing.label || next.length > existing.label.length)) {
        existing.label = next
      }
      return
    }
    links.set(url, {
      url,
      label: friendlyLabel(url, label),
      host: hostOf(url),
      at,
      source,
      count: 1,
      order: order++,
    })
  }

  const addPath = (raw, { at = '', source = 'message', quoted = false } = {}) => {
    const value = cleanToken(raw)
    if (!isPathLike(value, { quoted, strict: remote })) return
    if (candidates >= MAX_PATH_CANDIDATES) return
    candidates += 1
    if (remote) {
      const display = expandHome(value)
      if (paths.has(display)) {
        paths.get(display).count += 1
        return
      }
      const dir = path.dirname(display)
      paths.set(display, {
        path: display,
        display,
        name: path.basename(display) || display,
        dir: dir === '.' ? '' : dir,
        kind: 'unknown',
        remote: true,
        at,
        source,
        count: 1,
        order: order++,
      })
      return
    }
    const found = resolvePath(value, bases)
    if (!found) return
    const existing = paths.get(found.path)
    if (existing) {
      existing.count += 1
      return
    }
    paths.set(found.path, {
      path: found.path,
      display: tildePath(found.path),
      name: path.basename(found.path) || found.path,
      dir: tildePath(path.dirname(found.path)),
      kind: found.kind,
      remote: false,
      at,
      source,
      count: 1,
      order: order++,
    })
  }

  const addText = (text, at, source) => {
    const value = String(text || '')
    if (!value) return
    const room = MAX_SCAN_CHARS - scanned
    if (room <= 0) return
    const slice = value.slice(0, Math.min(value.length, room, MAX_UNIT_CHARS))
    if (!slice) return
    scanned += slice.length
    for (const link of urlsIn(slice)) addLink(link.url, { label: link.label, at, source })
    /* pathTokensIn already applied the quoted/bare rules; keep the token's
       permission so a quoted bare filename is not rejected a second time. */
    for (const token of pathTokensIn(slice, { strict: remote })) {
      addPath(token, { at, source, quoted: true })
    }
  }

  /* Newest first: first encounter is the most recent mention, which is the
     order the panel shows and the point at which the scan budget stops. */
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (MAX_SCAN_CHARS - scanned <= 0) break
    const message = messages[i]
    if (!message) continue
    const at = String(message.at || '')

    if (message.who !== 'sys') addText(message.text, at, 'message')

    for (const mention of Array.isArray(message.mentions) ? message.mentions : []) {
      const items = Array.isArray(mention?.items) ? mention.items : []
      for (const item of items) {
        if (!item) continue
        if (typeof item.url === 'string') {
          addLink(item.url, { label: item.label || item.summary || '', at, source: 'mention' })
        }
        /* `label` is an absolute path for @orca:, `abs`/`detail` for
           @artifact:, and `path` for @maka: — take whichever is a real one. */
        for (const key of ['path', 'abs', 'detail', 'label']) {
          const value = typeof item[key] === 'string' ? item[key] : ''
          if (value && path.isAbsolute(expandHome(value))) addPath(value, { at, source: 'mention', quoted: true })
        }
      }
    }

    for (const attachment of Array.isArray(message.attachments) ? message.attachments : []) {
      if (attachment?.kind !== 'file') continue
      const value = attachment.path || attachment.value
      if (value) addPath(value, { at, source: 'attachment', quoted: true })
    }

    for (const step of Array.isArray(message.steps) ? message.steps : []) {
      if (!step || typeof step !== 'object') continue
      if (step.type === 'tool_use') {
        for (const value of flattenStrings(step.input)) addText(value, at, 'tool')
      } else if (step.type === 'tool_result') {
        addText(step.content, at, 'tool')
        addText(step.output, at, 'tool')
      } else if (step.type === 'text' || step.type === 'error') {
        addText(step.content, at, 'tool')
      }
    }
  }

  const byRecency = (a, b) => a.order - b.order
  const allLinks = [...links.values()].sort(byRecency)
  const allPaths = [...paths.values()].sort(byRecency)

  return {
    machine: String(machine || 'local'),
    remote,
    scannedAt: nowIso(),
    links: allLinks.slice(0, MAX_LINKS),
    paths: allPaths.slice(0, MAX_PATHS),
    counts: { links: allLinks.length, paths: allPaths.length },
    truncated: allLinks.length > MAX_LINKS || allPaths.length > MAX_PATHS || scanned >= MAX_SCAN_CHARS,
  }
}

/* ── calls ────────────────────────────────────────────────────────── */

/** Read the thread and its entity, then derive the metadata. */
function inspect({ workspace, id } = {}) {
  const workspaces = require('./workspace-store.cjs')
  const chats = require('./chat-store.cjs')
  const entities = require('./entity-store.cjs')

  const record = workspaces.open(workspace)
  const thread = chats.read({ workspace: record.id, id })
  if (!thread) throw new Error('That thread no longer exists.')
  const entity = entities.read(record.id, thread.entity)
  return build({
    thread,
    workspacePath: record.path,
    entityDir: entity?.dir || '',
    machine: thread.machine,
  })
}

/**
 * Act on one path that the metadata lists — never on one the caller invented.
 * The metadata is re-derived by the caller immediately before this runs.
 */
async function performPathAction(metadata, { target, action = 'reveal', handlers = {} } = {}) {
  const wanted = String(target || '')
  const item = (Array.isArray(metadata?.paths) ? metadata.paths : []).find(
    (entry) => entry.path === wanted,
  )
  if (!item) throw new Error('That path is not mentioned in this thread.')
  if (metadata.remote) {
    throw new Error('This thread runs on a remote machine. Copy the path and open it there.')
  }

  let stat
  try {
    stat = fs.statSync(item.path)
  } catch {
    throw new Error('That path no longer exists.')
  }
  const kind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other'

  if (action === 'editor') {
    if (kind !== 'file') throw new Error('VS Code can only open a file.')
    if (typeof handlers.openInEditor !== 'function') {
      throw new Error('Opening an editor is not available in this build.')
    }
    await handlers.openInEditor(item.path)
    return { action, path: item.path, kind }
  }

  if (action !== 'reveal') throw new Error(`Unknown path action "${action}".`)

  if (kind === 'directory') {
    if (typeof handlers.openPath !== 'function') {
      throw new Error('Opening a folder is not available in this build.')
    }
    await handlers.openPath(item.path)
  } else {
    if (typeof handlers.reveal !== 'function') {
      throw new Error('Revealing a file is not available in this build.')
    }
    await handlers.reveal(item.path)
  }
  return { action, path: item.path, kind }
}

/** Only web links are opened; the renderer cannot hand this a file or a shell. */
async function openLink(url, openExternal) {
  const target = String(url || '').trim()
  if (!/^https?:\/\//i.test(target)) throw new Error('Only web links can be opened here.')
  if (typeof openExternal !== 'function') {
    throw new Error('Opening links is not available in this build.')
  }
  await openExternal(target)
  return { url: target }
}

module.exports = {
  build,
  inspect,
  performPathAction,
  openLink,
  /* exported for the unit tests: the parser is the interesting part */
  urlsIn,
  trimUrl,
}
