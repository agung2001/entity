/**
 * Running an entity on this machine.
 *
 * One harness process per run, spawned with an argv array (never a shell), the
 * prompt on **stdin**, and `cwd` set to the entity's `dir`. Output is coalesced
 * per 50 ms and appended to `<ws>/runs/<runId>.jsonl`, so the run survives a
 * reload of the window and dies with the app — which is stated, not hidden.
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnTracked, killTree } = require('./child-registry.cjs')
const entities = require('./entity-store.cjs')
const workspaces = require('./workspace-store.cjs')
const skillRef = require('./skill-ref.cjs')
const artifacts = require('./artifact-store.cjs')
const harnesses = require('./harness-store.cjs')
const platform = require('./platform-brief.cjs')
const { expandHome } = require('./frontmatter.cjs')

const COALESCE_MS = 50
const KILL_AFTER_MS = 3000
/* How many run files the list reads before giving up on the tail of history. */
const MAX_RUNS_SCANNED = 400

/* Each harness takes instructions differently. Only claude and pi have a real
   system prompt; the rest get the file prepended to the prompt text. */
function invocation(harness, instructions, prompt, mcpFile, strict, model = '') {
  const preface = `${instructions.trim()}\n\n---\n\n${prompt}`
  const chosen = String(model || '').trim()
  switch (harness) {
    case 'claude': {
      const argv = ['-p', '--append-system-prompt', instructions]
      if (chosen) argv.push('--model', chosen)
      if (mcpFile) argv.push('--mcp-config', mcpFile)
      if (mcpFile && strict) argv.push('--strict-mcp-config')
      return { cmd: 'claude', argv, stdin: prompt, system: true }
    }
    case 'pi': {
      const argv = ['-p', '--append-system-prompt', instructions]
      if (chosen) argv.push('--model', chosen)
      return { cmd: 'pi', argv, stdin: prompt, system: true }
    }
    case 'opencode': {
      /* `opencode run` takes the message as a positional argument */
      const argv = ['run']
      if (chosen) argv.push('-m', chosen)
      argv.push(preface)
      return { cmd: 'opencode', argv, stdin: '', system: false }
    }
    case 'codex': {
      const argv = ['exec', '-', '--skip-git-repo-check']
      if (chosen) argv.push('-m', chosen)
      return { cmd: 'codex', argv, stdin: preface, system: false }
    }
    case 'gemini': {
      /* `-p/--prompt` is the prompt value; stdin would duplicate it */
      const argv = ['-p', preface]
      if (chosen) argv.push('-m', chosen)
      return { cmd: 'gemini', argv, stdin: '', system: false }
    }
    default:
      throw new Error(`The harness "${harness}" has no known invocation.`)
  }
}

/**
 * Chat invocations use each CLI's JSONL stream. The plain `invocation` above is
 * kept for entity runs, which only need the final text and whose logs are
 * already append-only run files.
 */
function chatInvocation(harness, instructions, prompt, model = '') {
  const preface = `${instructions.trim()}\n\n---\n\n${prompt}`
  const chosen = String(model || '').trim()
  switch (harness) {
    case 'claude': {
      const argv = [
        '-p',
        '--append-system-prompt',
        instructions,
        '--output-format',
        'stream-json',
        '--verbose',
      ]
      if (chosen) argv.push('--model', chosen)
      return { cmd: 'claude', argv, stdin: prompt, system: true }
    }
    case 'pi': {
      const argv = ['-p', '--append-system-prompt', instructions, '--mode', 'json']
      if (chosen) argv.push('--model', chosen)
      return { cmd: 'pi', argv, stdin: prompt, system: true }
    }
    case 'opencode': {
      const argv = ['run', '--format', 'json', '--thinking']
      if (chosen) argv.push('-m', chosen)
      argv.push(preface)
      return { cmd: 'opencode', argv, stdin: '', system: false }
    }
    case 'codex': {
      const argv = ['exec', '-', '--skip-git-repo-check', '--json']
      if (chosen) argv.push('-m', chosen)
      return { cmd: 'codex', argv, stdin: preface, system: false }
    }
    case 'gemini': {
      const argv = ['-p', preface, '--output-format', 'stream-json']
      if (chosen) argv.push('-m', chosen)
      return { cmd: 'gemini', argv, stdin: '', system: false }
    }
    default:
      throw new Error(`The harness "${harness}" has no known invocation.`)
  }
}

/** claude's own MCP file shape, filtered to the entity's `mcp:` list. */
function writeClaudeMcp(record, runId, entity) {
  const pool = workspaces.mcp(record.id)
  const servers = {}
  for (const name of entity.mcp) {
    const entry = pool.servers[name]
    if (entry) servers[name] = entry
  }
  const file = path.join(record.path, 'runs', `.mcp-${runId}.json`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, 'utf8')
  return { file, count: Object.keys(servers).length }
}

function newRunId() {
  return `r_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function readRunFile(record, file, isActive) {
  let text = ''
  try {
    text = fs.readFileSync(path.join(record.path, 'runs', file), 'utf8')
  } catch {
    return null
  }
  let meta = {}
  let status = 'queued'
  let exit = null
  let lastAt = null
  let lastError = ''

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    lastAt = event.at || lastAt
    if (event.kind === 'state' || event.kind === 'exit') {
      if (event.kind === 'state') {
        if (!meta.entity) meta = { ...meta, ...event.data }
        if (event.data?.error) lastError = event.data.error
        status = event.data?.status || status
      } else {
        exit = event.data || {}
        status = exit.code === 0 ? 'ok' : 'error'
        if (exit.canceled) status = 'canceled'
      }
    }
  }

  /* A run that still says `running` but has no child in this process died with
     the hub. It is reported as canceled; the log is left untouched. */
  let note = ''
  if (status === 'running' && !isActive) {
    status = 'canceled'
    note = 'hub closed'
  }

  return {
    id: path.basename(file, '.jsonl'),
    workspace: record.id,
    entity: meta.entity || '',
    harness: meta.harness || '',
    dir: meta.dir || '',
    prompt: meta.prompt || '',
    skill: meta.skill || null,
    status,
    startedAt: meta.startedAt || null,
    endedAt: exit?.endedAt || lastAt,
    exitCode: exit?.code ?? null,
    ms: exit?.ms ?? null,
    error: lastError || meta.error || '',
    note,
  }
}

function createRunner({ emit = () => {} } = {}) {
  /** runId → live run */
  const active = new Map()
  /** `${workspace}/${entity}` → runId — one run per entity, on purpose */
  const locks = new Map()

  function runsDir(workspaceId) {
    return path.join(workspaces.open(workspaceId).path, 'runs')
  }

  function publish(run, kind, data) {
    run.seq += 1
    const event = { runId: run.runId, workspace: run.workspace, seq: run.seq, at: new Date().toISOString(), kind, data }
    try {
      fs.appendFileSync(run.file, `${JSON.stringify(event)}\n`, 'utf8')
    } catch {
      /* the stream still reaches the window */
    }
    emit(event)
    return event
  }

  function flush(run, kind) {
    const buffer = kind === 'stdout' ? run.outBuf : run.errBuf
    if (!buffer.length) return
    const text = buffer.join('')
    if (kind === 'stdout') run.outBuf = []
    else run.errBuf = []
    publish(run, kind, text)
  }

  function schedule(run, kind) {
    if (kind === 'stdout') {
      if (run.outTimer) return
      run.outTimer = setTimeout(() => {
        run.outTimer = null
        flush(run, 'stdout')
      }, COALESCE_MS)
    } else {
      if (run.errTimer) return
      run.errTimer = setTimeout(() => {
        run.errTimer = null
        flush(run, 'stderr')
      }, COALESCE_MS)
    }
  }

  function cleanup(run) {
    clearTimeout(run.outTimer)
    clearTimeout(run.errTimer)
    run.outTimer = run.errTimer = null
    flush(run, 'stdout')
    flush(run, 'stderr')
    if (run.mcpFile) {
      try {
        fs.rmSync(run.mcpFile, { force: true })
      } catch {
        /* the run directory is disposable */
      }
    }
    active.delete(run.runId)
    const key = `${run.workspace}/${run.entity}`
    if (locks.get(key) === run.runId) locks.delete(key)
  }

  function finish(run, { code = null, canceled = false, error = '' } = {}) {
    if (run.finished) return
    run.finished = true
    clearTimeout(run.killTimer)

    if (run.outTimer) {
      clearTimeout(run.outTimer)
      run.outTimer = null
    }
    if (run.errTimer) {
      clearTimeout(run.errTimer)
      run.errTimer = null
    }
    flush(run, 'stdout')
    flush(run, 'stderr')

    const endedAt = new Date().toISOString()
    const ms = run.startedAt ? Date.now() - run.startedMs : 0
    const status = canceled ? 'canceled' : code === 0 ? 'ok' : 'error'
    if (error) publish(run, 'state', { status: 'error', error, endedAt })
    publish(run, 'exit', { code, ms, endedAt, canceled })
    if (run.mcpFile) {
      try {
        fs.rmSync(run.mcpFile, { force: true })
      } catch {
        /* nothing to remove */
      }
      run.mcpFile = ''
    }
    run.status = status
    run.exitCode = code
    run.endedAt = endedAt
    active.delete(run.runId)
    const key = `${run.workspace}/${run.entity}`
    if (locks.get(key) === run.runId) locks.delete(key)
  }

  function start({ workspace, name, prompt }) {
    const entity = entities.read(workspace, name)
    if (!entity) throw new Error(`No entity called "${name}" in this workspace.`)
    if (!prompt || !String(prompt).trim()) throw new Error('Write a prompt first.')

    const key = `${workspace}/${entity.name}`
    if (locks.has(key)) throw new Error(`${entity.name} is already running.`)

    const dir = entities.resolveDir(entity)
    const record = workspaces.open(workspace)
    /* `/workspace:<skill>` or `/<harness>:<skill>` is resolved to a path and the
       prompt becomes `use this skill <path>`; a reference that does not resolve
       throws here, before a run id is spent */
    const applied = skillRef.rewrite(record, String(prompt))
    const runId = newRunId()
    const run = {
      runId,
      workspace,
      entity: entity.name,
      harness: entity.harness,
      dir,
      seq: 0,
      status: 'running',
      outBuf: [],
      errBuf: [],
      outTimer: null,
      errTimer: null,
      killTimer: null,
      finished: false,
      mcpFile: '',
      file: path.join(runsDir(workspace), `${runId}.jsonl`),
      startedMs: Date.now(),
      startedAt: new Date().toISOString(),
    }

    let mcpFile = ''
    if (entity.harness === 'claude' && record.mcpStrict) {
      const written = writeClaudeMcp(record, runId, entity)
      mcpFile = written.file
      run.mcpFile = written.file
    }

    /* Two compositions, one source. `platform.compose` owns the precedence —
       platform brief, workspace context, then this entity's own body — so a
       chat turn and a run cannot tell the same agent different things. The
       artifact shelf is scope furniture and goes last. */
    const instructions = platform.compose({
      record,
      entity,
      extra: artifacts.brief(workspace),
    })
    const spec = invocation(
      entity.harness,
      instructions,
      applied.text,
      mcpFile,
      record.mcpStrict,
      entity.model,
    )
    spec.cmd = harnesses.binary(entity.harness) || spec.cmd
    locks.set(key, runId)
    active.set(runId, run)

    publish(run, 'state', {
      status: 'running',
      entity: entity.name,
      harness: entity.harness,
      dir,
      /* `prompt` is what the user typed; `skill` is what it resolved to */
      prompt: String(prompt),
      skill: applied.ref
        ? {
            namespace: applied.ref.namespace,
            label: applied.ref.label,
            name: applied.ref.name,
            path: applied.ref.path,
          }
        : null,
      startedAt: run.startedAt,
      mcp: mcpFile ? entity.mcp.filter((server) => workspaces.mcp(workspace).servers[server]) : [],
      systemPrompt: spec.system,
    })

    let child
    try {
      /* Tracked, not merely spawned: a harness brings its own MCP servers and
         helper processes, and all of them have to die with the run. */
      child = spawnTracked(spec.cmd, spec.argv, {
        cwd: dir,
        env: { ...process.env, ...platform.env({ record, entity }) },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        kind: 'run',
        label: `${entity.name} · ${entity.harness}`,
      })
    } catch (error) {
      finish(run, { error: String(error?.message || error) })
      throw error
    }

    run.child = child

    child.on('error', (error) => {
      const missing = error?.code === 'ENOENT'
      finish(run, {
        error: missing
          ? `${spec.cmd} is not installed on this machine, or not on PATH.`
          : String(error?.message || error),
      })
    })

    child.stdout?.on('data', (chunk) => {
      run.outBuf.push(String(chunk))
      schedule(run, 'stdout')
    })
    child.stderr?.on('data', (chunk) => {
      run.errBuf.push(String(chunk))
      schedule(run, 'stderr')
    })

    child.on('close', (code, signal) => {
      finish(run, { code: typeof code === 'number' ? code : null, canceled: run.canceled || signal === 'SIGTERM' })
    })

    child.stdin?.on('error', () => {
      /* a harness that exits before reading stdin is not a hub error */
    })
    try {
      child.stdin?.write(spec.stdin)
      child.stdin?.end()
    } catch {
      /* the close handler reports the failure */
    }

    return {
      runId,
      entity: entity.name,
      harness: entity.harness,
      dir,
      systemPrompt: spec.system,
    }
  }

  function cancel({ runId }) {
    const run = active.get(String(runId || ''))
    if (!run || !run.child) return { canceled: false, reason: 'not running' }
    if (run.canceled) return { canceled: true, reason: 'already stopping' }
    run.canceled = true
    /* The group, not the leader: a harness's MCP servers and browsers are
       children of the harness, and killing only the harness orphans them. */
    killTree(run.child, 'SIGTERM')
    clearTimeout(run.killTimer)
    run.killTimer = setTimeout(() => killTree(run.child, 'SIGKILL'), KILL_AFTER_MS)
    publish(run, 'state', { status: 'canceled', note: 'SIGTERM' })
    return { canceled: true }
  }

  /** Newest first, with the effective status of every run in this workspace. */
  function list({ workspace }) {
    const record = workspaces.open(workspace)
    let files = []
    try {
      files = fs
        .readdirSync(path.join(record.path, 'runs'))
        .filter((file) => file.endsWith('.jsonl') && !file.startsWith('.'))
    } catch {
      return []
    }
    /* A workspace accumulates runs forever; parse the newest ones. The cap is
       generous enough that the journal still looks complete in practice. */
    const newest = files
      .map((file) => {
        try {
          return { file, mtime: fs.statSync(path.join(record.path, 'runs', file)).mtimeMs }
        } catch {
          return { file, mtime: 0 }
        }
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_RUNS_SCANNED)
      .map((entry) => entry.file)

    return newest
      .map((file) => readRunFile(record, file, active.has(path.basename(file, '.jsonl'))))
      .filter(Boolean)
      .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))
  }

  /** entity name → its most recent run, for the table's state column. */
  function latest({ workspace }) {
    const map = {}
    for (const run of list({ workspace })) {
      if (!run.entity || map[run.entity]) continue
      map[run.entity] = run
    }
    return map
  }

  function snapshot({ workspace, runId }) {
    const run = active.get(String(runId || ''))
    if (!run) return null
    return {
      runId: run.runId,
      workspace: run.workspace,
      entity: run.entity,
      harness: run.harness,
      dir: run.dir,
      status: run.status,
    }
  }

  function closeAll() {
    for (const run of active.values()) {
      killTree(run.child, 'SIGTERM')
      cleanup(run)
    }
  }

  return { start, cancel, list, latest, snapshot, closeAll, activeCount: () => active.size }
}

module.exports = { createRunner, invocation, chatInvocation, HARNESSES: entities.HARNESSES }
