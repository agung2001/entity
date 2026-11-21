/**
 * Build a disposable profile for a screenshot — the same idea as
 * `seed-profile.mjs`, but written for a picture rather than a test.
 *
 * Everything here is invented at run time inside `.tmp/` (gitignored). No value
 * in this file is a real host, workspace, account or SSH alias, and this script
 * never reads the user's `~/.ssh/config` or `auth.json`: it writes a scratch
 * `HOME/.ssh/config` of its own, so a screenshot taken against this profile
 * cannot spoil a real configuration even by accident.
 *
 * The fleet is deliberately the shape the roster has to survive:
 * - a long alias that wraps, and its sibling that differs in the last letters
 * - a host that has been scanned (a full inventory)
 * - a host that is unreachable (a reason in the row, and a kept count beside it)
 * - hosts that were never tested
 * - git remotes, which are in `~/.ssh/config` but are not agent hosts
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
}

/* The fleet, invented. Aliases read like a workshop's machines, not like a
   person's: `atlas`, `borealis`, `cinder`. */
const HOSTS = [
  { alias: 'atlas-build', hostName: '10.20.0.11', user: 'root', scanned: true },
  { alias: 'borealis-gpu', hostName: '10.20.0.12', user: 'root', scanned: false },
  { alias: 'cinder-staging', hostName: '10.20.0.13', user: 'root', scanned: false },
  { alias: 'dune-ci-runner-01', hostName: '10.20.0.14', user: 'root', scanned: true },
  { alias: 'dune-ci-runner-02', hostName: '10.20.0.15', user: 'root', scanned: false },
  /* the pair that must never be told apart by ellipsis: they differ at the end */
  { alias: 'workshop-west', hostName: '10.20.0.21', user: 'root', scanned: false },
  { alias: 'workshop-east', hostName: '10.20.0.22', user: 'root', scanned: false },
  { alias: 'ember-analytics', hostName: '10.20.0.31', user: 'root', scanned: false, port: '2222' },
  /* a host that answers nothing, so the picture shows the failure state too —
     192.0.2.0/24 is TEST-NET-1 (RFC 5737): reserved for documentation, routed
     nowhere, so a connection to it cannot reach a real machine */
  { alias: 'garnet-archive', hostName: '192.0.2.44', user: 'root', scanned: false },
  { alias: 'fathom-batch', hostName: '10.20.0.32', user: 'root', scanned: true },
  /* git remotes: real entries in a config, not agent hosts */
  { alias: 'mirror-origin', hostName: 'git.example.test', user: 'git', remote: true },
  { alias: 'mirror-upstream', hostName: 'git.example.test', user: 'git', remote: true },
  { alias: 'vendor-fork', hostName: 'vendor.example.test', user: 'git', remote: true },
]

/** One `Host` block, in the grammar the real reader parses. */
function sshConfig(hosts) {
  const lines = [
    '# A scratch fleet for a screenshot. Every alias here is invented.',
    '',
  ]
  for (const host of hosts) {
    lines.push(`Host ${host.alias}`)
    lines.push(`    HostName ${host.hostName}`)
    lines.push(`    User ${host.user}`)
    if (host.port) lines.push(`    Port ${host.port}`)
    lines.push(`    IdentityFile ~/.ssh/id_ed25519`)
    lines.push('')
  }
  return lines.join('\n')
}

/* Invented harness inventories, so the roster's *Inventory* column is not
   `no inventory yet` on every row in the picture. */
const INVENTORY = {
  'atlas-build': [
    { id: 'claude', label: 'Claude Code', path: '~/.local/bin/claude', models: ['claude-sonnet-4-6', 'claude-opus-4-1'] },
    { id: 'codex', label: 'Codex', path: '~/.local/bin/codex', models: ['gpt-5-codex'] },
    { id: 'opencode', label: 'OpenCode', path: '~/.local/bin/opencode', models: ['anthropic/claude-sonnet-4-6'] },
    { id: 'gemini', label: 'Gemini CLI', path: '~/.local/bin/gemini', models: ['gemini-2.5-pro'] },
    { id: 'pi', label: 'pi', path: '~/.local/bin/pi', models: ['sonnet', 'opus'] },
  ],
  'dune-ci-runner-01': [
    { id: 'codex', label: 'Codex', path: '/usr/local/bin/codex', models: ['gpt-5-codex'] },
    { id: 'pi', label: 'pi', path: '/usr/local/bin/pi', models: ['sonnet'] },
  ],
  'fathom-batch': [
    { id: 'claude', label: 'Claude Code', path: '/usr/local/bin/claude', models: ['claude-haiku-4-5'] },
  ],
}

export async function seedStory({ root, profile, stateDir, home }) {
  process.env.ENTITY_HOME = profile
  /* The ssh reader resolves `~` from the real home directory, so a scratch HOME
     is what keeps a picture of a fleet away from a real one. */
  process.env.HOME = home
  process.env.ENTITY_HOSTNAME = 'studio-workstation'

  resetDir(profile)
  resetDir(stateDir)
  resetDir(home)
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true })
  fs.writeFileSync(path.join(home, '.ssh', 'config'), sshConfig(HOSTS), { mode: 0o600 })

  const auth = require(path.join(root, 'electron', 'auth-store.cjs'))
  const workspaces = require(path.join(root, 'electron', 'workspace-store.cjs'))
  const entities = require(path.join(root, 'electron', 'entity-store.cjs'))

  /* A synthetic identity, generated here and never written to the repository.
     `example.test` can never be registered (RFC 2606), so it cannot be a real
     mailbox even by accident. */
  const nonce = crypto.randomBytes(3).toString('hex')
  const email = `studio-${nonce}@example.test`
  const username = `studio-${nonce}`
  const password = crypto.randomBytes(24).toString('base64url')
  const account = await auth.register({ email, name: username, password })

  const record = workspaces.create({
    label: 'studio',
    owner: { name: username, email },
  })
  const workspace = record.id
  const workspacePath = record.path

  /* One plausible entity, so the tab counts are not all zero. */
  entities.write({
    workspace,
    name: 'buildkeeper',
    harness: 'claude',
    model: '',
    dir: workspacePath,
    skills: [],
    mcp: [],
    instructions: '# Buildkeeper\n\nYou watch the build fleet and report what changed.\n',
    frontmatter: { description: 'Watches the build fleet and reports what changed.' },
  })
  entities.write({
    workspace,
    name: 'quartermaster',
    harness: 'codex',
    model: '',
    dir: workspacePath,
    skills: [],
    mcp: [],
    instructions: '# Quartermaster\n\nYou keep the inventory of what each machine can run.\n',
    frontmatter: { description: 'Keeps the inventory of what each machine can run.' },
  })

  /* The scan snapshots: same file the app reads, in the same shape. */
  const now = Date.now()
  const hosts = {}
  for (const [alias, harnesses] of Object.entries(INVENTORY)) {
    hosts[alias] = {
      alias,
      label: alias,
      spec: `${HOSTS.find((host) => host.alias === alias)?.user || 'root'}@${HOSTS.find((host) => host.alias === alias)?.hostName || '10.20.0.0'}`,
      status: 'ok',
      source: 'ssh',
      checkedAt: new Date(now - 1000 * 60 * 7).toISOString(),
      durationMs: 640,
      harnesses,
    }
  }
  hosts.local = {
    alias: 'local',
    label: 'this machine',
    spec: 'localhost',
    status: 'ok',
    source: 'local',
    checkedAt: new Date(now - 1000 * 60 * 2).toISOString(),
    durationMs: 210,
    harnesses: INVENTORY['atlas-build'],
  }
  const factsFile = path.join(workspacePath, 'machine-facts.json')
  fs.writeFileSync(
    factsFile,
    `${JSON.stringify({ schema: 1, hosts, updatedAt: new Date(now).toISOString() }, null, 2)}\n`,
    'utf8',
  )

  /* The sweep is this machine, claimed, so the roster shows a real answer in the
     `Sweep here` column and the rail's line. */
  workspaces.setArtifactRetention({
    id: workspace,
    artifactRetention: {
      executor: {
        kind: 'machine',
        member: email,
        hostname: 'studio-workstation',
        claimedAt: new Date(now).toISOString(),
      },
    },
  })

  const state = {
    accountId: account?.id || null,
    user: { username, email },
    password,
    workspace,
    workspaceLabel: 'studio',
    workspacePath,
    profile,
    home,
  }
  fs.writeFileSync(path.join(stateDir, 'story.json'), `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  })
  return state
}
