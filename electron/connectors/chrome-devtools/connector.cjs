/**
 * The Chrome DevTools connector: the Chrome this machine already has open, driven
 * through Google's own `chrome-devtools-mcp` server.
 *
 * **This file is the connector's descriptor**: the row id and the catalog entry the
 * roster and composer read, in one place. The registry (`../registry.cjs`) derives its
 * maps from here and the catalog assembles itself from the registry, so this connector
 * is added by creating this folder — not by editing a table somewhere else.
 *
 * There is no resolver, no mention and no account. `@chrome-devtools:` would have
 * nothing to put in a prompt that the turn cannot read itself, so the composer never
 * offers it.
 *
 * There is no `launcher` either, because a launcher is a script this app would have to
 * ship and no folder of this repo creates one. What the row declares instead is `server`:
 * the server's own published command, which `connector-store.install()` writes into the
 * workspace's `mcp.json` verbatim. No absolute path and no version pinned to a home
 * directory, so the definition syncs and still means the same thing on the second
 * machine — the browser it attaches to is whichever machine runs it.
 *
 * `entry` is the catalog entry verbatim.
 */
module.exports = {
  id: 'chrome-devtools',
  account: false,

  /* No mention head and no resolver kind: nothing here is typed in a composer. */

  entry: {
    label: 'Chrome DevTools',
    kind: 'mcp',
    verify: null,
    website: 'https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session',
    summary: 'The Chrome this machine already has open, driven through its own DevTools MCP server.',
    /* A first `npx -y chrome-devtools-mcp@latest` downloads the package before it
       answers, so a cold start gets a long deadline. */
    timeoutMs: 90_000,
    /* What installing writes into this workspace's `mcp.json`, as the server publishes
       it: `--autoConnect` takes the Chrome the person already has open, and it carries
       no address of its own, which is what keeps the definition portable. No `--channel`
       either: stable Chrome is the browser a person has open, and a beta or canary one
       is a single arg away on the row. */
    server: {
      command: 'npx',
      args: ['chrome-devtools-mcp@latest', '--autoConnect'],
    },
    work: {
      resolves: 'the browser this machine already has open — its tabs, console, network log and a screenshot',
      returns: 'what the page said: a tab list, console and network entries, a snapshot of the DOM, or a PNG',
      needs: 'Chrome 144+ with `--autoConnect` enabled at `chrome://inspect/#remote-debugging`',
      page: 'mcp.json',
      how: [
        'An attach needs a browser already listening: `--browserUrl http://127.0.0.1:9222` (or `--browser-url` / `-u`). The ws form is `--wsEndpoint`, read out of `http://127.0.0.1:9222/json/version`.',
        '`--autoConnect` (`--auto-connect`) attaches without the port, but it needs Chrome 144+ and the person enabling it at `chrome://inspect/#remote-debugging`. That is the flag the shipped definition passes.',
        'With none of those flags the server launches its own Chrome on a dedicated profile, which is a clean browser rather than the one the person has open.',
        'The definition names no address, so it travels: a teammate installs the same row and it attaches to *their* Chrome. Pin `--browserUrl` to a loopback port and it names this machine instead — which is why a teammate’s workspace lands that version parked.',
        'A browser that closes goes away on the server’s own idle timeout. With a remote endpoint that disconnects and leaves the browser open.',
      ],
      samples: [],
    },
  },
}
