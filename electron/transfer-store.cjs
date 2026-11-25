/* Transfer: one file a person hands to another person.
 *
 * Two formats, and the extension is the contract:
 *
 *   <workspace>-<preset>-<date>.entity.json   readable, `secrets: 'none'`
 *   <workspace>-<preset>-<date>.entity.zip    sealed, scrypt + AES-256-GCM
 *
 * The reader is a trust boundary: every file arriving here was written by some
 * other machine and may have been edited by hand on the way. So it re-derives
 * what the writer promised — a `.json` must really be plaintext and really carry
 * no credential, a `.zip` must really be sealed — and refuses with
 * "Nothing was changed." before a single byte reaches a workspace.
 *
 * Secrets never travel by default. A redacted definition carries `***`, and the
 * only writer of the merged value is `workspaces.writeMcp` (through
 * `preserveSecrets`), so a `***` can never overwrite a real local token.
 */

'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const yazl = require('yazl')
const unzipper = require('unzipper')

const workspaces = require('./workspace-store.cjs')
const connectors = require('./connector-store.cjs')
const catalog = require('./connector-catalog.cjs')
const backups = require('./backup-store.cjs')
const remote = require('./remote-manifest.cjs')

const SCHEMA = 1
const KIND = 'entity.transfer'
const CONNECTOR_KIND = 'entity.connector'
const REDACTED = remote.REDACTED || '***'
const MIN_PASSPHRASE = 12
const MAX_FILE = 25 * 1024 * 1024
const DIRS = ['entities', 'skills', 'artifacts', 'chats']
const GROUPS = ['entities', 'skills', 'artifacts', 'chats', 'connections', 'workspace']

const PRESETS = {
  agents: { label: 'Agents & skills', slug: 'agents-and-skills' },
  connections: { label: 'Connections', slug: 'connections' },
  whole: { label: 'Whole workspace', slug: 'whole-workspace' },
}

/* ── refusals ─────────────────────────────────────────────────────── */

/** Every reader refusal says the same second sentence, because the caller is a
 *  person looking at a toast: they need to know the workspace is untouched. */
function refusal(message, code = 'transfer') {
  const error = new Error(`${message} Nothing was changed.`)
  error.code = code
  return error
}

function passphraseError(message) {
  const error = new Error(message)
  error.code = 'passphrase'
  return error
}

/* Wrong-passphrase budget, per process. Keyed by the file's own bytes, so a
   second file is not locked out by a first one. Three tries, then a minute;
   there is no recovery path and no counter on disk to reset. */
const ATTEMPTS = new Map()

function attemptsFor(buffer) {
  const key = crypto.createHash('sha256').update(buffer).digest('hex')
  let entry = ATTEMPTS.get(key)
  if (!entry) {
    entry = { fails: 0, until: 0 }
    ATTEMPTS.set(key, entry)
  }
  return { key, entry }
}

function failAttempt(buffer) {
  const { entry } = attemptsFor(buffer)
  entry.fails += 1
  const left = 3 - entry.fails
  if (left <= 0) {
    entry.fails = 0
    entry.until = Date.now() + 60_000
    return passphraseError('Wrong passphrase, three times. That file is closed for a minute.')
  }
  return passphraseError(
    `Wrong passphrase. ${left} ${left === 1 ? 'try' : 'tries'} left, then the file closes for a minute.`,
  )
}

/* ── reading a file ───────────────────────────────────────────────── */

function decode(data) {
  const buffer = Buffer.from(String(data || ''), 'base64')
  if (!buffer.length) throw refusal('That file is empty.')
  return buffer
}

function zipShaped(buffer) {
  return buffer[0] === 0x50 && buffer[1] === 0x4b
}

async function openSealed(buffer, passphrase) {
  const { key, entry } = attemptsFor(buffer)
  const wait = entry.until - Date.now()
  if (wait > 0) {
    throw passphraseError(
      `That file is closed for another ${Math.ceil(wait / 1000)}s — the passphrase was wrong three times.`,
    )
  }
  if (!passphrase) {
    throw passphraseError('This file is sealed. Enter the passphrase that made it.')
  }

  let archive = null
  try {
    archive = await unzipper.Open.buffer(buffer)
  } catch {
    archive = null
  }
  const sealEntry = archive?.files.find((file) => file.path === 'seal.json')
  const payloadEntry = archive?.files.find((file) => file.path === 'entity.bin')
  if (!sealEntry || !payloadEntry) throw refusal('This file is named .zip but it is not sealed.')

  let seal = null
  try {
    seal = JSON.parse((await sealEntry.buffer()).toString('utf8'))
  } catch {
    seal = null
  }
  if (!seal || seal.kdf !== 'scrypt' || seal.cipher !== 'aes-256-gcm') {
    throw refusal('This file is named .zip but it is not sealed.')
  }

  try {
    const derived = crypto.scryptSync(String(passphrase), Buffer.from(seal.salt, 'base64'), 32)
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      derived,
      Buffer.from(seal.iv, 'base64'),
    )
    decipher.setAuthTag(Buffer.from(seal.tag, 'base64'))
    const plain = Buffer.concat([decipher.update(await payloadEntry.buffer()), decipher.final()])
    const bundle = JSON.parse(plain.toString('utf8'))
    ATTEMPTS.delete(key)
    return bundle
  } catch {
    throw failAttempt(buffer)
  }
}

/** A plain `.entity.json` must look like one. A credential in a readable file is
 *  the mistake the writer already refuses to make; a hand-edited file can still
 *  make it, so the reader checks the definition too. */
function openPlain(buffer) {
  let bundle = null
  try {
    bundle = JSON.parse(buffer.toString('utf8'))
  } catch {
    throw refusal('That file is not readable JSON.')
  }
  if (!bundle || typeof bundle !== 'object') throw refusal('That file is not readable JSON.')
  if (bundle.sealed === true) throw refusal('This file is named .json but it is sealed.')
  if (bundle.secrets !== 'none') {
    throw refusal('This file claims to carry secrets in a readable file.')
  }
  for (const definition of Object.values(bundle.mcp?.servers || {})) {
    for (const [name, value] of Object.entries(definition?.env || {})) {
      if (value !== REDACTED && /token|key|secret|pass|auth/i.test(name)) {
        throw refusal('A file that carries a credential must be sealed.')
      }
    }
    for (const [name, value] of Object.entries(definition?.headers || {})) {
      if (value !== REDACTED && /token|key|secret|auth|cookie/i.test(name)) {
        throw refusal('A file that carries a credential must be sealed.')
      }
    }
  }
  return bundle
}

async function read({ filename, data, passphrase } = {}) {
  const name = String(filename || '')
  const buffer = decode(data)
  if (name.endsWith('.json')) {
    if (zipShaped(buffer)) throw refusal('This file is named .json but it is sealed.')
    return openPlain(buffer)
  }
  if (name.endsWith('.zip')) {
    if (!zipShaped(buffer)) throw refusal('This file is named .zip but it is not sealed.')
    return openSealed(buffer, passphrase)
  }
  throw refusal('That is not an entity transfer file — expected .entity.json or .entity.zip.')
}

/* ── writing a file ───────────────────────────────────────────────── */

function zipBuffer(entries) {
  const zip = new yazl.ZipFile()
  const chunks = []
  const done = new Promise((resolve, reject) => {
    zip.outputStream.on('data', (chunk) => chunks.push(chunk))
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
    zip.outputStream.on('error', reject)
  })
  for (const [name, buffer] of entries) zip.addBuffer(buffer, name, { mode: 0o600 })
  zip.end()
  return done
}

async function encode(bundle, passphrase) {
  const plain = Buffer.from(JSON.stringify(bundle), 'utf8')
  if (!passphrase) return plain
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = crypto.scryptSync(String(passphrase), salt, 32)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plain), cipher.final()])
  const seal = {
    schema: 1,
    kdf: 'scrypt',
    cipher: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  }
  return zipBuffer([
    ['seal.json', Buffer.from(JSON.stringify(seal), 'utf8')],
    ['entity.bin', data],
  ])
}

/* ── one workspace's bytes ────────────────────────────────────────── */

function redact(definition) {
  const out = { ...definition }
  if (out.env && typeof out.env === 'object' && !Array.isArray(out.env)) {
    out.env = Object.fromEntries(Object.keys(out.env).map((key) => [key, REDACTED]))
  }
  if (out.headers && typeof out.headers === 'object') {
    out.headers = Object.fromEntries(Object.keys(out.headers).map((key) => [key, REDACTED]))
  }
  return out
}

function hasRedacted(definition) {
  for (const field of ['env', 'headers']) {
    const values = definition?.[field]
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue
    if (Object.values(values).some((value) => value === REDACTED)) return true
  }
  return false
}

/** The setting names a definition carries — the keys, never a value. Both shapes
 *  are real: `add()` writes an array of names, and a pool definition written by a
 *  sync or by hand is an object of them. */
function settingKeys(definition) {
  const keys = []
  for (const field of ['env', 'headers']) {
    const values = definition?.[field]
    if (!values || typeof values !== 'object') continue
    const list = Array.isArray(values) ? values : Object.keys(values)
    keys.push(...list.map(String).filter(Boolean))
  }
  return keys
}

/** Does the definition that would travel hold a credential? An array-shaped `env`
 *  is a list of names with nothing behind them and `***` is what a redacted value
 *  looks like, so neither counts. This is the question that decides whether sealing
 *  a file means anything at all. */
function carriesToken(definition) {
  for (const field of ['env', 'headers']) {
    const values = definition?.[field]
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue
    if (Object.values(values).some((value) => value !== REDACTED && String(value || '') !== '')) {
      return true
    }
  }
  return false
}

function poolOf(record, real) {
  const pool = workspaces.mcp(record.id)
  const servers = {}
  for (const [name, definition] of Object.entries(pool.servers || {})) {
    servers[name] = real ? { ...definition } : redact(definition)
  }
  return { schema: 1, servers }
}

/** Only the preset's own groups. `mcp.json` and `connectors.json` are carried as
 *  structured fields, not as files, because a file is what a `***` merge never
 *  sees. */
function collect(record, preset, includeCredentials) {
  const exported = workspaces.exportWorkspace({ id: record.id })
  const files = {}
  for (const [rel, value] of Object.entries(exported.files || {})) {
    if (rel === 'mcp.json' || rel === 'connectors.json') continue
    const top = rel.split('/')[0]
    if (preset === 'connections') continue
    if (preset === 'agents' && !['entities', 'skills', 'artifacts'].includes(top)) continue
    files[rel] = value
  }

  const wantsConnections = preset === 'connections' || preset === 'whole'
  const real = wantsConnections && preset === 'connections' && includeCredentials === true
  const bundle = {
    schema: SCHEMA,
    kind: KIND,
    scope: preset === 'whole' ? 'workspace' : 'preset',
    preset,
    sender: sentBy(),
    workspace: { label: record.label, id: record.id },
    exportedAt: new Date().toISOString(),
    secrets: real ? 'included' : 'none',
    sealed: false,
    files,
    skills: preset === 'agents' || preset === 'whole' ? exported.skills || [] : [],
    connectors: wantsConnections ? { rows: connectors.readIndex(record).rows } : null,
    mcp: wantsConnections ? poolOf(record, real) : null,
  }
  /* Only the whole workspace carries the record itself: the two smaller presets
     are about work, and shipping someone's context paragraph with a skill pack
     would be a copy nobody asked for. */
  if (preset === 'whole') {
    bundle.workspace = {
      ...bundle.workspace,
      kind: record.kind,
      createdAt: record.createdAt,
      context: record.context,
      mcpStrict: record.mcpStrict !== false,
      owner: record.owner,
      members: record.members,
    }
  }
  return bundle
}

function sentBy() {
  try {
    const user = require('./auth-store.cjs').get()
    return { name: String(user?.name || ''), email: String(user?.email || '') }
  } catch {
    return { name: '', email: '' }
  }
}

function countsOf(bundle) {
  const counts = { entities: 0, skills: 0, artifacts: 0, chats: 0, files: 0, bytes: 0 }
  const skills = new Set()
  for (const [rel, value] of Object.entries(bundle.files || {})) {
    counts.files += 1
    counts.bytes +=
      typeof value === 'string'
        ? Buffer.byteLength(value)
        : Math.ceil(String(value?.dataUrl || '').length * 0.75)
    const [top, second] = rel.split('/')
    if (top === 'entities') counts.entities += 1
    else if (top === 'chats') counts.chats += 1
    else if (top === 'skills') {
      if (!skills.has(second)) {
        skills.add(second)
        counts.skills += 1
      }
    } else if (top === 'artifacts' && rel !== 'artifacts/.scope.json') counts.artifacts += 1
  }
  counts.connectors = Object.keys(bundle.connectors?.rows || {}).length
  counts.servers = Object.keys(bundle.mcp?.servers || {}).length
  return counts
}

function fileName(id, preset, sealed) {
  const stamp = new Date().toISOString().slice(0, 10)
  return `${id}-${PRESETS[preset].slug}-${stamp}.entity.${sealed ? 'zip' : 'json'}`
}

function freeFile(dir, name) {
  let target = path.join(dir, name)
  if (!fs.existsSync(target)) return target
  const stem = name.replace(/\.entity\.(json|zip)$/, '')
  const ext = name.slice(stem.length)
  for (let n = 2; n < 1000; n += 1) {
    target = path.join(dir, `${stem}-${n}${ext}`)
    if (!fs.existsSync(target)) return target
  }
  throw new Error(`Could not find a free name for ${name} in ${dir}.`)
}

/** `~/Downloads` on every platform the app ships for. `ENTITY_TRANSFER_DIR` is
 *  the test hook — a suite must never write into a real person's Downloads. */
function downloadsDir() {
  if (process.env.ENTITY_TRANSFER_DIR) return process.env.ENTITY_TRANSFER_DIR
  return path.join(os.homedir(), 'Downloads')
}

/** Where a file just written lives now. A send hands back only the base name it
 *  printed, so the name is the whole address — the one path-bearing verb
 *  re-derives it from the directory this process chose rather than trusting a
 *  string the renderer handed back. */
function filePath(filename) {
  const name = path.basename(String(filename || '').trim())
  if (!name || name === '.' || name === '..') throw new Error('Which file?')
  return path.join(downloadsDir(), name)
}

/* ── send ─────────────────────────────────────────────────────────── */

async function send({
  workspace,
  preset = 'agents',
  includeCredentials = false,
  passphrase = '',
  dry = false,
  directory = '',
} = {}) {
  if (!PRESETS[preset]) throw new Error(`"${preset}" is not a transfer preset.`)
  const record = workspaces.open(workspace)
  const bundle = collect(record, preset, includeCredentials)
  const sealed = Boolean(passphrase) || bundle.secrets === 'included'

  if (bundle.secrets === 'included' && !passphrase) {
    throw new Error('A file that carries a credential must be sealed. Enter a passphrase.')
  }
  if (sealed && String(passphrase).length < MIN_PASSPHRASE) {
    throw new Error(
      `Use at least ${MIN_PASSPHRASE} characters — a shorter passphrase does not keep the file shut.`,
    )
  }

  const name = fileName(record.id, preset, sealed)
  const payload = await encode(bundle, passphrase)
  const counts = countsOf(bundle)
  const header = { filename: name, bytes: payload.length, counts, sealed, secrets: bundle.secrets, preset }
  if (dry) return header

  const dir = directory || downloadsDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = freeFile(dir, name)
  fs.writeFileSync(file, payload, { mode: 0o600 })
  return { ...header, filename: path.basename(file), path: file }
}

/* ── the diff ─────────────────────────────────────────────────────── */

function safeRel(value) {
  const rel = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rel || rel.includes('\0')) return ''
  const parts = rel.split('/').filter(Boolean)
  if (!parts.length || parts.some((part) => part === '..' || part === '.')) return ''
  if (rel === 'workspace.json' || rel === 'members.json') return rel
  if (parts.length < 2 || !DIRS.includes(parts[0])) return ''
  return parts.join('/')
}

function bufferOf(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  const match = String(value?.dataUrl || '').match(/^data:[^,]*;base64,([\s\S]*)$/)
  return match ? Buffer.from(match[1], 'base64') : Buffer.alloc(0)
}

/** One path's action. `add` means the file is not there, `keep` means it either
 *  matches or this mode must not touch it, `replace` only exists in the mode the
 *  person chose, and `skip` means the file is there and the incoming copy loses
 *  (a symlinked skill, a chat that add-alongside does not overwrite). */
function fileAction(root, rel, value, mode) {
  const target = path.join(root, rel)
  let stat = null
  try {
    stat = fs.lstatSync(target)
  } catch {
    return 'add'
  }
  if (stat.isSymbolicLink()) return 'skip'
  if (!stat.isFile()) return 'skip'
  let local = null
  try {
    local = fs.readFileSync(target)
  } catch {
    return 'keep'
  }
  const incoming = bufferOf(value)
  if (local.equals(incoming)) return 'keep'
  return mode === 'replace' ? 'replace' : 'keep'
}

function freeName(record, name) {
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${name}-${n}`
    if (!connectors.isInstalled({ workspace: record.id, id: candidate })) return candidate
  }
  throw new Error(`Could not find a free name for "${name}".`)
}

function diffOf(record, bundle, mode) {
  const groups = new Map(GROUPS.map((key) => [key, []]))
  const push = (group, rel, action) => groups.get(group).push({ path: rel, action })

  for (const [rel, value] of Object.entries(bundle.files || {})) {
    const safe = safeRel(rel)
    if (!safe || safe === 'workspace.json' || safe === 'members.json') continue
    push(safe.split('/')[0], safe, fileAction(record.path, safe, value, mode))
  }

  const pool = workspaces.mcp(record.id)
  const index = connectors.readIndex(record)
  for (const name of Object.keys(bundle.mcp?.servers || {})) {
    const local = Boolean(pool.servers[name] || pool.disabled[name])
    push('connections', `mcp.json:${name}`, !local ? 'add' : mode === 'replace' ? 'replace' : 'keep')
  }
  for (const name of Object.keys(bundle.connectors?.rows || {})) {
    push(
      'connections',
      `connectors.json:${name}`,
      !index.rows[name] ? 'add' : mode === 'replace' ? 'replace' : 'keep',
    )
  }

  if (bundle.preset === 'whole') {
    const context = bundle.workspace?.context
    const differs = typeof context === 'string' && context !== record.context
    push('workspace', 'workspace.json', differs && mode === 'replace' ? 'replace' : 'keep')
    const localMembers = JSON.stringify(record.members || [])
    const incomingMembers = JSON.stringify(bundle.workspace?.members || [])
    push(
      'workspace',
      'members.json',
      localMembers === incomingMembers ? 'keep' : mode === 'replace' ? 'replace' : 'keep',
    )
  }

  const out = []
  const totals = { add: 0, replace: 0, keep: 0, skip: 0, conflict: 0 }
  for (const [key, paths] of groups) {
    if (!paths.length) continue
    const counts = { add: 0, replace: 0, keep: 0, skip: 0, conflict: 0 }
    for (const entry of paths) counts[entry.action] += 1
    for (const field of Object.keys(totals)) totals[field] += counts[field]
    out.push({
      key,
      paths: paths.sort((a, b) => a.path.localeCompare(b.path)),
      counts,
      /* An all-keep group is the one the sheet collapses to a single line. */
      same: counts.keep === paths.length,
    })
  }
  return { groups: out, totals, kept: totals.keep, skipped: totals.skip, same: totals.add + totals.replace === 0 }
}

function transferBundle(bundle) {
  if (!bundle || bundle.schema !== SCHEMA || bundle.kind !== KIND) {
    throw refusal(`That file is not an entity transfer (it says "${bundle?.kind || 'nothing'}").`)
  }
  return bundle
}

async function inspect({ workspace, filename, data, passphrase, mode = 'add' } = {}) {
  const record = workspaces.open(workspace)
  const bundle = transferBundle(await read({ filename, data, passphrase }))
  const diff = diffOf(record, bundle, mode === 'replace' ? 'replace' : 'add')
  return {
    filename: String(filename || ''),
    preset: bundle.preset,
    scope: bundle.scope,
    sender: bundle.sender || { name: '', email: '' },
    workspace: { label: bundle.workspace?.label || '', id: bundle.workspace?.id || '' },
    exportedAt: bundle.exportedAt || '',
    /* The reader enforces the rule, so after a successful read the extension is
       the whole answer: a `.zip` is sealed whatever it carries, a `.json` is
       readable. `secrets` says what is inside, which is a different question. */
    sealed: /\.zip$/i.test(String(filename || '')),
    counts: countsOf(bundle),
    ...diff,
  }
}

/* ── apply: write into a workspace that is here ───────────────────── */

function writeOne(record, rel, value) {
  const safe = safeRel(rel)
  if (!safe || safe === 'workspace.json' || safe === 'members.json') {
    throw new Error(`${rel} is not a file a transfer writes.`)
  }
  workspaces.writeFileAtomic(path.join(record.path, safe), bufferOf(value))
}

function writeConnections(record, bundle, mode) {
  const servers = bundle.mcp?.servers || {}
  const pool = workspaces.mcp(record.id)
  const incoming = {}
  for (const [name, definition] of Object.entries(servers)) {
    /* Add-alongside never overwrites; only the mode the person chose does. */
    if (mode !== 'replace' && (pool.servers[name] || pool.disabled[name])) continue
    incoming[name] = definition
  }
  if (Object.keys(servers).length) {
    /* `writeMcp` is the only writer of a pool value: a `***` in the incoming
       definition keeps the local secret, which is why a redacted transfer can
       carry a working server without ever holding its token. */
    workspaces.writeMcp({
      id: record.id,
      servers: { ...(pool.servers || {}), ...incoming },
      disabled: pool.disabled || {},
    })
  }

  const rows = bundle.connectors?.rows || {}
  if (Object.keys(rows).length) {
    const index = connectors.readIndex(record)
    const merged = { ...index.rows }
    for (const [name, row] of Object.entries(rows)) {
      if (mode !== 'replace' && merged[name]) continue
      merged[name] = row
    }
    connectors.writeIndex(record, { rows: merged })
  }
}

function writeWorkspace(record, bundle) {
  const context = bundle.workspace?.context
  if (typeof context === 'string' && context !== record.context) {
    workspaces.setContext({ id: record.id, context })
  }
  const members = bundle.workspace?.members
  if (Array.isArray(members)) {
    const doc = { schema: 1, owner: bundle.workspace.owner || null, members }
    workspaces.writeFileAtomic(
      path.join(record.path, 'members.json'),
      `${JSON.stringify(doc, null, 2)}\n`,
    )
  }
}

async function write(record, bundle, { mode, snapshot }) {
  const diff = diffOf(record, bundle, mode)
  const pending = []
  for (const group of diff.groups) {
    for (const entry of group.paths) {
      if (entry.action === 'add' || entry.action === 'replace') pending.push({ group: group.key, ...entry })
    }
  }
  const result = { written: 0, kept: diff.kept, skipped: diff.skipped, firstFailure: null, snapshot: '' }
  if (!pending.length) return result

  if (snapshot !== false) {
    try {
      result.snapshot = (await backups.createSnapshot(record, { reason: 'manual' })).name
    } catch (error) {
      throw new Error(
        `Nothing was changed: a copy of this workspace could not be saved first (${error.message}).`,
      )
    }
  }

  for (const group of diff.groups) {
    const entries = group.paths.filter((entry) => entry.action === 'add' || entry.action === 'replace')
    if (!entries.length) continue
    if (group.key === 'connections') {
      try {
        writeConnections(record, bundle, mode)
        result.written += entries.length
      } catch (error) {
        result.firstFailure = { group: group.key, path: entries[0].path, message: error.message }
        break
      }
      continue
    }
    if (group.key === 'workspace') {
      try {
        writeWorkspace(record, bundle)
        result.written += entries.length
      } catch (error) {
        result.firstFailure = { group: group.key, path: entries[0].path, message: error.message }
        break
      }
      continue
    }
    let stopped = false
    for (const entry of entries) {
      try {
        writeOne(record, entry.path, bundle.files[entry.path])
        result.written += 1
      } catch (error) {
        result.firstFailure = { group: group.key, path: entry.path, message: error.message }
        stopped = true
        break
      }
    }
    if (stopped) break
  }
  return result
}

async function apply({ workspace, filename, data, passphrase, mode = 'add', snapshot = true } = {}) {
  const record = workspaces.open(workspace)
  const bundle = transferBundle(await read({ filename, data, passphrase }))
  return write(record, bundle, { mode: mode === 'replace' ? 'replace' : 'add', snapshot })
}

/* ── place: the receiving machine does not have this workspace yet ── */

/** The transfer bundle, re-labelled as the shape `importWorkspace` already knows
 *  how to stage, name and move into place. The two files that store skips
 *  (`connectors.json`, and the members it takes from the roster) are written by
 *  `finishPlace` afterwards, against the new record. */
function asWorkspaceBundle(bundle, label) {
  return {
    schema: 1,
    kind: 'entity.workspace',
    exportedAt: bundle.exportedAt,
    workspace: {
      label,
      kind: 'local',
      createdAt: bundle.workspace?.createdAt || new Date().toISOString(),
      mcpStrict: bundle.workspace?.mcpStrict !== false,
      owner: bundle.workspace?.owner || null,
      members: bundle.workspace?.members || [],
    },
    files: bundle.files || {},
    skills: [],
  }
}

function finishPlace(record, bundle) {
  const context = bundle.workspace?.context
  if (typeof context === 'string' && context) workspaces.setContext({ id: record.id, context })
  const rows = bundle.connectors?.rows || {}
  if (Object.keys(rows).length) connectors.writeIndex(record, { rows })
  const servers = bundle.mcp?.servers || {}
  if (Object.keys(servers).length) workspaces.writeMcp({ id: record.id, servers })
}

async function place({ workspace, filename, data, passphrase, mode = 'beside', confirm = '' } = {}) {
  const bundle = transferBundle(await read({ filename, data, passphrase }))
  if (bundle.scope !== 'workspace') {
    throw refusal('That file carries one preset, not a whole workspace. Receive it instead.')
  }
  const record = workspaces.open(workspace)

  if (mode === 'replace') {
    if (String(confirm || '') !== record.id) {
      throw refusal('Type the workspace id to confirm — that is the one thing that unlocks a replace.')
    }
    const result = await write(record, { ...bundle, preset: 'whole' }, { mode: 'replace', snapshot: true })
    return { id: record.id, label: record.label, replaced: true, ...result }
  }

  const label = String(bundle.workspace?.label || record.label || 'Workspace')
  const id = workspaces.uniqueWorkspaceId(label)
  const imported = workspaces.importWorkspace({ bundle: asWorkspaceBundle(bundle, id) })
  finishPlace(imported.record, bundle)
  return {
    id: imported.record.id,
    label: imported.record.label,
    replaced: false,
    written: countsOf(bundle).files,
    kept: 0,
    skipped: imported.skipped?.length || 0,
    firstFailure: null,
    snapshot: '',
  }
}

/* ── one connector ────────────────────────────────────────────────── */

async function connectorSend({
  workspace,
  id,
  includeToken = false,
  passphrase = '',
  dry = false,
  directory = '',
} = {}) {
  const record = workspaces.open(workspace)
  const name = String(id || '').trim()
  if (!name) throw new Error('Which connector should travel?')
  const indexed = connectors.readIndex(record).rows[name] || null
  /* The mention is the catalogue's, and the index row leaves it empty — so a file
     built from the index alone promised "the link code" and carried nothing. */
  const row = indexed ? { ...indexed, mention: catalog.mentionOf(name) || indexed.mention || '' } : null
  const pool = workspaces.mcp(record.id)
  const definition = pool.servers[name] || pool.disabled[name] || null
  if (!row && !definition) throw new Error(`This workspace has no connector called "${name}".`)

  const real = includeToken === true
  const token = carriesToken(definition)
  const facts = {
    real,
    kind: row?.kind || (definition ? 'mcp' : 'cli'),
    oauth: row?.oauth === true,
    definition,
    mention: row?.mention || '',
    token,
  }
  /* A passphrase over a file with nothing secret in it is theatre — and it is what
     asked a person to seal a connector that had no token to seal. The reader
     enforces the other direction; this enforces this one. */
  if (real && !token) {
    throw refusal('This connector stores no token, so there is nothing to seal. Send it unsealed.')
  }

  /* A dry ask is how the sheet learns what travels before anything is written —
     and it is also why it can paint the token variant while the passphrase is
     still empty: nothing is sealed, so nothing needs a key yet. The two lists come
     back flat, the same shape `connectorInspect` answers with, because the sheet
     reads one shape for both ends. */
  if (dry) {
    return {
      filename: `${record.id}-${name}-${new Date().toISOString().slice(0, 10)}.entity.${real ? 'zip' : 'json'}`,
      bytes: 0,
      sealed: real,
      id: name,
      label: row?.label || name,
      kind: facts.kind,
      oauth: facts.oauth,
      token,
      ...travelsOf(facts),
    }
  }

  if (real && !passphrase) {
    throw new Error('A file that carries a credential must be sealed. Enter a passphrase.')
  }
  if (real && String(passphrase).length < MIN_PASSPHRASE) {
    throw new Error(
      `Use at least ${MIN_PASSPHRASE} characters — a shorter passphrase does not keep the file shut.`,
    )
  }

  const bundle = {
    schema: SCHEMA,
    kind: CONNECTOR_KIND,
    scope: 'connector',
    preset: '',
    sender: sentBy(),
    workspace: { label: record.label, id: record.id },
    exportedAt: new Date().toISOString(),
    secrets: real ? 'included' : 'none',
    sealed: real,
    files: {},
    skills: [],
    /* Five fields, named one by one. An index row is this workspace's own bookkeeping
       — today it holds no secret, and the day it grows one an allowlist is what stops
       it travelling in a readable file. */
    connectors: {
      rows: {
        [name]: {
          label: row?.label || name,
          kind: row?.kind || (definition ? 'mcp' : 'cli'),
          scope: 'workspace',
          mention: row?.mention || '',
          oauth: row?.oauth === true,
        },
      },
    },
    mcp: definition ? { schema: 1, servers: { [name]: real ? { ...definition } : redact(definition) } } : null,
  }

  const filename = `${record.id}-${name}-${new Date().toISOString().slice(0, 10)}.entity.${real ? 'zip' : 'json'}`
  const payload = await encode(bundle, real ? passphrase : '')
  const dir = directory || downloadsDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = freeFile(dir, filename)
  fs.writeFileSync(file, payload, { mode: 0o600 })
  return {
    filename: path.basename(file),
    path: file,
    bytes: payload.length,
    sealed: real,
    id: name,
    label: row?.label || name,
    kind: facts.kind,
    oauth: facts.oauth,
    token,
    ...travelsOf(facts),
  }
}

/**
 * The sheet's two columns, as the literal content of the file rather than a
 * paragraph that flatters every kind.
 *
 * A connector file holds one row — `label`, `kind`, `mention`, `oauth` — and, for
 * an `mcp` connector, its definition with every value replaced by `***`. So the
 * list names exactly that: the address, the command, the *names* of the settings.
 * Everything else is on the other side of the line, and the OAuth pair most of all
 * — the client and its accounts belong to this machine and never travel
 * (docs/connectors.md: one app-wide client per machine, because a client per
 * workspace would put the same secret in a shared file N times).
 */
function travelsOf({ real = false, kind = 'mcp', oauth = false, definition = null, mention = '', token = false } = {}) {
  const travels = ['Its name, label and kind']
  if (mention) travels.push(`The link code ${mention}`)
  if (definition?.url) travels.push('The server address')
  if (definition?.command) travels.push('The command and its arguments')
  const keys = settingKeys(definition)
  if (keys.length) travels.push(`The setting names (${keys.join(', ')})`)
  if (real) travels.push('The token behind those names, in full')

  const stays = []
  if (oauth) {
    stays.push('The OAuth client, which belongs to this machine', 'The accounts signed in here')
  } else if (kind === 'cli') {
    stays.push('The binary and its sign-in on this machine')
  } else if (token && !real) {
    stays.push('The token behind those setting names')
  } else if (!definition) {
    /* The `bindingFor` wording, for the row whose credential is a key this machine
       holds rather than a definition anything could carry. */
    stays.push('A token on this machine, if it has one')
  }
  /* Not in the file, and not a tidiness call: which tier this workspace granted is
     this workspace's own decision, and the receiving side picks its own. */
  stays.push('The permission tier')
  return { travels, stays }
}
async function connectorInspect({ workspace, filename, data, passphrase } = {}) {
  const record = workspaces.open(workspace)
  const bundle = await read({ filename, data, passphrase })
  if (!bundle || bundle.kind !== CONNECTOR_KIND) throw refusal('That file does not carry a connector.')
  if (bundle.scope === 'machine') {
    throw refusal('That connector only works on the machine that wrote it.')
  }
  const name = Object.keys(bundle.connectors?.rows || {})[0] || ''
  if (!name) throw refusal('That file does not name a connector.')
  const row = bundle.connectors.rows[name] || {}
  const definition = bundle.mcp?.servers?.[name] || null
  const present = connectors.isInstalled({ workspace: record.id, id: name })

  /* `***` plus no real value here is a state, not a failure: the file arrived, the
     token did not, and the page has to say so before anything is clicked. */
  const local = workspaces.mcp(record.id).servers[name] || null
  const kind = row.kind || (definition ? 'mcp' : 'cli')
  const needsSignIn =
    kind === 'mcp'
      ? (!definition || hasRedacted(definition)) && !(local && !hasRedacted(local))
      : true

  return {
    id: name,
    label: row.label || name,
    kind,
    present,
    beside: present ? freeName(record, name) : '',
    needsSignIn,
    sealed: bundle.secrets === 'included',
    sender: bundle.sender || { name: '', email: '' },
    filename: String(filename || ''),
    /* The same two lists the sending sheet showed, from the file's own facts — and
       `token` counts the one already here, because that is the token this machine
       keeps if the incoming one is `***`. */
    ...travelsOf({
      real: bundle.secrets === 'included',
      kind,
      oauth: row.oauth === true,
      definition,
      mention: row.mention || '',
      token: carriesToken(definition) || carriesToken(local),
    }),
  }
}

async function connectorInstall({ workspace, filename, data, passphrase, mode = 'update' } = {}) {
  const record = workspaces.open(workspace)
  const bundle = await read({ filename, data, passphrase })
  if (!bundle || bundle.kind !== CONNECTOR_KIND) throw refusal('That file does not carry a connector.')
  if (bundle.scope === 'machine') {
    throw refusal('That connector only works on the machine that wrote it.')
  }
  const name = Object.keys(bundle.connectors?.rows || {})[0] || ''
  if (!name) throw refusal('That file does not name a connector.')
  const row = bundle.connectors.rows[name] || {}
  const definition = bundle.mcp?.servers?.[name] || null
  const present = connectors.isInstalled({ workspace: record.id, id: name })
  const beside = mode === 'beside'

  if (present && !beside) {
    /* Update: the definition may change here, the token may not. `writeMcp` keeps
       a local `env`/`headers` value wherever the incoming one is `***`. */
    if (definition) {
      const pool = workspaces.mcp(record.id)
      workspaces.writeMcp({
        id: record.id,
        servers: { ...(pool.servers || {}), [name]: definition },
        disabled: pool.disabled || {},
      })
    }
    const after = workspaces.mcp(record.id).servers[name] || null
    return {
      id: name,
      label: connectors.readIndex(record).rows[name]?.label || row.label || name,
      updated: true,
      beside: false,
      needsSignIn: Boolean(definition && hasRedacted(definition) && (!after || hasRedacted(after))),
    }
  }

  const id = present ? freeName(record, name) : name
  if (definition) {
    const pool = workspaces.mcp(record.id)
    workspaces.writeMcp({
      id: record.id,
      servers: { ...(pool.servers || {}), [id]: definition },
      disabled: pool.disabled || {},
    })
  }
  const index = connectors.readIndex(record)
  if (!index.rows[id]) {
    /* The same five fields the sender was allowed to write, and nothing else: a
       file is the least trusted thing this page reads, so it does not get to seed
       arbitrary bookkeeping. */
    connectors.writeIndex(record, {
      rows: {
        ...index.rows,
        [id]: {
          label: row.label || id,
          kind: row.kind || (definition ? 'mcp' : 'cli'),
          scope: 'workspace',
          mention: row.mention || '',
          oauth: row.oauth === true,
        },
      },
    })
  }
  const after = workspaces.mcp(record.id).servers[id] || null
  return {
    id,
    label: row.label || id,
    updated: false,
    beside: present,
    needsSignIn: definition ? hasRedacted(definition) && (!after || hasRedacted(after)) : true,
  }
}

module.exports = {
  SCHEMA,
  KIND,
  CONNECTOR_KIND,
  MIN_PASSPHRASE,
  PRESETS,
  downloadsDir,
  fileName,
  filePath,
  /* the seven verbs */
  send,
  inspect,
  apply,
  place,
  connectorSend,
  connectorInspect,
  connectorInstall,
  /* for the unit tests: pure shapes, no disk */
  collect,
  countsOf,
  encode,
  read,
  redact,
  hasRedacted,
}
