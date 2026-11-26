/**
 * The GitHub connector: who `gh` has signed in, and what moved in the last 90 days.
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
  id: 'github',
  account: false,

  dashboard: { call: 'github.dashboard', mode: 'cli', kind: 'github' },

  /* Who `gh` has signed in, what moved in the last 90 days, and the one switch that
     makes another login active. Read-only apart from that switch, and no token is
     ever read by this process. */
  calls: {
    'github.logins': () => require('./dashboard.cjs').logins(),
    'github.dashboard': (args) => require('./dashboard.cjs').dashboard(args),
    'github.useActive': (args) => require('./dashboard.cjs').useActive(args),
  },

  entry: {
      label: 'GitHub CLI',
      kind: 'cli',
      binary: 'gh',
      summary: 'Repositories and searches through the gh CLI already signed in here.',
      verify: { argv: ['auth', 'status'], okExit: 0, then: ['--version'] },
      work: {
        mention: '@github:',
        resolves: 'a repository, or a search across your repositories',
        syntax: '@github:<owner/repo> | <query>',
        examples: ['@github:artistudio/entity', '@github:connector'],
        returns: 'the repository itself — full name, URL, default branch, last push',
        resolver: 'github',
        needs: 'gh signed in on this machine',
        page: '',
        how: [
          'A full name (`owner/repo`) is one repository; anything without a slash is a search across the repositories your token can see.',
          'The repository comes back with its URL, default branch and last push, so the entity knows what it is looking at before it runs anything.',
          'A search returns the matching repositories, capped so a broad word cannot flood the prompt.',
          'Entity does not wrap `gh` — the entity calls it itself when it needs one of its verbs.',
        ],
        samples: [
          { code: '@github:artistudio/entity', then: 'one repository, with its URL and default branch' },
          { code: '@github:connectors', then: 'every repository matching that word' },
        ],
  },
  },
}
