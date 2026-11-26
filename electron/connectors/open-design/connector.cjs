/**
 * The Open Design connector: the MCP tools behind `@opendesign:`.
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
  id: 'open-design',
  resolver: 'opendesign',
  mention: 'opendesign',
  suffix: 'Opendesign',
  account: false,

  mentionModule: () => require('./mention.cjs'),

  entry: {
      label: 'Open Design',
      kind: 'mcp',
      verify: null,
      summary: 'Artifacts, files and searches from the design workspace’s own MCP server.',
      website: 'https://open-design.ai/',
      launcher: 'opendesign/bin/opendesign-mcp.sh',
      timeoutMs: 90_000,
      readOnlyTools: ['get_active_context', 'get_artifact', 'get_file', 'search_files', 'list_files'],
      work: {
        mention: '@opendesign:',
        resolves: 'an artifact, one file, or a search across the design workspace',
        syntax: '@opendesign:<artifact|file|search>:<query>',
        examples: ['@opendesign:artifact:onboarding', '@opendesign:search:nav bar'],
        returns: 'the matching artifacts and paths, read through this workspace’s MCP pool',
        resolver: 'opendesign',
        needs: 'the Open Design server installed into this workspace',
        page: 'mcp.json',
        how: [
          'The first segment is what to read — `artifact`, `file` or `search` — and the rest of the line is the query, which may hold spaces.',
          '`artifact` and `file` name one thing directly; `search` looks across the design workspace and lists what matched.',
          'Every read is one of the server’s own read tools. `delete_file` and `delete_project` exist in the pool and are never offered by a mention, so a typo cannot remove anything.',
          'The server runs from this workspace’s `skills/opendesign/`, which travels with the workspace — the same mention works on a teammate’s machine.',
          'Its first start downloads and builds, so a cold run gets a 90-second deadline; after that the pool answers immediately.',
        ],
        samples: [
          { code: '@opendesign:artifact:onboarding', then: 'that artifact’s path and content summary' },
          { code: '@opendesign:search:nav bar', then: 'every file the server matches for those words' },
        ],
  },
  },
}
