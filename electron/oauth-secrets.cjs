/**
 * OAuth credentials for account-bearing connectors — the half that must never be
 * read by a page.
 *
 * Two different things live in two different files, and the split is the rule
 * `docs/security.md` keeps:
 *
 *   - `oauth-accounts.json` (`oauth-accounts.cjs`) — the seven public fields of
 *     each account: address, scopes, status, timestamps. A page reads this.
 *   - `oauth-secrets.json` (**this file**) — the OAuth client id/secret and one
 *     refresh token per account, written `0600`. **No call table entry returns
 *     this file.** The renderer learns only whether a client is configured, never
 *     the values.
 *
 * Why not Keychain / libsecret: the app already keeps the MCP pool's credentials
 * in a `0600` file on this machine and calls that acceptable (`docs/security.md`
 * — "The MCP pool may hold a credential and is written `0600`"). A second, more
 * privileged mechanism for the same class of secret would be a new dependency and
 * a new failure mode on Linux, for no gain over the rule the repo already states.
 *
 * The loopback round-trip (`connect()`) lives in `oauth-accounts.cjs`; this module
 * is only the vault it writes into.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/* `ENTITY_HOME` first, exactly like every other store: a test must never write the
   developer's real `~/.entity`. */
const ROOT = process.env.ENTITY_HOME
  ? path.resolve(process.env.ENTITY_HOME)
  : path.join(os.homedir(), '.entity')
const CONFIG = path.join(ROOT, 'oauth-secrets.json')
const FILE = 'oauth-secrets.json'
const SCHEMA = 1

/* The client id/secret Google issues for this app. `clientId` ends in
   `.apps.googleusercontent.com`; a desktop ("installed app") client has a secret
   that Google documents as not-secret, but it is still stored here rather than in
   a tracked file. */
const text = (value, max = 400) => String(value ?? '').trim().slice(0, max)

function empty() {
  return { schema: SCHEMA, clients: {}, tokens: {} }
}

/** Unreadable or absent reads as empty: no client configured is a state, not a
 *  crash. */
function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
    return {
      schema: SCHEMA,
      clients: raw?.clients && typeof raw.clients === 'object' ? raw.clients : {},
      tokens: raw?.tokens && typeof raw.tokens === 'object' ? raw.tokens : {},
    }
  } catch {
    return empty()
  }
}

function write(store) {
  const body = `${JSON.stringify({ schema: SCHEMA, clients: store.clients || {}, tokens: store.tokens || {} }, null, 2)}\n`
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
 * Is a client configured **for this provider**? The renderer asks this to decide
 * whether to show the credentials form or the `Connect` button — the values
 * themselves never cross the call table.
 *
 * `provider` is the connector family, because Gmail / Drive / YouTube share one
 * Google client and X will need its own.
 */
/* The provider table is the single source: what a provider needs, where to create a
   client, and whether the callback must be registered. Duplicating any of it here
   is how a page ends up telling an X user to make a "Desktop app" Google client,
   which is exactly the bug this file had. */
const providers = require('./oauth-providers.cjs')

/** The provider's own name, for a button that must not say "Google" on X. */
const labelOf = (provider = 'google') => providers.labelOf(provider)

function status({ provider = 'google' } = {}) {
  const name = String(provider)
  const client = read().clients[name] || {}
  const meta = providers.providerConfig(name) || providers.providerConfig('google')
  /* A public client is configured by its id alone. */
  const configured = Boolean(client.clientId && (client.clientSecret || !meta.secretRequired))
  return {
    provider: name,
    configured,
    secretRequired: meta.secretRequired,
    label: meta.label,
    /* Enough to recognise which client is in use, never enough to use it. */
    hint: client.clientId ? `${String(client.clientId).slice(0, 12)}…` : '',
    /* The provider's own console page for creating one, so the form can link out. */
    consoleUrl: meta.consoleUrl,
    instruction: meta.clientHint || '',
    /* Present only where the provider needs it registered (X). */
    callback: providers.callbackOf(name),
  }
}

/**
 * Save (or replace) one provider's client.
 *
 * Validation is here, not in the view: this is the trust boundary. Both values
 * are required, the id has to look like a Google client id, and the secret has to
 * be long enough to be one. A refusal writes nothing.
 */
function setClient({ provider = 'google', clientId, clientSecret } = {}) {
  const name = text(provider, 40) || 'google'
  const meta = providers.providerConfig(name) || providers.providerConfig('google')
  const id = text(clientId)
  const secret = text(clientSecret)
  if (!id) throw new Error('A client id is required.')
  if (meta.secretRequired !== false && !secret) throw new Error('A client secret is required.')
  /* Validate the shape Google documents, for Google only: X's client ids are
     opaque base64 and checking them against a Google suffix would refuse a valid
     one. */
  if (name === 'google' && !id.endsWith('.apps.googleusercontent.com')) {
    throw new Error(
      'That does not look like a Google client id — it should end in .apps.googleusercontent.com.',
    )
  }
  if (meta.secretRequired !== false && secret.length < 10) throw new Error('That client secret looks too short to be one.')
  const store = read()
  store.clients[name] = {
    clientId: id,
    /* A public client stores no secret at all. */
    ...(secret ? { clientSecret: secret } : {}),
    savedAt: new Date().toISOString(),
  }
  write(store)
  return status({ provider: name })
}

/** Remove a provider's client and every token issued under it. */
function clearClient({ provider = 'google' } = {}) {
  const name = text(provider, 40) || 'google'
  const store = read()
  delete store.clients[name]
  for (const [key, token] of Object.entries(store.tokens)) {
    if (token?.provider === name) delete store.tokens[key]
  }
  write(store)
  return status({ provider: name })
}

/** The live client for a provider, for the consent round-trip. Main-process only:
 *  no call-table entry may return this. */
function clientFor(provider = 'google') {
  const name = String(provider)
  const client = read().clients[name] || null
  const meta = providers.providerConfig(name) || providers.providerConfig('google')
  if (!client?.clientId) return null
  if (meta.secretRequired !== false && !client.clientSecret) return null
  return { clientId: client.clientId, clientSecret: client.clientSecret || '' }
}

/** `<connector>:<localpart>`, the same key the account store uses. */
const keyOf = (connector, localpart) => `${String(connector)}:${String(localpart)}`

/** Store one account's refresh token. Written by the consent answer only. */
function putToken({ connector, localpart, provider = 'google', refreshToken, scopes = [] } = {}) {
  if (!connector || !localpart) throw new Error('A token needs a connector and an account.')
  if (!refreshToken) throw new Error('A token needs a refresh token.')
  const store = read()
  store.tokens[keyOf(connector, localpart)] = {
    provider: String(provider),
    refreshToken: String(refreshToken),
    scopes: Array.isArray(scopes) ? scopes.map(String) : [],
    savedAt: new Date().toISOString(),
  }
  write(store)
}

/** One account's token, for a refresh. Main-process only. */
function tokenFor({ connector, localpart } = {}) {
  return read().tokens[keyOf(connector, localpart)] || null
}

/** Forget one account's token (used when the account is removed). */
function forgetToken({ connector, localpart } = {}) {
  const store = read()
  delete store.tokens[keyOf(connector, localpart)]
  write(store)
}

/** Forget every token of one connector (used when the connector is removed). */
function forgetConnector(connector) {
  const store = read()
  for (const key of Object.keys(store.tokens)) {
    if (key.startsWith(`${String(connector)}:`)) delete store.tokens[key]
  }
  write(store)
}

/**
 * Forget every token of one provider (used when the client is replaced): a
 * refresh token issued to an older client id is dead anyway.
 */
function forgetProvider(provider = 'google') {
  const store = read()
  for (const [key, token] of Object.entries(store.tokens)) {
    if (token?.provider === String(provider)) delete store.tokens[key]
  }
  write(store)
}

module.exports = {
  CONFIG,
  FILE,
  read,
  labelOf,
  status,
  setClient,
  clearClient,
  clientFor,
  putToken,
  tokenFor,
  forgetToken,
  forgetConnector,
  forgetProvider,
}
