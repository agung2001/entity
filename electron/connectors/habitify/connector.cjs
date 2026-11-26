/**
 * The Habitify connector: a day’s habits, read over the MCP session it already opens.
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
  id: 'habitify',
  resolver: 'habitify',
  mention: 'habitify',
  suffix: 'Habitify',
  account: false,

  /* which tab this connector draws, and what its lock is made of */
  dashboard: { call: 'habitify.dashboard', mode: 'oauth', kind: 'habitify' },

  /* Which accounts this machine holds, and what one day was scheduled. Read-only on
     both calls — the only upstream tool either one can reach is `list-habits-by-date`. */
  calls: {
    'habitify.accounts': () => require('./dashboard.cjs').accounts(),
    'habitify.dashboard': (args) => require('./dashboard.cjs').dashboard(args),
  },

  mentionModule: () => require('./mention.cjs'),

  entry: {
      label: 'Habitify',
      kind: 'rest',
      oauth: true,
      provider: 'habitify',
      website: 'https://habitify.me',
      summary: 'The habits a day was scheduled, and whether they were done.',
      verify: null,
      /* The dashboard tab gates on this block, the same way the `opendesign` entry's
         does: `page` is empty because a `rest` row binds through a consent, not an
         `mcp.json`, and `documented` already leaves a non-MCP kind with no page. */
      work: {
        mention: '@habitify:',
        resolves: 'a day, and optionally one habit within that day',
        syntax: '@habitify:[<habit>:]<date|today|yesterday>',
        examples: ['@habitify:today', '@habitify:Meditate:yesterday'],
        returns: 'the habit name, its status word and the day each row was scheduled on',
        resolver: 'habitify',
        needs: 'a signed-in Habitify account on this machine',
        page: '',
        how: [
          'The date is `today`, `yesterday` or `YYYY-MM-DD` — nothing is guessed, so a malformed date is an error rather than today.',
          'A habit name before the colon narrows the day to that habit; an exact name wins, a single prefix match is accepted, and two prefix matches are refused instead of picking one.',
          'The day comes back as it was scheduled: `completed`, `skipped`, `failed`, or `none` for a habit that was due and not logged.',
          '**Read-only.** The only tool this app calls is `list-habits-by-date`; nothing here writes to Habitify, so completing, skipping or logging a habit cannot happen from a turn or from the Dashboard.',
          'The read goes through Habitify’s MCP server with the account’s own access token, refreshed on this machine and named by its localpart — no address appears in these rows.',
        ],
        samples: [
          { code: '@habitify:today', then: 'every habit scheduled today, with its status' },
          { code: '@habitify:Meditate:yesterday', then: 'that one habit, yesterday' },
        ],
  },
  },
}
