/**
 * What each connector may do, in three tiers — the data behind the scope selector.
 *
 * This is the **second extension point**. A new account-bearing connector adds one
 * entry here; nothing in `oauth-accounts.cjs` changes. Its provider (Google, X, …)
 * lives in `oauth-providers.cjs`, because two connectors may share one provider
 * while asking for very different access — Gmail, Drive and YouTube all ride Google.
 *
 * `read` → `write` → `full`, cumulative: `write` includes `read`, because a write
 * scope with no read scope cannot see what it is replying to. Tier names and the
 * one-line `detail` are what the card prints; `detail` says what the tier can and
 * cannot do, which is the answer to "I do not want to hand an app everything".
 *
 * **Two strings per scope, and conflating them is `Error 400 invalid_scope`.**
 * Google's authorize endpoint accepts full URLs (`https://www.googleapis.com/auth/…`,
 * or the legacy `https://mail.google.com/`), while the short id it *displays*
 * (`gmail.readonly`) is rejected outright. So each scope carries `wire` and
 * `display`, and only `wire` ever reaches a server. X happens to use short names on
 * the wire too, which is why its two forms match.
 */

/* ── scopes: tiered, and chosen by the person ─────────────────────────────
   A single "full access" grant is what most people flinch at, and rightly: an
   agent that can only read mail needs `gmail.readonly`, not `https://mail.google.com/`.
   So every connector offers three **tiers**, and the tier is a choice stored per
   connector in the workspace's index (not a global app setting — one workspace may
   want to send mail and another may not).

   `read` → `write` → `full`, cumulative: choosing `write` also grants `read`
   because a write scope with no read scope cannot see what it is replying to.
   Tier names and one-line descriptions are what the card prints.

   Two strings per scope, and conflating them is `Error 400 invalid_scope`:
   Google's authorize endpoint accepts **full URLs** (`https://www.googleapis.com/auth/…`,
   or the legacy `https://mail.google.com/`), while the short id it *displays*
   (`gmail.readonly`) is rejected outright. Each scope therefore carries both. */
const GOOGLE_AUTH = (path) => `https://www.googleapis.com/auth/${path}`

const SCOPE_CATALOG = {
  gmail: {
    tiers: [
      {
        id: 'read',
        label: 'Read mail',
        detail: 'Read messages and threads. Cannot send, reply, or change anything.',
        scopes: [{ wire: GOOGLE_AUTH('gmail.readonly'), display: 'gmail.readonly' }],
      },
      {
        id: 'write',
        label: 'Read and label',
        detail: 'Read, label, archive and draft — but not send, and not delete permanently.',
        scopes: [
          { wire: GOOGLE_AUTH('gmail.readonly'), display: 'gmail.readonly' },
          { wire: GOOGLE_AUTH('gmail.modify'), display: 'gmail.modify' },
        ],
      },
      {
        id: 'full',
        label: 'Full access',
        detail: 'Read, label, delete, change settings — and send mail as you.',
        scopes: [{ wire: 'https://mail.google.com/', display: 'mail.google.com' }],
      },
    ],
  },
  'google-drive': {
    tiers: [
      {
        id: 'read',
        label: 'Read files this app created',
        detail: 'Only files and folders it made itself, read-only. Nothing else in your Drive.',
        scopes: [
          { wire: GOOGLE_AUTH('drive.file'), display: 'drive.file' },
          { wire: GOOGLE_AUTH('drive.readonly'), display: 'drive.readonly' },
        ],
      },
      {
        id: 'write',
        label: 'Create and edit its own files',
        detail: 'Create, edit and delete files this app made. Cannot read the rest of your Drive.',
        scopes: [{ wire: GOOGLE_AUTH('drive.file'), display: 'drive.file' }],
      },
      {
        id: 'full',
        label: 'Full access',
        detail: 'Every file in your Drive: read, create, edit, delete, share.',
        scopes: [{ wire: GOOGLE_AUTH('drive'), display: 'drive' }],
      },
    ],
  },
  youtube: {
    tiers: [
      {
        id: 'read',
        label: 'Read channel data',
        detail: 'List channels, videos and captions. Cannot upload, edit or post.',
        scopes: [{ wire: GOOGLE_AUTH('youtube.readonly'), display: 'youtube.readonly' }],
      },
      {
        id: 'write',
        label: 'Manage videos',
        detail: 'Upload, edit and delete videos and playlists. Cannot act on comments.',
        scopes: [
          { wire: GOOGLE_AUTH('youtube.readonly'), display: 'youtube.readonly' },
          { wire: GOOGLE_AUTH('youtube.upload'), display: 'youtube.upload' },
        ],
      },
      {
        id: 'full',
        label: 'Full access',
        detail: 'Videos, playlists, comments and channel settings — everything the API offers.',
        scopes: [{ wire: GOOGLE_AUTH('youtube'), display: 'youtube' }],
      },
    ],
  },
  /* YouTube **Studio** data is a different grant from the public YouTube search
     above: reading a channel's own analytics needs `yt-analytics.readonly`, and
     the two are separate scopes on purpose. A person who only wants to search
     public videos should never be asked for their channel's revenue numbers. */
  'youtube-studio': {
    tiers: [
      {
        id: 'read',
        label: 'Read your channel',
        detail: 'Your own videos, playlists and comments. No analytics.',
        scopes: [{ wire: GOOGLE_AUTH('youtube.readonly'), display: 'youtube.readonly' }],
      },
      {
        id: 'write',
        label: 'Manage your channel',
        detail: 'Read, plus edit titles, descriptions, tags and playlists.',
        scopes: [
          { wire: GOOGLE_AUTH('youtube.readonly'), display: 'youtube.readonly' },
          { wire: GOOGLE_AUTH('youtube.force-ssl'), display: 'youtube.force-ssl' },
        ],
      },
      {
        id: 'full',
        label: 'Analytics and comments',
        detail:
          'What Studio shows: views, watch time, subscriber movement, traffic sources, revenue, and the comment threads needing a reply.',
        scopes: [
          { wire: GOOGLE_AUTH('youtube.readonly'), display: 'youtube.readonly' },
          { wire: GOOGLE_AUTH('yt-analytics.readonly'), display: 'yt-analytics.readonly' },
          { wire: GOOGLE_AUTH('youtube.force-ssl'), display: 'youtube.force-ssl' },
        ],
      },
    ],
  },

  x: {
    tiers: [
      {
        id: 'read',
        label: 'Read posts',
        detail: 'Read posts, threads and profiles. Cannot post or reply.',
        scopes: [
          { wire: 'tweet.read', display: 'tweet.read' },
          { wire: 'users.read', display: 'users.read' },
          { wire: 'offline.access', display: 'offline.access' },
        ],
      },
      {
        id: 'write',
        label: 'Read and post',
        detail: 'Read, and post or reply as you.',
        scopes: [
          { wire: 'tweet.read', display: 'tweet.read' },
          { wire: 'tweet.write', display: 'tweet.write' },
          { wire: 'users.read', display: 'users.read' },
          { wire: 'offline.access', display: 'offline.access' },
        ],
      },
      {
        id: 'full',
        label: 'Full access',
        detail: 'Everything the X API allows for your account, including posting and deleting.',
        scopes: [
          { wire: 'tweet.read', display: 'tweet.read' },
          { wire: 'tweet.write', display: 'tweet.write' },
          { wire: 'follows.read', display: 'follows.read' },
          { wire: 'follows.write', display: 'follows.write' },
          { wire: 'offline.access', display: 'offline.access' },
        ],
      },
    ],
  },
}


/** Every tier of every connector, flat — used to build the display map below. */
const ALL_SCOPES = Object.values(SCOPE_CATALOG)
  .flatMap((entry) => entry.tiers)
  .flatMap((tier) => tier.scopes)

/** The tier a connector falls back to. `full` is what the first requests asked for;
 *  a read-only default would silently narrow what every existing row means. */
const DEFAULT_TIER = 'full'

const tiersFor = (connector) => SCOPE_CATALOG[String(connector)]?.tiers || []

function tierOf(connector, tier) {
  const tiers = tiersFor(connector)
  return (
    tiers.find((entry) => entry.id === tier) ||
    tiers.find((entry) => entry.id === DEFAULT_TIER) ||
    tiers[0] ||
    null
  )
}

/** The wire scopes for a connector at a tier — the only form sent to a server. */
const wireScopes = (connector, tier = DEFAULT_TIER) =>
  (tierOf(connector, tier)?.scopes || []).map((scope) => scope.wire)

/** The display ids the card prints for a tier. */
const displayScopes = (connector, tier = DEFAULT_TIER) =>
  (tierOf(connector, tier)?.scopes || []).map((scope) => scope.display)

/** wire → display, so a scope Google echoes back prints the way the card wrote it. */
const DISPLAY_OF = new Map(ALL_SCOPES.map((scope) => [scope.wire, scope.display]))

const displayOf = (scope) =>
  DISPLAY_OF.get(scope) ||
  String(scope)
    .replace(/^https:\/\/www\.googleapis\.com\/auth\//, '')
    .replace(/^https:\/\/mail\.google\.com\/$/, 'mail.google.com')

module.exports = {
  SCOPE_CATALOG,
  DEFAULT_TIER,
  tiersFor,
  tierOf,
  wireScopes,
  displayScopes,
  displayOf,
}
