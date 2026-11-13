# Entity

Desktop app built with **Vue 3 + Vite** (renderer) and **Electron** (shell).

The renderer is the entity hub: entities (agent instruction files), the skills a
workspace has attached, the machines it may use, and the runs those entities
produce. A **workspace is a directory** — `~/.entity/workspaces/<id>/` — so
switching workspaces changes the entities, skills, machines and run history at
once, and everything survives quitting the app.

Entities run **on this machine**: a real harness process (`claude`, `codex`,
`pi`, `opencode`, `gemini`), a real working directory, a real exit code. The app
can also run as a shared server and keep a workspace **two-way synced** with it
(see "Deploy the server" and "Remote workspaces"); remote *agent execution* over
ssh is still deliberately not implemented.

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

## Deploy the server (Docker)

The same app can run as a shared server. It serves the built renderer and the
call table behind a login, so a teammate can open the workspaces their account
is a member of.

```bash
cp .env.example .env        # set ENTITY_ADMIN_EMAIL + a long ENTITY_ADMIN_PASSWORD
docker compose up -d --build
docker compose logs -f entity
```

The admin account is created only while the account store is empty, so changing
the password later is not overwritten by a compose restart. Server accounts are
separate from the desktop's `~/.entity/auth.json`. Add teammates from the
container (the password is read from the environment, never argv):

```bash
docker compose exec -e ENTITY_NEW_PASSWORD='a long password' entity \
  node server/users.cjs add teammate@example.com "Teammate"
docker compose exec entity node server/users.cjs list
```

Then open the server URL, sign in, create a workspace, and add the teammate's
email under Workspace settings → Members. The teammate connects from their own
machine as described below.

`docker-compose.yml` publishes **port 1020** and nothing else. Point the
existing nginx at it (for example `proxy_pass http://127.0.0.1:1020;`) for
`https://entity.example.com`. nginx must forward `Host` and set
`X-Forwarded-Proto: https`, and should disable buffering for
`/__entity/events` so run output streams. Keep `ENTITY_SECURE_COOKIE=true`;
for a direct plain-`http://` smoke test set it to `false`, or the browser will
not send the session cookie back.

The TeamCity build calls the repository's own `scripts/deploy.sh` from the
server checkout (`pull`, `build`, `test`, `up`); there is no host-local deploy
script to maintain. `pull` resets the checkout to `origin/main` and deliberately
keeps `.env`.

The data directory is the named volume `entity-data` mounted at `/data`
(`ENTITY_HOME`). A bind mount works too, but the directory must be writable by
uid `10001` (`sudo chown -R 10001:10001 ./data`). The image runs as an
unprivileged user (uid 10001), with a
read-only root filesystem, a tmpfs `/tmp`, `cap_drop: ALL` and
`no-new-privileges`. The server only needs Node built-ins; there is no
`npm install` at runtime.

```bash
npm run serve             # local server against the current dist/
npm run start:server      # build, then serve
npm run docker:up         # compose up -d --build
```

## Remote workspaces (two-way sync)

On the workspace picker, **Connect remote** asks for the server URL, your email
and password, finds the workspaces that account may open, and clones the one you
pick into a local workspace of the same name (kind `remote`).

- **What syncs.** `entities/**`, `artifacts/**`, the attached skill names and
  harnesses, the enabled MCP pool, and the shared workspace metadata (label,
  context, `mcpStrict`, owner and member roster).
- **What does not.** Skill bodies (each machine re-links its own harness
  library), MCP secrets (`env`/`header` values become `***`), copied SSH keys,
  generated `machines/CONFIG`, chats and run logs.
- **Incremental.** Both ends hash the same content-addressed manifest. The local
  side keeps the manifest from the last successful pass and does a three-way
  diff (base / local / remote), so only changed paths move.
- **When.** A pass every six hours (`ENTITY_SYNC_INTERVAL_MS` for the client
  process), a debounced push ~2.5 s after the workspace watcher sees a local
  edit, and **Sync now** in the remote panel.
- **Conflicts.** If both sides changed one file, the remote version keeps the
  path and the local bytes are written to
  `artifacts/conflicts/<path>.<timestamp>.local.<ext>`, then pushed. Nothing is
  silently discarded.
- **Deletes** move the file to `.remote-trash/<timestamp>/` on the deleting
  side instead of unlinking it. Writes are conditional (`x-entity-base`), so a
  concurrent edit answers `409` and is resolved on the next pass rather than
  clobbered.
- **MCP is quarantined, not trusted.** A server that is new to this machine
  lands in `mcp.json`'s `disabled[]` until a person enables it; a remote
  `command` is code.
- **The guard runs first.** Every pulled text blob is scanned for prompt
  injection, credential export, shell pipes, invisible unicode and injected
  markup. A high-severity finding aborts the pass *before any write*, marks the
  connection `blocked`, and shows the excerpt. Approving binds to the exact
  sha256; editing the file arms the guard again.
- **Second opinion: your own local harness.** The connect dialog (and the
  remote panel afterwards) can enable an agent reviewer and choose which
  installed CLI — `claude`, `codex`, `pi`, `opencode`, `gemini` — and which
  model reviews the pulled bytes. It runs one-shot in a scratch directory with
  a strict JSON brief. If the configured evaluator cannot run, the sync stops
  with an error rather than pretending it was checked. The deterministic scan
  always runs first. (`ENTITY_GUARD_AI_URL` + `ENTITY_GUARD_AI_MODEL` +
  `ENTITY_GUARD_AI_KEY` remain available as an HTTP-model alternative when no
  local harness is selected.)

Connection state lives in `<ws>/.remote.json`; the bearer token in
`<ws>/.remote.token` (mode 0600). The password is not stored.

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
  chats/<threadId>.json            one conversation per file, private to its account
  artifacts/<path>                 documents, screenshots and other deliverables
  runs/<runId>.jsonl               append-only run log
  audit.jsonl                      one line per agent-initiated write
  .bin/entity                      launcher for the CLI, regenerated per run
  .remote.json                     connection + the base manifest after a sync
  .remote.token                    bearer token for the server, mode 0600
  .remote-trash/<stamp>/<path>     files a remote delete removed locally
~/.entity/server-users.json        server build: multi-user scrypt verifiers (0600)
~/.entity/server-secret            server build: HMAC session key (0600)
~/.entity/trash/<ws>/<stamp>/      files a remote delete removed on the server
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
preselected). The same form is reachable from the workspace picker.

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

`env` on an MCP server is either a list of variable **names** or a name → value
map copied from a harness config; the pool may therefore hold a credential, and
it is written 0600. No verb returns a value — `mcp list` reports
`envKeys`/`headerKeys` only. Account → MCP is the other direction: a loopback HTTP
MCP endpoint with a bearer token, exposing `list_workspaces`, `get_workspace`,
`list_entities`, `get_entity`, `create_entity`, `list_chats`, `read_chat` and
`list_artifacts`. Reads work by default; `create_entity` needs **Allow writes**.

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

### Mentions are resolved before the agent sees them

`@` names something concrete, and the app resolves it when you press send — the
message itself is never rewritten, and no work happens while you type.

| mention | becomes |
| --- | --- |
| `@py-agent fix the build` | that entity **runs** the job first; its answer is injected into this turn |
| `@orca:One:src/app.ts` | an absolute path inside an Orca project (`orca repo list`), root when the file is omitted |
| `@artifact:login shot` | a file on this workspace's artifact shelf, as `artifact://…` plus its path |
| `@maka:one:plan` | notes found through the Maka MCP server (vault, then query) |
| `@youtrack:AC:login bug` | issues found through the YouTrack MCP server, scoped to `project: AC` |

While a mention is being typed on one word (`@youtrack:AC:log`, `@maka:`, `@orca:One:`)
the composer lists what matches, ten at a time, and picking one inserts it. A
**Show 10 more** row asks the source for the next page (`search_issues` reports
`hasNextPage`; the rest are paged by offset) and the same button reveals more of
a skill library. A space ends that live search and the rest of the sentence
becomes the query. The search is debounced, cached for 30 s per page, and a slow
answer for a stale prefix is dropped rather than painted.

A mention owns the text after it, up to the next `@` — which is how a query can
contain spaces without quotes. The resolution is prepended to the prompt as a
`Resolved mentions` block, so the harness sees both the token and the thing it
refers to, and each answer's fold lists what was resolved.

Two failure modes, deliberately different: a **name** that does not exist (an
entity, an Orca project) stops the message before it is sent, while a **search**
with no hits only adds a note. Entity mentions are one level deep (a mentioned
entity's own `@` is left as text), at most two per message, and bounded at two
minutes each.

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
`#/<workspace>/chat` without a query adopts the newest thread and replaces the
URL, so the address is always shareable. A thread records the account that
created it; `list`, `read`, `rename`, `send`, `cancel` and `remove` only see
that account's threads, so another account in the same workspace cannot read
them even with the thread id. A right-edge outline draws one tick per message,
follows the reading position, and opens a jump card on hover or focus.

### Artifacts in chat

The harness is told that workspace artifacts live in `<ws>/artifacts`, that a
screenshot belongs there rather than `/tmp`, and that a saved file should be
referenced as `artifact://<relative-path>`. The chat renders that reference as an
image or a download card, and also attaches any file written to the artifact
shelf during the turn even when the answer never names it. A failed turn keeps
the files it managed to save, and older threads without artifact metadata are
matched to their request windows when they are read. An absolute `/artifacts/…`
path resolves through the same read RPC. The rail's artifact panel is the shelf
for browsing, uploading, searching, filtering and removing those files; opening
a row goes to the artifact's own detail page.

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
  remote-manifest.cjs content-addressed workspace manifest + path scoping
  remote-guard.cjs    pre-write scan: prompt injection, credential export, payloads
  harness-review.cjs  optional second opinion: one-shot local CLI over pulled files
  remote-sync.cjs     three-way incremental sync, 6h poll, conflict copies, quarantine
  workspace-watch.cjs fs.watch over workspaces → "a file changed, re-read it"
  cli.cjs             the `entity` CLI; a transport over platform-core, no fs
  frontmatter.cjs     the flat frontmatter parser shared by entities and skills
  seed.cjs            the optional sample entities + their descriptions/defaults
  local-data.cjs      ~/.ssh/config parser, ssh probes, harness skill scanner
scripts/
  dev-desktop.mjs     runs Vite programmatically, then launches Electron
server/
  index.cjs           HTTP server: static renderer, auth, call table, sync API
  auth.cjs            multi-user scrypt accounts + HMAC sessions
  sync.cjs            manifest/blob routes, membership, conditional writes
  static.cjs          dist serving + history fallback
  users.cjs           terminal account admin (add / list / password / remove)
Dockerfile            renderer build stage + non-root runtime
docker-compose.yml    volume, read-only rootfs, healthcheck, port 1020
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
    ChatView.vue      thread transcript, row action menu, composer and minimap
    EntityDetailView.vue  entity page: editable harness/model, harness paths, Markdown instructions
    SkillsView.vue    the workspace's skill catalog (default tab) + the harness libraries tab
    McpView.vue       workspace MCP pool + global harness MCP config (a row opens one server)
    McpServerView.vue  one MCP server: tools, definition, env, entities that narrow to it
    AccountView.vue   profile + password, sound, and the Entity MCP server connection
    ArtifactDetailView.vue  one artifact: inline preview, metadata, download/reveal/delete
    SkillDetailView.vue  overview / SKILL.md / files, read from the link target
    MachinesView.vue  workspace attachments + fleet tabs from ~/.ssh/config
    MachineDetailView.vue  one host: connection, key copy, probe, attachment
    ActivityView.vue  thread journal + one tab per harness session store (cached counts)
    ManageWorkspacesView.vue  the post-login room picker: search, sort, new/import/export/delete,
                              connect remote, per-workspace remote status
  components/
    EntityMark.vue    the animated voxel character
    HarnessIcon.vue   brand marks for the skill filter pills
    MachineIcon.vue   the server glyph on machine cards
    SkillIcon.vue     the medal glyph on skill cards
    MarkPicker.vue    shape + mood + colour, opened on the entity page
    AppRail.vue       two-tier shell: icon strip + contextual second panel
    RailContext.vue   the second tier's list for the current section
    EntityRailPanel.vue   entity search, state filters, add and row actions
    ArtifactRailPanel.vue artifact search, type/sort filters and upload
    EntityCreateDialog.vue the one entity creation form
    AppTopbar.vue     breadcrumbs + view tools
    MessageList / MessageBody / SlashComposer
    ThreadMinimap.vue  right-edge message outline and jump card
    ModelInput.vue     free-text model field with detected suggestions
    McpAccountPanel.vue  Entity's MCP server status, token, agent config and tools
    MarkdownEditor.vue Write/Review Markdown editor with a sanitized preview
    HarnessPaths.vue   machine-wide executable overrides for the five harnesses
    PickMenu.vue      the quiet text trigger used for filter axes
    WorkspaceWizard.vue    the create form (setup page and modal)
    WorkspaceStats.vue     the overview's entity / conversation / skill / machine cards
    NewThreadDialog.vue    searchable entity/harness picks, detected models before a thread starts
    TranscriptDialog / TraceTimeline  one execution's command, timing, thinking, tools
    CommandPalette.vue    categorized search: workspaces, chat, entities, skills, machines, activity
    RemoteConnectDialog.vue  server URL + credentials → workspace picker → connect & pull
    RemoteSyncPanel.vue      last pass, conflicts, guard findings, approve, disconnect
    ToastHost.vue
  composables/
    entityMark.js     30 pixel silhouettes, renderer, colour wheel + one shared rAF loop
    useDesktop.js     wrapper over the preload bridge
    localBridge.js    `call()` and `onRunEvent()`: IPC in Electron, HTTP+SSE in a browser
                      (one event stream shared by every subscribing store)
  stores/
    hub.js            session, the active workspace's view model and chat state
    workspaces.js     list/open/create, machines, skills, mcp; scope loading
    artifacts.js      artifact metadata, upload, save, read, remove
    harnesses.js      installed harness paths and detected models
    entities.js       entity files mapped onto the table rows
    runs.js           run summaries, live output, stale-event guard
    fleet.js          ssh hosts from ~/.ssh/config + per-host probe state
    remote.js         connection badges, manual sync, approval, streamed sync events
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
| `#/workspaces` | Workspace picker; the post-login landing page |
| `#/` | Redirects to `#/workspaces` |
| `#/:workspace/overview` | Workspace Overview |
| `#/:workspace/chat` | Chat |
| `#/:workspace/entities/:name` | Entity detail (identity, skills, source file) |
| `#/:workspace/skills` | Workspace skills |
| `#/:workspace/skills/:name` | Skill detail |
| `#/:workspace/mcp` | Workspace MCP pool + global harness MCP configs |
| `#/:workspace/mcp/:name` | One MCP server: tools, definition, environment, entities |
| `#/:workspace/artifacts/:id` | Artifact detail: inline preview, metadata, download, reveal, delete |
| `#/:workspace/machines` | Machines |
| `#/:workspace/machines/:id` | Machine detail (connection, key copy, probe) |
| `#/:workspace/settings` | Workspace settings; tabs live in the rail's second tier |
| `#/account` | Account profile |
| `#/account/sound` | Pixel Area 51 sound settings |
| `#/account/mcp` | Entity MCP server status, token and tools |

The rail has two tiers. The first is a 64px icon strip: the brand, Overview,
Entities, Artifacts, Chat and Configurations, with the theme switch and account
at the bottom. Each icon has an immediate tooltip. The brand opens
`#/workspaces`, the room picker shown after sign-in; picking a workspace opens
its Overview at `#/<workspace>/overview` and brings the workspace navigation
back. Every workspace route names its workspace in the URL, and the guard opens
that workspace before rendering the page. Overview
is a dedicated page with no second tier. The second tier belongs to the section
in the URL — entity files under Entities, the shelf under Artifacts, the
WORKING/DONE chat history under Chat, and the workspace settings tabs under
Configurations. Clicking the active section icon again folds or unfolds the
second tier (`⌘B` also works), drag its right edge to resize it (double-click
resets), and the light/dark switch sits at the bottom of the icon strip
(`⌘⇧L` in the desktop app, `⌥⇧L` in a browser). Entity and artifact rows open
their detail pages directly; the lists, search, filters, upload and add actions
live in the rail. The chat history has a text search and a time filter instead
of Today/Yesterday headings. New thread is the + in the Chat rail; `⌘N` in the
desktop app and `⌥⇧N` in a browser.

Workspace settings are a page (`#/<workspace>/settings`) with no second tab strip: the
rail's second tier carries General, Members, Skills, MCP, Machines and Activity,
and the page shows only the selected tab. The `#/workspaces` picker carries the
workspace cards plus new/import and per-row export/delete actions. MCP has its
own page (`#/mcp`) for the servers the workspace consumes, while
`#/account/mcp` is the opposite direction: the loopback
MCP server an agent connects to. Account is three deep-linkable routes:
`#/account` for the profile, `#/account/sound` for SFX and `#/account/mcp` for
the server. Artifacts have their own detail pages (`#/<workspace>/artifacts/:id`);
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

The guard runs in order: **session → workspace → route**. After sign-in, a hub
with workspaces lands on `/workspaces` to pick a room; workspace routes carry
the workspace id, so a direct link opens that workspace before the page renders.
If
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

### Shared MCP servers

The workspace has one MCP pool (`<ws>/mcp.json`) and **every entity gets it**. Add a
server once — on the MCP page, or by attaching one a harness on this machine
already has configured — and any thread can use it. There is no per-entity step.

An entity may narrow the pool in its own frontmatter, and `mcp: none` opts out
entirely:

```markdown
---
name: py-agent
harness: claude
mcp: youtrack
---
```

Every message resolves the pool from disk again, so an edit in `$EDITOR` lands on
the next turn with nothing to restart.

What the turn then spawns depends on the harness. Each mechanism below was
checked against the CLI itself; none of them writes into your own config:

| harness | how the pool reaches it | merge or replace |
| --- | --- | --- |
| `claude` | `--mcp-config <file> --strict-mcp-config` | replaces (only the pool) |
| `opencode` | `OPENCODE_CONFIG=<file>` | merges over its own |
| `codex` | `-c mcp_servers.<name>.*` overrides; a bearer token rides in `ENTITY_MCP_<NAME>_TOKEN` | merges; the token never appears in `ps` |
| `pi` | a generated `--extension` (`.mjs`) that calls `pi.registerMcpServer()` on load — the agent dir is not touched. Before pi 0.99 (or when the version cannot be read) it falls back to a temp `PI_CODING_AGENT_DIR` with `mcp.json` merged and everything else symlinked through | merges; pi's own `mcp.json` wins a same-name clash |
| `gemini` | `GEMINI_CLI_HOME=<temp>`: a temp `~/.gemini` with `settings.json` merged, the rest symlinked, plus `--skip-trust` (gemini disables user-level MCP in an untrusted folder) | merges |

The temp file or directory lives under `<ws>/runs/.mcp-*`, mode 0600, and is
removed when the process exits.

A server that is missing from the pool, or whose secret is unset, is reported on
the turn (`mcpNote`) instead of half-written, and the turn still runs.

Attaching a server from a harness config copies its definition **verbatim**,
including the header or env value that makes it work — that is the point, and it
is why `mcp.json` is written 0600. Nothing reads a value back: `entity mcp list`
reports `envKeys`/`headerKeys`, the inventory shows names, and the audit log
records the server name only. `${NAME}` in `args`/`url`/`headers` is still
expanded from the app's environment if you would rather keep a token out of the
file.

The generated config is a second copy of those values, under
`<ws>/runs/.mcp-*.json` at mode 0600: deleted when the process exits, and any
left behind by a killed turn is pruned on the next one.

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
- MCP servers may carry a credential in the pool (a header or env value copied
  from a harness config). The file is 0600, no verb returns a value, the inventory
  and audit log show names only, and tool discovery returns tool names,
  descriptions and schemas — never the credential.
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
  MCP is injected per turn for all five harnesses: claude and opencode take a
  config file, codex takes `-c` overrides, and pi and gemini run from a mirrored
  config directory that is deleted afterwards (see "Shared MCP servers").
- Remote **workspace sync** is implemented (above). Remote **agent placement**
  and ssh deploy are not: a run still executes on the machine whose window
  started it. The server image has no harness binaries, so a run started on the
  server reports the same "binary missing" error a desktop would.
- Sync is file-level, not a CRDT: two simultaneous edits of the same file keep
  both bytes via a conflict copy, but they are not merged line by line. The MCP
  pool and skill names are union-merged; removing one on one side does not
  remove it on the other.
- The remote guard is a deterministic pattern scan plus an optional model
  reviewer, not a sandbox. The local-harness evaluator is a one-shot process in
  a scratch directory, but it still inherits your user account and that CLI's
  own permissions. It catches the obvious instruction-override and
  credential-export payloads before they reach a harness; it cannot prove a
  file is benign.
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

## Security notes (server + sync)

- The server requires a session for every `/__entity/call`, every `/api/*` and
  the event stream. Sign-in is scrypt-verified, rate-limited per address, and
  the browser gets an `HttpOnly`, `SameSite=Lax` cookie; a sync client uses a
  bearer token. `Origin` is checked on the call table.
- Workspace membership is enforced on the server: `workspace.list` is filtered,
  a workspace-scoped call opens the record and checks the role, roster edits
  require owner/admin, and host-level actions (harness paths, ssh probes, the
  loopback MCP server) are administrator-only.
- Sync paths are scoped to `entities/` and `artifacts/` on both ends, resolved
  and re-checked against the workspace root. Dotfiles, `..`, absolute paths,
  symlinks and files over 25 MB are refused or skipped (and reported).
- MCP secrets never travel as secrets: the shared form carries the keys with
  `***` values, and both ends merge the redacted copy over their own values.

## Not included (add when you need them)

State management (`pinia`), TypeScript, auto-update.
