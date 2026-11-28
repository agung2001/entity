[← Connectors](../connectors.md)

# Chrome DevTools

<img src="../assets/connectors/chrome-devtools.webp" alt="The Chrome DevTools connector page before installing: an MCP row with no definition to read, its Tools card saying “not probed” because no harness declares the server, the In the chat card saying no resolver is shipped and naming the @chrome-devtools: form it therefore does not offer, and the rail listing the local transport, the website, no token and an Install button" width="820" />

Google's own `chrome-devtools-mcp` server, which drives the Chrome this machine already has
open: its tabs, its console, its network log, and a screenshot of whatever is on screen.
The standard install is `npx -y chrome-devtools-mcp@latest`.

An `mcp` row with no credential of its own. What proves who you are here is Chrome's own
signed-in profile, and the row stores none of it: the definition lives in this workspace's
`mcp.json` beside every other MCP server's, which is why the rail says **none** where a
token would sit. Nothing here is a secret this app hands out.

It also ships no `launcher`, so a workspace that has not installed it shows a page with no
command to copy. Read the page, then install the server where you configure your MCP
servers — the row records that this workspace reaches it, and nothing is invented.

## Two ways to attach, and a default

| you pass | what it reaches |
| --- | --- |
| `--browserUrl http://127.0.0.1:9222` (also `--browser-url`, `-u`) | a Chrome already listening on its remote-debugging port |
| `--wsEndpoint ws://127.0.0.1:9222/devtools/browser/<id>` | the same browser, addressed by its websocket endpoint — the id is in `http://127.0.0.1:9222/json/version` |
| `--autoConnect` (also `--auto-connect`) | a browser that enabled it, with no port to pass |
| nothing | a Chrome of the server's own, on a dedicated profile |

The first two are the same browser reached two ways, and they need the browser started with
remote debugging on. `--autoConnect` is the path with no port at all, and it has two
requirements that are not this app's to satisfy: Chrome 144 or later, and the person turning
it on at `chrome://inspect/#remote-debugging`.

With no flag the server launches its own Chrome on a profile of its own. That is a clean
browser with none of your tabs or sign-ins, which is the right shape for a scripted run and
the wrong one for "look at the page I have open" — the whole point of the two attach paths
above. The flags that change which browser runs (`--headless`, `--isolated`, `--channel`,
`--executablePath`, `--userDataDir`) are the server's own; this row sets none of them.

A browser that goes away is not an error that outlives it. The server has an idle timeout,
and with a remote endpoint it disconnects when that runs out and leaves the browser open,
exactly as it found it.

## The browser on this machine

This row reads *this* machine's browser, so its definition is machine-bound on purpose. A
teammate who opens the same workspace sees the row and no binding: the endpoint is
`127.0.0.1`, and a `127.0.0.1` on someone else's laptop is not your Chrome. Installing it
in their workspace is not the same as reaching yours, and the row does not pretend
otherwise.

That is also why the definition travels and the browser does not. The row is a definition
like any other — it lists, it installs, it uninstalls — and the thing it points at stays
where it is.

## There is no `@` form

The catalog entry carries no `work.mention` and no resolver, so `@chrome-devtools:` is not a
thing you can type and the composer will not offer it. A browser is something a turn drives,
not something typed into a line: what a mention would have to paste into the prompt is a
window's state, and the server's own tools are what read it.

→ [MCP servers](../mcp.md) — the `mcp` kind in full, and how each harness receives the set
→ [Connectors](../connectors.md) — the roster, the three kinds, and the rows that answer no `@`
