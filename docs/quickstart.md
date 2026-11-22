[← README](../README.md)

# Quickstart

## Requirements

**Node.js `^20.19` or `>=22.12`** (Vite 8). Any one of the assistant CLIs on `PATH`
— `claude`, `codex`, `gemini`, `opencode`, `pi` and the newer `agy` / `hermes` —
installed from a terminal once; after that you never need one to use the app.

```bash
git clone https://github.com/agung2001/entity.git
cd entity
npm install
npm run dev:desktop      # Vite + Electron, HMR included
```

On a fresh profile the app lands on the **/welcome** wizard: name the room, pick an
agent CLI, say hello. It registers the machine-local owner on the way in — `owner` with
the default password `123456`, changeable later — so there is no sign-in form to fill
here; [Onboarding](onboarding.md) walks through the three steps.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Renderer only, in a browser at http://localhost:5183 |
| `npm run dev:lan` | The same, bound to `0.0.0.0` so another machine on your network can open it |
| `npm run dev:desktop` | Vite **and** Electron, pointed at the dev server |
| `npm run build` | Builds the renderer into `dist/` |
| `npm run start` | Runs Electron against the existing `dist/` build |
| `npm run test` | Unit tests + the static UI contract (`tests/unit/`) |
| `npm run test:smoke` | The release-blocking Playwright pack, including real `opencode` and `pi` turns |
| `npm run test:regression` | The deterministic Playwright regression pack |
| `npm run test:e2e` | Both Playwright packs |
| `npm run test:gate` | Unit + smoke — the release gate |
| `npm run package` | Builds a distributable for the current platform → `release/` |
| `npm run package:mac` | Universal macOS DMG → `release/` (macOS only) |
| `npm run package:mac:install` | Builds the universal macOS DMG, then installs/replaces `Entity.app` in `/Applications` (set `ENTITY_APP_DIR` to use another folder) |
| `npm run package:win` | x64 Windows installer → `release/` (run on Windows; needs Wine on macOS) |
| `npm run package:linux` | x64 Linux AppImage → `release/` (Linux only) |
| `npm run package:linux:install` | Builds the Linux AppImage, then installs/replaces it for the current user in `~/Applications` (launcher entry, icons and `~/.local/bin` symlink included) |
| `npm run serve` | The shared server against the built renderer |
| `npm run clean:dev` | Stops a dev server or headless browser this checkout left behind |

## Ports and profiles

- The dev server uses **5183** so it does not collide with projects that grab Vite's
  default 5173. Override with `VITE_DEV_PORT=6000`.
- `npm run dev:lan` binds to `0.0.0.0`: open it by **IP address**, not a hostname —
  Vite only auto-allows `localhost` and literal IPs, so `http://my-mac.local:5183` is a
  blocked host until that name is added to `server.allowedHosts`.
- `ENTITY_HOME` moves the whole profile — account, workspaces, run logs — which is
  handy for a scratch hub:

```bash
ENTITY_HOME=/tmp/entity-scratch npm run dev:desktop
```

Two clocks bound a turn. The wall-clock deadline (default 90 min) is armed when the
harness is spawned — it is what stops a run that keeps talking, since the silence timer
below never fires while output continues. It is a setting: **Workspace → Chats → How long
a turn may run**, 10 minutes to 6 hours, saved in `~/.entity/turn.json` and read when a
turn starts. Starting the app with `ENTITY_TURN_TIMEOUT_MS` overrides it (that is how the
E2E suite pins the number). `ENTITY_MENTION_TIMEOUT_MS` (default 60 min) is one delegated
run's own budget, so a turn that delegates must be given longer than a single run.

## Tests

The default E2E packs start their own server on port **5199** and seed a throwaway
profile under `.tmp/` — no real account, workspace, SSH host or MCP secret is used.
The opt-in remote and MCP cases read an alias or your existing harness config from
the environment at run time; no value is committed. Install the browser once:

```bash
npx playwright install chromium
```

See [`tests/README.md`](../tests/README.md) for the smoke/regression split.

## Release builds

```bash
git tag v0.0.1 && git push origin v0.0.1
```

That builds macOS and Windows installers, publishes a GitHub Release and pushes the
container image to GHCR. Tag builds are unsigned: macOS may ask you to open the app
from **System Settings → Privacy & Security**, and Windows SmartScreen may warn
before running the installer. The workflow uses the tag as the app version, so
`v0.0.1` produces installers named `0.0.1` and the image tag
`ghcr.io/agung2001/entity:0.0.1` (also `:v0.0.1`, `:0.0`, `:latest`).

The same workflow announces the release in Discord, pinging `@everyone`. Nothing
else is required to build; to turn the announcement on, add the channel webhook as
the repository secret `DISCORD_WEBHOOK_URL`. Without that secret the step logs a
skip. A failed broadcast never fails the release — the installers are already
published when it runs.

Preview the card without sending it:

```bash
node scripts/broadcast-release.mjs --dry-run --tag v0.0.1
```

## Related

- [Workspaces and entities](workspaces.md) — what a workspace actually is
- [Deploy the server](deploy.md) — the shared build
- [Status](status.md)
