/**
 * The X connector: one account’s posts, read by `@x:<query>`.
 *
 * **This file is the connector's descriptor**: the row id, the resolver kind, the
 * mention head and the catalog entry the roster and composer read, in one place. The
 * registry (`../registry.cjs`) derives its maps from here, and the catalog assembles
 * itself from the registry — so a connector is added by creating this folder, not by
 * editing four tables.
 *
 * `entry` is the catalog entry verbatim. It is nested rather than flattened because
 * two of its keys are already names here: `verify` on a catalog entry is the *command*
 * a page may print, while `verify` on this descriptor is the function a pasted key has
 * to pass.
 */
module.exports = {
  id: 'x',
  resolver: 'x',
  mention: 'x',
  suffix: 'X',
  account: true,

  mentionModule: () => require('./mention.cjs'),

  entry: {
      label: 'X',
      kind: 'rest',
      oauth: true,
      /* Named because it is the one account-bearing entry that does not ride Google.
         With `providerOf` derived from this table, a missing line here silently sent
         X's consent screen to Google's endpoints. */
      provider: 'x',
      verify: null,
      summary: 'Posts and threads an agent may read.',
      work: {
        mention: '@x:',
        resolves: 'recent posts matching a search, retweets excluded',
        syntax: '@x:<account|all>:<query>',
        examples: ['@x:main:from:stripe', '@x:all:release notes'],
        returns: 'the matching posts — text, date, and a link',
        resolver: 'x',
        needs: 'an X developer app (OAuth 2.0, PKCE) and one signed-in account on this machine',
        page: '',
        how: [
          'The scope comes first and is required, and decides whose grant the call runs as.',
          'X signs in through its own OAuth 2.0 app with PKCE — a public client, so there is a client id and no secret.',
          'X requires the callback URL to be registered exactly, and the port is picked per connection; if the sign-in is refused for a callback mismatch, that is why.',
          'The search covers recent posts only — about the last seven days, not the full archive.',
          'Retweets are excluded so the rows are original posts.',
          '`@x:all:` runs the search as every connected account in turn.',
        ],
        samples: [
          { code: '@x:main:from:stripe', then: 'recent posts, as that account' },
          { code: '@x:main:release notes', then: 'recent posts matching both words' },
        ],
  },
  },
}
