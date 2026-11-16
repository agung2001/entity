/**
 * The content-addressed view of a workspace that remote sync exchanges.
 *
 * One module, three callers: the local sync engine (`remote-sync.cjs`), the
 * server's sync routes (`server/sync.cjs`) and their tests. Nothing here trusts
 * a caller with a path: every path is normalised, scoped, and re-checked
 * against the workspace root before it is read or written.
 *
 * Real files live under `entities/`, `artifacts/` and `skills/`. A skill that
 * is a symlink into a harness library is skipped by the walk (the target is
 * machine-local); a workspace-owned skill directory is synced like any other
 * file, because its body lives in this workspace. Three *virtual* entries
 * describe the parts of a workspace that are configuration rather than files:
 *
 *   workspace.json   label, context, mcpStrict, members   (never id or path)
 *   mcp.json         enabled servers only, secrets replaced by "***"
 *   skills.json      attached skill names + harness      (the roster, not bodies)
 *
 * Secrets are redacted on purpose. A MCP server definition can carry an API key
 * in `env` or `headers`; copying that between machines (or into a server log)
 * is a credential leak, not a sync feature. The definitions still travel, so a
 * teammate gets a working shape and supplies the value locally.
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const SCOPES = ['entities', 'artifacts', 'skills']
const VIRTUAL = ['workspace.json', 'mcp.json', 'skills.json']
const MAX_FILE_BYTES = 25 * 1024 * 1024
const MAX_FILES = 20_000
const REDACTED = '***'

/** `a/b/c.md` → `a/b/c.md`; anything that could escape the root → null. */
function safeRel(value) {
  let rel = String(value || '').replace(/\\/g, '/')
  try {
    rel = decodeURIComponent(rel)
  } catch {
    return null
  }
  if (rel.startsWith('/')) return null
  if (rel.includes('\0')) return null
  const parts = rel.split('/').filter(Boolean)
  if (!parts.length) return null
  if (parts.some((part) => part === '.' || part === '..')) return null
  if (parts.some((part) => part.startsWith('.'))) return null
  if (parts.length > 32) return null
  const joined = parts.join('/')
  if (joined.length > 1024) return null
  if (/[\u0000-\u001f\u007f]/.test(joined)) return null
  /* Keep the shared scope portable: these names cannot be written on Windows. */
  if (/[<>:"|?*]/.test(joined)) return null
  if (VIRTUAL.includes(joined)) return joined
  if (!SCOPES.includes(parts[0])) return null
  if (parts.length < 2) return null
  return joined
}

function isVirtual(rel) {
  return VIRTUAL.includes(String(rel || ''))
}

function absoluteFor(root, rel) {
  const safe = safeRel(rel)
  if (!safe || isVirtual(safe)) throw new Error('That path is not a syncable file.')
  const resolvedRoot = path.resolve(root)
  const file = path.resolve(resolvedRoot, ...safe.split('/'))
  if (file !== resolvedRoot && !file.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('That path is outside this workspace.')
  }
  return file
}

/** sha256 of one file, streamed so a large artifact does not become a Buffer. */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

/**
 * Content hash with a per-process stat cache. A poll every six hours must not
 * re-read every artifact; a file whose mtime, ctime and size are unchanged has
 * the same bytes unless something is deliberately lying about time, and the
 * server recomputes its own side anyway.
 */
const hashCache = new Map()

async function hashFileCached(file, stat) {
  const key = path.resolve(file)
  const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
  const hit = hashCache.get(key)
  if (hit && hit.stamp === stamp) return hit.sha256
  const digest = await hashFile(file)
  hashCache.set(key, { stamp, sha256: digest })
  return digest
}

function sortMembers(members) {
  return (Array.isArray(members) ? members : [])
    .filter((entry) => entry && (entry.email || entry.name))
    .map((entry) => ({
      name: String(entry.name || entry.email || '').trim(),
      email: String(entry.email || '').trim(),
      role: ['owner', 'admin', 'member'].includes(entry.role) ? entry.role : 'member',
    }))
    .sort((a, b) => `${a.email}|${a.name}`.localeCompare(`${b.email}|${b.name}`))
}

function normaliseOwner(owner) {
  if (!owner || typeof owner !== 'object') return null
  const email = String(owner.email || '').trim()
  const name = String(owner.name || '').trim()
  if (!email && !name) return null
  return { name, email }
}

/** The part of workspace.json that is shared. `id` stays machine-local. */
function canonicalMeta(record, extra = {}) {
  return {
    label: String(record?.label || ''),
    context: String(record?.context ?? extra.context ?? ''),
    mcpStrict: (record?.mcpStrict ?? extra.mcpStrict) !== false,
    owner: normaliseOwner(record?.owner ?? extra.owner),
    members: sortMembers(record?.members ?? extra.members),
  }
}

/**
 * `servers` is the enabled pool. `disabled` normally stays local, but a server
 * that arrived from the server and was quarantined here is still part of the
 * shared set — otherwise every sync would push a set that is missing it and the
 * server's union-merge would hand it back forever.
 */
function sanitizeMcp(raw) {
  const servers = raw?.servers && typeof raw.servers === 'object' ? { ...raw.servers } : {}
  const parked = raw?.disabled && typeof raw.disabled === 'object' ? raw.disabled : {}
  for (const [name, entry] of Object.entries(parked)) {
    if (entry && entry.__remote && !servers[name]) servers[name] = entry
  }
  const out = {}
  for (const name of Object.keys(servers).sort()) {
    const entry = servers[name]
    if (!entry || typeof entry !== 'object') continue
    const clean = {}
    if (entry.command) clean.command = String(entry.command)
    if (Array.isArray(entry.args)) clean.args = entry.args.map(String)
    if (entry.url) clean.url = String(entry.url)
    if (entry.transport) clean.transport = String(entry.transport)
    if (entry.env && typeof entry.env === 'object') {
      clean.env = Array.isArray(entry.env)
        ? entry.env.map(String)
        : Object.fromEntries(Object.keys(entry.env).sort().map((key) => [key, REDACTED]))
    }
    if (entry.headers && typeof entry.headers === 'object') {
      clean.headers = Object.fromEntries(
        Object.keys(entry.headers).sort().map((key) => [key, REDACTED]),
      )
    }
    if (!clean.command && !clean.url) continue
    out[name] = clean
  }
  return { schema: 1, servers: out }
}

/**
 * Merge a remote MCP definition over a local one without destroying secrets.
 * `***` means "the shared copy redacted this value"; the local value wins.
 * Keys that exist locally but not in the shared definition are kept, because
 * they are usually credentials the other side never had.
 */
function mergeServer(local, remote) {
  const out = { ...remote }
  if (remote.env && local?.env && !Array.isArray(remote.env) && !Array.isArray(local.env)) {
    const env = { ...remote.env }
    for (const [key, value] of Object.entries(env)) {
      if (value === REDACTED && local.env[key]) env[key] = local.env[key]
    }
    for (const [key, value] of Object.entries(local.env)) {
      if (!(key in env)) env[key] = value
    }
    out.env = env
  }
  if (remote.headers && local?.headers) {
    const headers = { ...remote.headers }
    for (const [key, value] of Object.entries(headers)) {
      if (value === REDACTED && local.headers[key]) headers[key] = local.headers[key]
    }
    for (const [key, value] of Object.entries(local.headers)) {
      if (!(key in headers)) headers[key] = value
    }
    out.headers = headers
  }
  if ((!remote.command || remote.command === REDACTED) && local?.command) {
    out.command = local.command
  }
  if ((!remote.url || remote.url === REDACTED) && local?.url) out.url = local.url
  return out
}

function normaliseSkills(skills) {
  const seen = new Map()
  for (const entry of Array.isArray(skills) ? skills : []) {
    const name = typeof entry === 'string' ? entry : entry?.name
    if (!name) continue
    const harness = typeof entry === 'string' ? '' : String(entry?.harness || '')
    seen.set(String(name).toLowerCase(), { name: String(name), harness })
  }
  return [...seen.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 5000)
}

function virtualBuffers(record, skills, mcpRaw) {
  return {
    'workspace.json': Buffer.from(
      `${JSON.stringify(canonicalMeta(record), null, 2)}\n`,
      'utf8',
    ),
    'mcp.json': Buffer.from(`${JSON.stringify(sanitizeMcp(mcpRaw), null, 2)}\n`, 'utf8'),
    'skills.json': Buffer.from(
      `${JSON.stringify({ schema: 1, skills: normaliseSkills(skills) }, null, 2)}\n`,
      'utf8',
    ),
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * Attached skills are symlinks (or, on a filesystem without links, copies) in
 * `<ws>/skills`. Only the name is shared; the body belongs to the machine's
 * harness library and is re-linked on the far side when it exists there.
 */
function readAttachedSkills(dir) {
  let entries = []
  try {
    entries = fs.readdirSync(path.join(dir, 'skills'), { withFileTypes: true })
  } catch {
    return []
  }
  return normaliseSkills(
    entries
      .filter((entry) => entry.isSymbolicLink() || entry.isDirectory())
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => ({ name: entry.name, harness: '' })),
  )
}

/**
 * Walk the sync scopes and return the manifest. Dotfiles are skipped
 * (`.remote.json` is sync state, not content) and files above the cap are
 * reported as skipped rather than silently dropped.
 *
 * `skills/` is special: a skill attached from a harness library is a symlink
 * (`<ws>/skills/<name> -> ~/.pi/agent/skills/<name>`). A team clone must get the
 * real files, not a link that only works on the author's machine, so the walker
 * dereferences a top-level skill link and records its contents under the same
 * `skills/<name>/…` paths. Nested links are still skipped: a link inside a skill
 * can point anywhere, and the skill itself is the unit that was attached.
 */
function skillTarget(file) {
  try {
    const stat = fs.statSync(file)
    if (stat.isDirectory()) {
      return fs.existsSync(path.join(file, 'SKILL.md')) ? { stat, directory: true } : null
    }
    if (stat.isFile() && file.toLowerCase().endsWith('.md')) return { stat, directory: false }
  } catch {
    /* broken link */
  }
  return null
}

async function recordFile(full, rel, stat, files, skipped) {
  if (stat.size > MAX_FILE_BYTES) {
    skipped.push(`${rel}: ${stat.size} bytes is over the per-file sync cap`)
    return
  }
  let digest
  try {
    digest = await hashFileCached(full, stat)
  } catch {
    skipped.push(`${rel}: unreadable`)
    return
  }
  files.set(rel, {
    path: rel,
    sha256: digest,
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
    /* A workspace-owned skill may ship a runnable script. Preserve only the
       execute bits, never setuid/setgid or group/world write. */
    executable: (stat.mode & 0o111) !== 0,
    virtual: false,
  })
}

/**
 * `base` is the directory on disk, `diskRel` is where to read under it, and
 * `manifestRel` is the path the file will have in the manifest. They differ for
 * a dereferenced skill symlink: the bytes live in the harness library, but the
 * shared path is `skills/<name>/…`.
 */
async function walkDir(base, diskRel, manifestRel, files, skipped, depth, followTopLink) {
  if (depth > 20) {
    skipped.push(`${manifestRel}: directory nesting is too deep to sync`)
    return
  }
  let entries = []
  try {
    entries = fs.readdirSync(diskRel ? path.join(base, diskRel) : base, {
      withFileTypes: true,
    })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const diskChild = diskRel ? path.join(diskRel, entry.name) : entry.name
    const rel = `${manifestRel}/${entry.name}`
    const full = path.join(base, diskChild)
    if (entry.isSymbolicLink()) {
      if (!followTopLink) {
        skipped.push(`${rel}: symlink not followed`)
        continue
      }
      let real
      try {
        real = fs.realpathSync(full)
      } catch {
        skipped.push(`${rel}: broken symlink`)
        continue
      }
      const target = skillTarget(real)
      if (!target) {
        skipped.push(`${rel}: symlink target is not a skill`)
        continue
      }
      if (target.directory) {
        if (files.size >= MAX_FILES) {
          skipped.push(`${rel}: file limit reached`)
          return
        }
        await walkDir(real, '', rel, files, skipped, depth + 1, false)
      } else {
        await recordFile(real, rel, target.stat, files, skipped)
      }
      continue
    }
    if (entry.isDirectory()) {
      if (files.size >= MAX_FILES) {
        skipped.push(`${rel}: file limit reached`)
        return
      }
      await walkDir(base, diskChild, rel, files, skipped, depth + 1, false)
      continue
    }
    if (!entry.isFile()) continue
    let stat
    try {
      stat = fs.statSync(full)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    await recordFile(full, rel, stat, files, skipped)
  }
}

async function walkScope(root, rel, files, skipped) {
  /* Only the top level of `skills/` dereferences links; everything below a
     skill (and every other scope) keeps the "a link is not content" rule. */
  await walkDir(root, rel, rel, files, skipped, 0, rel === 'skills')
}

async function buildManifest(dir, { record, skills, mcpRaw, skipped = [] } = {}) {
  if (!dir) throw new Error('A workspace directory is required.')
  const files = new Map()
  for (const scope of SCOPES) {
    await walkScope(dir, scope, files, skipped)
  }
  const virtual = virtualBuffers(record || {}, skills || [], mcpRaw || {})
  for (const [name, buffer] of Object.entries(virtual)) {
    files.set(name, {
      path: name,
      sha256: sha256(buffer),
      size: buffer.length,
      mtimeMs: 0,
      virtual: true,
    })
  }

  const list = [...files.values()].sort((a, b) => a.path.localeCompare(b.path))
  const rev = sha256(
    Buffer.from(list.map((entry) => `${entry.path}:${entry.sha256}`).join('\n'), 'utf8'),
  )
  return {
    rev,
    files: list,
    byPath: files,
    virtual,
    skipped,
    /* Capability marker: an older server omits this and cannot exchange
       workspace-owned skill files. Clients use it to avoid treating "the
       server does not track skills" as "the server deleted the skills". */
    scopes: [...SCOPES],
    updatedAt: new Date().toISOString(),
  }
}

/** A disk workspace's inputs: workspace.json, mcp.json and the attached links. */
function recordInputs(record) {
  const raw = readJson(path.join(record.path, 'workspace.json'), {}) || {}
  return {
    record: {
      ...record,
      /* The files are authoritative: a sync applies the remote shape by writing
         them, and the `record` this function receives was read before that. */
      label: raw.label ?? record.label,
      context: raw.context ?? record.context ?? '',
      mcpStrict: raw.mcpStrict ?? record.mcpStrict,
      owner: raw.owner ?? record.owner,
      members: Array.isArray(raw.members) ? raw.members : record.members,
    },
    skills: readAttachedSkills(record.path),
    mcpRaw: readJson(path.join(record.path, 'mcp.json'), { schema: 1, servers: {} }),
  }
}

function manifestForRecord(record, skipped = []) {
  const inputs = recordInputs(record)
  return buildManifest(record.path, { ...inputs, skipped })
}

/** tmp + rename in the same directory: a crash cannot truncate a synced file. */
function writeAtomic(file, buffer, { mode } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, buffer, mode ? { mode } : undefined)
  fs.renameSync(tmp, file)
  if (mode) {
    try {
      fs.chmodSync(file, mode)
    } catch {
      /* filesystems without modes */
    }
  }
}

module.exports = {
  SCOPES,
  VIRTUAL,
  MAX_FILE_BYTES,
  MAX_FILES,
  REDACTED,
  safeRel,
  isVirtual,
  absoluteFor,
  hashFile,
  sha256,
  buildManifest,
  manifestForRecord,
  recordInputs,
  canonicalMeta,
  sanitizeMcp,
  mergeServer,
  normaliseSkills,
  readAttachedSkills,
  virtualBuffers,
  writeAtomic,
  readJson,
  sortMembers,
}
