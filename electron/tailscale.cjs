/**
 * Tailscale: the fourth connector shape — it authenticates nothing.
 *
 * GitHub, Gmail and Clockify each hold a credential and answer questions about a
 * remote service. This one reads **one machine-local daemon** and gates exactly
 * one thing on it: the repo's own `npm run dev:lan`, so a phone on the same
 * tailnet can open the app by name. Nothing here writes to Tailscale — no
 * `up`, no `set`, no auth key, no `serve`/`funnel`. The only side effects in this
 * file are one `tailscale status` read and a Vite child this app owns and reaps.
 *
 * Everything a page is allowed to know is a field in `read()`'s answer or a field
 * in `serve()`'s answer. No path, no argv, no raw JSON, no stderr beyond one
 * sentence — the renderer gets facts, not a shell.
 */
const { execFile, spawn } = require('node:child_process')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const { spawnTracked, killTree } = require('./child-registry.cjs')

/* The daemon read is bounded: `tailscale status` talks to a Unix socket and a
   daemon that is wedged must not hold a page's first paint. */
const TIMEOUT_MS = 5000
const MAX_BUFFER = 4 * 1024 * 1024
const UP_MS = 15_000
const DOWN_MS = 5000
const WATCH_MS = 5000
const DEFAULT_PORT = 5183
const MIN_PORT = 1024
const MAX_PORT = 65535

/* The app runs from the checkout (dev) or the bundled app (packaged); either way
   `..` from this file is the directory `package.json` lives in, which is the one
   `npm run dev:lan` has to start in. */
const ROOT = path.join(__dirname, '..')

/** `BackendState` → the five words this app speaks. `NoState` is a daemon that
 *  is not up, which is what `stopped` means to a person looking at the app. */
const BACKEND = {
  stopped: 'stopped',
  nostate: 'stopped',
  needslogin: 'signed-out',
  needsmachineauth: 'signed-out',
  starting: 'starting',
  running: 'running',
}

/** The one shape `read()` answers with, and nothing else. */
function snapshot(over) {
  return {
    state: 'unreadable',
    version: '',
    dnsName: '',
    ipv4: '',
    magicdnsSuffix: '',
    magicdnsEnabled: false,
    hostName: '',
    error: '',
    ...over,
  }
}

function execFileText(bin, argv) {
  return new Promise((resolve) => {
    execFile(bin, argv, { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true }, (error, stdout, stderr) =>
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') }),
    )
  })
}

/** One clean sentence out of a failed run — never a stack, never the whole log. */
function failureLine(result, what) {
  if (result?.error?.killed) return `${what} did not answer within ${TIMEOUT_MS / 1000} s.`
  const printed = `${result?.stderr || ''}\n${result?.stdout || ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return printed.length ? printed[printed.length - 1].slice(0, 200) : `${what} failed.`
}

const firstToken = (text) => String(text || '').trim().split(/\s+/)[0] || ''

/**
 * Raw `status --json` + the `--version` string → the one shape a page reads.
 *
 * Kept pure and exported so the unit test can pin the derivation without a
 * daemon, and so the privacy rule below is checkable in one place.
 */
function derive(status, versionText) {
  const state = BACKEND[String(status?.BackendState || '').toLowerCase()] || ''
  const tailnet = status?.CurrentTailnet || {}
  /* PRIVACY. `CurrentTailnet.Name` is Tailscale's *account* label, and on a
     tailnet with no org domain it is the sign-in mailbox (this machine's is one).
     An email on a page is how a screenshot leaks an identity, so it is never
     copied into the answer, never logged, and never used as a fallback name: the
     Tailnet card shows `MagicDNSSuffix` (`acme-demo.ts.net`) instead. */
  const enabled = tailnet.MagicDNSEnabled === true
  const dns = String(status?.Self?.DNSName || '')
  const ips = Array.isArray(status?.Self?.TailscaleIPs) ? status.Self.TailscaleIPs : []
  return snapshot({
    state: state || 'unreadable',
    error: state ? '' : 'Tailscale answered with a state this app does not know.',
    version: firstToken(versionText),
    /* Only when MagicDNS is on: a name Tailscale will not resolve is worse than
       no name, because the QR behind it dead-ends on the phone. */
    dnsName: enabled ? dns.replace(/\.$/, '') : '',
    /* The first IPv4 in the list; an IPv6 literal in a `host:port` URL needs
       brackets, and Tailscale always assigns IPv4 too. */
    ipv4: ips.find((ip) => typeof ip === 'string' && !ip.includes(':')) || '',
    magicdnsSuffix: String(tailnet.MagicDNSSuffix || ''),
    magicdnsEnabled: enabled,
    hostName: String(status?.Self?.HostName || ''),
  })
}

/**
 * Read the daemon. `exec` is injectable so the unit test stubs the binary
 * instead of owning one.
 */
async function read({ exec = execFileText } = {}) {
  const status = await exec('tailscale', ['status', '--json'])
  if (status?.error?.code === 'ENOENT') {
    return snapshot({ state: 'absent', error: 'No `tailscale` on this machine.' })
  }
  if (!String(status?.stdout || '').trim()) {
    const line = status?.error ? failureLine(status, 'tailscale status') : 'tailscale status answered nothing.'
    return snapshot({ state: 'unreadable', error: line })
  }
  let parsed = null
  try {
    parsed = JSON.parse(status.stdout)
  } catch {
    return snapshot({ state: 'unreadable', error: 'tailscale status did not answer with JSON.' })
  }
  const version = await exec('tailscale', ['version'])
  return derive(parsed, version?.stdout)
}

/** The address the phone opens: the MagicDNS name when there is one, else the
 *  IPv4. `''` — never `http://:5183` — when the read produced neither. */
function addressOf(snapshotRead, port) {
  const tail = `:${Number(port) || DEFAULT_PORT}`
  if (snapshotRead?.dnsName) return { url: `http://${snapshotRead.dnsName}${tail}`, kind: 'magicdns' }
  if (snapshotRead?.ipv4) return { url: `http://${snapshotRead.ipv4}${tail}`, kind: 'ip' }
  return { url: '', kind: 'ip' }
}

/* ── the one toggle: a dev server this app owns ───────────────────────────── */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A bind probe: the listener closes immediately, so it answers without taking
 *  the port. `0.0.0.0` because that is what `--host 0.0.0.0` will bind. */
function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen({ host: '0.0.0.0', port, exclusive: true }, () => server.close(() => resolve(true)))
  })
}

/** Who holds the port, in one line, without a shell. Best effort: `lsof` is
 *  absent on a bare Linux and that is not a reason to lose the sentence. */
function holderOf(port) {
  return new Promise((resolve) => {
    execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { timeout: TIMEOUT_MS }, (error, stdout) => {
      if (error && !stdout) return resolve('')
      const pid = /^p(\d+)$/m.exec(String(stdout || ''))
      const name = /^c(\S+)$/m.exec(String(stdout || ''))
      if (!pid) return resolve('')
      resolve(`pid ${pid[1]}${name ? ` (${name[1]})` : ''}`)
    })
  })
}

const lastLine = (text) =>
  String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop() || ''

/** Does the port accept a connection yet? The child prints "ready" on its own
 *  schedule; the socket is the only answer that cannot be wrong. */
function portAnswers(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.unref()
    socket.setTimeout(700)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => resolve(false))
  })
}

async function waitForPort(port, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await portAnswers(port)) return true
    await sleep(150)
  }
  return false
}

/**
 * Ask Vite, over TCP, whether it will serve a request addressed to the MagicDNS
 * name. It validates the `Host` header, so this is the one check that proves the
 * QR leads somewhere instead of a "blocked host" page.
 *
 * `node:http` and not `fetch`: `Host` is a forbidden request header, and fetch
 * silently drops it — which would make this probe pass while the phone fails.
 */
function hostAnswers(port, host) {
  return new Promise((resolve) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: '/', method: 'GET', headers: { host }, timeout: 5000 },
      (response) => {
        response.resume()
        resolve({ ok: response.statusCode >= 200 && response.statusCode < 400, status: response.statusCode })
      },
    )
    request.once('timeout', () => {
      request.destroy()
      resolve({ ok: false, status: 0 })
    })
    request.once('error', () => resolve({ ok: false, status: 0 }))
    request.end()
  })
}

let child = null
let serving = null
let stderrTail = ''
let watch = null

function stopWatch() {
  if (watch) clearInterval(watch)
  watch = null
}

/** A tailnet that drops while serving takes the server with it: the whole point
 *  of the QR is an address that works. Polled only while serving. */
function startWatch() {
  stopWatch()
  watch = setInterval(async () => {
    if (!serving) return stopWatch()
    const now = await read()
    if (now.state !== 'running') await stop()
  }, WATCH_MS)
  watch.unref?.()
}

function serve() {
  if (!serving) return { running: false, port: 0, url: '', addressKind: '', startedAt: '', pid: 0 }
  return {
    running: true,
    port: serving.port,
    url: serving.url,
    addressKind: serving.kind,
    startedAt: serving.startedAt,
    pid: serving.pid,
  }
}

/**
 * Start `npm run dev:lan` for this machine and wait until a phone could open it.
 *
 * The order matters and is the feature: a pre-flight bind, so a taken port fails
 * with a sentence instead of Vite silently moving the QR to 5184; the child as a
 * tracked process group, so the stop is real; then the socket, then the host.
 */
async function start(port) {
  const target = Number(port) || DEFAULT_PORT
  if (!Number.isInteger(target) || target < MIN_PORT || target > MAX_PORT) {
    throw new Error(`Port must be a whole number between ${MIN_PORT} and ${MAX_PORT}.`)
  }
  if (serving?.port === target) return serve()
  if (child) await stop()

  const holder = (await portFree(target)) ? '' : await holderOf(target)
  if (!(await portFree(target))) {
    throw new Error(`Port ${target} is already taken${holder ? ` by ${holder}` : ''}. Stop that process, or pick another port.`)
  }

  const tailnet = await read()
  const address = addressOf(tailnet, target)
  stderrTail = ''
  const spawned = spawnTracked('npm', ['run', 'dev:lan', '--', '--port', String(target), '--strictPort'], {
    cwd: ROOT,
    /* The one thing the child is told: which name it must answer to. Vite merges
       this into `server.allowedHosts` (`vite.config.js`), so `npm run dev` keeps
       its localhost/IP behaviour untouched. */
    env: {
      ...process.env,
      ...(tailnet.magicdnsSuffix ? { __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: tailnet.magicdnsSuffix } : {}),
    },
    kind: 'dev-server',
    label: 'LAN web server',
  })
  child = spawned
  let exited = null
  spawned.stderr?.on('data', (chunk) => {
    stderrTail = `${stderrTail}${String(chunk)}`.slice(-4000)
  })
  spawned.once('exit', (code) => {
    exited = code ?? -1
    /* The child can die while serving (the user kills Vite, the machine sleeps).
       Drop the handle so the page reads "off" instead of a stale port. */
    if (child === spawned) {
      child = null
      serving = null
      stopWatch()
    }
  })

  if (!(await waitForPort(target, UP_MS))) {
    const line =
      lastLine(stderrTail) ||
      (exited === null ? `The dev server did not answer on port ${target} within ${UP_MS / 1000} s.` : `The dev server exited with code ${exited}.`)
    await stop()
    throw new Error(line)
  }

  if (address.kind === 'magicdns') {
    const answer = await hostAnswers(target, tailnet.dnsName)
    if (!answer.ok) {
      await stop()
      throw new Error(
        `Vite did not accept its own MagicDNS name (${tailnet.dnsName}), so the QR would open a blocked page. Check \`server.allowedHosts\` in vite.config.js.`,
      )
    }
  }

  serving = {
    port: target,
    url: address.url,
    kind: address.kind,
    startedAt: new Date().toISOString(),
    pid: spawned.pid || 0,
  }
  startWatch()
  return serve()
}

/** Stop the whole group and wait for the port to be free. Idempotent, because a
 *  quit path and a page path can both arrive. */
async function stop() {
  const running = child
  const port = serving?.port || 0
  child = null
  serving = null
  stopWatch()
  if (!running) return serve()
  killTree(running)
  const deadline = Date.now() + DOWN_MS
  while (port && Date.now() < deadline) {
    if (await portFree(port)) break
    await sleep(120)
  }
  return serve()
}

/**
 * Reveal the Tailscale app — the verb for the states whose fix lives outside
 * Entity (stopped, signed out). Each platform names its own app; none of them
 * runs a Tailscale verb, and none of them writes a setting.
 */
function opener() {
  if (process.platform === 'darwin') return { cmd: 'open', argv: ['-a', 'Tailscale'] }
  /* ponytail: the default install directory on Windows and the packaged tray
     binary on Linux. Ceiling — a person who installed elsewhere gets
     `opened: false` and the download link instead. Upgrade path: read the
     uninstall registry key on Windows, `/usr/share/applications` on Linux. */
  if (process.platform === 'win32') {
    return { cmd: path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale-ipn.exe'), argv: [] }
  }
  return { cmd: 'tailscale-systray', argv: [] }
}

/* `open -a Tailscale` is the OS opener, not a child of this app: it exits in
   microseconds, or (a tray binary on Linux) never. So it is spawned detached and
   the answer is `spawn`, which fires once the binary exists — the only thing we
   actually want to know is whether this machine has the app where we look. */
function open() {
  const plan = opener()
  return new Promise((resolve) => {
    let settled = false
    const child = spawn(plan.cmd, plan.argv, { detached: true, stdio: 'ignore', windowsHide: true })
    const answer = (opened) => {
      if (settled) return
      settled = true
      child.unref()
      resolve({ opened })
    }
    child.once('spawn', () => answer(true))
    child.once('error', () => answer(false))
  })
}

module.exports = {
  DEFAULT_PORT,
  derive,
  addressOf,
  read,
  start,
  stop,
  serve,
  open,
}
