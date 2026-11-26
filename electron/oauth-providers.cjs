/**
 * The providers a connector can authenticate against — one row each.
 *
 * This is the **extension point**. Adding a built-in connector that signs in
 * (Figma, Slack, Notion, Linear…) is one entry here, plus its scope tiers in
 * `oauth-scopes.cjs`; nothing in `oauth-accounts.cjs` changes.
 *
 * A provider says how to talk OAuth 2.0, not what a connector may do — the tiers
 * are separate, because two connectors may share a provider (Gmail, Drive and
 * YouTube all ride `google`) while asking for very different access.
 *
 * Every field is optional except `authorize`, `token`, `profile` and `baseScope`:
 *
 *   authorize    where the browser is sent for consent
 *   token        where the code (and a refresh token) is exchanged
 *   profile      how the account is named; `profileOf` reshapes a nested answer
 *   baseScope    the scopes every request carries, space-separated
 *   params       extra authorize-query parameters (Google's `access_type=offline`)
 *   clientAuth   'pkce' for a public client — no secret is sent or stored
 *   pkce         the challenge method; `S256`, always. It is a field rather than a
 *                constant in `oauth-accounts.cjs` so a provider that only advertises
 *                `plain` is a visible decision and not a silent downgrade
 *   fixedPort    a port the redirect must use, because the provider validates the
 *                callback URL by exact match (X) — absent means an OS-chosen port
 *   dynamicClient true when the client id is minted per install with a
 *                `POST <registry>/reg` (RFC 7591) — there is no client to paste, so
 *                the card must not ask for one
 *   registry     the authorization server root a dynamic registration posts to
 *   resource     the RFC 8707 resource a token is bound to (an MCP server's URL)
 */
const catalog = require('./connector-catalog.cjs')

const PROVIDERS = {
  google: {
    label: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    profile: 'https://openidconnect.googleapis.com/v1/userinfo',
    /* `openid email` is what names the account; the connector's own scope is what
       lets an agent read. `offline` + `consent` is what makes Google return a
       refresh token rather than only an access token.
       **`include_granted_scopes` is deliberately absent.** Set to `true` — which it
       once was — Google merges in *every* scope the person already granted this
       client id, so a client that held YouTube + Drive approval refuses a Gmail
       request with `invalid_request: scopes that cannot be requested together`.
       One connector, one grant: the request names this connector's scopes only. */
    baseScope: 'openid email',
    params: { access_type: 'offline', prompt: 'consent' },
    /* Where a person creates one, and what to create. */
    consoleUrl: 'https://console.cloud.google.com/apis/credentials',
    clientHint: 'Create an OAuth client of type “Desktop app”.',
    secretRequired: true,
    pkce: 'S256',
    /* The console hands out a downloadable `credentials.json` for this kind, so
       the card offers a drop zone here and nowhere else. */
    clientFile: true,
    /* Google documents a loopback redirect exemption, so an OS-chosen port is
       legal and no callback needs registering. */
  },

  /* X's OAuth 2.0 is a different deployment: its own hosts, PKCE with no client
     secret, and `users.read` is what names the account. `offline.access` is X's way
     of asking for a refresh token — Google's `access_type=offline` does not exist
     here. */
  x: {
    label: 'X',
    authorize: 'https://x.com/i/oauth2/authorize',
    token: 'https://api.x.com/2/oauth2/token',
    /* v2 `/users/me` is the identity read; it needs `users.read`. */
    profile: 'https://api.x.com/2/users/me',
    baseScope: 'users.read',
    params: {},
    /* the answer is `{ data: { username, name, id } }`, not a flat object */
    profileOf: (body) => {
      const user = body?.data || {}
      /* X has no address to name a row by, so the username stands in for one —
         `<handle>@x` is what the card and the mention scope use. */
      return { email: user.username ? `${user.username}@x` : '', name: user.name || user.username || '' }
    },
    consoleUrl: 'https://developer.x.com/en/portal/dashboard',
    clientHint: 'Create an app with OAuth 2.0 enabled and use its Client ID — a public client needs no secret.',
    secretRequired: false,
    clientAuth: 'pkce',
    pkce: 'S256',
    /* X validates the callback by **exact match** — no wildcard, no loopback
       exemption. A random port can never be registered, so X pins one. */
    fixedPort: 8724,
  },

  /* Habitify's MCP server is the resource; `account.habitify.me` is its
     authorization server. The client is minted per install by `POST /reg`, because
     it accepts a loopback redirect on an OS-chosen port — which is why there is no
     client id to paste and no fixed port to pin. `resource` is sent on the token
     request as RFC 8707 asks, binding the grant to the MCP server it was issued for.
     Endpoints and the registration shape are from One's verified `habitify/mcp.ts`,
     not from guesswork. */
  habitify: {
    label: 'Habitify',
    authorize: 'https://account.habitify.me/auth',
    token: 'https://account.habitify.me/token',
    registry: 'https://account.habitify.me',
    resource: 'https://mcp.habitify.me',
    resourceMetadata: 'https://mcp.habitify.me/.well-known/oauth-protected-resource',
    baseScope: 'openid profile email',
    params: {},
    /* There is no `/userinfo` to read here, so the identity comes out of the grant
       itself: an OIDC id_token's claims, and — for a server that puts the account
       beside the tokens instead — the token body's own `email`/`name`. The token is
       **decoded, never verified**: it names a row for the person who just signed in,
       nothing downstream trusts it, and a JWKS fetch would be a second network
       dependency for a screenshot-grade fact. Only `email` and `name` are read.
       `profileOf` receives the whole token payload, not a fetched profile. */
    profileOf: (tokenBody = {}) => {
      const part = String(tokenBody?.id_token || '').split('.')[1]
      let claims = {}
      if (part) {
        try {
          claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) || {}
        } catch {
          claims = {}
        }
      }
      return { email: claims.email || tokenBody?.email || '', name: claims.name || tokenBody?.name || '' }
    },
    consoleUrl: '',
    clientHint: 'Nothing to create: this app registers itself with Habitify when you connect.',
    secretRequired: false,
    clientAuth: 'pkce',
    pkce: 'S256',
    dynamicClient: true,
    scopes: ['openid', 'profile', 'email', 'offline_access'],
  },

  /* Fitbit is a classic OAuth 2.0 deployment with one twist worth stating: **it has
     no address to name an account by.** The identity read is its profile endpoint,
     which answers an `encodedId` (the short id in a fitbit.com/user/<id> URL) and a
     full name, so the row is named `<encodedId>@fitbit` — the same shape X uses for
     a handle, and the same thing the mention scope would take.

     Public client: PKCE with no secret (`secretRequired: false`), which Fitbit
     accepts for an app registered as a personal one. The callback is pinned because
     Fitbit matches the registered URL exactly — the card prints this literal one for
     a person to paste into `dev.fitbit.com/apps`.

     **Eight scopes, no more.** Fitbit refuses a grant that asks for more than eight
     at once, so `baseScope` plus a tier stays far under it; adding a ninth here is a
     rejected consent, not a wider read. */
  fitbit: {
    label: 'Fitbit',
    authorize: 'https://www.fitbit.com/oauth2/authorize',
    token: 'https://api.fitbit.com/oauth2/token',
    profile: 'https://api.fitbit.com/1/user/-/profile.json',
    baseScope: 'activity sleep heartrate profile',
    params: {},
    /* `{ user: { encodedId, fullName, timezone, offsetFromUTCMillis } }` — no
       mailbox anywhere in it, so the encoded id is what names the row. */
    profileOf: (body) => {
      const user = body?.user || {}
      return { email: user.encodedId ? `${user.encodedId}@fitbit` : '', name: user.fullName || '' }
    },
    consoleUrl: 'https://dev.fitbit.com/apps',
    clientHint:
      'Create a personal app and register the callback URL shown below. A public client needs the id, not a secret.',
    secretRequired: false,
    clientAuth: 'pkce',
    pkce: 'S256',
    fixedPort: 8790,
  },
}

/**
 * The provider a connector authenticates against, read from the catalog.
 *
 * It used to be a hand-kept map beside this table, so a new row could be added here
 * and still be looked up as Google. The catalog entry carries `provider`; everything
 * that does not name one rides Google, which is what `gmail`, `google-drive`,
 * `youtube` and `youtube-studio` mean.
 */
const providerOf = (connector) => catalog.entryOf(connector)?.provider || 'google'
const providerConfig = (provider) => PROVIDERS[String(provider)] || null
/** The provider object for a connector, or null when nothing is configured. */
const configOf = (connector) => providerConfig(providerOf(connector))
/** The provider's display name ('Google', 'X') for a button or a sentence. */
const labelOf = (provider = 'google') => (PROVIDERS[String(provider)] || PROVIDERS.google).label
/** The redirect URL a provider expects. X needs this literal one registered. */
const callbackOf = (provider) => {
  const config = PROVIDERS[String(provider)]
  return config?.fixedPort ? `http://127.0.0.1:${config.fixedPort}/oauth/callback` : ''
}

module.exports = { PROVIDERS, providerOf, providerConfig, configOf, labelOf, callbackOf }
