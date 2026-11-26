/**
 * The YouTrack connector: issues over the MCP endpoint this workspace declares.
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
  id: 'youtrack',
  account: false,

  dashboard: { call: 'youtrack.dashboard', mode: 'mcp', kind: 'youtrack' },

  /* Read over the MCP endpoint the workspace declares: `probe` answers whether the tab
     can open at all, and `dashboard` is the two paginated reads the pane’s numbers
     come from. Both read-only, and neither returns the `Authorization` value it sends. */
  calls: {
    'youtrack.probe': (args) => require('./dashboard.cjs').probe(args),
    'youtrack.dashboard': (args) => require('./dashboard.cjs').dashboard(args),
  },

  entry: {
      label: 'YouTrack',
      kind: 'mcp',
      verify: null,
      summary: 'Issues, read through this workspace’s MCP pool.',
      work: {
        mention: '@youtrack:',
        resolves: 'issues, scoped to a project key or searched across the workspace',
        syntax: '@youtrack:[<PROJECT>:]<query>',
        examples: ['@youtrack:AC:login bug', '@youtrack:flaky test'],
        returns: 'the matching issues — id, summary, state — read through the MCP pool',
        resolver: 'youtrack',
        needs: 'a token in this workspace’s mcp.json',
        page: 'mcp.json',
        how: [
          'A short upper-case word before the colon is a project key; the rest is the query.',
          'Without a key the whole text is searched across the issues your token can read.',
          'The issues come back as id, summary and state — the same rows the panel on the dashboard would draw.',
          'This goes through the workspace MCP pool, so it stops working the moment the token does.',
        ],
        samples: [
          { code: '@youtrack:AC:login bug', then: 'issues in AC whose text matches “login bug”' },
          { code: '@youtrack:flaky test', then: 'that search across every readable project' },
        ],
  },
  },
}
