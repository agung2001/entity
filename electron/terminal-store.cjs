/**
 * The chat terminal: one interactive shell, on this machine or on a fleet host.
 *
 * Why a pty at all. A shell reading from a pipe has no line editing, no prompt
 * redraw and no way to run a full-screen program: `zsh -i` would print a prompt
 * and then silently ignore every keystroke. Both paths therefore hand the child
 * a real terminal:
 *
 *   remote  `ssh -tt <alias> '<stty>; exec $SHELL -il'`
 *   linux   `script -q -c '<stty>; exec $SHELL -il' /dev/null`
 *   macOS   `python3 -c '<pty.spawn(...)>'`
 *
 * No native module and no `electron-rebuild`, so the relay is an existing
 * binary. Which one is not a preference — it is what the platform allows:
 *
 *   - util-linux `script` relays whatever it is handed, so Linux is fine.
 *   - **macOS `script` is not usable here.** It calls `tcgetattr` on its own
 *     stdin and exits with `tcgetattr/ioctl: Operation not supported on socket`
 *     when that stdin is not a terminal. Electron always hands a child a
 *     socketpair, so it always fails — a prompt-shaped window that never
 *     echoes a key. `python3` (Command Line Tools) allocates the pty itself and
 *     asks nothing of its stdin, so it is the macOS relay.
 *
 * The cost of either relay is geometry — see `resize()`: a pty we do not own
 * cannot be resized from this process, so the shell is told its size once, at
 * open, and later panel widths are reflowed by the emulator, not by the pty.
 *
 * Nothing here takes a command from the renderer. The shell is the user's own
 * `$SHELL`, the directory must already exist, and the ssh alias must be one
 * `~/.ssh/config` names — a thread's machine is a picker, not a string.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnTracked, killTree } = require('./child-registry.cjs')

const IS_WINDOWS = process.platform === 'win32'
/** One window should not be able to fork an unbounded number of shells. */
const MAX_SESSIONS = 4
/** Scrollback kept in memory so a toggled panel comes back where it was. */
const MAX_BUFFER = 96 * 1024
const ALIAS_RE = /^[A-Za-z0-9._@-]+$/
const DEFAULT_COLS = 100
const DEFAULT_ROWS = 24
/** Where a python3 usually lives when it is not first on PATH. */
const PYTHON_CANDIDATES = ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3']

/**
 * The macOS relay, as a program small enough to read in one screen: allocate a
 * pty, size it, hand it to the user's shell, and copy bytes both ways. pty.spawn
 * leaves the real stdin alone, which is the whole point (see the header).
 */
const PYTHON_RELAY = `import os, pty
cols = int(os.environ["ENTITY_TERM_COLS"])
rows = int(os.environ["ENTITY_TERM_ROWS"])
shell = os.environ["ENTITY_TERM_SHELL"]
inner = 'stty rows %d cols %d 2>/dev/null; exec "%s" -il' % (rows, cols, shell)
pty.spawn(["/bin/sh", "-c", inner])`

const sessions = new Map()
let seq = 0

function clampSize(value, fallback, low, high) {
  const number = Math.round(Number(value))
  if (!Number.isFinite(number)) return fallback
  return Math.min(high, Math.max(low, number))
}

/** The shell to run: the user's own, if it is still there. */
function resolveShell(env = process.env) {
  const declared = String(env.SHELL || '').trim()
  if (declared && path.isAbsolute(declared) && fs.existsSync(declared)) return declared
  for (const candidate of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (fs.existsSync(candidate)) return candidate
  }
  return '/bin/sh'
}

/**
 * `stty` runs *inside* the pty, before the shell starts, so the geometry is
 * right before the first prompt paints — and nothing is echoed. The values come
 * from the environment, so no path or number is ever spliced into a command.
 */
function sized() {
  return 'stty rows "$ENTITY_TERM_ROWS" cols "$ENTITY_TERM_COLS" 2>/dev/null; exec "$ENTITY_TERM_SHELL" -il'
}

/** A python3 that can be spawned, or '' when there is none to be found. */
function resolvePython(env = process.env, candidates = PYTHON_CANDIDATES) {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, 'python3')
    if (fs.existsSync(candidate)) return candidate
  }
  return ''
}

/**
 * The pty relay this platform can actually drive, as a `{ cmd, argv }` pair.
 * Throws with the reason when there is none, because a missing relay otherwise
 * looks like a shell that starts and then ignores the keyboard.
 */
function localRelay({ platform = process.platform, env = process.env, candidates = PYTHON_CANDIDATES } = {}) {
  if (platform === 'darwin') {
    const python = resolvePython(env, candidates)
    if (!python) {
      throw new Error(
        'This Mac has no python3, which the terminal needs to allocate a pty (macOS `script` cannot do it). ' +
          'Install the Command Line Tools, or open the thread on a fleet host.',
      )
    }
    return { cmd: python, argv: ['-c', PYTHON_RELAY], relay: 'python3' }
  }
  /* util-linux `script`: -c <command>, then the typescript file. */
  return {
    cmd: fs.existsSync('/usr/bin/script') ? '/usr/bin/script' : 'script',
    argv: ['-q', '-c', sized(), '/dev/null'],
    relay: 'script',
  }
}

/**
 * The argv for one session. Exported because it is the only part worth testing
 * without a terminal: a wrong relay is a silent failure (a prompt that never
 * echoes), and the alias rule is a security boundary.
 */
function buildCommand({ machine = 'local', dir = '', cols, rows, shell, platform = process.platform } = {}) {
  const geometry = { cols: clampSize(cols, DEFAULT_COLS, 20, 400), rows: clampSize(rows, DEFAULT_ROWS, 5, 200) }
  const chosen = shell || resolveShell()
  const env = {
    ENTITY_TERM_COLS: String(geometry.cols),
    ENTITY_TERM_ROWS: String(geometry.rows),
    ENTITY_TERM_SHELL: chosen,
  }

  /* `local` (and an omitted machine) is this machine; anything else has to be
     an alias, including the empty string, which is a caller bug rather than a
     request for the local shell. */
  const remote = String(machine ?? 'local').trim()
  if (remote && remote !== 'local') {
    const alias = remote
    if (!ALIAS_RE.test(alias) || alias.startsWith('-')) {
      throw new Error(`"${alias}" is not an ssh host alias.`)
    }
    return {
      cmd: 'ssh',
      argv: [
        '-tt',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        '-o',
        'LogLevel=ERROR',
        alias,
        `stty rows ${geometry.rows} cols ${geometry.cols} 2>/dev/null; exec "\${SHELL:-sh}" -il`,
      ],
      env,
      cwd: null,
      ...geometry,
    }
  }

  if (platform === 'win32') {
    throw new Error(
      'The terminal needs a POSIX pty, and this build has none on Windows. Use your own terminal there.',
    )
  }

  const relay = localRelay({ platform, env: process.env })
  return { cmd: relay.cmd, argv: relay.argv, env, cwd: dir || null, relay: relay.relay, ...geometry }
}

function append(session, chunk) {
  session.buffer += chunk
  if (session.buffer.length > MAX_BUFFER) {
    session.buffer = session.buffer.slice(session.buffer.length - MAX_BUFFER)
  }
}

function summary(session) {
  return {
    id: session.id,
    machine: session.machine,
    dir: session.cwd || '',
    cols: session.cols,
    rows: session.rows,
    relay: session.relay || '',
    closed: session.closed,
    startedAt: session.startedAt,
  }
}

function createTerminal({ emit = () => {} } = {}) {
  function send(event) {
    try {
      emit(event)
    } catch {
      /* a closed window must not break the shell */
    }
  }

  function close(id, { quiet = false } = {}) {
    const session = sessions.get(String(id))
    if (!session) return { closed: false }
    sessions.delete(session.id)
    session.closed = true
    try {
      if (session.child?.pid) killTree(session.child)
      else session.child?.kill()
    } catch {
      /* the shell may have exited on its own */
    }
    if (!quiet) {
      send({
        kind: 'terminal',
        type: 'closed',
        workspace: session.workspace,
        id: session.id,
        machine: session.machine,
      })
    }
    return { closed: true }
  }

  function available() {
    /* Windows has no POSIX pty, so a *local* shell is out — but `ssh -tt` does
       not need one, so a fleet host still works from a Windows build. */
    if (IS_WINDOWS) {
      return {
        ok: true,
        local: false,
        reason:
          'Local shells need a POSIX pty; on Windows use a fleet host, or your own terminal for this machine.',
        shell: '',
        relay: '',
        sessions: sessions.size,
      }
    }
    let relay = ''
    let reason = ''
    try {
      relay = localRelay().relay
    } catch (error) {
      /* say which relay was missing before the first prompt, not after */
      reason = String(error?.message || error)
    }
    return {
      ok: true,
      local: Boolean(relay),
      reason,
      shell: resolveShell(),
      relay,
      sessions: sessions.size,
    }
  }

  /**
   * Open (or reattach to) the shell for one panel. Reattaching is deliberate:
   * closing the panel with the shortcut is a hide, not a kill, and a window
   * reload should come back to the same shell rather than a bare prompt.
   */
  function open({ workspace, machine = 'local', dir = '', cols, rows } = {}) {
    const target = String(machine || 'local').trim() || 'local'
    let cwd = ''
    if (target === 'local' && dir) {
      const candidate = path.resolve(String(dir))
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) cwd = candidate
    }

    const existing = [...sessions.values()].find(
      (entry) =>
        !entry.closed &&
        entry.workspace === workspace &&
        entry.machine === target &&
        (entry.cwd || '') === cwd,
    )
    if (existing) {
      return { ...summary(existing), replay: existing.buffer, reused: true }
    }

    if (sessions.size >= MAX_SESSIONS) {
      /* Oldest first: the panel the user opened last is the one they want. */
      const oldest = [...sessions.values()].sort((a, b) => a.seq - b.seq)[0]
      if (oldest) close(oldest.id)
    }

    const plan = buildCommand({ machine: target, dir: cwd, cols, rows })
    const child = spawnTracked(plan.cmd, plan.argv, {
      kind: 'terminal',
      label: target === 'local' ? 'terminal' : `terminal ${target}`,
      env: { ...process.env, ...plan.env, TERM: process.env.TERM || 'xterm-256color' },
      ...(plan.cwd ? { cwd: plan.cwd } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    seq += 1
    const session = {
      id: `t${seq}`,
      seq,
      workspace,
      machine: target,
      cwd: cwd,
      cols: plan.cols,
      rows: plan.rows,
      relay: plan.relay || '',
      buffer: '',
      closed: false,
      startedAt: new Date().toISOString(),
      child,
    }
    sessions.set(session.id, session)

    const data = (chunk) => {
      const text = chunk.toString('utf8')
      append(session, text)
      send({
        kind: 'terminal',
        type: 'data',
        workspace: session.workspace,
        id: session.id,
        machine: session.machine,
        data: text,
      })
    }
    child.stdout.on('data', data)
    child.stderr.on('data', data)

    child.once('error', (error) => {
      append(session, `\r\n[${String(error?.message || error)}]\r\n`)
      send({
        kind: 'terminal',
        type: 'data',
        workspace: session.workspace,
        id: session.id,
        machine: session.machine,
        data: `\r\n[${String(error?.message || error)}]\r\n`,
      })
    })

    child.once('exit', (code, signal) => {
      session.closed = true
      sessions.delete(session.id)
      const note = `\r\n[the shell exited${code === null ? '' : ` with ${code}`}${
        signal ? ` (${signal})` : ''
      } — reopen with the shortcut]\r\n`
      append(session, note)
      send({
        kind: 'terminal',
        type: 'exit',
        workspace: session.workspace,
        id: session.id,
        machine: session.machine,
        data: note,
        code,
        signal,
      })
    })

    return { ...summary(session), replay: '', reused: false }
  }

  function write({ id, data } = {}) {
    const session = sessions.get(String(id))
    if (!session || session.closed) throw new Error('That terminal is not open any more.')
    const text = String(data ?? '')
    /* A paste can be large; a single write is fine up to the pipe buffer, and
       the renderer sends keystrokes, not files. */
    if (text) session.child.stdin.write(text)
    return { written: text.length }
  }

  /**
   * Geometry is recorded, not applied: a pty owned by `script` (or by ssh's
   * remote side) cannot be resized from this process. The emulator reflows the
   * text it already has, and programs that redraw re-query the rows/cols the pty
   * reported at open. Stated in README → Ceilings rather than faked.
   */
  function resize({ id, cols, rows } = {}) {
    const session = sessions.get(String(id))
    if (!session) return { ok: false }
    session.cols = clampSize(cols, session.cols, 20, 400)
    session.rows = clampSize(rows, session.rows, 5, 200)
    return { ok: true, cols: session.cols, rows: session.rows, applied: false }
  }

  function list({ workspace } = {}) {
    return [...sessions.values()]
      .filter((session) => !workspace || session.workspace === workspace)
      .map(summary)
  }

  function read({ id } = {}) {
    const session = sessions.get(String(id))
    if (!session) return { id: String(id || ''), buffer: '', closed: true }
    return { ...summary(session), buffer: session.buffer }
  }

  function closeAll() {
    for (const id of [...sessions.keys()]) close(id, { quiet: true })
  }

  return { available, open, write, resize, close, closeAll, list, read }
}

module.exports = {
  createTerminal,
  buildCommand,
  resolveShell,
  resolvePython,
  localRelay,
  PYTHON_RELAY,
  MAX_SESSIONS,
  clampSize,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  ALIAS_RE,
}
