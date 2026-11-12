/**
 * Harness sessions on this machine, for the Activity page.
 *
 * The app's own threads live under the workspace, but each harness also keeps a
 * session store of its own. Those are the sessions a person can continue in a
 * terminal, so this module reads them — read-only, by cwd — and returns enough
 * for the UI to show a row and copy a resume command.
 *
 * Scope rule: only sessions whose working directory belongs to an entity in the
 * active workspace. A session from another project is not this workspace's
 * activity.
 *
 *   claude   ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
 *   pi       ~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<uuid>.jsonl
 *   codex    ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl
 *   gemini   ~/.gemini/tmp/<project>/chats/session-*.jsonl
 *   opencode ~/.local/share/opencode (SQLite; listed through its own CLI)
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const entities = require('./entity-store.cjs')
const workspaces = require('./workspace-store.cjs')
const { expandHome } = require('./frontmatter.cjs')

const execFileAsync = promisify(execFile)
const HOME = os.homedir()
const MAX_ITEMS = 100
const MAX_HEAD_BYTES = 256 * 1024
const MAX_CODEX_FILES = 1200

const HARNESS_LABELS = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  opencode: 'opencode',
  pi: 'pi',
  gemini: 'Gemini CLI',
}

const RESUME = {
  claude: ['claude', '--resume'],
  codex: ['codex', 'resume'],
  opencode: ['opencode', '--session'],
  pi: ['pi', '--session'],
  gemini: ['gemini', '--resume'],
}

/* ── small readers ────────────────────────────────────────────────── */

function readHead(file, bytes = MAX_HEAD_BYTES) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buffer = Buffer.alloc(bytes)
    const read = fs.readSync(fd, buffer, 0, bytes, 0)
    return buffer.subarray(0, read).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* the read already failed or finished */
      }
    }
  }
}

/** First line only: codex's session_meta line carries a large instruction blob. */
function readFirstLine(file, bytes = MAX_HEAD_BYTES) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const chunks = []
    let total = 0
    const buffer = Buffer.alloc(8192)
    while (total < bytes) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (!read) break
      const chunk = buffer.subarray(0, read)
      const newline = chunk.indexOf(0x0a)
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline))
        break
      }
      chunks.push(Buffer.from(chunk))
      total += read
    }
    return Buffer.concat(chunks).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* nothing left to close */
      }
    }
  }
}

function parseLine(line) {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function linesOf(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
}

function walkText(value, depth = 0) {
  if (depth > 5 || value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value.map((entry) => walkText(entry, depth + 1)).filter(Boolean).join(' ')
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (typeof value.content === 'string') return value.content
    if (Array.isArray(value.content)) return walkText(value.content, depth + 1)
    if (Array.isArray(value.parts)) return walkText(value.parts, depth + 1)
  }
  return ''
}

function cleanPreview(value) {
  let text = String(value || '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, ' ')
    .replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/gi, ' ')
    .replace(/<multi_agent[\s\S]*?<\/multi_agent[a-z_]*>/gi, ' ')
  /* codex and gemini receive the entity instructions prepended as
     `<instructions>\n---\n<prompt>`; the row should show what was asked. */
  if (/^\s*#\s/.test(text) && text.includes('\n---\n')) {
    const parts = text.split('\n---\n')
    text = parts[parts.length - 1]
  }
  text = text.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > 160 ? `${text.slice(0, 159)}…` : text
}

function shellQuote(value) {
  const text = String(value)
  if (process.platform === 'win32') return `"${text.replace(/"/g, '\\"')}"`
  return `'${text.replace(/'/g, `'\\''`)}'`
}

function commandFor(harness, id, dir) {
  const parts = RESUME[harness]
  if (!parts || !id) return ''
  const cd = dir
    ? process.platform === 'win32'
      ? `cd /d ${shellQuote(dir)} && `
      : `cd ${shellQuote(dir)} && `
    : ''
  return `${cd}${parts.join(' ')} ${shellQuote(id)}`
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return 0
  }
}

function iso(value) {
  if (!value) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null
    const date = new Date(value)
    return Number.isFinite(date.getTime()) ? date.toISOString() : null
  }
  return String(value)
}

function safeReal(value) {
  try {
    return fs.realpathSync(String(value))
  } catch {
    return path.resolve(String(value || ''))
  }
}

function listFiles(dir, extension = '.jsonl') {
  try {
    return fs
      .readdirSync(dir)
      .filter((file) => file.endsWith(extension))
      .map((file) => {
        const full = path.join(dir, file)
        return { file: full, mtime: mtimeOf(full) }
      })
      .sort((a, b) => b.mtime - a.mtime)
      .map((entry) => entry.file)
  } catch {
    return []
  }
}

function walkFiles(root, cap = MAX_CODEX_FILES) {
  const out = []
  const stack = [root]
  while (stack.length && out.length < cap) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (out.length >= cap) break
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full)
    }
  }
  return out
}

/* ── workspace scope ──────────────────────────────────────────────── */

function scopeFor(workspace) {
  const record = workspaces.open(workspace)
  const byDir = new Map()
  for (const entity of entities.list(record.id)) {
    if (!entity.dir) continue
    const dir = safeReal(expandHome(entity.dir))
    if (!byDir.has(dir)) byDir.set(dir, [])
    byDir.get(dir).push(entity.name)
  }
  return { record, byDir, dirs: [...byDir.keys()] }
}

/* ── per-harness scanners ─────────────────────────────────────────── */

const claudeProject = (dir) => dir.replace(/[^a-zA-Z0-9]/g, '-')
const piProject = (dir) => `--${dir.replace(/[^a-zA-Z0-9]/g, '-')}--`

function scanClaude(dirs) {
  const items = []
  const root = path.join(HOME, '.claude', 'projects')
  for (const dir of dirs) {
    const files = listFiles(path.join(root, claudeProject(dir))).slice(0, MAX_ITEMS)
    for (const file of files) {
      const text = readHead(file)
      let cwd = ''
      let id = ''
      let startedAt = ''
      let preview = ''
      for (const line of linesOf(text)) {
        const event = parseLine(line)
        if (!event) continue
        if (!cwd && typeof event.cwd === 'string') cwd = event.cwd
        if (!id && typeof event.sessionId === 'string') id = event.sessionId
        if (!startedAt && event.timestamp) startedAt = event.timestamp
        if (!preview && event.type === 'user') {
          const raw = walkText(event.message?.content ?? event.message?.text)
          if (!/^\s*<(environment_context|local-commands|command)/i.test(raw)) {
            preview = cleanPreview(raw)
          }
        }
        if (cwd && id && preview) break
      }
      if (!id) id = path.basename(file, '.jsonl')
      items.push({
        id,
        dir: cwd || dir,
        startedAt: iso(startedAt),
        updatedAt: iso(mtimeOf(file)) || iso(startedAt),
        title: preview,
        preview,
      })
    }
  }
  return items
}

function scanPi(dirs) {
  const items = []
  const root = path.join(HOME, '.pi', 'agent', 'sessions')
  for (const dir of dirs) {
    const files = listFiles(path.join(root, piProject(dir))).slice(0, MAX_ITEMS)
    for (const file of files) {
      const text = readHead(file)
      let cwd = ''
      let id = ''
      let startedAt = ''
      let preview = ''
      for (const line of linesOf(text)) {
        const event = parseLine(line)
        if (!event) continue
        if (event.type === 'session') {
          if (typeof event.id === 'string') id = event.id
          if (typeof event.cwd === 'string') cwd = event.cwd
          if (!startedAt && event.timestamp) startedAt = event.timestamp
        }
        if (!preview && event.type === 'message' && event.message?.role === 'user') {
          const raw = walkText(event.message.content)
          if (raw) preview = cleanPreview(raw)
        }
        if (cwd && id && preview) break
      }
      if (!id) continue
      items.push({
        id,
        dir: cwd || dir,
        startedAt: iso(startedAt),
        updatedAt: iso(mtimeOf(file)) || iso(startedAt),
        title: preview,
        preview,
      })
    }
  }
  return items
}

function scanCodex(dirs) {
  const wanted = new Set(dirs)
  const items = []
  const files = walkFiles(path.join(HOME, '.codex', 'sessions'))
    .map((file) => ({ file, mtime: mtimeOf(file) }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_CODEX_FILES)

  for (const { file } of files) {
    const first = parseLine(readFirstLine(file))
    if (first?.type !== 'session_meta') continue
    const meta = first.payload || {}
    const cwd = typeof meta.cwd === 'string' ? meta.cwd : ''
    const id = String(meta.session_id || meta.id || '')
    if (!cwd || !id || !wanted.has(safeReal(cwd))) continue

    const text = readHead(file)
    let preview = ''
    let startedAt = meta.timestamp || first.timestamp || ''
    for (const line of linesOf(text)) {
      const event = parseLine(line)
      if (!event) continue
      if (event.type !== 'response_item') continue
      const payload = event.payload || {}
      if (payload.type !== 'message' || payload.role !== 'user') continue
      const raw = walkText(payload.content)
      if (!raw || /^\s*<environment_context/i.test(raw)) continue
      const clean = cleanPreview(raw)
      if (clean) {
        preview = clean
        break
      }
    }
    items.push({
      id,
      dir: cwd,
      startedAt: iso(startedAt),
      updatedAt: iso(mtimeOf(file)) || iso(startedAt),
      title: preview,
      preview,
    })
  }
  return items
}

function scanGemini(dirs) {
  const items = []
  const projectsFile = path.join(HOME, '.gemini', 'projects.json')
  let projects = {}
  try {
    projects = JSON.parse(fs.readFileSync(projectsFile, 'utf8'))?.projects || {}
  } catch {
    return items
  }
  const byReal = new Map(Object.entries(projects).map(([cwd, name]) => [safeReal(cwd), name]))

  for (const dir of dirs) {
    const name = byReal.get(dir)
    if (!name) continue
    const files = listFiles(path.join(HOME, '.gemini', 'tmp', name, 'chats')).slice(0, MAX_ITEMS)
    for (const file of files) {
      const text = readHead(file)
      let id = ''
      let startedAt = ''
      let updatedAt = ''
      let preview = ''
      for (const line of linesOf(text)) {
        const event = parseLine(line)
        if (!event) continue
        if (!id && typeof event.sessionId === 'string') id = event.sessionId
        if (!startedAt && event.startTime) startedAt = event.startTime
        if (event.lastUpdated) updatedAt = event.lastUpdated
        if (!preview && event.type === 'user') {
          const raw = walkText(event.content)
          if (raw) preview = cleanPreview(raw)
        }
        if (id && preview) break
      }
      if (!id) continue
      items.push({
        id,
        dir,
        startedAt: iso(startedAt),
        updatedAt: iso(updatedAt) || iso(mtimeOf(file)) || iso(startedAt),
        title: preview,
        preview,
      })
    }
  }
  return items
}

async function scanOpencode(dirs) {
  const items = []
  let note = ''
  for (const dir of dirs) {
    let stdout = ''
    try {
      ;({ stdout } = await execFileAsync(
        'opencode',
        ['session', 'list', '-n', String(MAX_ITEMS), '--format', 'json'],
        { cwd: dir, timeout: 7000, maxBuffer: 3 * 1024 * 1024 },
      ))
    } catch (error) {
      note =
        error?.code === 'ENOENT'
          ? 'opencode is not installed on this machine, or not on PATH.'
          : `opencode could not list its sessions: ${String(error?.message || error)}`
      continue
    }
    let list = []
    try {
      list = JSON.parse(stdout || '[]')
    } catch {
      continue
    }
    for (const entry of Array.isArray(list) ? list : []) {
      const sessionDir = safeReal(entry.directory || dir)
      if (!dirs.includes(sessionDir)) continue
      items.push({
        id: String(entry.id || ''),
        dir: sessionDir,
        startedAt: iso(entry.created),
        updatedAt: iso(entry.updated) || iso(entry.created),
        title: String(entry.title || ''),
        preview: String(entry.title || ''),
      })
    }
  }
  return { items, note }
}

/* ── public ───────────────────────────────────────────────────────── */

function dedupe(items) {
  const seen = new Set()
  return items.filter((item) => {
    if (!item.id) return false
    const key = `${item.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function list({ workspace, harness } = {}) {
  const wanted = String(harness || '')
  const label = HARNESS_LABELS[wanted]
  if (!label) return { harness: wanted, items: [], count: 0, note: 'Unknown harness.' }
  if (!workspace) return { harness: wanted, label, items: [], count: 0, note: 'No workspace is open.' }

  const { byDir, dirs } = scopeFor(workspace)
  if (!dirs.length) {
    return {
      harness: wanted,
      label,
      items: [],
      count: 0,
      note: 'This workspace has no entity with a working directory yet.',
    }
  }

  let items = []
  let note = ''
  if (wanted === 'claude') items = scanClaude(dirs)
  else if (wanted === 'pi') items = scanPi(dirs)
  else if (wanted === 'codex') items = scanCodex(dirs)
  else if (wanted === 'gemini') items = scanGemini(dirs)
  else if (wanted === 'opencode') ({ items, note } = await scanOpencode(dirs))

  items = dedupe(items)
    .map((item) => ({
      ...item,
      harness: wanted,
      harnessLabel: label,
      entities: byDir.get(safeReal(item.dir)) || [],
      resumeCommand: commandFor(wanted, item.id, item.dir),
    }))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))

  return {
    harness: wanted,
    label,
    items: items.slice(0, MAX_ITEMS),
    count: items.length,
    note,
  }
}

module.exports = { HARNESS_LABELS, list }
