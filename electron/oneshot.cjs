/**
 * One harness turn, no chat, no workspace writes.
 *
 * The learning review and the follow-up suggestions both need the same thing:
 * run the person's own CLI once with a strict brief in a scratch directory and
 * return its text. This is a smaller sibling of `harness-review.cjs`, which
 * keeps its own copy because the sync guard must stay independent of anything
 * that changes here.
 *
 * The process is tracked by `child-registry`, so quitting the app kills it, and
 * it is killed again on timeout. A missing binary, a non-zero exit or empty
 * output is an error — the caller shows it instead of pretending nothing
 * happened.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnTracked, killTree } = require('./child-registry.cjs')
const harnesses = require('./harness-store.cjs')
const { oneShotInvocation } = require('./runner-local.cjs')

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 120_000

function runOneShot({
  harness,
  model = '',
  instruction = '',
  prompt = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  label = 'one-shot',
} = {}) {
  const id = String(harness || '')
  const meta = harnesses.META.find((item) => item.id === id)
  if (!meta) throw new Error('Choose a local harness first.')
  const spec = oneShotInvocation(id, instruction, prompt, model)
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-oneshot-'))

  let child
  let stdout = ''
  let stderr = ''
  let timedOut = false

  try {
    child = spawnTracked(spec.cmd, spec.argv, {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      kind: 'oneshot',
      label: `${label} (${id})`,
    })
  } catch (error) {
    fs.rmSync(cwd, { recursive: true, force: true })
    throw new Error(`The ${meta.label} CLI could not start: ${error?.message || error}`)
  }

  return new Promise((resolve, reject) => {
    const finish = (fn) => {
      clearTimeout(timer)
      fs.rmSync(cwd, { recursive: true, force: true })
      fn()
    }
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child, 'SIGKILL')
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      finish(() => reject(new Error(`The ${meta.label} CLI failed to start: ${error.message}`)))
    })
    child.on('close', (code) => {
      finish(() => {
        if (timedOut) {
          reject(new Error(`The ${meta.label} CLI did not answer within ${Math.round(timeoutMs / 1000)}s.`))
          return
        }
        if (code !== 0) {
          const detail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400)
          reject(
            new Error(
              `The ${meta.label} CLI exited with code ${code}${detail ? `: ${detail}` : '.'}`,
            ),
          )
          return
        }
        resolve({ text: stdout.trim(), harness: id, model: String(model || '') })
      })
    })

    try {
      if (spec.stdin) child.stdin.write(spec.stdin)
      child.stdin.end()
    } catch {
      /* the close/error handler reports a dead child */
    }
  })
}

/** The last JSON object in a model answer, ignoring fences and prose around it. */
function lastJson(text) {
  const value = String(text || '')
  const end = value.lastIndexOf('}')
  if (end < 0) return null
  const start = value.lastIndexOf('{', end)
  if (start < 0) return null
  try {
    return JSON.parse(value.slice(start, end + 1))
  } catch {
    return null
  }
}

module.exports = { runOneShot, lastJson }
