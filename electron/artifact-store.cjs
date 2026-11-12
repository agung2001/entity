/**
 * Workspace artifacts.
 *
 *   <ws>/artifacts/<relative path>
 *
 * A workspace artifact is any file the person or an entity wants to keep
 * outside the conversation: a document, a screenshot, an exported image, a PDF.
 * It lives beside the workspace's entities and chats, so it moves with the
 * workspace and is included in its export bundle. No database.
 *
 * The renderer never reads a path. It asks for a listed artifact by id and gets
 * either text or a data URL back, capped at a size that is safe for the window.
 */
const fs = require('node:fs')
const path = require('node:path')
const workspaces = require('./workspace-store.cjs')
const { tilde } = require('./frontmatter.cjs')

const DIRNAME = 'artifacts'
const MAX_WRITE_BYTES = 25 * 1024 * 1024
const MAX_READ_BYTES = 25 * 1024 * 1024
const MAX_TEXT_CHARS = 400_000
const MAX_ITEMS_SCANNED = 4_000

const MIME = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.csv': 'text/csv',
  '.log': 'text/plain',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.jsx': 'text/javascript',
  '.py': 'text/x-python',
  '.sh': 'text/x-shellscript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.svg'])
const TEXT_EXT = new Set([
  '.md',
  '.txt',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.csv',
  '.log',
  '.html',
  '.css',
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.sh',
])

function artifactsDir(record) {
  return path.join(record.path, DIRNAME)
}

function ensureDir(record) {
  const dir = artifactsDir(record)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function mimeFor(name) {
  return MIME[path.extname(String(name || '')).toLowerCase()] || 'application/octet-stream'
}

function kindFor(name) {
  const ext = path.extname(String(name || '')).toLowerCase()
  if (IMAGE_EXT.has(ext)) return 'image'
  if (TEXT_EXT.has(ext) || mimeFor(name).startsWith('text/')) return 'text'
  if (ext === '.pdf') return 'pdf'
  if (ext === '.zip') return 'archive'
  if (mimeFor(name).startsWith('audio/')) return 'audio'
  if (mimeFor(name).startsWith('video/')) return 'video'
  return 'file'
}

/** A relative artifact id is a posix path below `<ws>/artifacts`. */
function safeRelative(value) {
  const rel = String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
  const parts = rel.split('/').filter(Boolean)
  if (!parts.length || parts.some((part) => part === '..' || part === '.' || part.includes('\0'))) {
    throw new Error('That is not an artifact id.')
  }
  return parts.join('/')
}

function absolute(record, id) {
  const rel = safeRelative(id)
  const root = path.resolve(artifactsDir(record))
  const file = path.resolve(root, ...rel.split('/'))
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
    throw new Error('That artifact is outside this workspace.')
  }
  return file
}

function safeFileName(value, fallback = 'artifact') {
  const base = path
    .basename(String(value || fallback))
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/^[.\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return base || fallback
}

function uniqueName(dir, name) {
  const ext = path.extname(name)
  const stem = path.basename(name, ext)
  let candidate = name
  let n = 2
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem}-${n}${ext}`
    n += 1
    if (n > 10_000) throw new Error('Could not find a free artifact name.')
  }
  return candidate
}

function metadata(record, rel, stat) {
  const name = path.basename(rel)
  const ext = path.extname(name).toLowerCase()
  return {
    id: rel,
    name,
    path: tilde(path.join(artifactsDir(record), rel)),
    ext,
    mime: mimeFor(name),
    kind: kindFor(name),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  }
}

function walk(record, rel, out) {
  let entries = []
  try {
    entries = fs.readdirSync(path.join(artifactsDir(record), rel), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= MAX_ITEMS_SCANNED) return
    if (entry.name.startsWith('.')) continue
    const child = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      walk(record, child, out)
      continue
    }
    if (!entry.isFile()) continue
    let stat
    try {
      stat = fs.statSync(path.join(artifactsDir(record), child))
    } catch {
      continue
    }
    out.push(metadata(record, child, stat))
  }
}

function list({ workspace } = {}) {
  const record = workspaces.open(workspace)
  const items = []
  walk(record, '', items)
  items.sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)))
  return {
    path: tilde(artifactsDir(record)),
    count: items.length,
    items,
  }
}

function read({ workspace, id } = {}) {
  const record = workspaces.open(workspace)
  const file = absolute(record, id)
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    throw new Error('That artifact no longer exists.')
  }
  if (!stat.isFile()) throw new Error('That artifact is not a file.')
  if (stat.size > MAX_READ_BYTES) throw new Error('That artifact is too large to preview here.')
  const buffer = fs.readFileSync(file)
  const meta = metadata(record, safeRelative(id), stat)
  if (meta.kind === 'text') {
    const text = buffer.toString('utf8')
    return {
      ...meta,
      text: text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n… (truncated)` : text,
      truncated: text.length > MAX_TEXT_CHARS,
    }
  }
  return {
    ...meta,
    dataUrl: `data:${meta.mime};base64,${buffer.toString('base64')}`,
  }
}

function download({ workspace, id } = {}) {
  const record = workspaces.open(workspace)
  const file = absolute(record, id)
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    throw new Error('That artifact no longer exists.')
  }
  if (!stat.isFile()) throw new Error('That artifact is not a file.')
  if (stat.size > MAX_READ_BYTES) throw new Error('That artifact is too large to download here.')
  const meta = metadata(record, safeRelative(id), stat)
  return {
    ...meta,
    dataUrl: `data:${meta.mime};base64,${fs.readFileSync(file).toString('base64')}`,
  }
}

function decodeDataUrl(dataUrl) {
  const text = String(dataUrl || '')
  const match = text.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/)
  if (!match) throw new Error('Expected a data URL.')
  const mime = match[1] || 'application/octet-stream'
  if (!match[2]) throw new Error('Only base64 data URLs can be uploaded.')
  const buffer = Buffer.from(match[3], 'base64')
  if (!buffer.length) throw new Error('That file is empty.')
  if (buffer.length > MAX_WRITE_BYTES) throw new Error('That file is larger than 25 MB.')
  return { mime, buffer }
}

function upload({ workspace, name, dataUrl } = {}) {
  const record = workspaces.open(workspace)
  const { buffer } = decodeDataUrl(dataUrl)
  const dir = ensureDir(record)
  const base = safeFileName(name)
  const target = uniqueName(dir, base)
  const file = path.join(dir, target)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, buffer)
  fs.renameSync(tmp, file)
  return metadata(record, target, fs.statSync(file))
}

function saveText({ workspace, name, text } = {}) {
  const record = workspaces.open(workspace)
  const body = String(text || '')
  if (!body.trim()) throw new Error('There is nothing to save.')
  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes > MAX_WRITE_BYTES) throw new Error('That text is larger than 25 MB.')
  const dir = ensureDir(record)
  const base = safeFileName(name || 'artifact.md')
  const target = uniqueName(dir, base)
  const file = path.join(dir, target)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, body, 'utf8')
  fs.renameSync(tmp, file)
  return metadata(record, target, fs.statSync(file))
}

function remove({ workspace, id } = {}) {
  const record = workspaces.open(workspace)
  const file = absolute(record, id)
  let stat
  try {
    stat = fs.lstatSync(file)
  } catch {
    return { id: safeRelative(id), removed: false }
  }
  if (!stat.isFile()) throw new Error('That artifact is not a regular file.')
  fs.rmSync(file, { force: true })
  return { id: safeRelative(id), removed: true }
}

function locate({ workspace, id } = {}) {
  const record = workspaces.open(workspace)
  const file = absolute(record, id)
  if (!fs.existsSync(file)) throw new Error('That artifact no longer exists.')
  return { file, root: artifactsDir(record) }
}

function rootPath({ workspace } = {}) {
  const record = workspaces.open(workspace)
  return { path: tilde(artifactsDir(record)), absolute: artifactsDir(record) }
}

/**
 * The small instruction appended to a harness prompt. Agents can already write
 * files; this tells them where a workspace artifact belongs and how to point
 * the chat at it.
 */
function brief(workspace) {
  const record = workspaces.open(workspace)
  const dir = ensureDir(record)
  return [
    `Workspace artifacts live in ${dir}.`,
    'When you create a document, image, or screenshot for the user, save it there.',
    'Use a filename without spaces (dashes are fine), and in your reply refer to it as artifact://<relative-path> so the chat can show it.',
  ].join(' ')
}

module.exports = {
  DIRNAME,
  artifactsDir,
  rootPath,
  list,
  read,
  download,
  upload,
  saveText,
  remove,
  locate,
  brief,
  mimeFor,
  kindFor,
}
