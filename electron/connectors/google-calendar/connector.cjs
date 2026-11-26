/**
 * The Google Calendar connector: events read by `@gcal:<when>`, and the dashboard tab.
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
  id: 'google-calendar',
  resolver: 'calendar',
  mention: 'gcal',
  suffix: 'Calendar',
  account: true,

  /* which tab this connector draws, and what its lock is made of */
  dashboard: { call: 'calendar.dashboard', mode: 'oauth', kind: 'calendar' },

  /* Six counts and a week of events, read per account from the grant the accounts card
     already holds. The `accounts` read is the tab strip’s gate — it answers before the
     tab is pressed, so a person sees the lock without clicking through to it. */
  calls: {
    'calendar.dashboard': (args) => require('./dashboard.cjs').dashboard(args),
    'calendar.accounts': () => require('./dashboard.cjs').accounts(),
  },

  mentionModule: () => require('./mention.cjs'),

  entry: {
      label: 'Google Calendar',
      kind: 'rest',
      oauth: true,
      verify: null,
      summary: 'The week already on your calendars.',
      work: {
        mention: '@gcal:',
        resolves: 'events in the calendars you name, or in every connected account with `all`',
        syntax: '@gcal:<account|all>:<query>',
        examples: ['@gcal:all:planning', '@gcal:avery:standup'],
        returns: 'the matching events — title, when, which calendar, and a link',
        resolver: 'calendar',
        needs: 'one signed-in Google account granting `calendar.readonly`',
        page: '',
        how: [
          'The scope comes first and is required: `@gcal:avery:` is that account, `@gcal:all:` is every connected one.',
          'The account is the localpart of the address, as the card shows it — `@gcal:avery:` for `avery@example.test`.',
          'The query is the rest of the line and is matched against event titles, so it may hold spaces.',
          'Only calendars ticked in Google Calendar are read, which is the same set the app shows.',
          'This is read-only: it never creates, moves, declines or cancels an event, and no scope it asks for allows that.',
          'A word that is not one of your accounts is an error, not a search — so a typo cannot quietly read the wrong calendar.',
        ],
        samples: [
          { code: '@gcal:all:planning', then: 'matching events across every connected calendar' },
          { code: '@gcal:avery:standup', then: 'that one account, titles matching “standup”' },
        ],
  },
  },
}
