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
/* Which session wrote a file. `artifacts/` is one tree for the whole workspace,
   but a file is still produced *by a turn*, and reading that back out of clocks
   and folder shapes is a guess. This index records the answer once, when the
   turn ends, so a later read does not have to infer it again — and so a second
   conversation running at the same time cannot claim it. */
const ORIGIN_FILE = '.origin.json'
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

/* ── which session wrote a file ─────────────────────────────────────
 * `<id> → <threadId>`, local to this machine: a thread id means nothing on a
 * clone, and the sibling that owns the file has its own index. It is a dot
 * file, so `walk` never lists it and `manifest.safeRel` never carries it — the
 * shared shelf stays exactly what it was on the wire.
 */
function originFile(record) {
  return path.join(artifactsDir(record), ORIGIN_FILE)
}

const THREAD_ID = /^[a-z0-9][a-z0-9_-]{0,80}$/i

/** A map is data from disk: keep only the shape this store writes. */
function readOrigins(record) {
  const out = {}
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(originFile(record), 'utf8'))
  } catch {
    return out
  }
  if (!raw || raw.schema !== 1 || !raw.threads || typeof raw.threads !== 'object') return out
  for (const [id, threadId] of Object.entries(raw.threads)) {
    let rel = ''
    try {
      rel = safeRelative(id)
    } catch {
      continue
    }
    if (typeof threadId === 'string' && THREAD_ID.test(threadId)) out[rel] = threadId
  }
  return out
}

function writeOrigins(record, origins) {
  ensureDir(record)
  const file = originFile(record)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify({ schema: 1, threads: origins })}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * Record the files one turn produced. Called when the turn ends, from the store
 * that already decided ownership from the transcript — the only place that has
 * evidence. An id written by a different thread is left alone: the turn that
 * created a file owns it, and a revise is not a change of author.
 */
function stampOrigins({ workspace, threadId, ids } = {}) {
  const id = String(threadId || '')
  if (!THREAD_ID.test(id)) throw new Error('That is not a thread id.')
  const record = workspaces.open(workspace)
  const origins = readOrigins(record)
  const touched = []
  for (const value of Array.isArray(ids) ? ids : []) {
    let rel = ''
    try {
      rel = safeRelative(value)
    } catch {
      continue
    }
    if (origins[rel] && origins[rel] !== id) continue
    if (origins[rel] === id) continue
    origins[rel] = id
    touched.push(rel)
  }
  if (touched.length) writeOrigins(record, origins)
  return touched
}

/** `<id> → <threadId>` for this machine, or `{}` before any turn has stamped. */
function origins({ workspace } = {}) {
  return readOrigins(workspaces.open(workspace))
}

/** Forget ids that are gone, and ids stamped for a thread nobody knows. */
function pruneOrigins(record, origins, alive) {
  let changed = false
  for (const id of Object.keys(origins)) {
    if (!alive(id)) {
      delete origins[id]
      changed = true
    }
  }
  if (changed) writeOrigins(record, origins)
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
  const local = scope === 'personal' || scope === 'unclaimed'
  const dir = local ? personalDir(record) : artifactsDir(record)
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
    /* The shelf the file is *on* is the scope. A file found in the shared tree
       with no owner in the index is `unclaimed`: present, not published, and
       carried by nothing until someone shares it. */
    scope: scope === 'unclaimed' ? 'personal' : scope,
    unclaimed: scope === 'unclaimed',
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
    /* `conflicts/` is the sync engine's copy of a file that disagreed, not
       something a person made. `chat-store` already refuses to attribute it and
       `adoptUnclaimed` refuses to move it, so it must not appear as a row on a
       shelf either — 391 of them read as the owner's own files. */
    if (!rel && entry.isDirectory() && entry.name === CONFLICTS_DIR) continue
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
    /* A file in the shared tree that the index does not know was never shared —
       it was written there (an agent's screenshot, a hand-run script). Reporting
       it as shared is the leak this rule exists to stop, so it is reported as
       the person's own until they actually share it. */
    const claimed = scope !== 'shared' || Boolean(index.shared?.[child])
    out.push(metadata(record, child, stat, index, claimed ? scope : 'unclaimed'))
  }
}

/**
 * Take back the files that were never shared.
 *
 * The shared tree is what an export bundle and remote sync carry, and it used to
 * be filled two ways: by `share()` (a rename, and an entry in the index) and by
 * anything that wrote a path under `artifacts/` — an agent told to leave a
 * screenshot on "the workspace artifact shelf", a script, a hand-run command.
 * Those files were never shared by anyone, but `list()` called them Shared
 * because of where they sat, which put them in front of a colleague on the next
 * sync.
 *
 * So the shelf stops guessing. A file in the shared tree with no owner in the
 * index is moved into the personal root, where every other unshared file lives,
 * and nothing is carried until someone shares it. The move is a rename, so one
 * file still exists in one place.
 *
 * Idempotent and never destructive:
 *   - a name that already exists on the personal shelf is kept as `<name>-2`, so
 *     neither copy is lost to the other;
 *   - the whole tree is walked, not the top level, so a screenshot in
 *     `artifacts/screenshots/entity-41/` is adopted with its path;
 *   - a failure on one file is recorded and the rest still move.
 */
/* The sync engine's own record of a file that disagreed. It lives under the
   shared tree so a person can find it, but it is evidence about a file rather
   than a file anybody made: not a shelf row, not an adoption, not content. */
const CONFLICTS_DIR = 'conflicts'
const ADOPT_SKIP = new Set([CONFLICTS_DIR])

function adoptUnclaimed(record, { index = readScope(record) } = {}) {
  const root = artifactsDir(record)
  const adopted = []
  const failed = []
  const claimed = new Set(Object.keys(index.shared || {}))

  const visit = (rel) => {
    let entries = []
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      /* `conflicts/` is the sync engine's own record of a disagreement: it is
         evidence about a file, not a file a person made, and moving it would
         destroy the record of what went wrong. */
      if (!rel && ADOPT_SKIP.has(entry.name)) continue
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        visit(child)
        continue
      }
      if (entry.isFile() && !claimed.has(child)) adoptOne(child)
    }
  }

  visit('')

  function adoptOne(rel) {
    const source = fileUnder(root, rel)
    const home = personalDir(record)
    try {
      const dir = path.posix.dirname(rel)
      const relDir = dir === '.' ? '' : dir
      fs.mkdirSync(path.join(home, relDir), { recursive: true })
      /* `uniqueName` on the personal side: a same-named file the person already
         has is theirs, and neither copy may overwrite the other. */
      const name = uniqueName(path.join(home, relDir), path.basename(rel))
      const dest = fileUnder(home, relDir ? `${relDir}/${name}` : name)
      fs.renameSync(source, dest)
      adopted.push({ from: rel, to: relDir ? `${relDir}/${name}` : name })
    } catch (error) {
      failed.push({ id: rel, reason: String(error?.message || error).slice(0, 200) })
    }
  }

  return { adopted, failed }
}

function list({ workspace } = {}) {
  const record = workspaces.open(workspace)
  const index = readScope(record)
  const origins = readOrigins(record)
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
    /* An origin naming a file that is gone is the same lie in the other index. */
    const present = new Set(items.map((row) => row.id))
    pruneOrigins(record, origins, (id) => present.has(id))
  }
  return {
    path: tilde(artifactsDir(record)),
    personal: tilde(personalDir(record)),
    count: items.length,
    items,
    counts,
    /* Present but not published: files sitting in the shared tree that no share
       ever claimed. They read as personal (see `walk`) and the sync manifest
       refuses to carry them (see `remote-manifest`'s `claimed` scope). */
    unclaimed: items.filter((item) => item.unclaimed).length,
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

/* ── when a file was last opened ─────────────────────────────────────
 * The shelf's age rule counts from the last time a person looked at the file,
 * which is not its modification time: a March screenshot reviewed last week is
 * not a March file. One small map beside the files records it, and the walk
 * skips dot entries, so it never appears as an artifact itself.
 *
 * ponytail: the whole map is rewritten on every open — one small write per read.
 * The shelf can afford that at thousands of files; if a profile ever says
 * otherwise, fold the map into an `.index.json` and append rather than rewrite.
 */
const OPENED = '.opened.json'

function openedFile(record) {
  return path.join(artifactsDir(record), OPENED)
}

function readOpened(record) {
  try {
    const raw = JSON.parse(fs.readFileSync(openedFile(record), 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

/** `<id> → ISO` for every file this machine has opened. */
function openedMap({ workspace } = {}) {
  return readOpened(workspaces.open(workspace))
}

/** Stamp one id as opened now. A shelf that cannot be written is still readable. */
function touchOpened(record, rel) {
  try {
    const map = readOpened(record)
    map[rel] = new Date().toISOString()
    const file = openedFile(record)
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(map)}\n`, 'utf8')
    fs.renameSync(tmp, file)
  } catch {
    /* the age rule falls back to the file's own mtime */
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
  const meta = metadata(record, safeRelative(id), stat, readScope(record), scopeOf(record, file))
  touchOpened(record, meta.id)
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
  touchOpened(record, meta.id)
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
  const origins = readOrigins(record)
  if (origins[rel]) {
    delete origins[rel]
    writeOrigins(record, origins)
  }
  return { id: rel, removed: true }
}

/**
 * Erase a workspace's artifacts (settings → Artifacts → Erase all).
 *
 * Three populations, because the card draws three and a single button that
 * removed all of them would not say which half a person meant:
 *
 *   - `shared` — `artifacts/`, its `.archive/` and its `.trash/`, plus the two
 *     dot indexes that describe it (`.scope.json`, `.opened.json`). The sweep's
 *     folders are dot folders the shelf walk skips, so a "erase the shelf" that
 *     only listed the visible files would leave every archived and deleted file
 *     on the disk — the half-truth this button must not be.
 *   - `personal` — this window's own shelf, `.personal/<account>/artifacts/`. It
 *     syncs nowhere, and it is the only personal shelf the app ever lists, so it
 *     is also the only one a button here may remove: another account's folder is
 *     never on this screen, and erasing what the person cannot see is not what
 *     "erase personal" says.
 *   - `all` — both of those.
 *
 * A scope the store does not know is an error, never a silent `all`.
 */
const ERASE_SCOPES = ['shared', 'personal', 'all']

function eraseAll({ workspace, scope = 'all' } = {}) {
  const record = workspaces.open(workspace)
  const wanted = String(scope || 'all')
  if (!ERASE_SCOPES.includes(wanted)) {
    throw new Error(`Erase scope must be one of ${ERASE_SCOPES.join(', ')}.`)
  }
  const roots = []
  if (wanted === 'shared' || wanted === 'all') roots.push(artifactsDir(record))
  if (wanted === 'personal' || wanted === 'all') roots.push(personalDir(record))
  let removed = 0
  let bytes = 0

  const walkAndRemove = (dir) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      /* A link is never followed: erasing it must not reach outside the shelf. */
      if (entry.isSymbolicLink()) {
        fs.rmSync(full, { force: true })
        continue
      }
      if (entry.isDirectory()) {
        walkAndRemove(full)
        continue
      }
      if (!entry.isFile()) continue
      try {
        bytes += fs.statSync(full).size
      } catch {
        /* a file that vanished mid-walk costs a byte count, never the erase */
      }
      fs.rmSync(full, { force: true })
      removed += 1
    }
    /* the folder itself goes when it is empty; `force` keeps a race harmless */
    try {
      if (!fs.readdirSync(dir).length) fs.rmdirSync(dir)
    } catch {
      /* busy or already gone */
    }
  }

  for (const root of roots) walkAndRemove(root)
  if (wanted !== 'personal') {
    /* An emptied shelf starts from an empty index, not from one naming files that
       are gone. `ensureDir` is what `list` and `upload` expect to find. */
    ensureDir(record)
    writeScope(record, { schema: 1, shared: {} })
  }
  /* The origin index is the third thing that names those files, and it is the
     one that decides a later read — so it is pruned against what actually
     survived, not against the scope word. Erasing only the personal shelf leaves
     the shared one standing (`scope: personal`), and clearing the whole map there
     would unattach files that are still there; leaving a dead id would hand a new
     file of the same name to an old thread. */
  const survivors = new Set()
  for (const root of [personalDir(record), artifactsDir(record)]) {
    const rows = []
    walk(record, root, '', rows, { shared: {} }, 'personal')
    for (const row of rows) survivors.add(row.id)
  }
  const origins = readOrigins(record)
  pruneOrigins(record, origins, (id) => survivors.has(id))
  return { scope: wanted, removed, bytes }
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
  /* Reveal, editor and browser all pass through here, so this is the one place
     that knows a person just opened the file. */
  touchOpened(record, rel)
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
    /* The sibling `<ws>/artifacts/` is the *shared* tree: writing there
       publishes a file to every teammate on the next sync, which is the leak
       this brief is one half of. Name the difference rather than assuming a
       harness reads "personal" as a path it must construct. */
    `The directory beside it, ${path.join(record.path, DIRNAME)}, is the workspace's SHARED shelf: never write there. A file only belongs there when the person shares it themselves.`,
    'Files in your directory stay on this machine and are not synced until the person shares them.',
    'Use a filename without spaces (dashes are fine), and in your reply refer to it as artifact://<relative-path> so the chat can show it inline.',
  ].join(' ')
}

module.exports = {
  DIRNAME,
  PERSONAL_DIRNAME,
  adoptUnclaimed,
  artifactsDir,
  personalDir,
  rootPath,
  list,
  share,
  unshare,
  recent,
  openedMap,
  read,
  download,
  upload,
  saveText,
  writeText,
  remove,
  eraseAll,
  ERASE_SCOPES,
  locate,
  origins,
  stampOrigins,
  brief,
  mimeFor,
  kindFor,
  capabilitiesFor,
}
