/**
 * The YouTube Studio connector: analytics behind `@youtube-studio:`, and the dashboard tab.
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
  id: 'youtube-studio',
  resolver: 'youtube-studio',
  mention: 'youtube-studio',
  suffix: 'YoutubeStudio',
  account: true,

  /* which tab this connector draws, and what its lock is made of */
  dashboard: { call: 'youtube.dashboard', mode: 'oauth', kind: 'studio' },

  /* Read-only Google calls, no write scope used, and the analytics/revenue/comment
     grants are separate — a refusal is a `null` field with the missing scope named,
     never a `0`. */
  calls: {
    'youtube.roster': () => require('./dashboard.cjs').roster(),
    'youtube.dashboard': (args) => require('./dashboard.cjs').dashboard(args),
  },

  mentionModule: () => require('./mention.cjs'),

  entry: {
      label: 'YouTube Studio',
      kind: 'rest',
      oauth: true,
      verify: null,
      summary: 'Views, watch time, subscribers, revenue and comments from your own channel.',
      work: {
        mention: '@youtube-studio:',
        resolves: "the channel's own analytics, catalogue or comment threads",
        syntax: '@youtube-studio:<account>[:<channel>]:<what> [<days>]',
        examples: [
          '@youtube-studio:avery:summary 30',
          '@youtube-studio:avery:main-channel:traffic 90',
          '@youtube-studio:avery:unreplied',
        ],
        returns:
          'the numbers Studio shows — views, watch time, subscribers, revenue — or the videos, comments and traffic sources behind them',
        resolver: 'youtube-studio',
        needs: 'a signed-in channel owner account with the analytics scope',
        page: '',
        how: [
          'The account segment comes first, as every account-bearing connector does — it is the Google login.',
          '**The channel comes next and is optional**, because one Google login can manage several channels (a brand account, a network, a client\'s). Leave it out when the account has only one.',
          'The channel is recognised by not being a keyword, so `summary` is a thing to read and `main-channel` is a channel. A title, a slug of it, or the raw `UC…` id all work.',
          'Then *what*: `summary`, `videos`, `video`, `traffic`, `subscribers`, `comments`, `unreplied`, `playlists`, `revenue` or `search`.',
          'An optional trailing number is the window in days, defaulting to 28 — Studio\'s own default.',
          '`summary` is the Studio overview: the four KPI tiles, their change against the previous equally long window, and the top videos.',
          '`traffic` is the traffic-source breakdown; `subscribers` is net growth by day.',
          '`unreplied` is the newest comments with no reply — the one thing Studio buries two clicks deep.',
          'Revenue needs the monetary analytics scope; without it the row says so instead of printing zero.',
          'Every window is computed against the report\'s own end date, never the clock, so an old answer cannot look fresh.',
        ],
        samples: [
          { code: '@youtube-studio:avery:summary 28', then: 'the four Studio KPIs, their change, and the top videos' },
          { code: '@youtube-studio:avery:main-channel:traffic 90', then: 'where those 90 days of views came from' },
          { code: '@youtube-studio:avery:unreplied', then: 'the comments with no reply yet' },
        ],
  },
  },
}
