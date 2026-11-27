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

const SCRIPT = fs
  .readFileSync(path.join(__dirname, 'fleet-scan.sh'), 'utf8')
  /* The script is piped to a POSIX shell on the other end. A Windows checkout
     (`core.autocrlf=true`) reads it with CRLF, and dash sees `set -u\r` as an
     illegal option and aborts before printing any capability line. Send LF. */
  .replace(/\r\n?/g, '\n')
const SSH_TIMEOUT_MS = 25_000
const REPORT_TIMEOUT_MS = 10_000
const MAX_OUTPUT = 8 * 1024 * 1024
const MAX_MODELS = 2_000
const MAX_STRING = 512
/* The report is a page, not an archive: a host with 900 containers is a host
   whose first 200 are the honest answer, and the tab badge keeps the total. */
const MAX_CRON = 200
const MAX_DOCKER = 200
const MAX_SKILLS = 2_000
const MAX_ORCA = 500
const MAX_ANOMALIES = 200
const LOCAL_SHELL_ERROR = 'the local report needs a POSIX shell'

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

/* ── the report ───────────────────────────────────────────────────────────
   Five field groups the page draws as five tabs. `fleet-scan.sh` emits them as
   flat records; this is where each one becomes a shape the renderer can read
   without guessing, and where a group with nothing behind it becomes `null`.
   A null group is the page's honesty note — an empty table would read as "this
   host has no cron jobs", which is a different sentence. */

const safeNumber = (value) => {
  const text = clean(value, 40)
  if (!text) return null
  const number = Number(text)
  return Number.isFinite(number) ? number : null
}

const pick = (object, keys) => {
  if (!object || typeof object !== 'object') return undefined
  for (const key of keys) {
    const value = object[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

function newReport() {
  return {
    overview: { seen: false, values: {}, disks: [] },
    cron: { seen: false, entries: [], timers: [], files: 0 },
    docker: { seen: false, version: '', containers: [], images: [], disk: [] },
    skills: { seen: false, roots: [], items: [] },
    orca: { seen: false, values: {}, json: null, rows: [], anomalies: [], terminals: [] },
    errors: {},
  }
}

/* The runtime's field names are not this app's contract, and `orca status
   --json` has changed shape before. Every read is `??`-guarded and every miss
   becomes an empty string, because this parser is the app's only path to a
   host's health: a throw here would blank all five sections. */
function orcaConnection(value) {
  if (!value) return ''
  if (typeof value !== 'object') return clean(value, 80)
  const kind = clean(pick(value, ['kind', 'type', 'name', 'transport']) ?? '', 40)
  const port = clean(pick(value, ['port']) ?? '', 12)
  return clean([kind, port ? `port ${port}` : ''].filter(Boolean).join(' · '), 80)
}

function orcaFromJson(json) {
  const root = json?.result && typeof json.result === 'object' ? json.result : json
  const runtime = root?.runtime && typeof root.runtime === 'object' ? root.runtime : root || {}
  const app = root?.app && typeof root.app === 'object' ? root.app : {}
  const running = pick(app, ['running']) ?? pick(root, ['running', 'reachable'])
  const worktrees = pick(root, ['worktrees', 'rows'])
  const terminals = pick(root, ['terminals', 'sessions'])
  const anomalies = pick(root, ['anomalies'])
  const list = (value) => (Array.isArray(value) ? value : [])
  return {
    values: {
      reachable: running === true ? 'yes' : running === false ? 'no' : clean(running ?? '', 60),
      state: clean(pick(runtime, ['state', 'status']) ?? '', 60),
      connection: orcaConnection(
        pick(runtime, ['connection', 'transport', 'endpoint']) ?? pick(root, ['connection']),
      ),
      runtime_id: clean(
        pick(runtime, ['id', 'runtimeId', 'runtime_id']) ?? pick(root, ['runtimeId', 'runtime_id']) ?? '',
        80,
      ),
      worktrees: Array.isArray(worktrees) ? worktrees.length : pick(root, ['worktreeCount']),
      agents: Array.isArray(pick(root, ['agents']))
        ? root.agents.length
        : pick(root, ['agentCount', 'agents_total']),
      terminals_connected: pick(root, ['terminalsConnected', 'terminals_connected']),
      terminals_total: Array.isArray(terminals)
        ? terminals.length
        : pick(root, ['terminalsTotal', 'terminals_total']),
      host_memory: pick(root, ['hostMemory', 'host_memory', 'memoryPercent']),
      host: pick(root, ['host', 'hostname']),
      version: pick(root, ['version', 'appVersion']) ?? pick(app, ['version']),
    },
    rows: list(worktrees).map((entry) => ({
      path: clean(pick(entry, ['path', 'name', 'id']) ?? '', 240),
      branch: clean(pick(entry, ['branch']) ?? '', 120),
      state: clean(pick(entry, ['state', 'status']) ?? '', 40),
    })),
    anomalies: list(anomalies).map((entry) => ({
      entity: clean(pick(entry, ['entity', 'worktree', 'terminal', 'id']) ?? '', 120),
      kind: clean(pick(entry, ['kind', 'type']) ?? '', 40),
      detail: clean(pick(entry, ['detail', 'message', 'text']) ?? '', 300),
    })),
    terminals: list(terminals).map((entry) => ({
      id: clean(pick(entry, ['id', 'terminal', 'number']) ?? '', 40),
      worktree: clean(pick(entry, ['worktree', 'workspace', 'title']) ?? '', 160),
      state: clean(pick(entry, ['state', 'status']) ?? '', 40),
      last: clean(pick(entry, ['last', 'updatedAt', 'lastActivity']) ?? '', 60),
    })),
  }
}

function reportRecord(state, kind, rest) {
  if (kind === 'ovf') {
    const key = clean(rest[0], 40)
    if (!key) return
    state.overview.seen = true
    state.overview.values[key] = rest[1] ?? ''
  } else if (kind === 'disk') {
    const [mount, fs, size, used, avail, usePct] = rest.map((value) => clean(value, 240))
    if (!mount) return
    state.overview.seen = true
    state.overview.disks.push({ mount, fs, size, used, avail, usePct: safeNumber(String(usePct).replace('%', '')) })
  } else if (kind === 'cron') {
    const [schedule, user, source, command] = rest.map((value) => clean(value, 400))
    if (!schedule) return
    state.cron.seen = true
    if (state.cron.entries.length < MAX_CRON) {
      state.cron.entries.push({
        schedule,
        user,
        source: ['user', 'system', 'dropin'].includes(source) ? source : 'user',
        command,
      })
    }
  } else if (kind === 'timer') {
    const unit = clean(rest[0], 200)
    if (!unit) return
    state.cron.seen = true
    if (state.cron.timers.length < MAX_CRON) state.cron.timers.push({ unit, next: clean(rest[1], 80) })
  } else if (kind === 'docker') {
    const [name, image, status, ports, uptime] = rest.map((value) => clean(value, 240))
    if (!name) return
    state.docker.seen = true
    if (state.docker.containers.length < MAX_DOCKER) {
      state.docker.containers.push({ name, image, state: status, ports, uptime })
    }
  } else if (kind === 'image') {
    const ref = clean(rest[0], 240)
    if (!ref) return
    state.docker.seen = true
    if (state.docker.images.length < MAX_DOCKER) state.docker.images.push({ ref, size: clean(rest[1], 40) })
  } else if (kind === 'ddisk') {
    const type = clean(rest[0], 60)
    if (!type) return
    state.docker.seen = true
    state.docker.disk.push({
      type,
      count: safeNumber(rest[1]),
      size: clean(rest[2], 40),
      reclaimable: clean(rest[3], 40),
    })
  } else if (kind === 'skillroot') {
    const path = clean(rest[0], 400)
    if (!path) return
    state.skills.seen = true
    state.skills.roots.push({ path, count: safeNumber(rest[1]) ?? 0 })
  } else if (kind === 'skill') {
    const name = clean(rest[1], 160)
    if (!name) return
    state.skills.seen = true
    if (state.skills.items.length < MAX_SKILLS) {
      state.skills.items.push({
        root: clean(rest[0], 400),
        name,
        described: clean(rest[2]) === '1',
      })
    }
  } else if (kind === 'worktree') {
    state.orca.seen = true
    if (state.orca.rows.length < MAX_ORCA) {
      state.orca.rows.push({
        path: clean(rest[0], 240),
        branch: clean(rest[1], 120),
        state: clean(rest[2], 40),
      })
    }
  } else if (kind === 'anomaly') {
    state.orca.seen = true
    if (state.orca.anomalies.length < MAX_ANOMALIES) {
      state.orca.anomalies.push({
        entity: clean(rest[0], 120),
        kind: clean(rest[1], 40),
        detail: clean(rest[2], 300),
      })
    }
  } else if (kind === 'term') {
    state.orca.seen = true
    if (state.orca.terminals.length < MAX_ORCA) {
      state.orca.terminals.push({
        id: clean(rest[0], 40),
        worktree: clean(rest[1], 160),
        state: clean(rest[2], 40),
        last: clean(rest[3], 60),
      })
    }
  } else if (kind === 'set') {
    const group = clean(rest[0], 20)
    const key = clean(rest[1], 40)
    const value = rest[2] ?? ''
    if (!key) return
    if (group === 'cron') {
      state.cron.seen = true
      if (key === 'files') state.cron.files = safeNumber(value) ?? 0
    } else if (group === 'docker') {
      state.docker.seen = true
      if (key === 'version') state.docker.version = clean(value, 40)
    }
  } else if (kind === 'orcaf') {
    const key = clean(rest[0], 40)
    if (!key) return
    if (key === 'raw') {
      try {
        state.orca.json = JSON.parse(rest.slice(1).join('\t'))
        state.orca.seen = true
      } catch {
        state.errors.orca = 'the runtime status was not readable JSON'
      }
      return
    }
    state.orca.seen = true
    state.orca.values[key] = rest[1] ?? ''
  } else if (kind === 'error') {
    const group = clean(rest[0], 20)
    if (!['overview', 'cron', 'docker', 'skills', 'orca'].includes(group)) return
    state.errors[group] = clean(rest[1], 300) || 'the probe failed'
  }
}

function finishReport(state) {
  const report = {
    version: 1,
    overview: null,
    cron: null,
    docker: null,
    skills: null,
    orca: null,
    errors: state.errors,
  }

  if (state.overview.seen) {
    const values = state.overview.values
    report.overview = {
      uptimeSec: safeNumber(values.uptime_sec),
      bootedAt: clean(values.booted_at, 60),
      load1: safeNumber(values.load1),
      load5: safeNumber(values.load5),
      load15: safeNumber(values.load15),
      cores: safeNumber(values.cores),
      memTotalKb: safeNumber(values.mem_total_kb),
      memAvailKb: safeNumber(values.mem_avail_kb),
      swapTotalKb: safeNumber(values.swap_total_kb),
      swapFreeKb: safeNumber(values.swap_free_kb),
      kernel: clean(values.kernel, 120),
      os: clean(values.os, 120),
      cpu: clean(values.cpu, 160),
      clock: clean(values.clock, 60),
      disks: state.overview.disks,
    }
  }

  if (state.cron.seen) {
    const entries = state.cron.entries
    report.cron = {
      entries,
      timers: state.cron.timers,
      users: new Set(entries.map((entry) => entry.user).filter(Boolean)).size,
      files: state.cron.files,
    }
  }

  if (state.docker.seen) {
    report.docker = {
      version: state.docker.version,
      containers: state.docker.containers,
      images: state.docker.images,
      disk: state.docker.disk,
    }
  }

  if (state.skills.seen) {
    report.skills = {
      roots: state.skills.roots,
      items: state.skills.items,
      total: state.skills.items.length,
      described: state.skills.items.filter((item) => item.described).length,
    }
  }

  if (state.orca.seen) {
    const fromJson = state.orca.json ? orcaFromJson(state.orca.json) : null
    const text = (key) => clean(state.orca.values[key] ?? fromJson?.values?.[key] ?? '', 120)
    const count = (key) => safeNumber(state.orca.values[key] ?? fromJson?.values?.[key])
    /* A host that emits the worktree/timer records itself wins over a runtime
       JSON that has to be guessed at; `fleet-scan.sh` emits only the JSON. */
    const rows = (state.orca.rows.length ? state.orca.rows : fromJson?.rows || []).slice(0, MAX_ORCA)
    const anomalies = (state.orca.anomalies.length ? state.orca.anomalies : fromJson?.anomalies || []).slice(
      0,
      MAX_ANOMALIES,
    )
    const terminals = (state.orca.terminals.length ? state.orca.terminals : fromJson?.terminals || []).slice(
      0,
      MAX_ORCA,
    )
    report.orca = {
      reachable: text('reachable'),
      state: text('state'),
      connection: text('connection'),
      runtimeId: text('runtime_id'),
      worktrees: count('worktrees') ?? rows.length,
      agents: count('agents'),
      terminalsConnected: count('terminals_connected'),
      terminalsTotal: count('terminals_total') ?? terminals.length,
      hostMemory: count('host_memory'),
      host: text('host'),
      version: clean(state.orca.values.version ?? fromJson?.values?.version ?? '', 40),
      rows,
      anomalies,
      terminals,
    }
  }

  return report
}

/** Turn the TSV from fleet-scan.sh into the same shape the local scan returns. */
function parseScan(text) {
  const facts = { hostname: '', platform: '', arch: '', harnesses: [] }
  const byId = new Map()
  const report = newReport()
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
    } else {
      reportRecord(report, kind, rest)
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
  facts.report = finishReport(report)
  return facts
}

/* The report section runs here too, through the same script: a Mac reading
   itself should not describe itself with a second implementation. `sh -s` is
   the one thing that can be missing on Windows, and a missing shell costs the
   report — never the harness snapshot beside it. */
function localReport() {
  return new Promise((resolve) => {
    let timer = null
    let done = false
    const finish = (report) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve(report)
    }
    const failed = (reason) => ({
      version: 1,
      overview: null,
      cron: null,
      docker: null,
      skills: null,
      orca: null,
      errors: { overview: reason },
    })

    let child = null
    try {
      child = spawn('sh', ['-s'], {
        env: { ...process.env, REPORT_ONLY: '1' },
        windowsHide: true,
      })
    } catch {
      finish(failed(LOCAL_SHELL_ERROR))
      return
    }

    let stdout = ''
    timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      finish(failed('the local report timed out'))
    }, REPORT_TIMEOUT_MS)

    child.stdin.on('error', () => {})
    child.on('error', () => finish(failed(LOCAL_SHELL_ERROR)))
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
      if (Buffer.byteLength(stdout) > MAX_OUTPUT) {
        try {
          child.kill('SIGTERM')
        } catch {
          /* already gone */
        }
        finish(failed('the local report was larger than expected'))
      }
    })
    child.stderr.on('data', () => {})
    child.on('close', (code) => {
      if (done) return
      if (code !== 0) {
        finish(failed(LOCAL_SHELL_ERROR))
        return
      }
      try {
        finish(parseScan(stdout).report)
      } catch {
        finish(failed(LOCAL_SHELL_ERROR))
      }
    })
    try {
      child.stdin.end(SCRIPT)
    } catch {
      finish(failed(LOCAL_SHELL_ERROR))
    }
  })
}

async function scanLocal() {
  const started = Date.now()
  const snapshot = harnesses.snapshot()
  const report = await localReport()
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
    report,
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
