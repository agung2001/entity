/**
 * Local machine data — the SSH config and the harness skill libraries.
 *
 * One module, two callers: the Electron main process (IPC) and the Vite dev
 * server (a small middleware for `npm run dev` in a browser). Both read the
 * same files, so the hub shows the same machines and skills whether it runs as
 * a desktop app or in the browser.
 *
 * Nothing here talks to the network. It only reads local files and, when asked,
 * runs the local `ssh` client with BatchMode so a probe either succeeds with
 * the keys this machine already has or fails without prompting.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')

const HOME = os.homedir()
const PLATFORM = process.platform

/* Windows reads the per-user config from %USERPROFILE%\.ssh\config, which is
   the same `path.join(os.homedir(), '.ssh', 'config')` — no special casing is
   needed for the file itself, only for how we display it. The system-wide
   OpenSSH config (%ProgramData%\ssh\ssh_config) is deliberately not merged: it
   describes an ssh server, not the hosts this user connects to. */
const SSH_CONFIG_PATH = path.join(HOME, '.ssh', 'config')

function tilde(value) {
  if (!value) return ''
  const normalized = String(value)
  if (normalized === HOME) return '~'
  if (normalized.startsWith(HOME + path.sep)) {
    return '~' + path.sep + normalized.slice(HOME.length + 1)
  }
  return normalized
}

function stripQuotes(value) {
  const v = String(value || '').trim()
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1)
  }
  return v
}

function expandHome(value) {
  if (!value) return value
  if (value === '~') return HOME
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(HOME, value.slice(2))
  return value
}

/* ── ssh config ───────────────────────────────────────────────────── */

const WILDCARD = /[*?!]/

function includeTargets(value, baseDir) {
  const targets = []
  for (const raw of value.split(/\s+/)) {
    const token = expandHome(stripQuotes(raw))
    if (!token) continue
    const absolute = path.isAbsolute(token) ? token : path.resolve(baseDir, token)
    if (!WILDCARD.test(path.basename(absolute))) {
      targets.push(absolute)
      continue
    }
    /* `Include config.d/*` — expand the simple glob with readdir instead of
       pulling in a dependency. */
    const dir = path.dirname(absolute)
    const pattern = path.basename(absolute)
    const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
    const matcher = new RegExp(`^${source}$`)
    try {
      for (const name of fs.readdirSync(dir)) {
        if (matcher.test(name)) targets.push(path.join(dir, name))
      }
    } catch {
      /* an Include that does not resolve is simply skipped */
    }
  }
  return targets
}

function readSshFile(file, depth, seen, hosts) {
  const resolved = path.resolve(file)
  if (depth > 6 || seen.has(resolved)) return hosts
  let text
  try {
    text = fs.readFileSync(resolved, 'utf8')
  } catch {
    return hosts
  }
  seen.add(resolved)

  let current = null
  const commit = () => {
    if (current && current.aliases.length) hosts.push(current)
    current = null
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    /* ssh_config accepts `Keyword value` and `Keyword=value`; values keep their
       spaces (IdentityFile and ProxyJump can both contain them). */
    const match = line.match(/^([A-Za-z][A-Za-z0-9]*)\s*(?:=\s*)?(.*)$/)
    if (!match) continue
    const key = match[1].toLowerCase()
    const value = match[2].trim()

    if (key === 'host') {
      commit()
      const aliases = value
        .split(/\s+/)
        .map(stripQuotes)
        .filter((alias) => alias && !alias.startsWith('-') && !WILDCARD.test(alias))
      current = {
        aliases,
        hostName: '',
        user: '',
        port: '',
        identityFile: '',
        proxyJump: '',
        source: tilde(resolved),
      }
    } else if (key === 'match') {
      /* a Match block is not a host entry — close the current one */
      commit()
    } else if (key === 'include') {
      commit()
      for (const target of includeTargets(value, path.dirname(resolved))) {
        readSshFile(target, depth + 1, seen, hosts)
      }
    } else if (current) {
      if (key === 'hostname') current.hostName = stripQuotes(value)
      else if (key === 'user') current.user = stripQuotes(value)
      else if (key === 'port') current.port = stripQuotes(value)
      else if (key === 'identityfile') current.identityFile = stripQuotes(value)
      else if (key === 'proxyjump') current.proxyJump = stripQuotes(value)
    }
  }
  commit()
  return hosts
}

function readSshHosts() {
  const exists = fs.existsSync(SSH_CONFIG_PATH)
  const parsed = exists
    ? readSshFile(SSH_CONFIG_PATH, 0, new Set(), [])
    : []

  /* One card per Host block, in config order. A second block that repeats an
     alias is dropped, which is how ssh resolves a repeated Host anyway. */
  const used = new Set()
  const unique = []
  for (const host of parsed) {
    const free = host.aliases.filter((alias) => !used.has(alias))
    if (!free.length) continue
    free.forEach((alias) => used.add(alias))
    unique.push({ ...host, aliases: free })
  }

  const hosts = unique.map((host, index) => {
    const hostName = host.hostName || host.aliases[0]
    const user = host.user || ''
    const port = host.port || ''
    return {
      id: `${host.aliases[0]}#${index}`,
      alias: host.aliases[0],
      aliases: host.aliases,
      label: host.aliases[0],
      hostName,
      user,
      port,
      identityFile: host.identityFile ? tilde(host.identityFile) : '',
      proxyJump: host.proxyJump || '',
      source: host.source,
      spec: `${user ? `${user}@` : ''}${hostName}${port ? `:${port}` : ''}`,
    }
  })

  return {
    hostname: os.hostname(),
    platform: PLATFORM,
    configPath: SSH_CONFIG_PATH,
    displayPath:
      PLATFORM === 'win32' ? path.win32.join('%USERPROFILE%', '.ssh', 'config') : '~/.ssh/config',
    exists,
    hosts,
  }
}

function probeSshHost(alias) {
  const target = String(alias || '').trim()
  if (!target || target.startsWith('-')) {
    return Promise.resolve({
      alias: target,
      ok: false,
      ms: 0,
      reason: 'invalid',
      message: 'No host alias to test.',
    })
  }

  const started = Date.now()
  return new Promise((resolve) => {
    execFile(
      'ssh',
      [
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=5',
        '-o',
        'StrictHostKeyChecking=accept-new',
        target,
        'true',
      ],
      { timeout: 12000, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        const ms = Date.now() - started
        if (!error) {
          resolve({ alias: target, ok: true, ms, reason: 'ok', message: 'reachable' })
          return
        }

        const detail = String(stderr || error.message || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(-1)[0]
          ?.slice(0, 240)

        let reason = 'failed'
        const text = String(stderr || '').toLowerCase()
        if (error.code === 'ENOENT') {
          reason = 'missing'
        } else if (/permission denied|publickey|no more authentication/.test(text)) {
          reason = 'auth'
        } else if (/timed out|timeout/.test(text)) {
          reason = 'timeout'
        } else if (/host key verification failed|remote host identification has changed/.test(text)) {
          reason = 'hostkey'
        } else if (/could not resolve|name or service not known|nodename nor servname/.test(text)) {
          reason = 'dns'
        } else if (/connection refused|no route to host|network is unreachable/.test(text)) {
          reason = 'network'
        } else if (error.killed) {
          reason = 'timeout'
        }

        const fallback = {
          missing: 'The local ssh client is not installed.',
          auth: 'ssh could not authenticate with the keys on this machine.',
          timeout: 'ssh timed out after 5 seconds.',
          hostkey: 'The host key does not match known_hosts.',
          dns: 'The host name does not resolve.',
          network: 'The host is not reachable on the network.',
          invalid: 'No host alias to test.',
          failed: 'ssh could not connect.',
        }[reason]

        resolve({
          alias: target,
          ok: false,
          ms,
          reason,
          message: reason === 'missing' ? fallback : detail || fallback,
        })
      },
    )
  })
}

/* ── harness skill libraries ──────────────────────────────────────── */

const XDG_CONFIG = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config')

/* Harnesses read a skill from their own directory. The same skill can exist in
   several of them (often as a symlink), which is exactly what the filter is
   for: the copy in ~/.claude is not the copy in ~/.pi. */
const HARNESSES = [
  {
    id: 'pi',
    label: 'pi',
    roots: [path.join(HOME, '.pi', 'agent', 'skills')],
  },
  {
    id: 'claude',
    label: 'Claude Code',
    roots: [path.join(HOME, '.claude', 'skills')],
  },
  {
    id: 'opencode',
    label: 'opencode',
    roots: [path.join(XDG_CONFIG, 'opencode', 'skills'), path.join(HOME, '.opencode', 'skills')],
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    roots: [path.join(HOME, '.codex', 'skills')],
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    roots: [
      path.join(HOME, '.gemini', 'antigravity', 'skills'),
      path.join(HOME, '.antigravity', 'skills'),
    ],
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    roots: [path.join(HOME, '.gemini', 'skills')],
  },
]

const TEXT_EXT = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.sh',
  '.bash',
  '.zsh',
  '.rb',
  '.go',
  '.rs',
  '.sql',
  '.html',
  '.css',
  '.svg',
  '.xml',
  '.csv',
])

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function walkFiles(root, { cap = 400, maxDepth = 4, withBodies = false } = {}) {
  const out = []
  const seenDirs = new Set()

  const walk = (dir, depth) => {
    if (out.length >= cap || depth > maxDepth) return
    let real
    try {
      real = fs.realpathSync(dir)
    } catch {
      return
    }
    if (seenDirs.has(real)) return
    seenDirs.add(real)

    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= cap) return
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.DS_Store') {
        continue
      }
      const abs = path.join(dir, entry.name)
      let stat
      try {
        stat = fs.statSync(abs)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        walk(abs, depth + 1)
      } else if (stat.isFile()) {
        const rel = path.relative(root, abs) || entry.name
        const ext = path.extname(entry.name).toLowerCase()
        const item = {
          abs,
          name: rel,
          bytes: stat.size,
          size: formatBytes(stat.size),
          updatedAt: stat.mtime.toISOString(),
        }
        if (withBodies && TEXT_EXT.has(ext) && stat.size <= 160 * 1024) {
          try {
            item.body = fs.readFileSync(abs, 'utf8')
          } catch {
            item.body = null
          }
        }
        out.push(item)
      }
    }
  }

  walk(root, 0)
  return out
}

/* YAML-ish frontmatter: enough for the keys a SKILL.md actually carries, with
   folded (`>`) and literal (`|`) descriptions joined into one line. */
function parseFrontmatter(text) {
  if (!text.startsWith('---')) return {}
  const end = text.indexOf('\n---', 3)
  if (end < 0) return {}
  const lines = text.slice(3, end).split(/\r?\n/)
  const out = {}
  let key = null

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (match) {
      key = match[1]
      out[key] = match[2]
      continue
    }
    if (key && (/^\s+/.test(line) || line.trim() === '') && line.trim()) {
      out[key] = `${out[key] ? `${out[key]} ` : ''}${line.trim()}`
    }
  }

  for (const k of Object.keys(out)) {
    out[k] = stripQuotes(String(out[k]).replace(/^[>|][+-]?\s*/, '')).trim()
  }
  return out
}

function findEntryFile(dir) {
  for (const name of ['SKILL.md', 'skill.md', 'SKILL.markdown']) {
    const candidate = path.join(dir, name)
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* keep looking */
    }
  }
  return null
}

function readSkillMeta(entryFile, fallbackName) {
  let text = ''
  try {
    text = fs.readFileSync(entryFile, 'utf8')
  } catch {
    /* the directory is still a skill, just an unreadable one */
  }
  const fm = parseFrontmatter(text)
  const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim()
  /* some manifests carry a release-please marker after the number;
     keep the version a person can read, not the template comment */
  const version = String(fm.version || '')
    .split(/\s+/)[0]
    .replace(/^v(?=\d)/i, '')
  return {
    name: fm.name || heading || fallbackName,
    description: fm.description || '',
    version,
    license: fm.license || '',
    runtime: fm.runtime || fm.requires || '',
  }
}

function scanSkillLibrary() {
  const items = []
  const seen = new Set()
  const harnesses = []

  for (const harness of HARNESSES) {
    const roots = harness.roots.map((root) => ({
      path: root,
      displayPath: tilde(root),
      exists: fs.existsSync(root),
    }))
    let count = 0

    for (const root of roots) {
      if (!root.exists) continue
      let entries
      try {
        entries = fs.readdirSync(root.path, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        const full = path.join(root.path, entry.name)
        let stat
        try {
          stat = fs.statSync(full) // follows symlinks, which most harness links are
        } catch {
          continue
        }

        let entryFile = null
        let skillName = entry.name
        let singleFile = false
        if (stat.isDirectory()) {
          entryFile = findEntryFile(full)
          if (!entryFile) continue
        } else if (stat.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          entryFile = full
          skillName = entry.name.replace(/\.md$/i, '')
          singleFile = true
        } else {
          continue
        }

        const meta = readSkillMeta(entryFile, skillName)
        const key = `${harness.id}:${meta.name.toLowerCase()}`
        if (seen.has(key)) continue
        seen.add(key)

        const files = singleFile ? [{ bytes: stat.size }] : walkFiles(full, { cap: 400, maxDepth: 4 })
        const bytes = files.reduce((sum, file) => sum + (file.bytes || 0), 0)
        const updatedAt = (() => {
          try {
            return fs.statSync(entryFile).mtime.toISOString()
          } catch {
            return stat.mtime.toISOString()
          }
        })()

        items.push({
          id: `${harness.id}:${meta.name}`,
          name: meta.name,
          harness: harness.id,
          harnessLabel: harness.label,
          path: tilde(full),
          absolutePath: full,
          entry: path.basename(entryFile),
          singleFile,
          description: meta.description,
          version: meta.version,
          license: meta.license,
          runtime: meta.runtime,
          files: files.length,
          bytes,
          size: formatBytes(bytes),
          updatedAt,
        })
        count += 1
      }
    }

    harnesses.push({
      id: harness.id,
      label: harness.label,
      count,
      roots,
    })
  }

  items.sort((a, b) => a.name.localeCompare(b.name) || a.harnessLabel.localeCompare(b.harnessLabel))

  return {
    hostname: os.hostname(),
    platform: PLATFORM,
    scannedAt: new Date().toISOString(),
    harnesses,
    items,
    count: items.length,
  }
}

function readSkillEntry(harnessId, name) {
  const targetHarness = String(harnessId || '')
  const targetName = String(name || '').toLowerCase()
  const scan = scanSkillLibrary()
  const item = scan.items.find(
    (entry) => entry.harness === targetHarness && entry.name.toLowerCase() === targetName,
  )
  if (!item) return null

  const entryPath = item.singleFile
    ? item.absolutePath
    : path.join(item.absolutePath, item.entry)
  let md = ''
  try {
    md = fs.readFileSync(entryPath, 'utf8').slice(0, 400 * 1024)
  } catch {
    /* the page falls back to the metadata it already has */
  }

  let files = item.singleFile
    ? [{ name: item.entry, size: item.size, bytes: item.bytes, body: md }]
    : walkFiles(item.absolutePath, { cap: 60, maxDepth: 3, withBodies: true })

  /* The entry file leads the list, then references and scripts in path order. */
  files = files.sort((a, b) =>
    a.name === item.entry ? -1 : b.name === item.entry ? 1 : a.name.localeCompare(b.name),
  )

  return { ...item, md, files }
}

module.exports = {
  SSH_CONFIG_PATH,
  HARNESSES,
  readSshHosts,
  probeSshHost,
  scanSkillLibrary,
  readSkillEntry,
}
