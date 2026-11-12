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
const {
  HOME,
  tilde,
  stripQuotes,
  expandHome,
  parseFrontmatter,
} = require('./frontmatter.cjs')

const PLATFORM = process.platform

/* Windows reads the per-user config from %USERPROFILE%\.ssh\config, which is
   the same `path.join(os.homedir(), '.ssh', 'config')` — no special casing is
   needed for the file itself, only for how we display it. The system-wide
   OpenSSH config (%ProgramData%\ssh\ssh_config) is deliberately not merged: it
   describes an ssh server, not the hosts this user connects to. */
const SSH_CONFIG_PATH = path.join(HOME, '.ssh', 'config')

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

function uniqueHosts(parsed) {
  /* One entry per Host block, in config order. A second block that repeats an
     alias is dropped, which is how ssh resolves a repeated Host anyway. */
  const used = new Set()
  const unique = []
  for (const host of parsed) {
    const free = host.aliases.filter((alias) => !used.has(alias))
    if (!free.length) continue
    free.forEach((alias) => used.add(alias))
    unique.push({ ...host, aliases: free })
  }
  return unique
}

/**
 * Parse any file in ssh_config grammar — the user's config, or a workspace's
 * own `machines/CONFIG`. Same reader, so the two cannot disagree about what a
 * Host block is.
 */
function parseSshHostsFile(file) {
  const resolved = path.resolve(String(file || ''))
  if (!fs.existsSync(resolved)) return []
  return uniqueHosts(readSshFile(resolved, 0, new Set(), []))
}

function readSshHosts() {
  const exists = fs.existsSync(SSH_CONFIG_PATH)
  const unique = exists ? parseSshHostsFile(SSH_CONFIG_PATH) : []

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

function probeSshHost(alias, options = {}) {
  const target = String(alias || '').trim()
  const configFile = String(options.configFile || '').trim()
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
    /* `-F` replaces ~/.ssh/config with the workspace's own copy, so a probe
       proves the config this workspace carries, not the one the user happens to
       have. A missing file falls back to the default config instead of failing. */
    const argv = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new']
    if (configFile && fs.existsSync(configFile)) argv.unshift('-F', configFile)
    argv.push(target, 'true')

    execFile(
      'ssh',
      argv,
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

/* The frontmatter parser lives in frontmatter.cjs so skills and entities read
   the same grammar. Re-exported below for callers that already expect it here. */

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

/** Which harness a resolved path belongs to, if any — used to label a symlink. */
function harnessSourceOf(realPath) {
  if (!realPath) return null
  for (const harness of HARNESSES) {
    for (const root of harness.roots) {
      if (realPath === root || realPath.startsWith(root + path.sep)) {
        return { harness: harness.id, harnessLabel: harness.label, root }
      }
    }
  }
  return null
}

/**
 * Scan one directory that holds skills — either a harness's own library or a
 * workspace's `skills/` directory. Same shape for both, so the library view and
 * the workspace view cannot disagree about what a skill is.
 *
 * In workspace mode (`detectHarness`) each entry is usually a symlink into a
 * harness library: the harness is read off the resolved target, and a link whose
 * target is gone becomes `missing: true` instead of disappearing.
 */
function scanSkillDir(root, options = {}) {
  const { harness = 'workspace', harnessLabel = 'Workspace', detectHarness = false } = options
  const items = []
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return items
  }

  for (const entry of entries) {
    const full = path.join(root, entry.name)
    let stat = null
    let dangling = false
    try {
      stat = fs.statSync(full) // follows symlinks, which most harness links are
    } catch {
      dangling = entry.isSymbolicLink()
      if (!dangling) continue
    }

    const linkTarget = (() => {
      try {
        return entry.isSymbolicLink() ? fs.readlinkSync(full) : ''
      } catch {
        return ''
      }
    })()
    const realPath = (() => {
      try {
        return fs.realpathSync(full)
      } catch {
        return ''
      }
    })()
    const source = detectHarness ? harnessSourceOf(realPath) : null

    if (dangling) {
      items.push({
        id: `${harness}:${entry.name}`,
        name: entry.name,
        harness,
        harnessLabel,
        path: tilde(full),
        absolutePath: full,
        sourcePath: linkTarget ? tilde(linkTarget) : '',
        entry: null,
        singleFile: false,
        description: '',
        version: '',
        license: '',
        runtime: '',
        files: 0,
        bytes: 0,
        size: '—',
        updatedAt: null,
        link: entry.isSymbolicLink(),
        copied: false,
        missing: true,
      })
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
    const files = singleFile ? [{ bytes: stat.size }] : walkFiles(full, { cap: 400, maxDepth: 4 })
    const bytes = files.reduce((sum, file) => sum + (file.bytes || 0), 0)
    const updatedAt = (() => {
      try {
        return fs.statSync(entryFile).mtime.toISOString()
      } catch {
        return stat.mtime.toISOString()
      }
    })()

    const itemHarness = source?.harness || harness
    items.push({
      id: `${itemHarness}:${meta.name}`,
      name: meta.name,
      harness: itemHarness,
      harnessLabel: source?.harnessLabel || harnessLabel,
      path: tilde(full),
      absolutePath: full,
      sourcePath: detectHarness ? tilde(realPath) : tilde(full),
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
      link: entry.isSymbolicLink(),
      copied: detectHarness ? !entry.isSymbolicLink() : false,
      missing: false,
    })
  }

  return items
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

    const found = []
    for (const root of roots) {
      if (!root.exists) continue
      for (const item of scanSkillDir(root.path, { harness: harness.id, harnessLabel: harness.label })) {
        const key = `${harness.id}:${item.name.toLowerCase()}`
        if (seen.has(key)) continue
        seen.add(key)
        found.push(item)
      }
    }

    items.push(...found)
    harnesses.push({
      id: harness.id,
      label: harness.label,
      count: found.length,
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

/** Every skill directory this machine knows about, for the attach checklist. */
function skillSources() {
  const scan = scanSkillLibrary()
  return scan.items.map((item) => ({
    name: item.name,
    harness: item.harness,
    harnessLabel: item.harnessLabel,
    path: item.path,
    absolutePath: item.absolutePath,
    description: item.description,
    version: item.version,
  }))
}

function withContents(item) {
  const entryPath = item.singleFile ? item.absolutePath : path.join(item.absolutePath, item.entry)
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

function readSkillEntry(harnessId, name) {
  const targetHarness = String(harnessId || '')
  const targetName = String(name || '').toLowerCase()
  const scan = scanSkillLibrary()
  const item = scan.items.find(
    (entry) => entry.harness === targetHarness && entry.name.toLowerCase() === targetName,
  )
  return item ? withContents(item) : null
}

/** Read one skill out of a workspace's `skills/` directory. */
function readWorkspaceSkill(root, name) {
  const targetName = String(name || '').toLowerCase()
  const item = scanSkillDir(root, { detectHarness: true }).find(
    (entry) => entry.name.toLowerCase() === targetName,
  )
  if (!item || item.missing) return null
  return withContents(item)
}

module.exports = {
  SSH_CONFIG_PATH,
  HARNESSES,
  parseSshHostsFile,
  readSshHosts,
  probeSshHost,
  scanSkillLibrary,
  scanSkillDir,
  skillSources,
  harnessSourceOf,
  readSkillEntry,
  readWorkspaceSkill,
  parseFrontmatter,
}
