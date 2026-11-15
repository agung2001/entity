/**
 * The chat terminal, exercised against a real pty.
 *
 * Two things are worth pinning down and neither is visible in the UI:
 *
 *   1. The argv. BSD `script` and util-linux `script` disagree about where the
 *      command goes, and the failure is silent — a wrong order starts an
 *      interactive script and never runs the shell.
 *   2. That a shell really answers. A terminal that renders a prompt but cannot
 *      echo a command looks identical to a working one until someone types.
 *
 * The ssh case is asserted on the argv only: a unit test must not need a host.
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildCommand,
  clampSize,
  createTerminal,
  localRelay,
  resolvePython,
  MAX_SESSIONS,
  PYTHON_RELAY,
} = require('../../electron/terminal-store.cjs')

const POSIX = process.platform !== 'win32'

test('Linux relays the shell through util-linux script', () => {
  const linux = buildCommand({ machine: 'local', cols: 90, rows: 20, platform: 'linux', shell: '/bin/bash' })
  assert.equal(linux.relay, 'script')
  /* util-linux script: -c <command>, then the typescript file */
  assert.deepEqual(linux.argv.slice(0, 2), ['-q', '-c'])
  assert.equal(linux.argv[3], '/dev/null')
  assert.match(linux.argv[2], /stty .*exec "\$ENTITY_TERM_SHELL" -il/)
  assert.equal(linux.env.ENTITY_TERM_COLS, '90')
  assert.equal(linux.env.ENTITY_TERM_ROWS, '20')
  assert.equal(linux.env.ENTITY_TERM_SHELL, '/bin/bash')
  assert.equal(linux.cwd, null, 'a plan without a directory has no cwd')
})

/**
 * macOS is not Linux here. Its `script` calls `tcgetattr` on its own stdin and
 * exits when that is not a terminal — and Electron always hands a child a
 * socketpair, so it always exits. Asserting the python relay is what keeps this
 * from silently regressing into a terminal that never echoes a key.
 */
test('macOS relays through python3, never through script', { skip: process.platform !== 'darwin' }, () => {
  const plan = buildCommand({ machine: 'local', cols: 120, rows: 30, shell: '/bin/zsh' })
  assert.equal(plan.relay, 'python3')
  assert.equal(plan.cmd, resolvePython())
  assert.deepEqual(plan.argv, ['-c', PYTHON_RELAY])
  /* the geometry and the shell reach the relay through the environment only */
  assert.equal(plan.env.ENTITY_TERM_COLS, '120')
  assert.equal(plan.env.ENTITY_TERM_ROWS, '30')
  assert.equal(plan.env.ENTITY_TERM_SHELL, '/bin/zsh')
  assert.doesNotMatch(plan.argv.join(' '), /(^|[^\w])script(\s|$)/, 'script must not be the relay')
  assert.match(PYTHON_RELAY, /pty\.spawn/, 'the relay allocates the pty itself')
})

test('the relay names what it is, and says why when there is none', () => {
  assert.equal(localRelay({ platform: 'linux' }).relay, 'script')
  assert.throws(
    () => localRelay({ platform: 'darwin', env: { PATH: '/nonexistent' }, candidates: [] }),
    /no python3/,
  )
})

test('a fleet host is ssh with a forced remote pty, and the alias is checked', () => {
  const remote = buildCommand({ machine: 'build-box', platform: 'darwin' })
  assert.equal(remote.cmd, 'ssh')
  assert.ok(remote.argv.includes('-tt'), 'ssh must allocate the remote pty')
  assert.ok(remote.argv.includes('BatchMode=yes'), 'a terminal must not prompt for a password')
  assert.equal(remote.argv.at(-2), 'build-box')
  assert.match(remote.argv.at(-1), /stty rows \d+ cols \d+/)
  assert.equal(remote.cwd, null, 'a remote shell has no local cwd')

  for (const alias of ['-oProxyCommand=evil', 'host with space', 'a;b', '$(id)', 'user@box:22']) {
    assert.throws(() => buildCommand({ machine: alias }), /not an ssh host alias/, alias)
  }
  /* An absent machine — or an empty one, which is how a thread without a host
     arrives — is this machine, never an ssh call. */
  for (const machine of ['', '  ', 'local', undefined]) {
    assert.notEqual(buildCommand({ machine, platform: 'linux' }).cmd, 'ssh', JSON.stringify(machine))
  }
})

test('the geometry is clamped instead of trusted', () => {
  assert.equal(clampSize(0, 80, 20, 400), 20)
  assert.equal(clampSize(9999, 80, 20, 400), 400)
  assert.equal(clampSize('abc', 80, 20, 400), 80)
  assert.equal(buildCommand({ machine: 'local', cols: 5, rows: 1 }).cols, 20)
  assert.equal(buildCommand({ machine: 'local', cols: 5, rows: 1 }).rows, 5)
})

test('a shell answers: open, write, read the echo', { skip: !POSIX }, async () => {
  const events = []
  const terminal = createTerminal({ emit: (event) => events.push(event) })

  const session = terminal.open({ workspace: 'w1', machine: 'local', cols: 80, rows: 24 })
  assert.match(session.id, /^t\d+$/)
  assert.equal(session.reused, false)

  terminal.write({ id: session.id, data: 'printf ENTITY-TERMINAL-OK\\n\n' })

  const deadline = Date.now() + 15_000
  let seen = ''
  while (Date.now() < deadline) {
    seen = events
      .filter((event) => event.kind === 'terminal' && event.type === 'data')
      .map((event) => event.data)
      .join('')
    if (seen.includes('ENTITY-TERMINAL-OK')) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.match(seen, /ENTITY-TERMINAL-OK/, JSON.stringify(seen.slice(-400)))

  /* reattaching returns the same shell and the scrollback so far */
  const again = terminal.open({ workspace: 'w1', machine: 'local', cols: 80, rows: 24 })
  assert.equal(again.id, session.id)
  assert.equal(again.reused, true)
  assert.match(again.replay, /ENTITY-TERMINAL-OK/)

  assert.deepEqual(
    terminal.list({ workspace: 'w1' }).map((row) => row.id),
    [session.id],
  )

  terminal.close(session.id)
  assert.deepEqual(terminal.list({ workspace: 'w1' }), [])
})

test('a write to a closed session fails loudly instead of silently', { skip: !POSIX }, async () => {
  const terminal = createTerminal({ emit: () => {} })
  const session = terminal.open({ workspace: 'w2', machine: 'local' })
  terminal.close(session.id)
  assert.throws(() => terminal.write({ id: session.id, data: 'x' }), /not open any more/)
  assert.throws(() => terminal.write({ id: 't-does-not-exist', data: 'x' }), /not open any more/)
})

test('the session count is bounded, oldest first', { skip: !POSIX }, async () => {
  const terminal = createTerminal({ emit: () => {} })
  const first = terminal.open({ workspace: 'w3', machine: 'local' })
  for (let i = 0; i < MAX_SESSIONS; i += 1) {
    terminal.open({ workspace: `w3-${i}`, machine: 'local' })
  }
  const open = terminal.list()
  assert.equal(open.length, MAX_SESSIONS)
  assert.ok(!open.some((row) => row.id === first.id), 'the oldest session is the one reaped')
  for (const row of open) terminal.close(row.id)
})
