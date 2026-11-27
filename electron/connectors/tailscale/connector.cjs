/**
 * The Tailscale connector: the tailnet this machine is on, and one web server a
 * phone on that tailnet can open.
 *
 * **This file is the connector's descriptor**: the row id, the catalog entry and
 * the call table, in one place. The registry (`../registry.cjs`) derives its maps
 * from here and the catalog assembles itself from the registry, so this connector
 * is added by creating this folder — not by editing a table somewhere else.
 *
 * `dashboard.cjs` beside it is every verb (`status`, `start`, `stop`, `serve`,
 * `open`) and `lan-server.cjs` is the HTTP server a packaged app serves the built
 * renderer with. Both live here because they are one fact: what this machine's
 * tailnet says, and what a person hands to a phone.
 *
 * There is no resolver, no mention and no account. `@tailscale:` would have nothing
 * to put in a prompt that the turn cannot read itself; what this connector produces
 * is an address a *person* opens on a phone, which is not a prompt — so it carries
 * no `work` block and the composer never offers `@tailscale:`.
 *
 * There is no dashboard tab either: its page body is its own two cards
 * (`src/connectors/tailscale/TailscalePanel.vue`), which is why `dashboard.cjs`
 * here carries the calls and no `dashboard` field is declared.
 *
 * Three hooks are the one way this connector needs the *process* rather than a
 * call: `attach` hands it the call table (the page a phone loads asks the window's
 * own questions), `fanout` gives it the event stream, and `shutdown` stops what it
 * started when the app quits — a listener nothing on screen admits to is the leak
 * the child registry exists to prevent, for a child this app does not spawn.
 */
module.exports = {
  id: 'tailscale',
  account: false,

  /* No mention head and no resolver kind: nothing here is typed in a composer. */

  attach: (call) => require('./dashboard.cjs').attach({ call }),
  fanout: (event) => require('./dashboard.cjs').fanout(event),
  shutdown: () => require('./dashboard.cjs').stop(),

  /* The five verbs the page makes. `tailscale status --json` is the only read of
     the daemon, and `verify` below is the only other thing this app ever runs
     against it: no `up`, no `set`, no `serve`/`funnel`, no auth key. */
  calls: {
    'tailscale.status': () => require('./dashboard.cjs').read(),
    'tailscale.start': ({ port } = {}) => require('./dashboard.cjs').start(port),
    'tailscale.stop': () => require('./dashboard.cjs').stop(),
    'tailscale.serve': () => require('./dashboard.cjs').serve(),
    /* Reveals the Tailscale app (the fix for `stopped` and `signed-out`); it never
       runs a Tailscale verb. */
    'tailscale.open': () => require('./dashboard.cjs').open(),
  },

  entry: {
    label: 'Tailscale',
    kind: 'cli',
    binary: 'tailscale',
    website: 'https://tailscale.com',
    summary: 'Open this app on your phone by its tailnet name.',
    /* `tailscale version` proves the binary answers and prints the build. What a
       Start then runs is the page's own business (`mode`): a checkout's
       `npm run dev:lan`, or this app's built renderer. */
    verify: { argv: ['version'], okExit: 0 },
  },
}
