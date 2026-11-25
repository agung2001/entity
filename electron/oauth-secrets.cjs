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
    /* True where the console hands out a downloadable client file (Google), so
       the card offers a drop zone only on that provider's page. */
    acceptsClientFile: Boolean(meta.clientFile),
  }
}

/**
 * Save (or replace) one provider's client.
 *
 * Validation is here, not in the view: this is the trust boundary. Both values
 * are required, the id has to look like a Google client id, and the secret has to
 * be long enough to be one. A refusal writes nothing.
 */
function setClient({ provider = 'google', clientId, clientSecret, redirectUri } = {}) {
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
    /* A dynamically registered client is only valid for the redirect it was minted
       for, so the redirect is stored beside it and compared on every connect. */
    ...(redirectUri ? { redirectUri: String(redirectUri) } : {}),
    savedAt: new Date().toISOString(),
  }
  write(store)
  return status({ provider: name })
}

/* ── a downloaded `credentials.json` ──────────────────────────────────────
   Google hands out a file, not two strings, so the card can accept the file and
   this module reads it. The file is a courier: parsed here in the main process,
   never stored, and the entry that lands in `oauth-secrets.json` is exactly the
   one the typed form writes. Nothing below logs or returns the text. */
const FILE_MAX = 64 * 1024
/* Fixed length, never a slice of the value: how long a secret is, is not a fact a
   page needs. */
const SECRET_MASK = '••••••••••••'

/**
 * Read the client id and secret out of a downloaded `credentials.json`.
 *
 * Pure: reads nothing from disk, writes nothing. The id's suffix and the secret's
 * length are `setClient`'s rules and run when the person saves, so the file path
 * and the typed path cannot disagree about what a valid client is.
 *
 * Every refusal names the field or the *kind* of file — never a value, never the
 * file's contents.
 */
function parseClientFile(source, provider = 'google') {
  const name = String(provider)
  if (name !== 'google') {
    throw new Error(
      `A ${providers.labelOf(name)} client is not a file the console lets you download — paste its client id instead.`,
    )
  }
  const body = String(source ?? '')
  if (body.length > FILE_MAX) {
    throw new Error('That file is far larger than a credentials file. Pick the credentials.json the console downloaded.')
  }
  let file = null
  try {
    file = JSON.parse(body)
  } catch {
    throw new Error('That file is not JSON. Pick the credentials.json the console downloaded.')
  }
  if (file?.type === 'service_account' || file?.private_key) {
    throw new Error(
      'That is a service-account key. A service account is a robot identity and cannot sign a person in — download a “Desktop app” client instead.',
    )
  }
  if (file?.web) {
    throw new Error(
      'That is a Web-application client, which needs a registered redirect URL. Download a “Desktop app” client instead — it is the one the consent round-trip can use.',
    )
  }
  const installed = file?.installed || {}
  if (!installed.client_id) throw new Error('That file has no client_id. Pick a “Desktop app” client’s credentials.json.')
  if (!installed.client_secret) throw new Error('That file has no client_secret. Pick a “Desktop app” client’s credentials.json.')
  return { clientId: String(installed.client_id), clientSecret: String(installed.client_secret) }
}

/** What the card shows before Save: the id that was read, and a mask. No write. */
function previewClientFile({ provider = 'google', text: source } = {}) {
  const { clientId } = parseClientFile(source, provider)
  return { clientId, secretMasked: SECRET_MASK }
}

/** The file path's save: parse, then the same `setClient` the form calls. */
function setClientFromFile({ provider = 'google', text: source } = {}) {
  const { clientId, clientSecret } = parseClientFile(source, provider)
  return setClient({ provider, clientId, clientSecret })
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
  return {
    clientId: client.clientId,
    clientSecret: client.clientSecret || '',
    redirectUri: client.redirectUri || '',
  }
}

/** `<connector>:<localpart>`, the same key the account store uses. */
const keyOf = (connector, localpart) => `${String(connector)}:${String(localpart)}`

/**
 * Store one account's tokens. Written by the consent answer only.
 *
 * A refresh token is the durable half, but a provider may hand back an access token
 * with a deadline too, and a resolver that runs before that deadline should use it
 * instead of paying for a refresh. `clientId` / `redirectUri` / `authorizationServer`
 * ride along for a dynamically registered client, because a later refresh has to
 * present the same client it was issued to. Nothing here is ever returned by a verb.
 */
function putToken({
  connector,
  localpart,
  provider = 'google',
  refreshToken,
  accessToken,
  expiresAt,
  scopes = [],
  clientId,
  redirectUri,
  authorizationServer,
} = {}) {
  if (!connector || !localpart) throw new Error('A token needs a connector and an account.')
  if (!refreshToken) throw new Error('A token needs a refresh token.')
  const store = read()
  store.tokens[keyOf(connector, localpart)] = {
    provider: String(provider),
    refreshToken: String(refreshToken),
    scopes: Array.isArray(scopes) ? scopes.map(String) : [],
    ...(accessToken ? { accessToken: String(accessToken) } : {}),
    ...(Number.isFinite(Number(expiresAt)) ? { expiresAt: Number(expiresAt) } : {}),
    ...(clientId ? { clientId: String(clientId) } : {}),
    ...(redirectUri ? { redirectUri: String(redirectUri) } : {}),
    ...(authorizationServer ? { authorizationServer: String(authorizationServer) } : {}),
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
  parseClientFile,
  previewClientFile,
  setClientFromFile,
  clearClient,
  clientFor,
  putToken,
  tokenFor,
  forgetToken,
  forgetConnector,
  forgetProvider,
}
