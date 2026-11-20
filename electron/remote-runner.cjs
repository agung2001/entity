/**
 * Run one chat turn on an ssh host.
 *
 * The transport is deliberately small: stage a throwaway copy of the workspace
 * with `scp`, run a fixed `run.sh`, stream the harness JSONL back over stdout,
 * then remove the remote directory. Nothing is installed on the host for a
 * normal turn except a skill the person explicitly attaches with `/workspace:`.
 *
 * Credentials stay in the user's ~/.ssh/config and agent. The workspace never
 * receives a key, and no prompt or path is interpolated into a shell command
 * without quoting.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { spawnTracked, killTree } = require('./child-registry.cjs')
const workspaces = require('./workspace-store.cjs')
const localData = require('./local-data.cjs')
const skillRef = require('./skill-ref.cjs')
const platform = require('./platform-brief.cjs')
const { chatInvocation } = require('./runner-local.cjs')
const { createParser } = require('./chat-transcript.cjs')

const SSH_OPTIONS = [
  '-T',
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=10',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=3',
  '-o',
  'StrictHostKeyChecking=accept-new',
  '-o',
  'LogLevel=ERROR',
]
const SCP_OPTIONS = ['-q', '-r', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'LogLevel=ERROR']
const HARNESS_IDLE_MS = 15 * 60 * 1000
const MAX_FILE_BYTES = 25 * 1024 * 1024
const MAX_OUTPUT_CHARS = 240_000

/* The artifact shelf is the only unbounded thing in a workspace: a working
   profile can hold hundreds of megabytes of renders and screenshots. Staging all
   of it made every remote turn wait a minute or more before the harness even
   started — and tripped the transfer timeout, which is how a turn came back with
   `scp failed: Command failed:` and no reason in it.
   
   So the turn gets the newest files up to a budget, and the prompt is told what
   stayed behind (see `artifactsNote`). Entities and skills are kilobytes and are
   always staged whole. */
const ARTIFACT_BUDGET_BYTES = Math.max(
  0,
  Math.round(Number(process.env.ENTITY_REMOTE_ARTIFACT_MB) * 1024 * 1024),
) || 24 * 1024 * 1024
const ARTIFACT_BUDGET_FILES = 120
const ARTIFACT_SCAN_CAP = 4000
/* A pessimistic floor for the uplink: the timeout follows the payload instead of
   being a constant that a big stage can never meet. */
const TRANSFER_BYTES_PER_MS = 400
const TRANSFER_FLOOR_MS = 120_000

const SKILL_ROOTS = {
  pi: '.pi/agent/skills',
  claude: '.claude/skills',
  opencode: '.config/opencode/skills',
  codex: '.codex/skills',
  gemini: '.gemini/skills',
  ollama: '.ollama/skills',
  antigravity: '.gemini/antigravity/skills',
}

const SKILL_LABELS = {
  pi: 'pi',
  claude: 'Claude Code',
  opencode: 'opencode',
  codex: 'Codex CLI',
  gemini: 'Gemini CLI',
  ollama: 'Ollama',
  antigravity: 'Antigravity',
}
const SKILL_LIST_ROOTS = {
  pi: ['.pi/agent/skills'],
  claude: ['.claude/skills'],
  opencode: ['.config/opencode/skills', '.opencode/skills'],
  codex: ['.codex/skills'],
  gemini: ['.gemini/skills'],
  ollama: ['.ollama/skills'],
  antigravity: ['.gemini/antigravity/skills', '.antigravity/skills'],
}

const homeCache = new Map()
const skillCache = new Map()
const SKILL_CACHE_MS = 30_000
const clean = (value) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
const quote = platform.shellQuote

function sshArgs(alias, command) {
  return [...SSH_OPTIONS, alias, command]
}

function runFile(bin, args, { timeout = 20_000, maxBuffer = 4 * 1024 * 1024, label = '' } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        /* A killed transfer reports no stderr at all, so the old message was the
           command line and nothing else. Name the thing that ran out. */
        if (error.killed || error.signal) {
          const seconds = Math.round(Number(timeout) / 1000)
          reject(new Error(`${bin} timed out after ${seconds} s${label ? ` (${label})` : ''}.`))
          return
        }
        const detail = String(stderr || error.message || error)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(-1)[0]
        reject(new Error(detail ? `${bin} failed: ${detail}` : `${bin} exited with code ${error.code ?? 'unknown'}.`))
        return
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

function sshText(alias, command, options) {
  return runFile('ssh', sshArgs(alias, command), options).then((result) => result.stdout)
}

async function remoteHome(alias) {
  if (homeCache.has(alias)) return homeCache.get(alias)
  const home = clean(await sshText(alias, 'printf %s "$HOME"'))
  if (!home || /\s/.test(home)) throw new Error(`${alias} did not return a usable home directory.`)
  homeCache.set(alias, home)
  return home
}

function remotePath(home, ...parts) {
  return [home, ...parts].join('/').replace(/\/+/g, '/')
}

function runId() {
  return `r_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function copyDirIfPresent(source, target) {
  if (!fs.existsSync(source)) return
  try {
    fs.cpSync(source, target, { recursive: true, force: true, dereference: true })
  } catch {
    /* a broken skill symlink or a special file must not abort the turn */
  }
}

/** Every real file under the shelf, newest-ready. Skipped: dotfiles and the
    `.tmp` files an interrupted artifact write leaves behind. */
function listArtifactFiles(root, rel = '', depth = 0, out = []) {
  if (out.length >= ARTIFACT_SCAN_CAP || depth > 6) return out
  let entries = []
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (!entry.isDirectory() && /\.tmp$/i.test(entry.name)) continue
    /* `conflicts/` is the sync engine's copy of files that disagreed, not the
       member's work. It is the largest thing on a shelf that has one (56 MB here)
       and staging it spent the whole budget on duplicates. */
    if (!rel && entry.isDirectory() && entry.name === 'conflicts') continue
    const next = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      listArtifactFiles(root, next, depth + 1, out)
      continue
    }
    if (!entry.isFile()) continue
    try {
      const stat = fs.statSync(path.join(root, next))
      out.push({ rel: next, size: stat.size, mtime: stat.mtimeMs })
    } catch {
      /* a file that vanished between readdir and stat */
    }
  }
  return out
}

/**
 * Copy the newest artifacts until the budget is spent, and report the rest.
 *
 * Newest first on purpose: a remote turn is about the work in progress, not
 * about a render from last month. The counts are what the prompt tells the
 * model, so an old file is *absent and named* rather than silently missing.
 */
function stageArtifacts(source, target, { maxBytes = ARTIFACT_BUDGET_BYTES, maxFiles = ARTIFACT_BUDGET_FILES } = {}) {
  const files = listArtifactFiles(source).sort((a, b) => b.mtime - a.mtime)
  const result = { staged: 0, skipped: 0, bytes: 0, skippedBytes: 0 }
  if (!files.length) return result
  let bytes = 0
  for (const file of files) {
    const overBudget = result.staged >= maxFiles || bytes + file.size > maxBytes
    if (overBudget) {
      result.skipped += 1
      result.skippedBytes += file.size
      continue
    }
    const to = path.join(target, file.rel)
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(path.join(source, file.rel), to)
      bytes += file.size
      result.staged += 1
    } catch {
      result.skipped += 1
      result.skippedBytes += file.size
    }
  }
  result.bytes = bytes
  return result
}

function stageWorkspace(record, stage) {
  const workspace = path.join(stage, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  for (const name of ['entities', 'skills']) {
    copyDirIfPresent(path.join(record.path, name), path.join(workspace, name))
  }
  const shelf = path.join(record.path, 'artifacts')
  const artifacts = fs.existsSync(shelf)
    ? stageArtifacts(shelf, path.join(workspace, 'artifacts'))
    : { staged: 0, skipped: 0, bytes: 0, skippedBytes: 0 }
  return { workspace, artifacts }
}

/** What the model is told when only part of the shelf travelled. */
function artifactsNote({ staged, skipped, skippedBytes }) {
  if (!skipped) return ''
  return [
    'Artifacts (only part of the shelf is staged on this host):',
    `- ${staged} most recent files are available under workspace/artifacts`,
    `- ${skipped} older files (${formatMb(skippedBytes)}) stayed on the machine that started this turn —`,
    '  say so if one of them is needed instead of assuming it is empty or missing.',
  ].join('\n')
}

function formatMb(bytes) {
  const mb = (Number(bytes) || 0) / (1024 * 1024)
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

/** Bytes on disk under a stage directory, for the transfer timeout. */
function dirBytes(dir, depth = 0) {
  if (depth > 8) return 0
  let total = 0
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += dirBytes(full, depth + 1)
    else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size
      } catch {
        /* gone since readdir */
      }
    }
  }
  return total
}

function transferTimeout(bytes) {
  return Math.max(TRANSFER_FLOOR_MS, TRANSFER_FLOOR_MS + Math.ceil(bytes / TRANSFER_BYTES_PER_MS))
}

function safeFileName(value, used) {
  const base = path.basename(String(value || 'file'))
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'file'
  let name = base
  let n = 2
  while (used.has(name)) {
    const ext = path.extname(base)
    name = `${path.basename(base, ext)}-${n++}${ext}`
  }
  used.add(name)
  return name
}

function stageFiles(attachments, stage) {
  const used = new Set()
  const files = []
  if (!attachments?.length) return { dir: '', files }
  const dir = path.join(stage, 'attachments')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const entry of attachments) {
    if (entry.kind !== 'file' || !entry.path) continue
    let stat
    try {
      stat = fs.statSync(entry.path)
    } catch {
      throw new Error(`Attached file does not exist: ${entry.path}`)
    }
    if (!stat.isFile()) throw new Error(`Attached path is not a file: ${entry.path}`)
    if (stat.size > MAX_FILE_BYTES) throw new Error(`Attached file is over 25 MB: ${entry.path}`)
    const name = safeFileName(entry.path, used)
    fs.copyFileSync(entry.path, path.join(dir, name))
    files.push({ name, original: entry.path })
  }
  return { dir, files }
}

function filesBlock(files, remoteDir) {
  if (!files.length) return ''
  return [
    'Attached files (temporary; available on this machine):',
    ...files.map((file) => `- ${remoteDir ? `${remoteDir}/${file.name}` : file.original}`),
  ].join('\n')
}

function buildScript({ harness, model, instructions, prompt }) {
  const spec = chatInvocation(harness, instructions, prompt, model)
  const stdin = Boolean(spec.stdin)
  const promptText = stdin
    ? spec.stdin
    : harness === 'opencode' || harness === 'ollama'
      ? spec.argv[spec.argv.length - 1]
      : harness === 'gemini'
        ? spec.argv[1]
        : prompt
  let args = spec.argv
  if (harness === 'opencode') {
    args = ['run']
    if (model) args.push('-m', model)
    args.push('$PROMPT')
  } else if (harness === 'gemini') {
    args = ['-p', '$PROMPT']
    if (model) args.push('-m', model)
  } else if (harness === 'ollama') {
    /* the model is positional and required; the prompt follows it */
    args = ['run', model || 'llama3.2', '$PROMPT']
  } else if (!stdin) {
    throw new Error(`${harness} is not supported for remote chat yet.`)
  }
  const rendered = args
    .map((arg) => (arg === '$PROMPT' ? '"$PROMPT"' : quote(arg)))
    .join(' ')
  const lines = [
    '#!/bin/sh',
    'set -eu',
    'DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    'cd "$DIR/workspace"',
    'trap \'kill 0 2>/dev/null || true\' HUP INT TERM',
    ...(stdin ? [] : ['PROMPT=$(cat "$DIR/prompt.txt")']),
    stdin ? `${harness} ${rendered} < "$DIR/prompt.txt"` : `${harness} ${rendered}`,
  ]
  return { script: `${lines.join('\n')}\n`, promptText, stdin }
}

async function downloadArtifacts(alias, remoteRun, record) {
  const target = path.join(record.path, 'artifacts')
  fs.mkdirSync(target, { recursive: true })
  try {
    await runFile(
      'scp',
      [...SCP_OPTIONS, `${alias}:${remoteRun}/workspace/artifacts/.`, `${target}/`],
      /* best effort, but a generated board render is megabytes: give it room and
         keep the failure silent, because the turn itself already succeeded */
      { timeout: TRANSFER_FLOOR_MS * 2, label: `artifacts back to this machine` },
    )
  } catch {
    /* no artifacts, or the host removed them; the turn itself already succeeded */
  }
}

function remoteSkillRoot(home, harness) {
  const rel = SKILL_ROOTS[harness]
  if (!rel) throw new Error(`${harness} has no known remote skill directory.`)
  return remotePath(home, rel)
}

async function installRemoteSkill({ alias, harness, skill }) {
  const home = await remoteHome(alias)
  const root = remoteSkillRoot(home, harness)
  const target = remotePath(home, SKILL_ROOTS[harness], skill.name)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const tempParent = remotePath(home, '.entity', 'remote-skills', stamp)
  const backup = remotePath(home, '.entity', 'backups', 'skills', stamp, harness)
  const localParent = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-remote-skill-'))
  const localSkill = path.join(localParent, skill.name)
  try {
    const source = skill.path
    const stat = fs.statSync(source)
    if (stat.isDirectory()) {
      fs.cpSync(source, localSkill, { recursive: true, force: true, dereference: true })
    } else {
      fs.mkdirSync(localSkill, { recursive: true, mode: 0o700 })
      fs.copyFileSync(source, path.join(localSkill, skill.entry || 'SKILL.md'))
    }

    await sshText(alias, `mkdir -p ${quote(root)} ${quote(tempParent)} ${quote(backup)} && chmod 700 ${quote(tempParent)} ${quote(backup)}`)
    await runFile(
      'scp',
      [...SCP_OPTIONS, localSkill, `${alias}:${tempParent}/`],
      { timeout: 60_000 },
    )
    const temp = remotePath(tempParent, skill.name)
    await sshText(
      alias,
      [
        `if [ -e ${quote(target)} ]; then mv ${quote(target)} ${quote(remotePath(backup, skill.name))}; fi`,
        `rm -rf ${quote(target)}`,
        `mv ${quote(temp)} ${quote(target)}`,
      ].join(' && '),
    )
    clearSkillCache(alias)
    return { target, backup, harness, name: skill.name }
  } finally {
    fs.rmSync(localParent, { recursive: true, force: true })
  }
}

/** Install a `/workspace:` skill on the target, then rewrite the prompt to it. */
async function rewriteSkill(record, text, { machine, harness } = {}) {
  const source = String(text || '')
  const ref = skillRef.parse(source)
  if (!ref) return { text: source, skill: null }
  const owned = !ref.bare && (ref.namespace === skillRef.WORKSPACE || Boolean(SKILL_ROOTS[ref.namespace]))
  let skill = null
  if (owned) {
    skill = skillRef.resolve(record, ref)
    if (!skill) throw new Error(`/${ref.namespace}:${ref.name} is not a skill this workspace can reach.`)
  } else if (ref.bare) {
    const found = skillRef.candidates(record, ref.name)
    if (!found.length) return { text: source, skill: null }
    if (found.length > 1) {
      throw new Error(
        `/${ref.name} is a skill in more than one library: ${found.map((entry) => `/${entry.namespace}:${entry.name}`).join(', ')}.`,
      )
    }
    skill = found[0]
  } else {
    return { text: source, skill: null }
  }

  if (!ref.local) {
    /* A single slash means "the skill is already on the target". Sending the
       local copy is opt-in with `//`, so a remote turn cannot silently overwrite
       the host's library. */
    const home = await remoteHome(machine)
    const target = remotePath(home, SKILL_ROOTS[harness], skill.name)
    const exists = String(
      await sshText(machine, `test -e ${quote(target)} && printf yes || true`),
    ).trim()
    if (!exists) {
      const hint = ref.bare ? `//${ref.name}` : `//${ref.namespace}:${ref.name}`
      throw new Error(`${skill.name} is not installed on ${machine}. Use ${hint} to send the local copy.`)
    }
    return {
      text: ref.rest ? `use this skill ${target}\n\n${ref.rest}` : `use this skill ${target}`,
      skill: { target, harness, name: skill.name, source: 'remote' },
    }
  }

  const installed = await installRemoteSkill({ alias: machine, harness, skill })
  return {
    text: ref.rest ? `use this skill ${installed.target}\n\n${ref.rest}` : `use this skill ${installed.target}`,
    skill: { ...installed, source: skill.path },
  }
}

async function run({ record, entity, thread, prompt, instructions, attachments = [], onStart, onStep, onChild }) {
  const alias = String(thread.machine || '')
  if (!alias || alias === 'local') throw new Error('Not a remote machine.')
  const facts = workspaces.machineFacts(record.id).hosts[alias]
  if (!facts) throw new Error(`${alias} has no capability snapshot. Run Test & scan on the Fleet page first.`)
  const harness = String(thread.harness || '')
  const installed = (facts.harnesses || []).find((entry) => entry.id === harness)
  if (!installed) throw new Error(`${harness} is not installed on ${alias}.`)
  if (attachments.some((entry) => entry.kind === 'mcp')) {
    throw new Error('MCP attachments are not available on a remote host yet.')
  }

  const model = thread.model || (thread.harness === entity.harness ? entity.model : '')
  const home = await remoteHome(alias)
  const id = runId()
  const remoteRoot = remotePath(home, '.entity', 'remote-runs', record.id)
  const remoteRun = remotePath(remoteRoot, id)
  const localParent = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-remote-'))
  const stage = path.join(localParent, id)
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 })

  try {
    const staged = stageWorkspace(record, stage)
    const files = stageFiles(attachments, stage)
    const fileBlock = filesBlock(files.files, remotePath(remoteRun, 'attachments'))
    const shelfNote = artifactsNote(staged.artifacts)
    const finalPrompt = [prompt.trim(), fileBlock, shelfNote].filter(Boolean).join('\n\n')
    const remoteInstructions = platform.compose({ record, entity, remote: true })
    const { script, promptText } = buildScript({
      harness,
      model,
      instructions: remoteInstructions,
      prompt: finalPrompt,
    })
    fs.writeFileSync(path.join(stage, 'prompt.txt'), promptText, { encoding: 'utf8', mode: 0o600 })
    fs.writeFileSync(path.join(stage, 'run.sh'), script, { encoding: 'utf8', mode: 0o755 })

    await sshText(alias, `mkdir -p ${quote(remoteRoot)} && chmod 700 ${quote(remoteRoot)}`)
    /* The transfer's deadline follows what is actually being sent: a fixed minute
       cannot hold a staged workspace on a home uplink, and when it cannot, the
       harness never starts. */
    const payload = dirBytes(stage)
    await runFile(
      'scp',
      [...SCP_OPTIONS, stage, `${alias}:${remoteRoot}/`],
      { timeout: transferTimeout(payload), label: `${formatMb(payload)} to ${alias}` },
    )

    const startedMs = Date.now()
    const execution = {
      harness,
      model: String(model || ''),
      machine: alias,
      remote: true,
      command: `ssh ${alias} sh run.sh`,
      cwd: remotePath(remoteRun, 'workspace'),
      startedAt: new Date(startedMs).toISOString(),
      status: 'running',
      ...(files.files.length ? { files: files.files.map((file) => file.original) } : {}),
    }
    onStart?.(execution)

    const result = await new Promise((resolve) => {
      const child = spawnTracked(
        'ssh',
        sshArgs(alias, `cd ${quote(remoteRun)} && sh run.sh`),
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          kind: 'chat',
          label: `${entity.name} · ${harness} · ${alias}`,
        },
      )
      onChild?.(child)
      const timing = { firstStepAt: '', firstTextAt: '' }
      const parser = createParser(harness, {
        onStep: (event) => {
          const at = new Date().toISOString()
          if (!timing.firstStepAt) timing.firstStepAt = at
          if (!timing.firstTextAt && event.step?.type === 'text' && (event.step.content || event.delta)) timing.firstTextAt = at
          onStep?.(event)
        },
      })
      let out = ''
      let err = ''
      let settled = false
      let idle = null
      const finish = (code, error) => {
        if (settled) return
        settled = true
        if (idle) clearTimeout(idle)
        const parsed = parser.finish()
        const detail = String(error || parsed.error || '').trim()
        const exitFailure = !detail && typeof code === 'number' && code !== 0
          ? String(err || '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || `exited with code ${code}`
          : ''
        const endedAt = new Date().toISOString()
        const firstStepMs = timing.firstStepAt
          ? Math.max(0, Date.parse(timing.firstStepAt) - startedMs)
          : null
        const firstTextMs = timing.firstTextAt
          ? Math.max(0, Date.parse(timing.firstTextAt) - startedMs)
          : null
        resolve({
          ok: !detail && !exitFailure,
          answer: parsed.answer || '',
          error: detail || exitFailure,
          steps: parsed.steps,
          execution: {
            ...execution,
            ...(timing.firstStepAt
              ? { firstStepAt: timing.firstStepAt, ttfbMs: firstStepMs }
              : {}),
            ...(timing.firstTextAt
              ? { firstTextAt: timing.firstTextAt, firstTextMs }
              : {}),
            endedAt,
            ms: Date.now() - startedMs,
            exitCode: typeof code === 'number' ? code : null,
            status: detail || exitFailure ? 'error' : 'ok',
          },
        })
      }
      const armIdle = () => {
        if (idle) clearTimeout(idle)
        idle = setTimeout(() => {
          killTree(child, 'SIGTERM')
          finish(null, 'The remote harness produced no output for 15 minutes.')
        }, HARNESS_IDLE_MS)
        if (typeof idle.unref === 'function') idle.unref()
      }
      child.on('error', (error) => finish(null, error?.message || 'ssh could not start.'))
      child.stdout?.on('data', (chunk) => {
        const text = String(chunk)
        out = (out + text).slice(-MAX_OUTPUT_CHARS)
        parser.push(text)
        armIdle()
      })
      child.stderr?.on('data', (chunk) => {
        err = (err + String(chunk)).slice(-MAX_OUTPUT_CHARS)
        armIdle()
      })
      child.on('close', (code) => finish(typeof code === 'number' ? code : null, ''))
      armIdle()
    })

    if (result.ok) await downloadArtifacts(alias, remoteRun, record)
    return result
  } finally {
    fs.rmSync(localParent, { recursive: true, force: true })
    try {
      await sshText(alias, `rm -rf ${quote(remoteRun)}`, { timeout: 15_000 })
    } catch {
      /* the host may be gone; the next cleanup has the same path */
    }
  }
}

async function listSkills(alias) {
  const target = String(alias || '').trim()
  if (!target || target === 'local' || target.startsWith('-')) {
    throw new Error('Pick a remote host to list skills.')
  }
  const fleet = localData.readSshHosts()
  if (!fleet.hosts.some((host) => host.alias === target || host.aliases?.includes(target))) {
    throw new Error(`${target} is not in ~/.ssh/config.`)
  }
  const cached = skillCache.get(target)
  if (cached && Date.now() - cached.at < SKILL_CACHE_MS) return cached.value

  const script = []
  for (const [harness, roots] of Object.entries(SKILL_LIST_ROOTS)) {
    for (const root of roots) {
      script.push(
        `for d in "$HOME/${root}"/*; do [ -d "$d" ] && printf '${harness}\t%s\t%s\n' "$(basename "$d")" "$d"; done`,
      )
    }
  }
  script.push('true')
  const text = await sshText(target, script.join('\n'), { timeout: 20_000 })
  const seen = new Set()
  const items = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const [harness, name, skillPath] = line.split('\t')
    if (!harness || !name) continue
    const key = `${harness}:${name}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push({
      name,
      harness,
      harnessLabel: SKILL_LABELS[harness] || harness,
      path: skillPath || '',
      machine: target,
    })
  }
  items.sort((a, b) => a.harness.localeCompare(b.harness) || a.name.localeCompare(b.name))
  const value = { machine: target, items, count: items.length, scannedAt: new Date().toISOString() }
  skillCache.set(target, { at: Date.now(), value })
  return value
}

function clearSkillCache(alias) {
  if (!alias) skillCache.clear()
  else skillCache.delete(String(alias))
}

module.exports = {
  run,
  rewriteSkill,
  listSkills,
  clearSkillCache,
  buildScript,
  stageFiles,
  stageArtifacts,
  listArtifactFiles,
  artifactsNote,
  transferTimeout,
  SKILL_ROOTS,
}
