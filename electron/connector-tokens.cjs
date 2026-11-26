/**
 * Paste-once API tokens — the credential a connector that never refreshes holds.
 *
 * `oauth-secrets.cjs` stores a client and a refresh token *per account*. That is
 * the wrong shape for a service whose credential is one opaque key a person pastes
 * once and which expires only when they rotate it: Clockify, and whatever comes
 * next. There is no consent screen, no refresh, no per-account row — one key for
 * the connector, on this machine.
 *
 * So: its own `0600` file, its own verb group (`connector.token.*`), and the same
 * two rules the OAuth vault keeps:
 *
 *   - **No read returns a token.** `statusOf` answers `{ configured, hint }` and the
 *     hint is the last four characters, which is what a person needs to recognise
 *     which key is in place and not enough to use it.
 *   - **`tokenFor` is main-process only**, for the resolver that must actually call
 *     the service. The call table never exposes it.
 *
 * `connector-tokens.json` sits beside `oauth-secrets.json` in the same root, is
 * written `0600` and atomically (staged `.pid.tmp` + rename), and is never synced.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/* `ENTITY_HOME` first, exactly like every other store: a test must never write the
   developer's real `~/.entity`. */
const ROOT = process.env.ENTITY_HOME
  ? path.resolve(process.env.ENTITY_HOME)
  : path.join(os.homedir(), '.entity')
const CONFIG = path.join(ROOT, 'connector-tokens.json')
const FILE = 'connector-tokens.json'
const SCHEMA = 1

const text = (value, max = 400) => String(value ?? '').trim().slice(0, max)

function empty() {
  return { schema: SCHEMA, tokens: {} }
}

/** Unreadable or absent reads as empty: no token saved is a state, not a crash. */
function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
    return {
      schema: SCHEMA,
      tokens: raw?.tokens && typeof raw.tokens === 'object' ? raw.tokens : {},
    }
  } catch {
    return empty()
  }
}

function write(store) {
  const body = `${JSON.stringify({ schema: SCHEMA, tokens: store.tokens || {} }, null, 2)}\n`
  const staged = `${CONFIG}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(CONFIG), { recursive: true, mode: 0o700 })
    fs.writeFileSync(staged, body, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(staged, CONFIG)
  } catch (error) {
    try {
      fs.unlinkSync(staged)
    } catch {
      /* nothing was staged */
    }
    throw new Error(`${FILE} could not be written (${String(error?.message || error)}). Nothing changed.`)
  }
  return store
}

/**
 * What a page may know: whether a token is saved, and the last four characters of
 * it. The token itself never crosses this function — that is the whole contract.
 */
function statusOf(connector) {
  const name = text(connector, 60)
  const token = text(read().tokens[name]?.token)
  return {
    connector: name,
    configured: Boolean(token),
    hint: token ? `…${token.slice(-4)}` : '',
  }
}

/**
 * Save (or replace) one connector's token. Written by a call that already verified
 * it upstream — a key that cannot reach the service is not a key worth keeping.
 */
function save_(name, value) {
  const store = read()
  store.tokens[name] = { token: value, savedAt: new Date().toISOString() }
  write(store)
  return statusOf(name)
}

/** The token itself, for a resolver. Main-process only: no call-table entry returns it. */
function tokenFor(connector) {
  return text(read().tokens[text(connector, 60)]?.token) || ''
}

/**
 * The connector's own save-time check, from the registry.
 *
 * A `credential: 'token'` head ships `verify({ token, workspaceId })` in
 * `electron/connectors/<id>/connector.cjs`; the registry is the one place that maps a name to
 * it, so a head with no verify is refused rather than silently trusted. Required at
 * call time, in the direction that keeps the module graph acyclic.
 */
function verifierFor(connector) {
  const name = text(connector, 60)
  if (!name) throw new Error('Which connector should the key be checked against?')
  const verify = require('./connectors/index.cjs').verifyFor(name)
  if (!verify) throw new Error(`"${name}" ships no check for an API key, so nothing was checked.`)
  return verify
}

/** The save-time check, on its own: never writes, only asks the service. */
async function test({ connector, token, workspaceId } = {}) {
  const name = text(connector, 60)
  const value = text(token) || tokenFor(name)
  if (!value) throw new Error('Paste an API key first — there is none on this machine to check.')
  await verifierFor(name)({ token: value, workspaceId: text(workspaceId, 60) })
  return { ok: true, connector: name, detail: 'The service accepted this key for that workspace.' }
}

/** Verify, then write. A key that failed is never stored. */
async function save({ connector, token, workspaceId } = {}) {
  const name = text(connector, 60)
  const value = text(token)
  if (!value) throw new Error('A token is required.')
  await verifierFor(name)({ token: value, workspaceId: text(workspaceId, 60) })
  return save_(name, value)
}

function forget(connector) {
  const name = text(connector, 60)
  const store = read()
  if (!name || !store.tokens[name]) return statusOf(name)
  delete store.tokens[name]
  write(store)
  return statusOf(name)
}

module.exports = { CONFIG, FILE, SCHEMA, read, statusOf, test, save, tokenFor, forget }
