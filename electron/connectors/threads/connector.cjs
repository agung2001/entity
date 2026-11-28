/**
 * The Threads connector: the last 30 days of one Threads account — its posts, the
 * counts beside them, and the replies waiting underneath.
 *
 * **This file is the connector's descriptor**: the row id, the mention head, the
 * catalog entry the roster and composer read, the one verb the Dashboard tab asks
 * for, and the save-time check a pasted token has to pass. The registry
 * (`../registry.cjs`) derives its maps from here, and the catalog assembles itself
 * from the registry — so a connector is added by creating this folder, not by
 * editing four tables.
 *
 * `entry` is the catalog entry verbatim. It is nested rather than flattened because
 * two of its names are already used here: `verify` on a catalog entry is the *command*
 * a page may print, while `verify` on this descriptor is the function a token must
 * pass.
 *
 * **The credential is one pasted long-lived token**, the paste-once shape Clockify
 * established: it lives in `connector-tokens.cjs` (`0600`), `verify()` proves it
 * against the real Graph endpoint before anything is written, and no page can read it
 * back. There is no OAuth provider row and no scope tier, because there is no consent
 * screen to run and no per-account row to keep.
 *
 * **Read-only.** Every call Threads' API offers here is a GET: nothing posts, replies
 * or deletes, and no control on the tab implies one.
 */
const { text, me } = require('./api.cjs')

module.exports = {
  id: 'threads',
  resolver: 'threads',
  mention: 'threads',
  suffix: 'Threads',
  /* One Threads account per install, so there is no account segment in the mention
     and no account list on the page. */
  account: false,

  /* Which tab this connector draws, and what its lock is made of. */
  dashboard: { call: 'threads.dashboard', mode: 'token', kind: 'threads' },

  /* The one verb the tab reads, read-only: the token is read on this side of the
     bridge and the renderer gets rows. */
  calls: {
    'threads.dashboard': (args) => require('./dashboard.cjs').read(args),
  },

  mentionModule: () => require('./mention.cjs'),

  entry: {
      label: 'Threads',
      kind: 'rest',
      credential: 'token',
      website: 'https://www.threads.net',
      summary: 'Recent threads, their reach, and the replies waiting on them.',
      verify: null,
      work: {
        mention: '@threads:',
        resolves: 'recent posts, their counts, and the replies under them',
        syntax: '@threads:[posts|replies|insights:]<query|post-id>',
        examples: ['@threads:posts', '@threads:insights', '@threads:replies:1789012345678901'],
        returns: 'the last 30 days of posts with views, likes, replies and reposts beside each one, the 30-day totals and the three rates, or the replies under the recent posts — text, author and date',
        resolver: 'threads',
        needs: 'a long-lived Threads access token pasted on the connector page',
        page: '',
        how: [
          'A reader word picks the shape: `posts` (the default), `insights` or `replies`. Leave it out and `posts` is read.',
          'A first word that is not one of the three is not an error — it is a filter over the post text, because the likeliest thing to type after the colon is a word from a post.',
          '`@threads:replies:<post-id>` reads the replies under one post; without an id it reads the newest few posts in the window, because each post is a request per level and the API allows roughly 250 calls an hour.',
          'The window is the last 30 days, filtered here rather than by the endpoint: a total about a month cannot depend on a parameter every version of the API honours.',
          'A post whose counts could not be read is left out of the totals instead of counting as zero, and a window where no post answered is a refusal with a sentence rather than an empty table.',
          'The token is pasted once on the connector’s page and checked there against `GET /me` before it is saved. It lasts about 60 days; re-paste a fresh one before it lapses. Nothing but its last four characters is ever read back.',
          '**Read-only.** Every call is a GET: nothing here posts, replies or deletes.',
        ],
        samples: [
          { code: '@threads:posts', then: 'the last 30 days of posts, each with its views, likes, replies and reposts' },
          { code: '@threads:insights', then: 'the 30-day totals and the three rates' },
        ],
      },
  },

  /**
   * The save-time check: `GET /me?fields=id,username`.
   *
   * That endpoint, and not a report, because it is the cheapest call that proves the
   * token for the account it belongs to — a token that cannot name its own user
   * cannot read a post either, and this is the one call that says so before a write.
   */
  async verify({ token } = {}) {
    const key = text(token, 400)
    if (!key) throw new Error('Paste a Threads access token first.')
    await me(key)
    return { ok: true }
  },
}

/* ponytail: one Threads account per install, so this descriptor is the whole
   credential story — no OAuth provider row, no account list, no scope tier.
   Upgrade ceiling: several accounts would need the OAuth provider path, whose
   refresh is a GET /refresh_access_token?grant_type=th_refresh_token, and
   `oauth-accounts.cjs` does not implement it — so the upgrade is that provider row
   plus an `<account>:` segment in the mention, not a loop here. */
