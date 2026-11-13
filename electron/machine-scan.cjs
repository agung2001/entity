/**
 * Read a machine's installed agent harnesses and the models each one exposes.
 *
 * `local` is read in-process. An ssh host runs `fleet-scan.sh` over stdin, so
 * the remote needs nothing but a POSIX shell. Nothing is written remotely and
 * no key or ssh config is copied into the workspace: the snapshot is a fact
 * about the host, not a credential.
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const localData = require('./local-data.cjs')
const harnesses = require('./harness-store.cjs')
const workspaces = require('./workspace-store.cjs')

const SCRIPT = fs.readFileSync(path.join(__dirname, 'fleet-scan.sh'), 'utf8')
const SSH_TIMEOUT_MS = 25_000
const MAX_OUTPUT = 4 * 1024 * 1024
const MAX_MODELS = 2_000
const MAX_STRING = 512

const clean = (value, limit = MAX_STRING) =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, limit)

function hostFor(alias) {
  const fleet = localData.readSshHosts()
  return (
    fleet.hosts.find(
      (host) => host.alias === alias || host.id === alias || host.aliases?.includes(alias),
    ) || null
  )
}

function cleanHarness(entry) {
  const id = clean(entry.id, 40)
  const models = [...new Set((entry.models || []).map((model) => clean(model, 240)).filter(Boolean))]
    .slice(0, MAX_MODELS)
  return {
    id,
    label: clean(entry.label, 80) || id,
    path: clean(entry.path, 1_024),
    models,
    default: clean(entry.default, 240),
    source: ['cli', 'config', 'none'].includes(entry.source) ? entry.source : 'none',
  }
}

function normaliseHarnesses(list) {
  const byId = new Map()
  for (const entry of Array.isArray(list) ? list : []) {
    const id = clean(entry?.id, 40)
    if (!id || byId.has(id)) continue
    byId.set(id, cleanHarness(entry))
  }
  const order = new Map(harnesses.META.map((meta, index) => [meta.id, index]))
  return [...byId.values()].sort(
    (a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99) || a.id.localeCompare(b.id),
  )
}

/** Turn the TSV from fleet-scan.sh into the same shape the local scan returns. */
function parseScan(text) {
  const facts = { hostname: '', platform: '', arch: '', harnesses: [] }
  const byId = new Map()
  let sawMeta = false
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line) continue
    const [kind, ...rest] = line.split('\t')
    if (kind === 'meta') {
      sawMeta = true
      facts.hostname = clean(rest[0], 255)
      facts.platform = clean(rest[1], 80)
      facts.arch = clean(rest[2], 80)
    } else if (kind === 'harness') {
      const [id, label, file] = rest.map((value) => clean(value))
      if (!id) continue
      byId.set(id, { id, label: label || id, path: file, models: [], default: '', source: 'none' })
    } else if (kind === 'model') {
      const [id, model] = [clean(rest[0], 40), clean(rest[1], 240)]
      const entry = byId.get(id)
      if (!entry || !model) continue
      if (entry.models.length < MAX_MODELS) entry.models.push(model)
    } else if (kind === 'default') {
      const [id, model] = [clean(rest[0], 40), clean(rest[1], 240)]
      const entry = byId.get(id)
      if (entry && model) entry.default = model
    }
  }
  if (!sawMeta) throw new Error('The host did not return a capability report.')
  for (const entry of byId.values()) {
    if (entry.models.length) entry.source = 'cli'
    else if (entry.default) entry.source = 'config'
    if (entry.default && !entry.models.includes(entry.default)) {
      entry.models.unshift(entry.default)
    }
  }
  facts.harnesses = normaliseHarnesses([...byId.values()])
  return facts
}

function scanLocal() {
  const started = Date.now()
  const snapshot = harnesses.snapshot()
  return {
    alias: 'local',
    label: clean(snapshot.hostname).replace(/\.local$/i, '') || 'local',
    spec: snapshot.hostname,
    status: 'ok',
    source: 'local',
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    hostname: clean(snapshot.hostname, 255),
    platform: clean(snapshot.platform, 80),
    arch: clean(snapshot.arch, 80),
    harnesses: normaliseHarnesses(snapshot.harnesses),
  }
}

function runRemote(alias) {
  const args = [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=5',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'LogLevel=ERROR',
    alias,
    'sh -s',
  ]

  return new Promise((resolve, reject) => {
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    let done = false
    let timer = null
    const finish = (error, value) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(new Error(`The capability scan timed out after ${SSH_TIMEOUT_MS / 1000} seconds.`))
    }, SSH_TIMEOUT_MS)

    /* ssh can close stdin before the script ends (auth failure, no remote
       shell); that EPIPE must not become an uncaught stream error. */
    child.stdin.on('error', () => {})
    child.on('error', (error) => {
      finish(
        error.code === 'ENOENT'
          ? new Error('The local ssh client is not installed.')
          : new Error(clean(error.message, 300) || 'ssh could not start.'),
      )
    })
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
      if (Buffer.byteLength(stdout) > MAX_OUTPUT) {
        child.kill('SIGTERM')
        finish(new Error('The host returned more data than expected.'))
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4_000)
    })
    child.on('close', (code) => {
      if (done) return
      if (code !== 0) {
        const detail = String(stderr || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(-1)[0]
        finish(new Error(detail ? `ssh failed: ${clean(detail, 300)}` : `ssh exited with code ${code}.`))
        return
      }
      finish(null, stdout)
    })
    try {
      child.stdin.end(SCRIPT)
    } catch (error) {
      finish(new Error(clean(error.message, 300) || 'Could not send the scan script.'))
    }
  })
}

async function scan({ alias } = {}) {
  const target = String(alias || '').trim()
  if (!target || target.startsWith('-')) throw new Error('Pick a host to test.')
  if (target === 'local') return scanLocal()

  const host = hostFor(target)
  if (!host) throw new Error(`${target} is not in ~/.ssh/config.`)
  const probe = await localData.probeSshHost(target)
  if (!probe.ok) throw new Error(probe.message || `${target} is not reachable.`)

  const started = Date.now()
  const text = await runRemote(target)
  const parsed = parseScan(text)
  return {
    alias: target,
    label: clean(host.label, 120) || target,
    spec: clean(host.spec, 255),
    status: 'ok',
    source: 'ssh',
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    ...parsed,
  }
}

/** Probe, scan, and persist the snapshot in this workspace. */
async function scanAndSave({ id, alias } = {}) {
  if (!id) throw new Error('Open a workspace first.')
  const facts = await scan({ alias })
  workspaces.saveMachineFacts({ id, alias: facts.alias, facts })
  return facts
}

module.exports = {
  scan,
  scanAndSave,
  parseScan,
  scanLocal,
}
