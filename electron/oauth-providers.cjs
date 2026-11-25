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
 *   fixedPort    a port the redirect must use, because the provider validates the
 *                callback URL by exact match (X) — absent means an OS-chosen port
 */
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
    /* X validates the callback by **exact match** — no wildcard, no loopback
       exemption. A random port can never be registered, so X pins one. */
    fixedPort: 8724,
  },
}

/** The provider a connector authenticates against. Everything but X is Google. */
const PROVIDER_OF = { x: 'x' }

const providerOf = (connector) => PROVIDER_OF[String(connector)] || 'google'
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
