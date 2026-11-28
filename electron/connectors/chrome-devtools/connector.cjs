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
 * offers it. There is no `launcher` either: what this row binds is the *server's*
 * definition in `mcp.json`, installed through the server's own setup, so a workspace
 * that has not installed it shows a page with no command to copy — the Maka shape.
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
    work: {
      resolves: 'the browser this machine already has open — its tabs, console, network log and a screenshot',
      returns: 'what the page said: a tab list, console and network entries, a snapshot of the DOM, or a PNG',
      needs: 'Chrome’s remote-debugging endpoint, or `--autoConnect` enabled in Chrome 144+',
      page: 'mcp.json',
      how: [
        'An attach needs a browser already listening: `--browserUrl http://127.0.0.1:9222` (or `--browser-url` / `-u`). The ws form is `--wsEndpoint`, read out of `http://127.0.0.1:9222/json/version`.',
        '`--autoConnect` (`--auto-connect`) attaches without the port, but it needs Chrome 144+ and the person enabling it at `chrome://inspect/#remote-debugging`.',
        'With none of those flags the server launches its own Chrome on a dedicated profile, which is a clean browser rather than the one the person has open.',
        'This row reads *this* machine’s browser, so its definition is machine-bound on purpose: a teammate’s workspace shows the row and no binding.',
        'A browser that closes goes away on the server’s own idle timeout. With a remote endpoint that disconnects and leaves the browser open.',
      ],
      samples: [],
    },
  },
}
