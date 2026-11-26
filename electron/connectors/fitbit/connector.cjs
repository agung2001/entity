/**
 * The Fitbit connector: one day in steps, sleep and heart rate, read from the account’s own grant.
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
  id: 'fitbit',
  resolver: 'fitbit',
  mention: 'fitbit',
  suffix: 'Fitbit',
  account: false,

  /* which tab this connector draws, and what its lock is made of */
  dashboard: { call: 'fitbit.dashboard', mode: 'oauth', kind: 'fitbit' },

  /* Six counts and the hour-by-hour heart trace for one day. **Read-only** — every call
     is a GET, and nothing on the page can log anything. No token is ever read: the
     module refreshes one on this machine and keeps it there. */
  calls: {
    'fitbit.dashboard': (args) => require('./dashboard.cjs').readDay(args),
  },

  mentionModule: () => require('./mention.cjs'),

  entry: {
      label: 'Fitbit',
      kind: 'rest',
      oauth: true,
      provider: 'fitbit',
      website: 'https://www.fitbit.com',
      summary: 'A day’s steps, distance, active minutes, sleep, resting heart rate and devices.',
      verify: null,
      work: {
        mention: '@fitbit:',
        resolves: 'one day of counts from the signed-in account',
        syntax: '@fitbit:[steps|sleep|heart|devices:]<date|today|yesterday>',
        examples: ['@fitbit:today', '@fitbit:sleep:yesterday'],
        returns: 'the day’s steps and goal, distance, active minutes, last night’s sleep, resting heart rate and the devices that synced, with the hour-by-hour heart trace where the scope allows',
        resolver: 'fitbit',
        needs: 'a signed-in Fitbit account on this machine',
        page: '',
        how: [
          'The date is `today`, `yesterday` or `YYYY-MM-DD`, read in the account’s own timezone — nothing is guessed, so a malformed date is an error rather than today.',
          'A reader word before the colon (`steps`, `sleep`, `heart`, `devices`) narrows the answer to that one count; leave it out and the whole day comes back.',
          '**Read-only.** Every call this app makes is a GET: nothing logs activity, food, water or sleep, and no control on the page implies one.',
          'Five requests read a day: activity, sleep, the day’s heart summary, the minute-by-minute heart trace, and the device list. Fitbit allows 150 calls an hour per account, so this app counts its own calls and says when the hour resets rather than spending a 429.',
          'The device list and the account’s timezone sit in an hourly cache, so a second day in the same hour costs four calls rather than five — and a day already read costs none.',
          'The access token is refreshed on this machine and never shown to a page; the account is named by its encoded id, never by an address.',
        ],
        samples: [
          { code: '@fitbit:today', then: 'the day so far, count by count' },
          { code: '@fitbit:sleep:yesterday', then: 'last night’s minutes asleep and the score' },
        ],
  },
  },
}
