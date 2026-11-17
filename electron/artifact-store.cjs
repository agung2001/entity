/**
 * Workspace artifacts.
 *
 *   <ws>/artifacts/<relative path>              the workspace shelf — shared
 *   <ws>/.personal/<account>/artifacts/<rel>    your shelf — private
 *
 * A workspace artifact is any file the person or an entity wants to keep
 * outside the conversation: a document, a screenshot, an exported image, a PDF.
 *
 * The split is where the file *is*, not a flag: `/artifacts` is the one tree the
 * export bundle and remote sync carry, and `.personal` is outside `EXPORT_DIRS`,
 * outside the sync manifest's scopes, and its dot path can never pass
 * `safeRel`. So a personal file leaves this machine only when it is shared, and
 * sharing is a rename — one file, one place.
 *
 * The renderer never reads a path. It asks for a listed artifact by id and gets
 * either text or a data URL back, capped at a size that is safe for the window.
 */
const fs = require('node:fs')
const path = require('node:path')
const workspaces = require('./workspace-store.cjs')
const auth = require('./auth-store.cjs')
const { tilde } = require('./frontmatter.cjs')

const DIRNAME = 'artifacts'
/* One hidden root per signed-in account. Nothing that walks the workspace for
   export, sync or chat attribution looks inside it, which is the whole point. */
const PERSONAL_DIRNAME = '.personal'
/* The scope index sits beside the shared files and is hidden, so `walk` never
   lists it. It stamps who shared what — the file's own location already says
   whether it is shared. */
const SCOPE_FILE = '.scope.json'
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

/**
 * The account this window is signed in as. Personal artifacts are keyed by it,
 * so a second account on this machine sees its own shelf and nothing else. A
 * profile with no account is one key (`local`), never "everybody".
 */
function personalKey() {
  const email = String((auth.get() || null)?.email || '').toLowerCase()
  const slug = email
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug || 'local'
}

function personalDir(record) {
  return path.join(record.path, PERSONAL_DIRNAME, personalKey(), DIRNAME)
}

function scopeFile(record) {
  return path.join(artifactsDir(record), SCOPE_FILE)
}

function readScope(record) {
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(scopeFile(record), 'utf8'))
  } catch {
    /* no index yet, or one we cannot read: everything is personal */
  }
  const shared = {}
  if (raw && raw.schema === 1 && raw.shared && typeof raw.shared === 'object') {
    /* The index crosses a machine boundary now that it syncs, so keep only the
       shape this store writes: a peer must not be able to mark every file
       shared or stuff an unbounded string into a shelf row. */
    for (const [id, entry] of Object.entries(raw.shared)) {
      if (!entry || typeof entry !== 'object') continue
      const owner = entry.owner && typeof entry.owner === 'object' ? entry.owner : null
      shared[id] = {
        owner: owner
          ? {
              name: String(owner.name || '').slice(0, 80),
              email: String(owner.email || '').slice(0, 160),
            }
          : null,
        at: String(entry.at || '').slice(0, 40),
      }
    }
  }
  return { schema: 1, shared }
}

function writeScope(record, index) {
  ensureDir(record)
  const file = scopeFile(record)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ schema: 1, shared: index.shared }), 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * Who is asking. The account on this machine names the actor and the workspace
 * record names their role; a name or role sent by the renderer is never read.
 */
function actorFor(record) {
  const user = auth.get() || null
  const owner = record.owner || null
  const members = Array.isArray(record.members) ? record.members : []
  const email = String(user?.email || '').toLowerCase()
  const member = email
    ? members.find((entry) => String(entry.email || '').toLowerCase() === email)
    : null
  const name =
    member?.name ||
    String(user?.username || '').trim() ||
    (email ? email.split('@')[0] : '') ||
    owner?.name ||
    'Someone'
  /* The record's owner is an owner even when the roster has not caught up. */
  const isOwner =
    Boolean(email) &&
    (String(owner?.email || '').toLowerCase() === email || member?.role === 'owner')
  return {
    name,
    email: String(user?.email || owner?.email || ''),
    role: isOwner ? 'owner' : member?.role || (user ? 'member' : 'owner'),
  }
}

function sameActor(left, right) {
  const a = String(left?.email || '').toLowerCase()
  const b = String(right?.email || '').toLowerCase()
  if (a && b) return a === b
  const name = String(left?.name || '').toLowerCase()
  return Boolean(name) && name === String(right?.name || '').toLowerCase()
}

function canUnshare(record, entry) {
  const actor = actorFor(record)
  return sameActor(actor, entry.owner) || actor.role === 'owner' || actor.role === 'admin'
}

function ensureDir(record) {
  const dir = artifactsDir(record)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function ensurePersonal(record) {
  const dir = personalDir(record)
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

/** A rel resolved inside one root, refusing anything that would escape it. */
function fileUnder(root, id) {
  const base = path.resolve(root)
  const file = path.resolve(base, ...safeRelative(id).split('/'))
  if (file !== base && !file.startsWith(`${base}${path.sep}`)) {
    throw new Error('That artifact is outside this workspace.')
  }
  return file
}

/** Where an id actually is: your own shelf first, then the workspace's. */
function locateFile(record, id) {
  const rel = safeRelative(id)
  const roots = [
    { dir: personalDir(record), scope: 'personal' },
    { dir: artifactsDir(record), scope: 'shared' },
  ]
  for (const root of roots) {
    const file = fileUnder(root.dir, rel)
    if (fs.existsSync(file)) return { rel, file, scope: root.scope }
  }
  return null
}

function absolute(record, id) {
  const hit = locateFile(record, id)
  /* An id that is not there yet still needs a path: the workspace shelf is what
     a missing artifact would have been. Callers stat it and report. */
  return hit ? hit.file : fileUnder(artifactsDir(record), id)
}

/** Which root a resolved path belongs to — the scope is the location. */
function scopeOf(record, file) {
  const personal = `${path.resolve(personalDir(record))}${path.sep}`
  return path.resolve(file).startsWith(personal) ? 'personal' : 'shared'
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

/* What a person can *do* with a file besides downloading it. One list, on the
   server, because the same rules decide what the chat card offers and what
   `artifact.open` is allowed to launch. */
const BROWSER_EXT = new Set(['.html', '.htm', '.pdf'])

function capabilitiesFor(name) {
  const ext = path.extname(String(name || '')).toLowerCase()
  const kind = kindFor(name)
  const out = ['reveal']
  if (kind === 'text') out.push('editor')
  if (BROWSER_EXT.has(ext)) out.push('browser')
  return out
}

function metadata(record, rel, stat, index = { shared: {} }, scope = 'shared') {
  const name = path.basename(rel)
  const ext = path.extname(name).toLowerCase()
  const dir = scope === 'personal' ? personalDir(record) : artifactsDir(record)
  const entry = scope === 'shared' ? index.shared?.[rel] : null
  return {
    id: rel,
    name,
    path: tilde(path.join(dir, rel)),
    ext,
    mime: mimeFor(name),
    kind: kindFor(name),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    /* Reveal applies to every file; editor/browser depend on the extension. */
    capabilities: capabilitiesFor(name),
    /* The shelf the file is on is the scope; only shared files carry an owner. */
    scope,
    owner: entry?.owner || null,
  }
}

function walk(record, root, rel, out, index, scope) {
  let entries = []
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= MAX_ITEMS_SCANNED) return
    if (entry.name.startsWith('.')) continue
    const child = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      walk(record, root, child, out, index, scope)
      continue
    }
    if (!entry.isFile()) continue
    let stat
    try {
      stat = fs.statSync(path.join(root, child))
    } catch {
      continue
    }
    out.push(metadata(record, child, stat, index, scope))
  }
}

function list({ workspace } = {}) {
  const record = workspaces.open(workspace)
  const index = readScope(record)
  const rows = []
  walk(record, personalDir(record), '', rows, index, 'personal')
  walk(record, artifactsDir(record), '', rows, index, 'shared')
  /* One id names one file: sharing moves it between the roots, so a duplicate
     can only be a half-finished move. Yours is the one you can see. */
  const seen = new Set()
  const items = rows.filter((row) => (seen.has(row.id) ? false : seen.add(row.id)))
  items.sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)))
  const counts = { personal: 0, shared: 0 }
  for (const item of items) counts[item.scope] += 1
  /* An id whose file is gone is a lie in the counts. Below the walk's cap the
     list is complete, so it can say which entries are stale; above it, a
     missing row may simply be unread — keep the index rather than guess. */
  if (items.length < MAX_ITEMS_SCANNED) {
    const alive = new Set(items.filter((row) => row.scope === 'shared').map((row) => row.id))
    const stale = Object.keys(index.shared).filter((id) => !alive.has(id))
    if (stale.length) {
      for (const id of stale) delete index.shared[id]
      writeScope(record, index)
    }
  }
  return {
    path: tilde(artifactsDir(record)),
    personal: tilde(personalDir(record)),
    count: items.length,
    items,
    counts,
  }
}

/**
 * Put a file on the workspace shelf: a rename out of the personal root, so one
 * file exists in one place and it is the move that puts it on the wire. An id
 * already on the shelf is left alone, so a second share cannot take someone
 * else's file.
 */
function share({ workspace, id } = {}) {
  const record = workspaces.open(workspace)
  const rel = safeRelative(id)
  const index = readScope(record)
  const hit = locateFile(record, rel)
  if (!hit) throw new Error('That artifact no longer exists.')
  const stat = fs.statSync(hit.file)
  if (!stat.isFile()) throw new Error('That artifact is not a file.')
  if (hit.scope === 'shared') return metadata(record, rel, stat, index, 'shared')
  const dest = fileUnder(artifactsDir(record), rel)
  if (fs.existsSync(dest)) {
    throw new Error('A file with that name is already on the workspace shelf.')
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.renameSync(hit.file, dest)
  const actor = actorFor(record)
  index.shared[rel] = {
    owner: { name: actor.name, email: actor.email },
    at: new Date().toISOString(),
  }
  writeScope(record, index)
  return metadata(record, rel, fs.statSync(dest), index, 'shared')
}

/** Move a shared file back to your shelf: the same rename, the other way. */
function unshare({ workspace, id } = {}) {
  const record = workspaces.open(workspace)
  const rel = safeRelative(id)
  const index = readScope(record)
  const entry = index.shared[rel]
  if (entry && !canUnshare(record, entry)) {
    throw new Error("Only the file's owner or a workspace owner/admin can move that file back.")
  }
  const hit = locateFile(record, rel)
  if (!hit) throw new Error('That artifact no longer exists.')
  const stat = fs.statSync(hit.file)
  if (!stat.isFile()) throw new Error('That artifact is not a file.')
  if (hit.scope === 'personal') return metadata(record, rel, stat, index, 'personal')
  const dest = fileUnder(personalDir(record), rel)
  if (fs.existsSync(dest)) {
    throw new Error('You already have a personal file with that name.')
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.renameSync(hit.file, dest)
  if (entry) {
    delete index.shared[rel]
    writeScope(record, index)
  }
  return metadata(record, rel, fs.statSync(dest), index, 'personal')
}

/** Files written since a timestamp, newest first. Used to attach a turn's
 *  output to the chat answer instead of making the person hunt the shelf. */
function recent({ workspace, since, limit = 12 } = {}) {
  const record = workspaces.open(workspace)
  const numeric = Number(since)
  const sinceMs = Number.isFinite(numeric) ? numeric : Date.parse(String(since || ''))
  const items = []
  const seen = new Set()
  for (const [scope, root] of [
    ['personal', personalDir(record)],
    ['shared', artifactsDir(record)],
  ]) {
    const rows = []
    walk(record, root, '', rows, readScope(record), scope)
    for (const row of rows) if (!seen.has(row.id) && seen.add(row.id)) items.push(row)
  }
  const rows = Number.isFinite(sinceMs)
    ? items.filter((item) => {
        const at = Date.parse(item.modifiedAt)
        return Number.isFinite(at) && at >= sinceMs
      })
    : items
  rows.sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)))
  return rows.slice(0, Math.max(0, Math.min(100, Number(limit) || 12)))
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
  const meta = metadata(record, safeRelative(id), stat, readScope(record), scopeOf(record, file))
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
  const meta = metadata(record, safeRelative(id), stat, readScope(record), scopeOf(record, file))
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
  /* An upload is yours until you say otherwise: it lands on your shelf, which
     nothing syncs and nothing exports. */
  const dir = ensurePersonal(record)
  const base = safeFileName(name)
  const target = uniqueName(dir, base)
  const file = path.join(dir, target)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, buffer)
  fs.renameSync(tmp, file)
  return metadata(record, target, fs.statSync(file), readScope(record), 'personal')
}

function saveText({ workspace, name, text } = {}) {
  const record = workspaces.open(workspace)
  const body = String(text || '')
  if (!body.trim()) throw new Error('There is nothing to save.')
  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes > MAX_WRITE_BYTES) throw new Error('That text is larger than 25 MB.')
  const dir = ensurePersonal(record)
  const base = safeFileName(name || 'artifact.md')
  const target = uniqueName(dir, base)
  const file = path.join(dir, target)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, body, 'utf8')
  fs.renameSync(tmp, file)
  return metadata(record, target, fs.statSync(file), readScope(record), 'personal')
}

/**
 * Save an edit back to the artifact it came from. `saveText` always allocates
 * a new name, which is right for a derived chat export but wrong for an editor:
 * a person fixing a typo in `influencer.md` expects that file to change, not a
 * second copy beside it. The id is re-validated here, and only text artifacts
 * are writable — an editor must not overwrite a PNG or a ZIP with prose.
 */
function writeText({ workspace, id, text } = {}) {
  const record = workspaces.open(workspace)
  const rel = safeRelative(id)
  const file = absolute(record, rel)
  let stat
  try {
    /* lstat, not stat: an editor must not follow a link out of the shelf. */
    stat = fs.lstatSync(file)
  } catch {
    throw new Error('That artifact no longer exists.')
  }
  if (stat.isSymbolicLink()) throw new Error('That artifact is a link, not a file.')
  if (!stat.isFile()) throw new Error('That artifact is not a file.')
  const meta = metadata(record, rel, stat, readScope(record), scopeOf(record, file))
  if (meta.kind !== 'text') throw new Error('Only text artifacts can be edited here.')
  const body = String(text ?? '')
  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes > MAX_WRITE_BYTES) throw new Error('That text is larger than 25 MB.')
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, body, 'utf8')
  fs.renameSync(tmp, file)
  return metadata(record, rel, fs.statSync(file), readScope(record), scopeOf(record, file))
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
  /* The index must not keep an id whose file is gone. */
  const rel = safeRelative(id)
  const index = readScope(record)
  if (index.shared[rel]) {
    delete index.shared[rel]
    writeScope(record, index)
  }
  return { id: rel, removed: true }
}

function locate({ workspace, id } = {}) {
  const record = workspaces.open(workspace)
  const rel = safeRelative(id)
  const file = absolute(record, id)
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    throw new Error('That artifact no longer exists.')
  }
  if (!stat.isFile()) throw new Error('That artifact is not a file.')
  return {
    file,
    root: scopeOf(record, file) === 'personal' ? personalDir(record) : artifactsDir(record),
    meta: metadata(record, rel, stat, readScope(record), scopeOf(record, file)),
  }
}

function rootPath({ workspace } = {}) {
  const record = workspaces.open(workspace)
  return { path: tilde(artifactsDir(record)), absolute: artifactsDir(record) }
}

/**
 * The small instruction appended to a harness prompt. Agents can already write
 * files; this tells them where a workspace artifact belongs and how to point
 * the chat at it. It names the personal shelf, because that is where a turn's
 * output lands: private until the person shares it.
 */
function brief(workspace) {
  const record = workspaces.open(workspace)
  const dir = ensurePersonal(record)
  return [
    `Your personal artifacts live in ${dir}.`,
    'When you create a document, image, or screenshot for the user, save it inside that directory — not in /tmp, the workspace root, or a chat message.',
    'Files there stay on this machine and are not synced until the person shares them with the workspace.',
    'Use a filename without spaces (dashes are fine), and in your reply refer to it as artifact://<relative-path> so the chat can show it inline.',
  ].join(' ')
}

module.exports = {
  DIRNAME,
  PERSONAL_DIRNAME,
  artifactsDir,
  personalDir,
  rootPath,
  list,
  share,
  unshare,
  recent,
  read,
  download,
  upload,
  saveText,
  writeText,
  remove,
  locate,
  brief,
  mimeFor,
  kindFor,
  capabilitiesFor,
}
