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

const SKILL_ROOTS = {
  pi: '.pi/agent/skills',
  claude: '.claude/skills',
  opencode: '.config/opencode/skills',
  codex: '.codex/skills',
  gemini: '.gemini/skills',
  antigravity: '.gemini/antigravity/skills',
}

const homeCache = new Map()
const clean = (value) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
const quote = platform.shellQuote

function sshArgs(alias, command) {
  return [...SSH_OPTIONS, alias, command]
}

function runFile(bin, args, { timeout = 20_000, maxBuffer = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
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

function stageWorkspace(record, stage) {
  const workspace = path.join(stage, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  for (const name of ['entities', 'artifacts', 'skills']) {
    copyDirIfPresent(path.join(record.path, name), path.join(workspace, name))
  }
  return workspace
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
    : harness === 'opencode'
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
      { timeout: 30_000 },
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
    stageWorkspace(record, stage)
    const files = stageFiles(attachments, stage)
    const fileBlock = filesBlock(files.files, remotePath(remoteRun, 'attachments'))
    const finalPrompt = fileBlock ? `${prompt.trim()}\n\n${fileBlock}` : prompt
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
    await runFile(
      'scp',
      [...SCP_OPTIONS, stage, `${alias}:${remoteRoot}/`],
      { timeout: 60_000 },
    )

    const execution = {
      harness,
      model: String(model || ''),
      machine: alias,
      remote: true,
      command: `ssh ${alias} sh run.sh`,
      cwd: remotePath(remoteRun, 'workspace'),
      startedAt: new Date().toISOString(),
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
      const parser = createParser(harness, { onStep })
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
        resolve({
          ok: !detail && !exitFailure,
          answer: parsed.answer || '',
          error: detail || exitFailure,
          steps: parsed.steps,
          execution: { ...execution, status: detail || exitFailure ? 'error' : 'ok' },
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

module.exports = {
  run,
  rewriteSkill,
  buildScript,
  stageFiles,
  SKILL_ROOTS,
}
