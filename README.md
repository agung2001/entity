# Entity

Desktop app built with **Vue 3 + Vite** (renderer) and **Electron** (shell).

The renderer is the entity hub: entities (agent instruction files), the skills a
workspace has attached, the machines it may use, and the runs those entities
produce. A **workspace is a directory** — `~/.entity/workspaces/<id>/` — so
switching workspaces changes the entities, skills, machines and run history at
once, and everything survives quitting the app.

This step runs entities **on this Mac**: a real harness process (`claude`,
`codex`, `pi`, `opencode`, `gemini`), a real working directory, a real exit code.
Remote execution is deliberately not implemented yet; an attached ssh host is the
frame that step fills in.

## Requirements

- Node.js `^20.19` or `>=22.12` (Vite 8 requirement)

## Getting started

```bash
npm install
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Renderer only, in the browser at http://localhost:5183 |
| `npm run dev:desktop` | Starts Vite **and** Electron, pointed at the dev server (HMR included) |
| `npm run build` | Builds the renderer into `dist/` |
| `npm run start` | Runs Electron against the existing `dist/` build (no dev server) |
| `npm run preview` | Serves the built renderer through `vite preview` |
| `npm run package` | Builds and packages a distributable with electron-builder → `release/` |

`ENTITY_HOME` overrides `~/.entity`, which is useful for a scratch profile:

```bash
ENTITY_HOME=/tmp/entity-scratch npm run dev
```

### Ports

The dev server uses **5183** by default so it does not collide with the many
projects that grab Vite's default 5173. Override it with `VITE_DEV_PORT=6000 npm run dev`.
If the port is taken, Vite moves to the next free one and `dev:desktop` follows it
automatically — the launcher reads the URL Vite actually bound, it does not
assume a port.

## Where data lives

```
~/.entity/workspaces/<id>/          one workspace = one directory
  workspace.json                   { schema, id, label, kind, createdAt, mcpStrict }
  entities/<name>.md               frontmatter = config, body = instructions
  skills/<name>                    symlink into a harness skill library
  mcp.json                         { schema, servers: { name: { command | url, args, env } } }
  machines.json                    { schema, attached: ["local", "hetzner-prod"] }
  runs/<runId>.jsonl               append-only run log
```

Two rules make the scope coherent:

1. **The workspace is the scope, the machine is the source.** `~/.ssh/config`
   says which hosts exist; `machines.json` says which ones this workspace may
   use. `~/.claude/skills` says which skills exist; `skills/` says which ones this
   workspace has.
2. **No cross-workspace references.** `skills:` and `mcp:` on an entity resolve
   only inside its own workspace. The same name in two workspaces is two
   unrelated things.

Nothing is seeded behind your back: a profile with no workspace lands on
`/setup`, and sample entities are a checkbox in that form — off by default, and
when ticked it lists all six files so you choose which ones to write (three are
preselected). The same form is reachable as a modal from the workspace switcher.

Skills are not part of that form: the harness libraries are already on this
machine, so a skill is attached to a workspace later (one symlink, from the
Skills view or Workspace settings) when it is actually needed.

### One file is the entity

```markdown
---
name: py-agent
harness: claude
model: claude-sonnet
dir: ~/Documents/repository/github/entity
skills: web-research, pdf-ocr
mcp: github
---
# py-agent

You are py-agent, a Python engineer.

## Rules
- Run the tests before claiming a task is done.
```

The harness receives the body as a system prompt (`claude`, `pi` via
`--append-system-prompt`) or as prompt text (`codex`, `opencode`, `gemini`). The
prompt itself always goes in on **stdin**; `cwd` is the entity's `dir`. `skills:`
and `mcp:` names that do not resolve are reported as `problems[]` on the entity —
the file stays readable, the run is still allowed.

## Layout

```
electron/
  main.cjs            main process: window, lifecycle, IPC entry points
  preload.cjs         contextBridge — `call()` + `onRunEvent()`, nothing else
  rpc.cjs             the one call table (workspace / entity / run / machine / skill)
  workspace-store.cjs workspace dirs: create (atomic), list, machines, skills, mcp
  entity-store.cjs    entities/*.md read/write/scaffold + problems[]
  runner-local.cjs    spawn a harness, stream events, append the run log
  frontmatter.cjs     the flat frontmatter parser shared by entities and skills
  seed.cjs            the optional sample entities + their descriptions/defaults
  local-data.cjs      ~/.ssh/config parser, ssh probes, harness skill scanner
scripts/
  dev-desktop.mjs     runs Vite programmatically, then launches Electron
src/
  main.js             renderer entry
  router.js           hash history; guard order: session → workspace → route
  App.vue             root: marks the platform (macOS traffic-light inset)
  layouts/
    HubLayout.vue     rail + topbar + router-view + global overlays
  views/
    LoginView.vue     sign in
    SetupView.vue     first run: create the first workspace (no rail, no skip)
    OverviewView.vue  ask console, machines, entities, recent runs
    ChatView.vue      threads, rebuilt per workspace
    EntitiesView.vue  the entity table; "Add entity" scaffolds a file
    SkillsView.vue    the workspace's skill catalog + attach from the machine
    SkillDetailView.vue  overview / SKILL.md / files, read from the link target
    MachinesView.vue  fleet from ~/.ssh/config + workspace attachments
    ActivityView.vue  the run journal
  components/
    EntityMark.vue    the animated voxel character
    HarnessIcon.vue   brand marks for the skill filter pills
    MachineIcon.vue   the server glyph on machine cards
    SkillIcon.vue     the medal glyph on skill cards
    MarkPicker.vue    mood + colour, opened from the drawer
    AppRail.vue       brand, workspace switcher, nav, account menu
    AppTopbar.vue     breadcrumbs + view tools
    AskConsole / MessageList / SlashComposer
    PickMenu.vue      the quiet text trigger used for filter axes
    EntityDrawer.vue  overview, Run, skills, ENTITY.md
    RunPanel.vue      prompt, live tail, cancel, recent runs
    WorkspaceWizard.vue    the create form (setup page and modal)
    WorkspaceSettings.vue  machines / skills / MCP tabs
    AccountModal.vue  username, email and password
    CommandPalette.vue
    ToastHost.vue
  composables/
    entityMark.js     the mark's renderer + one shared rAF loop
    useDesktop.js     wrapper over the preload bridge
    localBridge.js    `call()` and `onRunEvent()`: IPC in Electron, HTTP+SSE in a browser
  stores/
    hub.js            session, the active workspace's view model, consoles, drawers
    workspaces.js     list/open/create, machines, skills, mcp; scope loading
    entities.js       entity files mapped onto the table rows
    runs.js           run summaries, live output, stale-event guard
    fleet.js          ssh hosts from ~/.ssh/config + per-host probe state
  data/
    mock.js           harness ids and the four built-in slash commands — nothing else
  styles/
    app.css           tokens, shell, rail, tables, consoles, overlays, run panel
    login.css         the sign-in and setup screens
    skill.css         the skill detail page
  assets/fonts/geist.woff2
index.html            renderer HTML + CSP
vite.config.js        `base: './'` so the build loads over `file://`; mounts the
                      call table + SSE at /__entity/* for dev and preview
```

## Routes

Hash history is used because the packaged app loads over `file://`, where
history mode has no server to resolve a path on reload.

| Route | Screen |
| --- | --- |
| `#/login` | Sign in (the only public route) |
| `#/setup` | Create the first workspace (no rail — the hub is not usable yet) |
| `#/` | Overview |
| `#/chat` | Chat |
| `#/entities` | Entities |
| `#/skills` | Workspace skills |
| `#/skills/:name` | Skill detail |
| `#/machines` | Machines |
| `#/activity` | Activity |

The guard runs in order: **session → workspace → route**. After sign-in, if
`~/.entity/workspaces/` holds no readable `workspace.json`, the router sends the
user to `/setup` and remembers the deep link they wanted, so the first workspace
lands them there. The active workspace id persists in
`localStorage['entity.workspace']` and is validated against disk on every boot: an
unknown id falls back to the oldest workspace.

## Talking to the main process

All local reads and writes go through **one call table** (`electron/rpc.cjs`).
Electron exposes it as `ipcMain.handle('entity:call')`; the Vite dev server
exposes the same table at `POST /__entity/call` and streams run events at
`GET /__entity/events`. The renderer's own wrapper is
`src/composables/localBridge.js`:

```js
import { call, onRunEvent } from '@/composables/localBridge'

const entity = await call('entity.read', { workspace, name })
const off = onRunEvent((event) => {
  if (event.workspace !== hub.workspace) return // stale-event rule
})
```

Add a feature by adding a handler to the call table — **not** by inventing a new
channel per feature, and never by handing the renderer a path or a shell string.
The renderer never touches `fs`; main validates names (`[a-z0-9-]+`), resolves
`dir` and only then spawns.

Keep `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true` (the
defaults in this scaffold), and never expose `ipcRenderer` itself.

## Runs

`run.start({ workspace, name, prompt })` spawns one harness process:

| harness | invocation | instructions |
| --- | --- | --- |
| claude | `claude -p --append-system-prompt <text> [--mcp-config <file> --strict-mcp-config]` | system prompt |
| pi | `pi -p --append-system-prompt <text>` | system prompt |
| opencode | `opencode run` | prepended to the prompt |
| codex | `codex exec -` | prepended to the prompt |
| gemini | `gemini -p` | prepended (unverified) |

Events (`state`, `stdout`, `stderr`, `exit`) are coalesced per 50 ms and appended
to `<ws>/runs/<runId>.jsonl`. Status is the last `state`/`exit` line, so there is
no index to keep consistent. A run that still says `running` with no child
process (the app was quit) is reported as canceled. One run per entity at a time.

MCP is enforced for **claude only**: the workspace pool is filtered to the
entity's `mcp:` list, written to a temporary `--mcp-config` file and deleted when
the run ends. `codex`, `opencode`, `pi` and `gemini` manage MCP in their own
global config, and the UI says so instead of implying enforcement.

## Security notes

- Renderer runs **sandboxed** with context isolation, and a CSP is declared in
  `index.html` (it allows the HMR websocket in dev and nothing extra in prod).
  The mark sets CSS custom properties inline, which `style-src 'unsafe-inline'`
  covers; the font is served from the app, not a CDN.
- Prompts go to the harness on stdin, never through a shell (`shell: false`).
  `harness` is one of five known ids; `dir` must exist and is resolved in main;
  entity and workspace names are `[a-z0-9-]+`, so no path escapes.
- MCP `env` entries are variable **names**; values resolve from the environment
  at run time and are never written into `mcp.json`.
- External links open in the OS browser; in-app navigation away from the app
  origin is blocked.
- Dev only: DevTools open detached when `ELECTRON_RENDERER_URL` is set.

## Relative asset paths

`vite.config.js` sets `base: './'`. Without it the built `index.html` requests
`/assets/…`, which resolves to the filesystem root under `file://` and the
packaged app renders a blank window.

## Ceilings (stated, not hidden)

- A run dies with the app; there is no daemon.
- Skills are not sandboxed per workspace at execution time — the harness reads its
  own user-level library. The workspace scope governs what the hub shows, attaches
  and completes.
- MCP is enforced for claude only (see above).
- Remote placement, ssh deploy and workspace deletion are not implemented; a
  directory in Finder is the honest interface.

## Not included (add when you need them)

State management (`pinia`), TypeScript, tests, auto-update.
