/**
 * OAuth accounts: one row per connected mailbox, kept on this machine only.
 *
 * An account-bearing connector (`rest` + `oauth`) has *accounts*, and an account
 * is a credential — not a definition. Definitions travel with the workspace;
 * accounts do not. They live beside `integrations.json` in `~/.entity/`, because
 * that is the one store the CLI rows already trust with a sign-in, and nothing
 * here writes `mcp.json`.
 *
 * Two rules this file keeps:
 *
 *   1. **A refresh token is never in this module's answer.** The file may hold one
 *      (that is what a credential store is for), but every read is reduced to the
 *      seven agreed fields, so a page cannot render what it was not given
 *      (`docs/security.md`).
 *   2. **Missing file reads as `{}`.** A connector with no account is a state, not
 *      an error, and a person who never connected anything has no file at all.
 *
 * **The consent round-trip** (`connect()`) is the OAuth 2.0 loopback flow:
 *
 *   1. a server on `127.0.0.1:<port>` is started for the redirect — an OS-chosen
 *      port where the provider allows one (Google), a fixed one where it validates
 *      the callback by exact match (X);
 *   2. the system browser is opened at the provider's consent URL (never a webview
 *      — `docs/security.md`, and a webview would also defeat the provider's own
 *      "this app wants access" screen);
 *   3. the provider redirects the browser back with `code` and `state`, or with
 *      `error=access_denied`;
 *   4. the code is exchanged for a refresh token over HTTPS (PKCE, S256), the
 *      profile is read once to name the account, and the row is filed.
 *
 * **Where the pieces live** — this file owns the flow and the account rows, and
 * nothing else, because the tables are the parts that grow:
 *
 *   - `oauth-providers.cjs` — one row per provider: endpoints, whether a client
 *     secret exists, a fixed port if the callback must be registered. Adding Figma
 *     or Slack is one entry there.
 *   - `oauth-scopes.cjs`    — one entry per connector, three access tiers each.
 *     Adding a connector is one entry there.
 *   - `oauth-secrets.cjs`   — the client id/secret and refresh tokens, `0600`, in
 *     a file no call table entry ever returns.
 *
 * A new built-in connector is therefore **two table rows and a resolver**; this
 * module does not change.
 *
 * The refresh token goes to `oauth-secrets.cjs` (`0600`), **not** to this file.
 * This file stays the public half: seven fields, no secret, readable by a page.
 *
 * One app-wide client, stored per machine, is the answer taken to spec §10
 * question 2 — a desktop build with a loopback redirect can ship one, and a client
 * per workspace would put the same secret in a synced folder N times. So the
 * client is asked for once, in the card, and every account under a provider uses
 * it.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const secrets = require('./oauth-secrets.cjs')
const workspaces = require('./workspace-store.cjs')
/* The chosen tier is a property of the *connector in this workspace*, so it lives
   in the workspace's index (`connectors.json`), not in the machine's account file:
   two workspaces may want different access from the same mailbox.
   Required at call time, not at load: `connector-store` loads the catalog, which
   the call table also loads, so a top-level require here closes a cycle
   (`connector-store` would see an exports object with `readIndex` not yet defined).
   The same shape `integrations-store` uses for the same reason. */
const indexOf = () => require('./connector-store.cjs')

/* `ENTITY_HOME` first, exactly like every other store: a test must never write the
   developer's real `~/.entity`. */
const ROOT = process.env.ENTITY_HOME
  ? path.resolve(process.env.ENTITY_HOME)
  : path.join(os.homedir(), '.entity')
const CONFIG = path.join(ROOT, 'oauth-accounts.json')
const FILE = 'oauth-accounts.json'
const SCHEMA = 1

/* Every field an account has, and nothing else. A key outside this list is
   bookkeeping the store never agreed to keep — and `/token|secret|refresh/i` is
   what makes that a rule rather than a convention. */
const FIELDS = ['email', 'localpart', 'scopes', 'missing', 'status', 'addedAt', 'refreshedAt']
const SECRET = /token|secret|refresh/i
const STATUSES = new Set(['connected', 'needs sign-in', 'signing in', 'parked'])

const text = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const strings = (value) =>
  Array.isArray(value) ? value.map((entry) => text(entry, 200)).filter(Boolean).slice(0, 40) : []
const iso = (value) => {
  const at = Date.parse(String(value || ''))
  return Number.isFinite(at) ? new Date(at).toISOString() : ''
}

/** One stored account, reduced to the seven agreed fields. Any key outside that
 *  list is dropped, and a secret-shaped one is dropped by the same rule — the only
 *  exemption is `refreshedAt`, a timestamp the card prints, whose name merely
 *  contains `refresh`. */
function normalise(raw) {
  if (!raw || typeof raw !== 'object') return null
  const email = text(raw.email, 200)
  const localpart = text(raw.localpart || email.split('@')[0], 80)
  if (!email || !localpart) return null
  const safe = {}
  for (const key of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
    if (SECRET.test(key) && !FIELDS.includes(key)) continue
    safe[key] = raw[key]
  }
  return {
    email,
    localpart,
    scopes: strings(safe.scopes),
    missing: strings(safe.missing),
    status: STATUSES.has(safe.status) ? safe.status : 'needs sign-in',
    addedAt: iso(safe.addedAt),
    refreshedAt: iso(safe.refreshedAt),
  }
}

/** The file, honestly read: unreadable or absent is `{}`, not an exception. */
function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
    const stored = raw?.accounts && typeof raw.accounts === 'object' ? raw.accounts : {}
    const accounts = {}
    for (const [connector, entries] of Object.entries(stored)) {
      const rows = (Array.isArray(entries) ? entries : []).map(normalise).filter(Boolean)
      if (rows.length) accounts[String(connector)] = rows
    }
    return { schema: SCHEMA, accounts }
  } catch {
    return { schema: SCHEMA, accounts: {} }
  }
}

function write(store) {
  const body = `${JSON.stringify({ schema: SCHEMA, accounts: store.accounts || {} }, null, 2)}\n`
  const staged = `${CONFIG}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(CONFIG), { recursive: true })
    fs.writeFileSync(staged, body, 'utf8')
    fs.renameSync(staged, CONFIG)
  } catch (error) {
    try {
      fs.unlinkSync(staged)
    } catch {
      /* nothing was staged */
    }
    throw new Error(`${FILE} could not be written (${String(error?.message || error)}). Nothing changed.`)
  }
}

/** Every account of every connector, secrets stripped by construction. */
function list() {
  return read().accounts
}

const matches = (account, who) =>
  String(account.localpart) === String(who) || String(account.email) === String(who)

/** Remove one account; its credential stays on the machine until Google is told. */
function remove({ connector, account } = {}) {
  const name = text(connector, 60)
  const who = text(account, 200)
  if (!name || !who) throw new Error('Which account should be removed?')
  const store = read()
  store.accounts[name] = (store.accounts[name] || []).filter((entry) => !matches(entry, who))
  if (!store.accounts[name].length) delete store.accounts[name]
  write(store)
  return store.accounts[name] || []
}

/** An uninstalled connector takes its accounts with it (design §2). */
function forget(connector) {
  const name = text(connector, 60)
  const store = read()
  if (!name || !store.accounts[name]) return store.accounts
  delete store.accounts[name]
  write(store)
  return store.accounts
}

/* ── the consent round-trip ───────────────────────────────────────────── */

/* Where each provider's endpoints live, and the shape of its consent. One row per
   provider in `oauth-providers.cjs` — adding a provider is one entry there, and
   this file does not change. */
const { providerOf, providerConfig, configOf, labelOf } = require('./oauth-providers.cjs')
/* What each connector may do. The data lives in `oauth-scopes.cjs`, one entry per
   connector, so a new built-in connector is a table row and not an edit here. */
const {
  DEFAULT_TIER,
  tiersFor,
  tierOf,
  wireScopes,
  displayScopes,
  displayOf,
} = require('./oauth-scopes.cjs')

/**
 * The tier this workspace chose for a connector.
 *
 * Stored on the connector's index row (`tier`), so it travels with the workspace
 * and two workspaces can ask one mailbox for different access. A workspace that
 * never chose reads `full`, which is what every row written before this setting
 * existed means.
 */
function connectorTier(connector, workspace) {
  if (!workspace) return DEFAULT_TIER
  try {
    const record = workspaces.open(workspace)
    const chosen = indexOf().readIndex(record).rows?.[String(connector)]?.tier
    /* A connector whose only tier is `read` (Habitify) has no `full` to fall back to,
       so the fallback is the table's own default — `tierOf` resolves id → `full` →
       first, which is what the scope request itself uses. Without this, a one-tier
       connector showed `read` with nothing marked current. */
    return tierOf(connector, tiersFor(connector).some((candidate) => candidate.id === chosen) ? chosen : DEFAULT_TIER).id
  } catch {
    return DEFAULT_TIER
  }
}

/** The tiers a page offers, in display form and with no wire URLs (a page never
 *  needs them; the wire form stays in this process). */
function tierChoices(connector, workspace) {
  const tiers = tiersFor(connector)
  const current = connectorTier(connector, workspace)
  return tiers.map((tier) => ({
    id: tier.id,
    label: tier.label,
    detail: tier.detail,
    scopes: tier.scopes.map((scope) => scope.display),
    current: tier.id === current,
  }))
}

/* How long a consent screen may stay open. A person has to read it; 20 s was the
   mockup's number for the *failure box*, and a real timeout that short would fail
   every careful reader. */
const CONSENT_TIMEOUT_MS = 5 * 60_000

const b64url = (buffer) =>
  buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** The HTML a person sees in their browser after the redirect. Deliberately plain:
 *  it is written from the loopback server, which serves nothing else. */
const PAGE = (heading, body) => `<!doctype html><meta charset="utf-8">
<title>${heading}</title>
<meta name="color-scheme" content="light dark">
<style>
 :root{font:16px/1.55 system-ui,-apple-system,'Segoe UI',sans-serif;color:#0a0a0a;background:#fff}
 @media (prefers-color-scheme:dark){:root{color:#f2eee4;background:#151411}}
 main{max-width:34rem;margin:18vh auto;padding:0 1.5rem}
 h1{font-size:1.35rem;margin:0 0 .6rem}
 p{margin:0;color:#4a4a4a}
 @media (prefers-color-scheme:dark){p{color:#c7c2b6}}
 code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em}
</style>
<main><h1>${heading}</h1><p>${body}</p></main>`

/** One consent in flight: the promise the call awaits, keyed by `state`. */
let pending = null

function finish(result) {
  const job = pending
  pending = null
  if (!job) return
  clearTimeout(job.timer)
  try {
    job.server.close()
  } catch {
    /* already closed by the answer */
  }
  job.resolve(result)
}

const denied = (label) =>
  `Nothing was saved. ${label} answered access_denied — the consent screen was closed, or this client is not on the account's allowed list.`
const STATE_MISMATCH =
  'Nothing was saved. The consent answer did not match the request that opened it, so it was ignored.'
const noCode = (label) => `Nothing was saved. ${label} answered without an authorization code.`

/** Exchange the code, read the profile, file the account. */
async function complete(job, code) {
  const { provider, providerClient, redirectUri, codeVerifier, connector, config, tier } = job
  const body = new URLSearchParams({
    code,
    client_id: providerClient.clientId,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  })
  /* A public client (X, Habitify) has no secret to send — PKCE is the whole proof.
     Google's installed-app flow does carry one, so it is added only where it exists.
     Form-encoded with `client_id` only, which is what a DCR registration with
     `token_endpoint_auth_method: 'none'` requires. */
  if (config.clientAuth !== 'pkce' && providerClient.clientSecret) {
    body.set('client_secret', providerClient.clientSecret)
  }
  /* RFC 8707: bind the grant to the resource it is for. */
  if (config.resource) body.set('resource', config.resource)
  const tokenResponse = await fetch(config.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  })
  const token = await tokenResponse.json().catch(() => ({}))
  if (!tokenResponse.ok) {
    const said = text(token?.error_description || token?.error || `HTTP ${tokenResponse.status}`, 200)
    /* The provider that was actually talked to, not Google: this line is the only
       place a failed exchange explains itself, and naming the wrong service sends
       whoever reads it to the wrong dashboard. */
    const who = secrets.labelOf(provider)
    return { ok: false, code: 'token_exchange_failed', message: `Nothing was saved. ${who} answered ${said}.` }
  }
  if (!token?.refresh_token) {
    return {
      ok: false,
      code: 'no_refresh_token',
      message:
        `Nothing was saved. ${secrets.labelOf(provider)} answered without a refresh token, so this account could not be read after an hour. Try connecting again — if it keeps happening, remove ${config.label} from the account's granted apps first.`,
    }
  }

  /* The address is what the row is named by, so it is read from the token's own
     identity, never typed by the person. */
  let profile = {}
  if (config.profile) {
    const profileResponse = await fetch(config.profile, {
      headers: { authorization: `Bearer ${token.access_token}` },
    })
    const raw = await profileResponse.json().catch(() => ({}))
    /* X answers `{ data: { username, name } }` where Google answers a flat
       object, so a provider that nests says how to read it. */
    profile = config.profileOf ? config.profileOf(raw) : raw
  } else if (config.profileOf) {
    /* A provider with no userinfo endpoint names the account out of the grant it
       just got — Habitify's OIDC id_token. Without this branch the identity was
       always empty and the connect flow always refused. */
    profile = config.profileOf(token)
  }
  const email = text(profile.email || profile.preferred_username || '', 200)
  if (!email) {
    return {
      ok: false,
      code: 'no_identity',
      message: `Nothing was saved. ${secrets.labelOf(provider)} answered, but the account had no address to name the row by.`,
    }
  }

  /* Google answers with the granted scopes as full URLs, so the comparison is
     made on the wire form and both results are stored in the display form — the
     card prints what a person recognises, and `not granted` names the same thing
     the re-consent asks for.
     `offline_access` is a means, not an end: what it buys is the refresh token, and a
     server that mints one has honoured it whether or not the id comes back in
     `scope`. Habitify is that server — its grant returns a refresh token and a scope
     of just `openid profile email`. Reading the echo alone calls a working account
     unusable and sends the person to re-consent for a scope they already hold. */
  const grantedWire = String(token.scope || '')
    .split(/\s+/)
    .filter(Boolean)
  const carried = (scope) =>
    grantedWire.includes(scope) ||
    /* Only when the request actually named it: a Google grant minting a refresh token
       through `access_type=offline` never asked for `offline_access`, and crediting it
       would invent a scope the person was never shown. */
    (scope === 'offline_access' &&
      Boolean(token.refresh_token) &&
      wireScopes(connector, tier).includes('offline_access'))
  const missing = wireScopes(connector, tier).filter((scope) => !carried(scope))
  /* A scope honoured but not echoed is still part of the grant, so it is named in
     the stored list: the card already says "the grant holds this", and a row whose
     `scopes` omitted it while a refresh token sat beside it would read as a
     contradiction to every consumer that checks the list. */
  const granted = [
    ...grantedWire,
    ...(carried('offline_access') && !grantedWire.includes('offline_access') ? ['offline_access'] : []),
  ].map(displayOf)

  const localpart = text(email.split('@')[0], 80)
  const now = new Date().toISOString()
  /* The secret first: an account row that points at a token is recoverable; a
     token with no row is an orphan nobody can see. */
  secrets.putToken({
    connector,
    localpart,
    provider,
    refreshToken: token.refresh_token,
    /* An access token with a deadline is stored too, so the first mention after a
       consent does not pay for a refresh it does not need. */
    accessToken: token.access_token,
    expiresAt: token.expires_in ? Date.now() + Number(token.expires_in) * 1000 : undefined,
    scopes: granted,
    /* A dynamically registered client is re-presented by the refresh, so its id and
       the redirect it was minted for travel with the token. */
    ...(config.dynamicClient && providerClient?.clientId
      ? {
          clientId: providerClient.clientId,
          redirectUri,
          authorizationServer: config.registry || '',
        }
      : {}),
  })

  const store = read()
  const rows = store.accounts[connector] || []
  const row = {
    email,
    localpart,
    scopes: granted.length ? granted : displayScopes(connector, tier),
    missing: missing.map(displayOf),
    status: 'connected',
    addedAt: rows.find((entry) => entry.localpart === localpart)?.addedAt || now,
    refreshedAt: now,
  }
  store.accounts[connector] = [...rows.filter((entry) => entry.localpart !== localpart), row]
  write(store)
  return { ok: true, account: normalise(row), accounts: store.accounts[connector].map(normalise) }
}

/* ── dynamic client registration ────────────────────────────────────────
   A provider with `dynamicClient: true` has no client id to paste: the id is minted
   by `POST <registry>/reg` for the exact redirect this run will use, so the loopback
   server has to be listening before the authorize URL can be built. The registration
   is public (`token_endpoint_auth_method: 'none'`) — PKCE is the whole proof.

   **A moved port is not a broken login.** A loopback redirect on an OS-chosen port
   changes between runs, and a registration is valid only for the URI it was minted
   for, so the stored one is re-minted when it no longer matches. The old
   registration is simply orphaned at the provider; asking a person to re-register by
   hand would be a setting for something the machine can do itself. */

/**
 * Does this run need a fresh registration?
 *
 * Pure on purpose, and exported: the decision is the only part worth a test, and a
 * test that has to open a listener and a browser is a test nobody runs.
 */
function needsRegistration({ stored, redirectUri, dynamicClient } = {}) {
  if (!dynamicClient) return false
  if (!stored?.clientId) return true
  /* Byte for byte: a client registered for `…:8724/callback` is not valid for
     `…:53111/callback`, and the authorization server compares the literal string. */
  return String(stored.redirectUri || '') !== String(redirectUri || '')
}

/** One anonymous `POST /reg`, for the redirect this run will actually use. */
async function registerClient(config, redirectUri) {
  const registry = String(config.registry || '').replace(/\/$/, '')
  if (!registry) throw new Error(`${config.label} has no registration endpoint configured in this build.`)
  let response
  try {
    response = await fetch(`${registry}/reg`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'Entity',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        /* A public client: there is no secret, which is exactly why PKCE is required. */
        token_endpoint_auth_method: 'none',
        application_type: 'native',
      }),
    })
  } catch (problem) {
    throw new Error(
      `${config.label} could not be reached to register this app (${String(problem?.message || problem)}). Nothing was saved.`,
    )
  }
  const body = await response.json().catch(() => ({}))
  const clientId = text(body?.client_id, 200)
  if (!response.ok || !clientId) {
    const said = text(body?.error_description || body?.error || `HTTP ${response.status}`, 200)
    throw new Error(
      `${config.label} refused to register this app for ${redirectUri} (${said}). Habitify accepts a loopback redirect on any port, so a refusal here is the network, not the port. Nothing was saved.`,
    )
  }
  return { clientId, redirectUri }
}

/**
 * Open one consent screen and wait for the answer.
 *
 * `openExternal` is injected by the call table: the desktop app and `npm run dev`
 * can open the system browser, the shared server cannot, and a build that cannot
 * open one says so instead of starting a listener nobody will ever reach.
 */
async function connect({ connector, workspace, tier: wantedTier, openExternal } = {}) {
  const name = text(connector, 60)
  if (!name) throw new Error('Which connector should the account be added to?')
  if (pending) {
    return { ok: false, code: 'busy', message: 'A consent screen is already open. Finish it, or wait for it to time out.' }
  }
  const provider = providerOf(name)
  const config = providerConfig(provider)
  if (!config) {
    return {
      ok: false,
      code: 'not_configured',
      message: `No OAuth provider is configured for "${name}" in this build, so no consent screen was opened. Nothing was saved.`,
    }
  }
  /* A dynamic provider registers itself once the redirect is known, so "no client"
     is the normal first-run state there and not an error. */
  const storedClient = config.dynamicClient ? secrets.clientFor(provider) : null
  const client = config.dynamicClient ? storedClient : secrets.clientFor(provider)
  if (!config.dynamicClient && !client) {
    return {
      ok: false,
      code: 'client_required',
      message:
        config.clientAuth === 'pkce'
          ? `No ${secrets.labelOf(provider)} client is saved on this machine yet. Paste its client id above, then connect the account.`
          : 'No OAuth client is saved on this machine yet. Paste a client id and secret above, then connect the account.',
    }
  }
  if (typeof openExternal !== 'function') {
    return {
      ok: false,
      code: 'no_browser',
      message:
        'This build cannot open the system browser, so the consent screen was not opened. Nothing was saved — connect the account from the desktop app.',
    }
  }

  /* PKCE: the verifier never leaves this process, and the challenge is what the
     consent URL carries. `state` binds the answer to this request. */
  const codeVerifier = b64url(crypto.randomBytes(32))
  const codeChallenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest())
  const state = b64url(crypto.randomBytes(24))

  /* The tier is read here, once: the consent screen must ask for exactly what
     will be stored, and the exchange must compare against the same list. */
  const tier = connectorTier(name, workspace)
  const job = { provider, providerClient: client, codeVerifier, connector: name, config, state, workspace, tier }
  /* The wire form, and only the wire form: a short id here is the 400. */
  /* Deduped: a tier that repeats one of the base scopes (`users.read` is both the
     identity read and an X tier scope) must not send it twice — the server rejects
     a repeated scope on some providers and ignores it on others. */
  const scope = [...new Set([config.baseScope, ...wireScopes(name, tier)].flatMap((entry) => entry.split(/\s+/)))].join(' ')
  const server = http.createServer()
  job.server = server
  /* One consent at a time: the guard above reads this, and `finish()` clears it so
     a timeout or a refusal cannot wedge every later press. */
  pending = job

  const answer = await new Promise((resolve) => {
    job.resolve = resolve
    job.timer = setTimeout(
      () =>
        finish({
          ok: false,
          code: 'timeout',
          message: `${secrets.labelOf(provider)} did not answer. Nothing was saved.`,
        }),
      CONSENT_TIMEOUT_MS,
    )

    server.on('request', async (request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1')
      if (url.pathname !== '/oauth/callback') {
        response.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
        return
      }
      /* The page the person sees must say the same thing the call concluded, so
         the mismatch case is not dressed as a success in their browser. */
      const wrongState = url.searchParams.get('state') !== job.state
      const replied = wrongState
        ? [PAGE('Nothing was saved', 'That answer did not belong to this request. You can close this tab.'), 400]
        : url.searchParams.get('error')
          ? [PAGE('Nothing was saved', `${url.searchParams.get('error')} — you can close this tab.`), 400]
          : url.searchParams.get('code')
            ? [PAGE('Account connected', 'You can close this tab and return to Entity.'), 200]
            : [PAGE('Nothing was saved', 'The answer carried no authorization code.'), 400]
      response.writeHead(replied[1], { 'content-type': 'text/html; charset=utf-8' }).end(replied[0])

      /* The browser has been answered; settle the call. */
      if (wrongState) return finish({ ok: false, code: 'state', message: STATE_MISMATCH })
      const deniedError = url.searchParams.get('error')
      if (deniedError) {
        /* Named per provider: these three sentences are the only place a rejected
           consent explains itself, and every provider reaches them. */
        const who = secrets.labelOf(provider)
        return finish({
          ok: false,
          code: deniedError,
          message: deniedError === 'access_denied' ? denied(who) : `Nothing was saved. ${who} answered ${deniedError}.`,
        })
      }
      const code = url.searchParams.get('code')
      if (!code) return finish({ ok: false, code: 'no_code', message: noCode(secrets.labelOf(provider)) })
      try {
        finish(await complete(job, code))
      } catch (problem) {
        finish({
          ok: false,
          code: 'exchange_failed',
          message: `Nothing was saved. ${String(problem?.message || problem)}`,
        })
      }
    })

    server.on('error', (problem) =>
      finish({
        ok: false,
        code: 'listen_failed',
        /* A fixed port can be taken by something else; an ephemeral one cannot, so
           this sentence is written for the case that can actually happen. */
        message: config.fixedPort
          ? `Nothing was saved. Port ${config.fixedPort} is already in use on this machine, so the sign-in could not start (${String(problem?.message || problem)}).`
          : `Nothing was saved. The local redirect could not listen (${String(problem?.message || problem)}).`,
      }),
    )

    /* Port 0 = let the OS pick a free one. Google ignores the port on a loopback
       redirect, which is what makes an ephemeral port legal there; X requires an
       exact registered URL, so it listens on its fixed port instead. */
    server.listen(config.fixedPort || 0, '127.0.0.1', async () => {
      const { port } = server.address()
      job.redirectUri = `http://127.0.0.1:${port}/oauth/callback`

      /* A dynamic provider needs the redirect before it will name a client, and the
         client has to be live *before* the authorize URL is built — so this is the
         one place the order forces an await. A registration that is still valid for
         this exact redirect is reused; a moved port mints a fresh one and replaces
         the stored value in place. */
      let live = client
      if (config.dynamicClient) {
        try {
          if (needsRegistration({ stored: client, redirectUri: job.redirectUri, dynamicClient: true })) {
            const minted = await registerClient(config, job.redirectUri)
            secrets.setClient({ provider, clientId: minted.clientId, redirectUri: minted.redirectUri })
            live = { clientId: minted.clientId, clientSecret: '', redirectUri: minted.redirectUri }
          }
        } catch (problem) {
          return finish({
            ok: false,
            code: 'registration_failed',
            message: String(problem?.message || problem),
          })
        }
        if (!live?.clientId) {
          return finish({
            ok: false,
            code: 'registration_failed',
            message: `${config.label} did not issue a client id, so no consent screen was opened. Nothing was saved.`,
          })
        }
        /* The minted client is the one the consent screen will name, so the job has
           to carry it too: `complete()` reads `job.providerClient`, and a client
           captured before this await is the *previous* registration — the token
           request would then present an id the code was never issued to, which the
           authorization server answers `invalid_grant`. */
        job.providerClient = live
      }

      const authorize = new URL(config.authorize)
      authorize.searchParams.set('client_id', live.clientId)
      authorize.searchParams.set('redirect_uri', job.redirectUri)
      authorize.searchParams.set('response_type', 'code')
      authorize.searchParams.set('scope', scope)
      authorize.searchParams.set('state', state)
      authorize.searchParams.set('code_challenge', codeChallenge)
      authorize.searchParams.set('code_challenge_method', config.pkce || 'S256')
      /* RFC 8707: a token bound to the resource it will be used against. Sent where
         the provider names one; tolerated elsewhere, and this build only sends it
         for a provider that asked for it by carrying `resource`. */
      if (config.resource) authorize.searchParams.set('resource', config.resource)
      for (const [key, value] of Object.entries(config.params || {})) authorize.searchParams.set(key, value)
      try {
        openExternal(authorize.toString())
      } catch (problem) {
        finish({
          ok: false,
          code: 'open_failed',
          message: `Nothing was saved. The system browser could not be opened (${String(problem?.message || problem)}).`,
        })
      }
    })
  })

  return answer
}


/**
 * The client a refresh presents. For a dynamically registered provider the token
 * record itself carries the id, because the stored registration may have been
 * replaced by a later run on a different port — and the refresh must still use the
 * client the refresh token was actually issued to.
 */
function clientForToken(config, token, connectorId) {
  if (config.dynamicClient) {
    if (!token?.clientId) return null
    return { clientId: token.clientId, clientSecret: '', redirectUri: token.redirectUri || '' }
  }
  return secrets.clientFor(token.provider || providerOf(connectorId))
}

/**
 * The refresh form, in one place.
 *
 * `client_id` only for a public client — a DCR registration with
 * `token_endpoint_auth_method: 'none'` has no secret to prove itself with — and the
 * RFC 8707 `resource` where the provider names one. A dynamically registered
 * connector stored the client id it was issued to, which is the one the refresh must
 * present even if the stored registration was later replaced.
 */
function tokenForm(config, client, token) {
  const form = new URLSearchParams({
    client_id: token?.clientId || client.clientId,
    refresh_token: token.refreshToken,
    grant_type: 'refresh_token',
  })
  if (config.clientAuth !== 'pkce' && client.clientSecret) form.set('client_secret', client.clientSecret)
  if (config.resource) form.set('resource', config.resource)
  return form
}

/**
 * Exchange a stored refresh token for an access token, and record what that means.
 *
 * One place decides `connected` vs `needs sign-in`, so the roster's aggregate and
 * the card's row cannot disagree about the same account. A rejected refresh is
 * Google's `invalid_grant`: that is a dead consent, not a transient error, so the
 * row is marked and the token is left in place for a re-consent to reuse.
 */
async function refresh(connector, config, connectorId, entry) {
  const token = secrets.tokenFor({ connector: connectorId, localpart: entry.localpart })
  if (!token?.refreshToken) return { ok: false, reason: 'no_token' }
  const client = clientForToken(config, token, connectorId)
  if (!client) return { ok: false, reason: 'no_client' }
  try {
    const response = await fetch(config.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: tokenForm(config, client, token),
    })
    const answer = await response.json().catch(() => ({}))
    const ok = response.ok && Boolean(answer?.access_token)
    if (ok) storeAccessToken(connectorId, entry.localpart, answer)
    const store = read()
    const rows = store.accounts[connectorId] || []
    store.accounts[connectorId] = rows.map((row) =>
      row.localpart === entry.localpart
        ? { ...row, status: ok ? 'connected' : 'needs sign-in', refreshedAt: new Date().toISOString() }
        : row,
    )
    write(store)
    return { ok, reason: ok ? 'refresh_ok' : text(answer?.error || 'refresh_failed', 80) }
  } catch (problem) {
    return { ok: false, reason: text(problem?.message || 'refresh_failed', 80) }
  }
}

/** One refresh, returning an access token. The resolvers' entry point: a mention
 *  needs a live token, and this is the only place one is minted. */
async function accessTokenFor(connector, localpart, workspace) {
  const provider = providerOf(connector)
  const config = providerConfig(provider)
  if (!config) throw new Error(`No OAuth provider is configured for "${connector}".`)
  const token = secrets.tokenFor({ connector, localpart })
  if (!token?.refreshToken) {
    throw new Error(`No account of @${connector}: is signed in yet. Connect one on the connector's page.`)
  }
  /* A consent that answered minutes ago left a live access token: reuse it rather
     than paying for a refresh on the first mention after connecting. */
  if (token.accessToken && Number(token.expiresAt) - Date.now() > 60_000) {
    return { accessToken: token.accessToken, scopes: token.scopes || [] }
  }
  const client = clientForToken(config, token, connector)
  if (!client) throw new Error('No OAuth client is saved on this machine, so a token cannot be refreshed.')
  const response = await fetch(config.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: tokenForm(config, client, token),
  })
  const answer = await response.json().catch(() => ({}))
  if (!response.ok || !answer?.access_token) {
    /* A dead grant is the state the card already draws; the resolver reports it in
       the same words rather than inventing a second vocabulary. */
    throw new Error(
      `@${connector}:${localpart} needs a sign-in — ${secrets.labelOf(provider)} rejected its refresh token.`,
    )
  }
  storeAccessToken(connector, localpart, answer)
  return { accessToken: answer.access_token, scopes: token.scopes || [] }
}

/**
 * Keep the access token a refresh just returned, so the next reader does not pay for
 * another one. Only the fields that can go stale are touched — the refresh token,
 * the client it belongs to and the scopes stay exactly as they were.
 */
function storeAccessToken(connector, localpart, answer) {
  const current = secrets.tokenFor({ connector, localpart })
  if (!current) return
  secrets.putToken({
    ...current,
    connector,
    localpart,
    accessToken: answer.access_token,
    expiresAt: answer.expires_in ? Date.now() + Number(answer.expires_in) * 1000 : undefined,
    /* A provider may rotate the refresh token; when it does, that is the live one. */
    refreshToken: answer.refresh_token || current.refreshToken,
  })
}

/** Every account of a connector that has a token here, usable by a resolver. */
function connectedAccounts(connector) {
  const rows = list()[String(connector)] || []
  /* Only a connector that asks for `offline_access` can honour it by minting a
     refresh token, so the correction below is limited to one that does: adding the
     scope to a connector whose grant never requested it would invent access. */
  const asksOffline = wireScopes(connector, 'read').includes('offline_access')
  return rows.map((row) => {
    const hasToken = Boolean(secrets.tokenFor({ connector, localpart: row.localpart })?.refreshToken)
    /* A row written before a server's scope echo was understood still carries
       `offline_access` in `missing`, and a refresh token beside it is the proof
       that the scope was honoured. Correcting it on the way out keeps an existing
       grant usable instead of asking for a re-consent that would add nothing. */
    const honoured = asksOffline && hasToken
    const missing = honoured ? row.missing.filter((scope) => scope !== 'offline_access') : row.missing
    return {
      ...row,
      missing,
      scopes:
        honoured && !row.scopes.includes('offline_access') ? [...row.scopes, 'offline_access'] : row.scopes,
      hasToken,
    }
  })
}

/**
 * `Test all accounts`: one batched pass, and it only claims what it checked.
 *
 * An account with no stored token cannot be probed — there is nothing to ask
 * Google with — so the sentence counts those separately instead of folding them
 * into "needs a sign-in", which would blame the person for a store that was never
 * written. EVERY account is a refresh attempt: a `needs sign-in` row becomes
 * `connected` when Google accepts it, which is the whole point of the button.
 *
 * A refresh token that Google rejects is `invalid_grant` at the protocol level,
 * and that is exactly the state the card already knows how to draw.
 */
async function test({ connector } = {}) {
  const name = text(connector, 60)
  const book = list()
  const rows = name ? book[name] || [] : Object.values(book).flat()
  if (!rows.length) {
    return { ok: true, detail: '0 accounts on this machine · 0 need a sign-in', accounts: 0 }
  }

  const store = read()
  let checked = 0
  let unusable = 0
  let unprobed = 0

  for (const [connectorId, entries] of Object.entries(store.accounts)) {
    if (name && connectorId !== name) continue
    for (const entry of entries) {
      const provider = providerOf(connectorId)
      const config = providerConfig(provider)
      const token = secrets.tokenFor({ connector: connectorId, localpart: entry.localpart })
      if (!config || !token?.refreshToken) {
        unprobed += 1
        continue
      }
      checked += 1
      const verdict = await refresh(provider, config, connectorId, entry)
      if (!verdict.ok) unusable += 1
    }
  }

  const parts = [`${checked} of ${rows.length} checked`]
  if (unusable) parts.push(`${unusable} need a sign-in`)
  if (unprobed) parts.push(`${unprobed} with no token here`)
  return {
    ok: true,
    detail: `${parts.join(' · ')}`,
    accounts: rows.length,
    checked,
    unusable,
  }
}

module.exports = {
  CONFIG,
  FILE,
  SCHEMA,
  /* the small pure decision a registration makes, exported so it can be tested
     without a listener and without a browser */
  needsRegistration,
  list,
  read,
  remove,
  forget,
  connect,
  test,
  /* the scope tier: what the card offers, and what the index stores */
  tierChoices,
  tiersFor,
  displayScopes,
  /* read by the mention resolvers */
  accessTokenFor,
  connectedAccounts,
}
