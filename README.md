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
| `npm run clean:dev` | Stops a dev server or screenshot browser left running by this checkout |
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

Visual checks use disposable headless Chrome profiles under
`/tmp/entity-chrome-*`. If a check is interrupted, `npm run clean:dev` stops the
leftover dev server and those headless browsers without touching a normal Chrome
window.

## Where data lives

```
~/.entity/auth.json                 account identity + scrypt verifier + encrypted password
~/.entity/auth.key                  AES-256 fallback key, mode 0600 (when safeStorage is unavailable)
~/.entity/workspaces/<id>/          one workspace = one directory
  workspace.json                   { schema, id, label, kind, createdAt, mcpStrict, context }
  members.json                     { schema, workspace, owner, members: [{ name, email, role }] }
  entities/<name>.md               frontmatter = config, body = instructions
  skills/<name>                    symlink into a harness skill library
  mcp.json                         { schema, servers: { name: { command | url, args, env } } }
~/.entity/mcp-server.json           Entity's own MCP server: enabled, port, token (0600), allowWrite
  machines/CONFIG                  this workspace's ssh_config (Host blocks)
  machines/<host>                  a copy of that host's key, mode 0600
  chats/<threadId>.json            one conversation per file
  artifacts/<path>                 documents, screenshots and other deliverables
  runs/<runId>.jsonl               append-only run log
  audit.jsonl                      one line per agent-initiated write
  .bin/entity                      launcher for the CLI, regenerated per run
```

`~/.entity/harnesses.json` holds the optional machine-wide binary path overrides (`{ "paths": { "claude": "/opt/.../claude" } }`).

`machines/CONFIG` is in `ssh_config` grammar and is rebuilt from `~/.ssh/config`
on every attach and detach; `# entity-machines: [...]` on its fourth line is the
attached list (ssh ignores comments), which is how a host that disappeared from
the user's config still stays attached as *missing*. A workspace made before
this layout had `machines.json`; it is migrated on first open and the old file
is kept as `.machines.json.bak`.

Two rules make the scope coherent:

1. **The workspace is the scope, the machine is the source.** `~/.ssh/config`
   says which hosts exist; `machines/CONFIG` says which ones this workspace may
   use, and carries the key copy so it can prove it. `~/.claude/skills` says
   which skills exist; `skills/` says which ones this workspace has.
2. **No cross-workspace references.** `skills:` and `mcp:` on an entity resolve
   only inside its own workspace. The same name in two workspaces is two
   unrelated things.

Nothing is seeded behind your back: a profile with no workspace lands on
`/setup`, and sample entities are a checkbox in that form — off by default, and
when ticked it lists all six files so you choose which ones to write (three are
preselected). The same form is reachable as a modal from the workspace switcher.

Skills are not part of that form: the harness libraries are already on this
machine, so a skill is attached to a workspace later (one symlink, from the
Skills view) when it is actually needed. The scan also reads `~/.agents/skills`,
which several agents share.

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

### An entity can change itself

The file above is not read-only to the agent it defines. Every run gets
`ENTITY_CLI_PATH` and a short brief, so it can list entities, read one, rewrite
its **body**, change another entity's config, add an MCP server to the workspace
pool, attach a skill, or set the workspace-wide context:

```bash
"$ENTITY_CLI_PATH" entity list
"$ENTITY_CLI_PATH" entity get py-agent --output json
"$ENTITY_CLI_PATH" entity set-instructions py-agent --body-stdin
"$ENTITY_CLI_PATH" mcp add github --command npx --args -y,server-github
"$ENTITY_CLI_PATH" workspace set-context --context-stdin
```

Four things make that safe to hand out:

- **One writer.** `electron/platform-core.cjs` owns every verb; `cli.cjs` is a
transport over it and touches no paths. A future MCP adapter would be a second
transport, not a second implementation.
- **Containment, on the resolved path.** A name is matched against the entity
  filename grammar *and* the resulting real path is checked to be inside the
  workspace. Another workspace is unreachable, by name or by `..`.
- **Optimistic concurrency.** `set-instructions` takes the `stamp` from the
  preceding `get` (`--if-unchanged`) and refuses a write that would clobber a
  person editing the same file in `$EDITOR`.
- **An audit line.** Every mutation appends to `<ws>/audit.jsonl`; `entity audit`
  reads it back. A change outlives the run that made it, so the row is the only
  thing that can explain it later.

`env` on an MCP server is a list of variable **names** — `mcp.json` never holds a
value, and no verb returns one. Set the variable in the environment the app runs
in. Account → MCP is the other direction: a loopback HTTP MCP endpoint with a
bearer token, exposing `list_workspaces`, `get_workspace`, `list_entities`,
`get_entity`, `create_entity`, `list_chats`, `read_chat` and `list_artifacts`.
Reads work by default; `create_entity` needs **Allow writes**.

A write changes the file; the window notices without a reload because
`workspace-watch.cjs` watches `entities/`, `skills/`, `workspace.json` and
`mcp.json` and drops one `workspace-changed` event per workspace per quiet
period. Run logs are deliberately excluded — they are appended every 50 ms.

### Skills are called, not just declared

`skills:` on an entity is a declaration; it changes nothing about what the
harness loads. To actually use a skill, start the message with a reference:

| reference | resolves to |
| --- | --- |
| `/workspace:<name>` | `<ws>/skills/<name>` — attached to this workspace |
| `/<harness>:<name>` | that harness's own library, e.g. `~/.claude/skills/<name>` |
| `/<name>` | any library on this machine, when exactly one has that name |

The `/` menu is a skill picker and nothing else — there are no built-in
commands, because every command this app once advertised was either a skill
reference or a token the harness owns. The menu lists the workspace's skills
first, then every harness library on the machine, and inserts the reference.
Picking from the menu always inserts the qualified form; a bare `/<name>` is
for typing by hand, and is accepted only when one library has it. Two libraries
with the same name is an error listing both qualified forms, not a guess — the
wrong library would load the wrong instructions silently.

The backend resolves the reference to an absolute path **on the machine the
thread is pinned to** and sends

```
use this skill /abs/path/to/skill

<the rest of the prompt>
```

Only this machine's libraries can be read, so a thread pinned to an ssh host
offers no skills and says so; it never hands a remote harness a local path it
cannot see. The reference itself is not sent. A reference this app owns that
does not resolve is an error — a typo should not turn into an answer without the
skill it named. `/review` (no colon, no match) and `/<unknown>:<name>` are left
alone: those belong to the harness. This is the one place the workspace's
`skills/` directory is load-bearing, and it is why a harness-only skill can be
used without attaching it first.

The **Skills** page opens on the workspace's own list. The machine-wide harness
libraries are a second tab, and they are scanned lazily — on first open of that
tab (or the first `/` typed in a composer for that machine), then cached per
machine for the session — so a launch does not walk six skill directories nobody
asked for.

## Chat transcripts

Each chat turn is still a real harness process, but the CLI now runs in its JSONL
stream mode (`claude --output-format stream-json`, `pi --mode json`, and the
equivalents for codex/opencode/gemini). `chat-transcript.cjs` folds that stream
into thinking blocks, assistant text and one row per tool call with its output.
The steps and execution metadata (command, cwd, model, duration, usage) live on
the assistant message in `<ws>/chats/<threadId>.json` — no database, no second
copy. The chat header opens the full transcript; each answer also carries an
inline, collapsible process fold. The transcript dialog itself is a detail view:
turn tabs, a two-lane wall-clock timeline, a step outline and one expanded step.
Old messages without a transcript simply do not show one. Each answer also has
copy, share and "save as artifact" actions. A failed turn carries a **Retry**
button that re-runs the same question without adding a second copy of it. Every
message — question or answer — has copy/share; share is a deep link
(`?thread=…&msg=…`) that opens the thread and scrolls to that row. Opening
`#/chat` without a query adopts the newest thread and replaces the URL, so the
address is always shareable. A right-edge outline draws one tick per message,
follows the reading position, and opens a jump card on hover or focus.

### Artifacts in chat

The harness is told that workspace artifacts live in `<ws>/artifacts`, that a
screenshot belongs there rather than `/tmp`, and that a saved file should be
referenced as `artifact://<relative-path>`. The chat renders that reference as an
image or a download card, and also attaches any file written to the artifact
shelf during the turn even when the answer never names it. A failed turn keeps
the files it managed to save, and older threads without artifact metadata are
matched to their request windows when they are read. An absolute `/artifacts/…`
path resolves through the same read RPC. `#/artifacts` remains the shelf for
browsing, uploading, searching, filtering and removing those files.

## Layout

```
electron/
  main.cjs            main process: window, lifecycle, IPC entry points
  preload.cjs         contextBridge — `call()` + `onRunEvent()`, nothing else
  rpc.cjs             the one call table (workspace / entity / run / machine / skill)
  auth-store.cjs      ~/.entity/auth.json: scrypt verifier + encrypted password
  workspace-store.cjs workspace dirs: create (atomic), list, update, machines, skills, mcp, members
  entity-store.cjs    entities/*.md read/write/scaffold + problems[]
  chat-store.cjs      threads under <ws>/chats, one harness turn per send
  chat-transcript.cjs JSONL stream → thinking / text / tool steps for a chat turn
  session-store.cjs   each harness's own session store, scoped by entity cwd
  mcp-store.cjs       MCP config discovery across ~/.claude.json, ~/.codex, ~/.pi, …
  mcp-tools.cjs       opens a server's JSON-RPC handshake and asks for tools/list
  mcp-server.cjs      Entity's own loopback MCP server: workspaces, entities, chats, artifacts
  artifact-store.cjs  <ws>/artifacts: list, read, upload, saveText, remove, prompt brief
  harness-store.cjs   installed CLI paths, ~/.entity/harnesses.json, detected model hints
  skill-ref.cjs       /workspace:<name> and /<harness>:<name> → `use this skill <path>`
  runner-local.cjs    spawn a harness, stream events, append the run log
  platform-core.cjs   the agent-facing verbs: the only writer an agent can reach
  platform-brief.cjs  what every run is told (brief + workspace context) and env
  platform-audit.cjs  <ws>/audit.jsonl — one line per agent-initiated write
  workspace-watch.cjs fs.watch over workspaces → "a file changed, re-read it"
  cli.cjs             the `entity` CLI; a transport over platform-core, no fs
  frontmatter.cjs     the flat frontmatter parser shared by entities and skills
  seed.cjs            the optional sample entities + their descriptions/defaults
  local-data.cjs      ~/.ssh/config parser, ssh probes, harness skill scanner
scripts/
  dev-desktop.mjs     runs Vite programmatically, then launches Electron
bin/
  entity              the same CLI for a terminal, a hook or CI
src/
  main.js             renderer entry
  router.js           hash history; guard order: session → workspace → route
  App.vue             root: marks the platform (macOS traffic-light inset)
  layouts/
    HubLayout.vue     rail + topbar + router-view + global overlays
  views/
    LoginView.vue     sign in
    SetupView.vue     first run: create the first workspace (no rail, no skip)
    OverviewView.vue  workspace statistics, machines, entities, recent runs
    ChatView.vue      collapsible thread history, row action menu, searchable filters, transcript
    EntitiesView.vue  the entity table; "Add entity" scaffolds a file
    EntityDetailView.vue  entity page: editable harness/model, harness paths, Markdown instructions
    SkillsView.vue    the workspace's skill catalog (default tab) + the harness libraries tab
    McpView.vue       workspace MCP pool + global harness MCP config (attach to pool)
    AccountView.vue   profile + password, sound, and the Entity MCP server connection
    ArtifactsView.vue  workspace artifact shelf: upload, remove, search, extension filter, sort
    SkillDetailView.vue  overview / SKILL.md / files, read from the link target
    MachinesView.vue  workspace attachments + fleet tabs from ~/.ssh/config
    MachineDetailView.vue  one host: connection, key copy, probe, attachment
    ActivityView.vue  thread journal + one tab per harness session store (cached counts)
    ManageWorkspacesView.vue  add, settings, export/import JSON, delete
  components/
    EntityMark.vue    the animated voxel character
    HarnessIcon.vue   brand marks for the skill filter pills
    MachineIcon.vue   the server glyph on machine cards
    SkillIcon.vue     the medal glyph on skill cards
    MarkPicker.vue    shape + mood + colour, opened on the entity page
    AppRail.vue       brand, workspace switcher, nav, account menu
    AppTopbar.vue     breadcrumbs + view tools
    MessageList / MessageBody / SlashComposer
    ThreadMinimap.vue  right-edge message outline and jump card
    ModelInput.vue     free-text model field with detected suggestions
    McpAccountPanel.vue  Entity's MCP server status, token, agent config and tools
    MarkdownEditor.vue Write/Review Markdown editor with a sanitized preview
    HarnessPaths.vue   machine-wide executable overrides for the five harnesses
    ArtifactThumb.vue  lazy image thumbnail for the artifact grid
    PickMenu.vue      the quiet text trigger used for filter axes
    WorkspaceWizard.vue    the create form (setup page and modal)
    WorkspaceStats.vue     the overview's entity / conversation / skill / machine cards
    NewThreadDialog.vue    searchable entity/harness picks, detected models before a thread starts
    TranscriptDialog / TraceTimeline  one execution's command, timing, thinking, tools
    CommandPalette.vue    categorized search: workspaces, chat, entities, skills, machines, activity
    ToastHost.vue
  composables/
    entityMark.js     30 pixel silhouettes, renderer, colour wheel + one shared rAF loop
    useDesktop.js     wrapper over the preload bridge
    localBridge.js    `call()` and `onRunEvent()`: IPC in Electron, HTTP+SSE in a browser
  stores/
    hub.js            session, the active workspace's view model and chat state
    workspaces.js     list/open/create, machines, skills, mcp; scope loading
    artifacts.js      artifact metadata, upload, save, read, remove
    harnesses.js      installed harness paths and detected models
    entities.js       entity files mapped onto the table rows
    runs.js           run summaries, live output, stale-event guard
    fleet.js          ssh hosts from ~/.ssh/config + per-host probe state
  data/
    mock.js           harness ids, model hints and the four built-in slash commands
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
| `#/entities/:name` | Entity detail (identity, skills, source file) |
| `#/skills` | Workspace skills |
| `#/skills/:name` | Skill detail |
| `#/mcp` | Workspace MCP pool + global harness MCP configs |
| `#/artifacts` | Workspace artifacts: upload, preview, remove, search, filter, sort |
| `#/machines` | Machines |
| `#/machines/:id` | Machine detail (connection, key copy, probe) |
| `#/activity` | Redirects to Workspace → Activity (old links keep working) |
| `#/workspaces` | Manage workspaces (add, export/import, delete, settings) |
| `#/workspace` | Workspace tabs: General, Members, Skills, MCP, Machines, Activity |
| `#/account` | Account profile |
| `#/account/sound` | Pixel Area 51 sound settings |
| `#/account/mcp` | Entity MCP server status, token and tools |

The rail keeps Overview, Entities and Artifacts in the main list, then folds
the chat history underneath them: one animated mark, title, state and menu per
thread. There is no separate Chat page column and no Chat nav item. Skills, MCP,
Machines and Activity live as individual tabs on `#/workspace`, so the everyday
surface stays small. Click the entity logo to fold or unfold the rail (`⌘B`
still works), drag the rail's right edge to resize it (double-click resets), and
the light/dark switch sits beside the topbar search (`⌘⇧L` in
the desktop app, `⌥⇧L` in a browser). New thread is a yellow topbar action;
`⌘N` in the desktop app and `⌥⇧N` in a browser.

Workspace settings are a page (`#/workspace`), not a modal: General, Members,
Skills, MCP, Machines and Activity are tabs for the record, roster, working
sections and journal. Managing
workspaces is its own page (`#/workspaces`): add, export/import one JSON bundle,
choose settings, or delete. MCP has its own page (`#/mcp`) for the servers the
workspace consumes, while `#/account/mcp` is the opposite direction: the loopback
MCP server an agent connects to. Account is three deep-linkable routes:
`#/account` for the profile, `#/account/sound` for SFX and `#/account/mcp` for
the server. Workspace artifacts have their own page (`#/artifacts`);
entities, skills and machines keep theirs.

One account belongs to a hub, and the first workspace creator owns it. The
renderer no longer keeps credentials: `~/.entity/auth.json` holds the public
identity, a scrypt password verifier and a password encrypted with Electron
`safeStorage` (or a local AES-256 key when the browser dev server cannot reach
the keychain). The login placeholder is deliberately generic; it never reveals
the saved email. The old localStorage credential is imported once into
`auth.json` and removed. Each workspace writes its binding in
`~/.entity/workspaces/<id>/members.json`, with the owner always a member.

With no account and no workspace yet, sign-in bootstraps that email as the
owner; the documented default password is `123456`. Once an account is
registered — or a workspace exists and records its owner — the bootstrap path
is closed. Profile images come from Gravatar, with an identicon fallback. The
sign-in screen is a light-mode Area 51 pixel scene — stepped mesas, a hovering
saucer, a slow searchlight and rising dust — while keeping the same warm yellow
accent as the mark.

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

The verbs an agent can call live in `platform-core.cjs` and are reachable from
the window through `platform.verbs` / `platform.call`, so a UI for them would not
need a second implementation. `cli.cjs` wraps the same table for a process.

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

## Child processes

A harness is not one process. `claude`, `pi` and the rest start MCP servers,
shells, and sometimes a headless browser. `child.kill()` reaches only the leader,
so helpers survived their parent, escaped to PPID 1 and kept spending CPU after
the window was gone.

`electron/child-registry.cjs` is now the only `spawn` in the app for work that
outlives a request:

- the child is a **process-group leader** on POSIX (`detached`), and a stop
  signals the group (`-pid`), so harness, MCP servers and browser die together.
  Windows has no group signal, so `taskkill /T` walks the tree;
- every live child is written to a **pid journal** in the temp directory
  (`entity-children-<uid>-<pid>.json`). A hard kill runs no handler, so the next
  boot reaps what the last one left — after proving the pid is still the process
  we started (still a group leader, command line still matches), or, when the
  leader is gone, that the surviving group is ours by uid and start time;
- shutdown is **SIGTERM, then SIGKILL after 3 s on the whole group**, and the
  quit waits for it. Electron's `before-quit`, the Vite dev server's `close`,
  `scripts/dev-desktop.mjs` and a `process.on('exit')` backstop all route through
  the same stop, so however the app ends, nothing is left running.

A dev-server reload (`electron/*.cjs` edit) stops the old call table's children
too: new module instances have no handle on them, and a harness leaked per edit
is the same bug as a harness leaked per quit.

## Security notes

- Renderer runs **sandboxed** with context isolation, and a CSP is declared in
  `index.html` (it allows the HMR websocket in dev and nothing extra in prod).
  The mark sets CSS custom properties inline, which `style-src 'unsafe-inline'`
  covers; the font is served from the app, not a CDN.
- Prompts go to the harness on stdin, never through a shell (`shell: false`).
  `harness` is one of five known ids; `dir` must exist and is resolved in main;
  entity and workspace names are `[a-z0-9-]+`, so no path escapes.
- A run can write its own files, so the CLI is a trust boundary too: every verb
  re-checks containment on the **resolved** path, `set-instructions` refuses a
  write that raced an outside edit, and every mutation is logged to
  `audit.jsonl`. It cannot reach another workspace, the ssh config, or a key.
- MCP `env` entries are variable **names**; values resolve from the environment
  at run time and are never written into `mcp.json`. Tool discovery returns only
  tool names, descriptions and schemas; it never returns env values.
- Chat transcripts contain model thinking and tool output. They live only in the
  workspace's own thread JSON and are never sent anywhere by the hub.
- External links open in the OS browser; in-app navigation away from the app
  origin is blocked.
- Dev only: DevTools open detached when `ELECTRON_RENDERER_URL` is set.

## Relative asset paths

`vite.config.js` sets `base: './'`. Without it the built `index.html` requests
`/assets/…`, which resolves to the filesystem root under `file://` and the
packaged app renders a blank window.

## Ceilings (stated, not hidden)

- A run dies with the app; there is no daemon.
- Skills are not sandboxed per workspace at execution time: a harness loads its
  own user-level library. `skills:` is a declaration; the `/workspace:<name>` and
  `/<harness>:<name>` references are what actually point a harness at a skill.
  A skill reference is resolved on the thread's machine, and only this machine's
  libraries can be read — remote skill discovery is not implemented, so a remote
  thread offers none rather than a local path the far side cannot see.
  MCP is enforced for claude only (see above).
- Remote placement and ssh deploy are not implemented; a directory in Finder is
  still the honest interface for a workspace that needs to be moved by hand.
- The in-run tool is still the CLI. Account → MCP additionally exposes a
  loopback Streamable HTTP MCP server (`127.0.0.1`, bearer token, writes opt-in)
  for clients outside a run. Both transports read the same workspace modules;
  the MCP server is off until enabled.
- `audit.jsonl` is written and readable (`entity audit`) but has no window yet.
- Export carries entities, chats, artifacts, copied skills and the MCP pool.
  Copied private keys, generated ssh config and run logs are deliberately left out.
- A workspace's `machines/CONFIG` holds absolute `IdentityFile` paths, so moving
  or renaming the directory by hand breaks the key reference. Attach a host again
  after such a move.

## Not included (add when you need them)

State management (`pinia`), TypeScript, tests, auto-update.
