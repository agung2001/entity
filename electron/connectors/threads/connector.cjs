/**
 * The Threads connector: the last 30 days of one Threads account — or of every
 * account on this machine — with the counts beside each post and the replies waiting
 * underneath.
 *
 * **This file is the connector's descriptor**: the row id, the mention head, the
 * catalog entry the roster and composer read, the one verb the Dashboard tab asks for,
 * and the provider the accounts sign in under. The registry (`../registry.cjs`) derives
 * its maps from here, and the catalog assembles itself from the registry — so a
 * connector is added by creating this folder, not by editing four tables.
 *
 * `entry` is the catalog entry verbatim. It is nested rather than flattened because
 * `verify` on a catalog entry is the *command* a page may print, while `verify` on a
 * descriptor is the function a credential must pass — and this connector has neither:
 * an account is proved by the identity read the accounts card runs (`adopt`), which is
 * the same door `@x:` and `@fitbit:` use.
 *
 * **Multi-account, like every account-bearing connector.** Each account is a row in
 * `oauth-accounts.json` plus a token in `oauth-secrets.json` (`0600`), named
 * `<username>@threads`, and the mention's first segment is the account — `all` reads
 * every usable one. The credential is **pasted**, not consented: Meta's Threads API has
 * no per-install loopback redirect to register, and the token a person already has (the
 * one their own cron keeps refreshed) is a long-lived one. See the `threads` row in
 * `electron/oauth-providers.cjs` for the two endpoints that keep it alive.
 *
 * **Read-only.** Every call Threads' API offers here is a GET: nothing posts, replies
 * or deletes, and no control on the tab implies one.
 */
module.exports = {
  id: 'threads',
  resolver: 'threads',
  mention: 'threads',
  suffix: 'Threads',
  /* One account per row, several rows per connector: the mention's first segment is
     the account, and `all` reads every usable one. */
  account: true,

  /* Which tab this connector draws, and what its lock is made of. */
  dashboard: { call: 'threads.dashboard', mode: 'oauth', kind: 'threads' },

  /* The one verb the tab reads: one account's 30 days. Read-only, and the token is
     minted on this side of the bridge by `oauth-accounts.cjs` — it never crosses. */
  calls: {
    'threads.dashboard': (args) => require('./dashboard.cjs').read(args),
  },

  mentionModule: () => require('./mention.cjs'),

  entry: {
      label: 'Threads',
      kind: 'rest',
      /* An account-bearing REST row: one credential per account, on this machine. */
      oauth: true,
      provider: 'threads',
      website: 'https://www.threads.net',
      summary: 'Recent threads, their reach, and the replies waiting on them.',
      verify: null,
      work: {
        mention: '@threads:',
        resolves: 'recent posts, their counts, and the replies under them',
        syntax: '@threads:<account|all>:[posts|replies|insights:]<query|post-id>',
        examples: ['@threads:all:posts', '@threads:all:insights', '@threads:avery:replies'],
        returns: 'the last 30 days of posts with views, likes, replies and reposts beside each one, the 30-day totals and the three rates, or the replies under the recent posts — text, author and date',
        resolver: 'threads',
        needs: 'a Threads access token pasted per account on the connector page',
        page: '',
        how: [
          'The scope comes first and is required: `all` for every connected account, or one username. A word that is not an account here is an error, so a typo cannot read the wrong audience — the same rule every account-bearing connector follows.',
          'A reader word picks the shape: `posts` (the default), `insights` or `replies`. Leave it out and `posts` is read.',
          'A first word that is not one of the three is not an error — it is a filter over the post text, because the likeliest thing to type there is a word from a post.',
          '`@threads:all:replies:<post-id>` reads the replies under one post; without an id it reads the newest few posts per account, because each post is a request per level and the API allows roughly 250 calls an hour.',
          'The window is the last 30 days, filtered here rather than by the endpoint: a total about a month cannot depend on a parameter every version of the API honours.',
          'A post whose counts could not be read is left out of the totals instead of counting as zero, and a window where no post answered is a refusal with a sentence rather than an empty table.',
          'Each account’s token is pasted once on this page and verified against `GET /me` before it is written. A long-lived Threads token lasts about 60 days and renews itself with the token alone, which is what the app does before it reads; re-paste only when Threads refuses it.',
          '**Read-only.** Every call is a GET: nothing here posts, replies or deletes.',
        ],
        samples: [
          { code: '@threads:all:posts', then: 'the last 30 days of every account, each post with its views, likes, replies and reposts' },
          { code: '@threads:avery:insights', then: 'one account’s 30-day totals and the three rates' },
        ],
      },
  },
}
