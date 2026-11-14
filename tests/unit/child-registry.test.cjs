/**
 * The failure these tests pin down is the one that started this module: a
 * harness that spawns helpers, and a `child.kill()` that only reaches the
 * leader. Everything below asserts on real processes, because the bug was real
 * processes outliving their parent.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const registry = require('../../electron/child-registry.cjs')

const POSIX = process.platform !== 'win32'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Every pid in a process group, read the same way the reaper reads it. */
function groupMembers(pgid) {
  if (!POSIX) return []
  const out = require('node:child_process').spawnSync('ps', ['-eo', 'pid=,pgid=,command='], {
    encoding: 'utf8',
  })
  return String(out.stdout || '')
    .split('\n')
    .map((line) => line.trim().split(/\s+/, 3))
    .filter((parts) => Number(parts[1]) === pgid)
    .map((parts) => Number(parts[0]))
}

async function waitFor(check, ms = 3000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await sleep(20)
  }
  return false
}

test('a tracked child is journalled while it runs and forgotten once it exits', async () => {
  if (!POSIX) return
  const file = registry.journalPath()
  const child = registry.spawnTracked('sh', ['-c', 'sleep 30'], { kind: 'test', label: 'sleeper' })
  try {
    assert.equal(registry.activeCount() >= 1, true)
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'))
    const entry = journal.find((item) => item.pid === child.pid)
    assert.ok(entry, 'the live child is in the journal')
    assert.equal(entry.kind, 'test')
    assert.equal(entry.cmd, 'sh')
  } finally {
    registry.killTree(child, 'SIGKILL')
  }

  assert.equal(await waitFor(() => !registry.isAlive(child.pid)), true, 'the child is gone')
  assert.equal(await waitFor(() => registry.activeCount() === 0), true)
})

test('killTree reaches grandchildren, not just the leader', async () => {
  if (!POSIX) return
  /* One group leader that starts a helper of its own — the shape of a harness
     with an MCP server, or a CLI that screenshots the app it just built. */
  const child = registry.spawnTracked('sh', ['-c', 'sleep 30 & sleep 30'], { kind: 'test' })
  const grandchild = await (async () => {
    await waitFor(() => groupMembers(child.pid).length >= 2)
    return groupMembers(child.pid).find((pid) => pid !== child.pid)
  })()
  assert.ok(grandchild, 'the leader has a helper in its group')

  registry.killTree(child, 'SIGKILL')

  assert.equal(await waitFor(() => groupMembers(child.pid).length === 0), true, 'the group is empty')
  assert.equal(registry.isAlive(grandchild), false, 'the grandchild did not survive')
})

test('stopAll escalates to SIGKILL when a child ignores SIGTERM', async () => {
  if (!POSIX) return
  const child = registry.spawnTracked('sh', ['-c', 'trap "" TERM; sleep 30'], { kind: 'test' })
  await sleep(100)
  assert.equal(registry.isAlive(child.pid), true)

  await registry.stopAll({ graceMs: 150 })

  assert.equal(registry.isAlive(child.pid), false)
  assert.equal(registry.activeCount(), 0)
})

test('reapOrphans kills a dead owner\'s children and spares a recycled pid', async () => {
  if (!POSIX) return
  /* A live process we do not own the journal for: its command line must not
     match, so the reaper has to leave it alone even though the pid is real. */
  const stranger = require('node:child_process').spawn('sleep', ['30'], {
    detached: true,
    stdio: 'ignore',
  })
  stranger.unref()

  /* The pid of an owner that has definitely exited. */
  const dead = await new Promise((resolve) => {
    const gone = require('node:child_process').spawn('sh', ['-c', 'exit 0'], { stdio: 'ignore' })
    gone.on('exit', () => resolve(gone.pid))
  })

  const orphan = registry.spawnTracked('sleep', ['30'], { kind: 'test' })
  const claimed = registry.spawnTracked('sleep', ['30'], { kind: 'test' })

  /* Hand these two children to the dead owner: one record matches its command,
     the other lies about it. */
  const file = registry.journalPath(dead)
  fs.writeFileSync(
    file,
    JSON.stringify([
      { pid: orphan.pid, pgid: null, kind: 'run', label: 'real', cmd: 'sleep' },
      { pid: stranger.pid, pgid: null, kind: 'run', label: 'lie', cmd: 'not-this-command' },
    ]),
    'utf8',
  )

  try {
    const reaped = registry.reapOrphans()
    assert.equal(reaped.length, 1)
    assert.equal(reaped[0].pid, orphan.pid)

    assert.equal(await waitFor(() => !registry.isAlive(orphan.pid)), true, 'the orphan is gone')
    assert.equal(registry.isAlive(stranger.pid), true, 'the unrelated process is untouched')
    assert.equal(fs.existsSync(file), false, 'the stale journal is cleaned up')
  } finally {
    registry.killTree(orphan, 'SIGKILL')
    registry.killTree(claimed, 'SIGKILL')
    try {
      process.kill(stranger.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
    try {
      fs.unlinkSync(file)
    } catch {
      /* already gone */
    }
  }
})

test('reapOrphans leaves a live owner\'s journal alone', async () => {
  const file = registry.journalPath()
  const child = registry.spawnTracked('sleep', ['30'], { kind: 'test' })
  try {
    assert.equal(fs.existsSync(file), true)
    /* Our own journal must never be reaped by us or by a second boot while this
       process is alive. */
    const reaped = registry.reapOrphans()
    assert.equal(reaped.length, 0)
    assert.equal(registry.isAlive(child.pid), true)
  } finally {
    registry.killTree(child, 'SIGKILL')
  }
  assert.equal(await waitFor(() => registry.activeCount() === 0), true)
})

test('the journal lives under the temp directory, one file per process', () => {
  assert.equal(path.dirname(registry.journalPath()), os.tmpdir())
  assert.match(path.basename(registry.journalPath()), /^entity-children-.+-\d+\.json$/)
  assert.notEqual(registry.journalPath(1), registry.journalPath(2))
})

test('reapOrphans kills the group when the leader died but its helpers did not', async () => {
  if (!POSIX) return
  /* The real shape of the leak: a launcher backgrounds a browser, then exits.
     The leader is gone, so asking "is the leader alive" would miss it. */
  const child = registry.spawnTracked('sh', ['-c', 'sleep 30 & exit 0'], { kind: 'test' })
  const spawnedAt = Date.now()
  const helper = await (async () => {
    await waitFor(() => !registry.isAlive(child.pid) && groupMembers(child.pid).length >= 1)
    return groupMembers(child.pid)[0]
  })()
  assert.ok(helper, 'the helper outlived its leader')

  const deadOwner = await new Promise((resolve) => {
    const gone = require('node:child_process').spawn('sh', ['-c', 'exit 0'], { stdio: 'ignore' })
    gone.on('exit', () => resolve(gone.pid))
  })
  const file = registry.journalPath(deadOwner)
  fs.writeFileSync(
    file,
    JSON.stringify([{ pid: child.pid, pgid: child.pid, startedAt: spawnedAt, cmd: 'sh', kind: 'run' }]),
    'utf8',
  )

  try {
    const reaped = registry.reapOrphans()
    assert.equal(reaped.length, 1, 'the orphaned group was reaped')
    assert.equal(await waitFor(() => !registry.isAlive(helper)), true, 'the helper is gone')
    assert.equal(groupMembers(child.pid).length, 0)
  } finally {
    try {
      process.kill(helper, 'SIGKILL')
    } catch {
      /* already gone */
    }
    try {
      fs.unlinkSync(file)
    } catch {
      /* already gone */
    }
  }
})
