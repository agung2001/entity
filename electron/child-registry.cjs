/**
 * Every long-lived child this app starts goes through here.
 *
 * Why this module exists. A harness CLI (`claude`, `pi`, `codex`, `gemini`,
 * `opencode`) is not one process. It spawns MCP servers, shells, and sometimes a
 * headless browser to screenshot the thing it just built. `child.kill()` signals
 * only the leader, so the grandchildren survive their parent, escape to PPID 1,
 * and keep burning CPU long after the window is gone. On a real machine that
 * looked like six orphaned headless-Chrome trees eating ~500% CPU for 40 minutes
 * after the script that started them had died.
 *
 * So two rules:
 *
 *   1. A child is spawned as its own process-group leader on POSIX (`detached`),
 *      and stopped by signalling the *group* (`-pid`) — harness, MCP servers and
 *      browser alike. Windows has no group signal, so `taskkill /T` walks the
 *      tree instead.
 *   2. Every live child is written to a pid journal in the temp directory. A
 *      hard kill (crash, `kill -9`, force quit) runs no handler, so the next
 *      boot reaps whatever the previous one left behind — after proving the pid
 *      still belongs to the process we started, because pids get reused.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const IS_WINDOWS = process.platform === 'win32'
const POSIX = !IS_WINDOWS
const GRACE_MS = 3000
const POLL_MS = 50
/** Clock skew allowed between our record and the kernel's start time. */
const START_SKEW_MS = 5000

/** pid → { pid, kind, label, cmd, startedAt } for children owned by this process */
const live = new Map()

function uidTag() {
  if (typeof process.getuid === 'function') return String(process.getuid())
  return String(process.env.USERNAME || process.env.USER || 'user').replace(/[^a-z0-9_-]/gi, '')
}

/** One journal per process, so two app instances never overwrite each other. */
function journalPath(pid = process.pid) {
  return path.join(os.tmpdir(), `entity-children-${uidTag()}-${pid}.json`)
}

function journalPrefix() {
  return `entity-children-${uidTag()}-`
}

function readJournal(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeJournal() {
  const file = journalPath()
  if (live.size === 0) {
    try {
      fs.unlinkSync(file)
    } catch {
      /* already gone */
    }
    return
  }
  const temp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify([...live.values()]), 'utf8')
    /* rename is atomic: a reader never sees half a journal */
    fs.renameSync(temp, file)
  } catch {
    try {
      fs.unlinkSync(temp)
    } catch {
      /* nothing to clean up */
    }
  }
}

/**
 * Alive *and* ours to signal — a pid owned by another user answers EPERM.
 *
 * A zombie answers `kill(pid, 0)` with success until it is reaped, so liveness
 * has to look at the state as well. Otherwise a stopped child is reported as
 * "still running", the grace period is spent waiting for nothing, and the
 * shutdown path lies about what it did.
 */
function isAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch (error) {
    return error?.code === 'EPERM'
  }
  if (IS_WINDOWS) return true
  const out = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
  if (out.status !== 0) return false
  return !String(out.stdout || '').trim().startsWith('Z')
}

/**
 * What the pid looks like right now, used to prove a journalled pid has not been
 * recycled by an unrelated process. Returns `{ pgid, command }` on POSIX and
 * `{ image }` on Windows, or null when the pid is gone.
 */
function describe(pid) {
  if (IS_WINDOWS) {
    const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    if (out.status !== 0) return null
    const match = /^"([^"]+)","(\d+)"/.exec(String(out.stdout || '').trim())
    if (!match || Number(match[2]) !== pid) return null
    return { image: match[1] }
  }
  const out = spawnSync('ps', ['-o', 'pgid=,command=', '-p', String(pid)], { encoding: 'utf8' })
  if (out.status !== 0) return null
  const match = /^(\d+)\s+(.*)$/.exec(String(out.stdout || '').trim())
  if (!match) return null
  return { pgid: Number(match[1]), command: match[2] }
}

function commandMatches(info, cmd) {
  const wanted = path.basename(String(cmd || '')).replace(/\.exe$/i, '')
  if (!wanted) return false
  const seen = IS_WINDOWS ? info.image : info.command
  return String(seen || '').toLowerCase().includes(wanted.toLowerCase())
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : -1
}

/**
 * Who is still in a process group.
 *
 * The leader is not the group. A CLI that backgrounds a browser and then exits
 * leaves the browser in the group with a dead leader — which is exactly how the
 * orphans this module exists for are made, so the reaper cannot ask "is the
 * leader alive?" and go home.
 */
function groupScan(pgid) {
  if (!POSIX) return []
  const out = spawnSync('ps', ['-eo', 'pid=,pgid=,uid=,lstart='], { encoding: 'utf8' })
  if (out.status !== 0) return []
  const members = []
  for (const line of String(out.stdout || '').split('\n')) {
    /* lstart carries spaces: "Thu Nov 12 15:30:00 2026" */
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line.trim())
    if (!match || Number(match[2]) !== pgid) continue
    const startedAt = new Date(match[4]).getTime()
    members.push({ pid: Number(match[1]), uid: Number(match[3]), startedAt })
  }
  return members
}

/**
 * Kill a child and everything it spawned.
 *
 * `target` is a ChildProcess or a bare pid. On POSIX the negative pid is the
 * group this module created at spawn time; if that is already gone we fall back
 * to the child's own signal so a caller with a non-detached process still works.
 */
function killTree(target, signal = 'SIGTERM') {
  const pid = typeof target === 'number' ? target : target?.pid
  if (!Number.isFinite(pid) || pid <= 0) return false

  if (IS_WINDOWS) {
    /* `/T` is the tree, `/F` is the force. A graceful Windows shutdown of a
       console tree is not something we can ask for, so any stop is a force. */
    const out = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    return out.status === 0
  }

  try {
    process.kill(-pid, signal)
    return true
  } catch {
    try {
      if (typeof target?.kill === 'function') {
        target.kill(signal)
        return true
      }
    } catch {
      /* it exited between the check and the signal */
    }
    return false
  }
}

function describeChild(child) {
  if (!child || typeof child.pid !== 'number') return null
  return {
    pid: child.pid,
    pgid: POSIX ? child.pid : null,
    startedAt: Date.now(),
  }
}

function register(record) {
  live.set(record.pid, record)
  writeJournal()
}

function forget(pid) {
  if (!Number.isFinite(pid)) return
  if (live.delete(pid)) writeJournal()
}

/**
 * The only spawn wrapper in the app for work that outlives a request.
 *
 * Caller-supplied options win, except two we own: `shell` stays closed (the argv
 * array is the contract, and a harness name is never a command line) and
 * `detached` stays on so the child leads its own group and can be stopped as a
 * tree.
 */
function spawnTracked(cmd, argv, options = {}) {
  const { kind = 'child', label = '', ...spawnOptions } = options
  const child = spawn(cmd, argv, {
    windowsHide: true,
    ...spawnOptions,
    shell: false,
    /* Own process group so the tree can be signalled as one. Not on Windows:
       there `detached` only detaches the console, and `taskkill /T` is the tree. */
    detached: POSIX,
  })

  if (typeof child.pid === 'number') {
    register({
      pid: child.pid,
      ...describeChild(child),
      kind,
      label,
      cmd: String(cmd),
    })
  }

  /* A child that exits or fails to start must not linger in the journal, or the
     next boot spends its time chasing pids that are already gone. */
  child.once('exit', () => forget(child.pid))
  child.once('error', () => forget(child.pid))

  return child
}

function activeCount() {
  return live.size
}

/** The records this process is currently responsible for. */
function active() {
  return [...live.values()]
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Stop everything, gracefully first.
 *
 * SIGTERM lets a harness flush its transcript and close its own MCP servers;
 * anything still breathing after `graceMs` gets SIGKILL on the group. Callers
 * that cannot await (a signal handler) use `stopAllSync`.
 */
async function stopAll({ graceMs = GRACE_MS } = {}) {
  const entries = [...live.values()]
  if (!entries.length) return { stopped: 0, killed: 0 }

  for (const entry of entries) killTree(entry.pid, 'SIGTERM')

  const deadline = Date.now() + Math.max(0, graceMs)
  while (Date.now() < deadline) {
    if (!entries.some((entry) => isAlive(entry.pid))) break
    await sleep(POLL_MS)
  }

  let killed = 0
  for (const entry of entries) {
    if (isAlive(entry.pid)) {
      killTree(entry.pid, 'SIGKILL')
      killed += 1
    }
    forget(entry.pid)
  }
  return { stopped: entries.length, killed }
}

/** Last-resort handler for `process.on('exit')`, where promises never run. */
function stopAllSync() {
  for (const entry of [...live.values()]) {
    killTree(entry.pid, 'SIGKILL')
    forget(entry.pid)
  }
}

/**
 * Kill what a previous instance left behind.
 *
 * Called once at boot by both transports. A journal is only trusted when its
 * owning process is dead. Then, per record:
 *
 *   - leader alive, still a group leader, command line still matches → kill the
 *     group (three independent reasons not to shoot an unrelated process that
 *     inherited a recycled pid);
 *   - leader gone but the group still holds processes, all of them this user's
 *     and all started at or after the spawn we recorded → kill the group. That
 *     is the orphaned-helpers case: the launcher exited, the browser it started
 *     did not.
 */
function reapOrphans({ log = () => {} } = {}) {
  const dir = os.tmpdir()
  const prefix = journalPrefix()
  let files = []
  try {
    files = fs.readdirSync(dir).filter((file) => file.startsWith(prefix) && file.endsWith('.json'))
  } catch {
    return []
  }

  const uid = currentUid()
  const reaped = []
  for (const name of files) {
    const owner = Number(name.slice(prefix.length, -'.json'.length))
    /* A live owner still owns its children; only the dead leave orphans. */
    if (!Number.isFinite(owner) || owner === process.pid || isAlive(owner)) continue

    const file = path.join(dir, name)
    const entries = readJournal(file)
    for (const entry of entries) {
      const pid = entry?.pid
      if (!Number.isFinite(pid) || pid === process.pid) continue

      const info = isAlive(pid) ? describe(pid) : null
      if (info && (!POSIX || (info.pgid === pid && commandMatches(info, entry.cmd)))) {
        killTree(pid, 'SIGKILL')
        reaped.push(entry)
        log(`reaped orphan ${pid} ${entry.label || entry.cmd || ''}`.trim())
        continue
      }
      if (!POSIX) continue

      /* The leader is gone. If anything it started is still in its group, that
         is the leak — but only when the group is provably ours, which needs the
         spawn time we recorded. A journal without one is not evidence. */
      const spawnedAt = Number(entry.startedAt) || 0
      if (spawnedAt <= 0) continue
      const group = groupScan(pid)
      if (!group.length) continue
      const ours = group.every(
        (member) => member.uid === uid && member.startedAt >= spawnedAt - START_SKEW_MS,
      )
      if (!ours) continue
      killTree(pid, 'SIGKILL')
      reaped.push(entry)
      log(`reaped orphaned group ${pid} (${group.length} process(es)) ${entry.label || ''}`.trim())
    }
    try {
      fs.unlinkSync(file)
    } catch {
      /* another instance cleaned it up first */
    }
  }
  return reaped
}

module.exports = {
  spawnTracked,
  killTree,
  stopAll,
  stopAllSync,
  reapOrphans,
  activeCount,
  active,
  isAlive,
  journalPath,
  describe,
}
