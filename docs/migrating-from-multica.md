# Migrating from Multica

Entity's unit of work is a Markdown file; Multica's is a database row behind an
API. So this is not an importer — the app ships no import button, and this
document is not one either. It is a **runbook**: the reading half is a couple of
commands, and every write is a file you can read, diff and undo before the first
turn runs.

It is written from one real port of a small roster, so the gotchas below are the
ones that actually bit, not the ones that might. Names, sizes and server ids in
the examples are invented; the failure modes are not.

The same shape works for any tool that can dump an agent definition as text.
Where a step is Multica-specific — BASE/personal twins, archived copies,
runtimes, the workspace skill library — the note says so.

---

## 1. What maps to what

| Multica | Entity | Notes |
| --- | --- | --- |
| Agent | `entities/<name>.md` | frontmatter = config, body = instructions |
| Instructions + system instructions | body, after the frontmatter | one field becomes one brief |
| Runtime (e.g. `Pi (ubuntu)`) | `harness:` | `claude`, `codex`, `gemini`, `opencode`, `pi` |
| Agent model | `model:` | omit it and the harness picks its own default |
| Per-agent skills | not carried | a skill belongs to the workspace; every entity sees all of them |
| Per-agent MCP list | not carried | every entity gets the whole workspace pool |
| Workspace | workspace | a directory under `~/.entity/workspaces/` |
| Workspace skill library | `skills/<name>/SKILL.md` | copy of a harness skill, or a workspace-owned skill |
| Workspace MCP servers | `mcp.json` | the pool every entity draws from |
| Archived agent | usually skip | in practice these are `Name (Personal)` twins |
| Conversation history, run logs, autopilot schedules | **not carried** | entities start with no history and no schedule |

> **There is no per-agent list here.** Multica attached MCP servers and skills
> per agent; in Entity they belong to the workspace and **every entity gets all
> of them**. So the port is a union, not a decision: read what the bodies need,
> put each server in the workspace pool and each skill in `skills/`, and stop.
> Nothing goes in an entity file, and an agent cannot be given a server its
> siblings are denied. A `skills:`/`mcp:` line copied from the source is inert —
> the reader ignores it and the next write removes it.

---

## 2. Export the roster (read-only)

Find the CLI first. It ships inside the desktop app bundle, and a copy on `PATH`
is easier to drive:

| Where | Path |
| --- | --- |
| App bundle (macOS) | `Multica.app/Contents/Resources/app.asar.unpacked/resources/bin/multica` |
| `PATH` copy | `~/.local/bin/multica`, or wherever `command -v multica` lands |

The app-bundle binary needs the profile the desktop app wrote for itself, or it
reads an empty config and reports a workspace with no agents:

```bash
MULTICA=/path/to/Multica.app/Contents/Resources/app.asar.unpacked/resources/bin/multica

# which profile is active, and which server it points at
"$MULTICA" auth status
"$MULTICA" --profile <profile> auth status
```

Read the roster with the archived copies included — they are hidden by default,
and you want to see them in order to exclude them on purpose:

```bash
"$MULTICA" --profile <profile> agent list --include-archived --output json > agents.json
jq -r '.[] | [.name, .archived, .runtime, .id] | @tsv' agents.json
```

Then dump each agent in full. `agent get` wants the **full UUID**; short id
prefixes are rejected:

```bash
mkdir -p agents-full
jq -r '.[] | "\(.name)\t\(.id)"' agents.json | while IFS=$'\t' read -r name id; do
  "$MULTICA" --profile <profile> agent get "$id" --output json \
    > "agents-full/$(printf '%s' "$name" | tr ' ' '-' | tr -cd '[:alnum:]-_').json"
done
```

`multica daemon status` will probably say **stopped**. That only affects running
work, not reading it — leave it stopped, and nothing in this runbook needs it.

Fields worth keeping per agent: `instructions`, `systemInstructions`, `runtime`,
`model`, `description`, `conversationStarters`, `archived`. Its `skills` and `mcp`
lists are read to widen the **workspace** — nowhere in Entity is either of them
per agent.

The dumps contain whatever the source agent embedded in its own brief. Check them
before you commit them to a repository: a brief often quotes internal hostnames,
ticket keys or a colleague's name, and that is exactly the material you do not
want travelling with a doc.

Images and other binary attachments are not part of the definition; save them
separately if an agent's brief refers to one.

---

## 3. Read the target before planning anything

```bash
ENTITY="${ENTITY_CLI_PATH:-entity}"   # the workspace shim also works: <workspace>/.bin/entity

"$ENTITY" workspace get --output json
"$ENTITY" entity list --output json
"$ENTITY" mcp list --output json
"$ENTITY" skill list --output json
```

What you are looking for:

- which names already exist → those become **updates**, not creates;
- `mcp.names` and `skill` names → the gap between source and target;
- each existing entity's `harness`, `model`, `dir` — an update must not silently
  move an entity to another harness or working directory.

`dir` matters more than it looks: `problemsFor()` treats a missing `dir` as a
problem, and `~` is a legitimate value.

---

## 4. Write the change set down before touching the workspace

Produce a table like this and get it agreed. It is cheap here and very expensive
afterwards, because a half-ported workspace looks fine (`ok: true`) and behaves
wrongly.

| Target | Action | Body size | Harness | MCP | Skills |
| --- | --- | --- | --- | --- | --- |
| `dispatcher` | update | 3.1k | `pi` | notes, tracker | — |
| `builder` | create | 18.4k | `claude` | — | — |
| `archivist` | update | 2.2k | `pi` | notes, tracker | `vault-index` |

Decide up front, in writing:

1. **Exclusions.** Anything archived, plus anything that is a personal twin of a
   shared agent. In Multica the convention was a `(Name)` suffix — `Writer
   (Personal)` alongside `Writer`. Port the BASE agent, skip the twins; porting
   both gives you two entities that fight over the same work.
2. **Platform-only sections.** A Multica brief usually carries a block about
   Multica itself (workspace administration, an admin CLI wrapper, the BASE/twin
   fleet convention). That block is instructions to write to a system that will
   not exist on the other side. Delete it; if it is worth keeping as history, keep
   it as a note, not as instructions.
3. **Dead pointers.** Grep the source bodies for the old product name — see §8.
4. **Harness per entity.** Pin it; do not let it default.
5. **Marks** (§9), so a batch of new rows does not arrive as identical badges.

---

## 5. Do it in this order

```
MCP pool  →  skills  →  entities that are new  →  entities that already exist
```

Reason: an entity is validated against the pool and the skill directory at read
time (`problemsFor()` in `electron/entity-store.cjs`). Create the entity first and
it lands with `skill "x" is missing` / `mcp server "x" is not in this workspace`
on it until the prerequisites arrive — and if you are checking `ok: true` as a
gate, that is a false alarm you will spend time on. Pool and skills first means
every entity is valid the moment it exists.

The updates go last so that the entities already in use keep working while the
newcomers are staged.

---

## 6. The MCP pool

`<workspace>/mcp.json` is the pool. Shape (mode `0600`):

```json
{
  "schema": 1,
  "servers": {
    "notes":  { "url": "https://mcp.example.com/mcp", "args": [] },
    "tracker":{ "url": "http://127.0.0.1:4700/mcp", "headers": { "Authorization": "Bearer …" } },
    "browser":{ "command": "npx", "args": ["-y", "@example/browser-mcp"], "env": ["BROWSER_TOKEN"] }
  },
  "disabled": {}
}
```

An entry is either `command`(+`args`,+`env`) or `url`(+`headers`,+`env`).

**Add what the CLI can add:**

```bash
"$ENTITY" mcp add browser --command npx --args -y,@example/browser-mcp --env BROWSER_TOKEN
"$ENTITY" mcp add tracker --spec-stdin <<'JSON'
{ "url": "http://127.0.0.1:4700/mcp" }
JSON
```

> **`entity mcp add` has no header flag.** `--url`, `--command`, `--args` and
> `--env` are the whole surface. A bearer-token HTTP server therefore has to be
> written into `mcp.json` by hand — back the file up first, keep the rest of the
> object intact, and re-read it with `mcp list --output json` afterwards.

`--env` takes **variable names**, not values: the app never stores a secret for
you and never returns one. `mcp list` shows `envKeys` and `headerKeys` only —
header *values* stay redacted, so a working server and a stale token look
identical from the CLI.

**What to carry.** Every server any ported entity's body relies on — the union,
because the pool is the workspace's and there is nothing per entity to trim. A
machine-local HTTP server exists only while its host process runs; registration is
still correct, but a turn will report it unreachable until it is up. Say that out
loud in the handover instead of letting the user discover it.

`strict` (`mcpStrict` in `workspace.json`, on by default, shown in the MCP
panel's footer) is carried to remote mirrors and kept per workspace — leave it at
the default. With no per-entity list there is no `mcp:` typo to catch: a server
either is in `mcp.json` (and every entity gets it) or it is not there at all, which
the MCP page shows as a missing row.

---

## 7. Skills

Two kinds, and they are not interchangeable:

```bash
"$ENTITY" skill list --output json     # what this workspace has
"$ENTITY" skill attach <name>          # symlink an existing harness-library skill
"$ENTITY" skill create <name> --description "…" --body-stdin   # a new workspace-owned skill
```

- **`attach`** is the cheap path: the skill already lives in a harness library
  (`~/.pi/agent/skills/…` and friends), and the workspace gets a copy. Use it
  whenever the skill is not really yours.
- **`create`** writes `skills/<name>/SKILL.md` under the workspace. Use it for
  skills that only make sense for this workspace.

Two limits bite during a port:

> **The description is capped at 240 characters, mid-word.** `skill create`
> normalises the description and slices it. Write a sentence that still reads as
> a sentence at 240, or it ends as `… and the revision h`.
>
> **`skill create` takes a body, not a directory.** A source skill with
> `references/` or `scripts/` loses them — copy those files in by hand after the
> create, into `skills/<name>/`, and check they landed. A SKILL.md that tells the
> agent to read `references/cli-location.md` is broken without it.

Then check the bodies' skill references resolve: a ported brief that says "use the
tracker skill" needs that skill in `skills/`, because every entity shares the same
library and nothing points at one skill from one file.

---

## 8. The bodies

```bash
"$ENTITY" entity set-instructions builder --body-file /tmp/builder.md
```

Prefer `--body-file` over `--body` for anything long: no shell quoting to get
wrong. For an update, read first and pass the stamp back so a concurrent edit is a
`conflict` instead of a silent overwrite:

```bash
"$ENTITY" entity get dispatcher --output json > /tmp/before.json
"$ENTITY" entity set-instructions dispatcher --body-file /tmp/body.md \
  --if-unchanged "$(jq -c .data.stamp /tmp/before.json)"
```

**Strip, then retarget, then verify.**

1. Remove the platform sections (§4.2) — the admin wrappers, the fleet
   convention, "post this to a Multica issue".
2. Retarget the pointers that survive. A brief that says *"put it on a Multica
   issue"* is now a brief that tells the agent to call a CLI that does not exist
   on this machine. Point it at whatever the workspace actually uses — an issue
   tracker project, a note in the vault, an artifact in `artifacts/`. **Do not
   invent a destination**: ask which one, because a wrong destination is worse
   than a prompt that admits it has none.
3. Verify with a grep, not with a memory of what you edited:

```bash
grep -rn -i "multica" ~/.entity/workspaces/<id>/entities/ || echo "clean"
```

Do this across every ported entity, not just the ones you remember editing. The
leftovers are always in a list of three siblings where you fixed two.

One more thing to decide while you are in the body: an entity's instructions are
its **system prompt**, and the whole thing is paid for on every turn. If a source
agent's brief is large because it embeds a checkout's conventions, that is still
cheaper than re-deriving them — but if it embeds a *dead* system's conventions,
cut it.

---

## 9. Marks: shape, colour, mood

Every entity carries a voxel character. Three keys, and **two of them are closed
vocabularies** (`src/composables/entityMark.js`):

| Key | Accepted | Invalid value renders as |
| --- | --- | --- |
| `shape` | 30 ids: `squircle blob pebble bean egg tablet capsule cylinder hex gem crystal wedge shield dome arch cloud teardrop leaf square sparkle clover flower heart house star pentagon octagon diamond bowl tag` | falls back to `squircle` |
| `color` | `sun ember lime mint sky orchid` | falls back to `sun` |
| `mood` | **any emoji**; `none happy cool focus sleepy hype` are only shortcuts | the raw text is printed in the badge |

So `shape: hexagon` and `color: amber` do not fail — they silently become a gold
squircle, and `mood: energetic` prints the word *energetic* in an 18px pill. Both
mistakes look like "the app ignored me".

**Pick for legibility, not for poetry.** The mood is a badge pinned to the
character's corner: `.mark .mood` is an 18×18 pill, `font-size: 12px`, on the
panel background. Detail dies there:

- thin-line, monochrome, or pale-on-pale glyphs (a compass 🧭, a ruler 📐)
  collapse into a grey smudge at 12px — the badge reads as empty or broken;
- saturated, high-contrast glyphs (a robot 🤖, a megaphone 📣, a chart 📈)
  survive.

Verify a contested mark by rendering it, not by squinting at the file. Six
colours across more than six entities means pairs will share a colour; shape and
glyph keep them apart, which is fine, but do not let two *neighbours in a list*
share both.

> **There is no verb that sets a mark on an existing entity.** `--shape/--color/
> --mood` exist only on `entity create`; `entity set-fields` covers
> `harness/model/dir` and nothing else. Changing a mark afterwards is an in-place edit
> of three frontmatter lines — see §12 for what that costs you in the audit log.

> **A mark picked in the UI beats the file.** The picker saves
> `entity.mark:<workspace>:<entity>` in the renderer's localStorage, and
> `markFor()` prefers that record over the frontmatter. On a fresh machine the
> file wins; on the machine where somebody used the picker, the file is ignored.

---

## 10. Harness and model

Map the source runtime to a harness the machine actually has, then let `model:`
decide quality and cost:

- omit `model:` → the harness default, which is what most agents want;
- pin `model:` when the source agent pins one, or when you are deliberately
  choosing a tier;
- changing harness on an **existing** entity is a different agent, not a port.
  If the source runtime has no faithful equivalent, keep the harness the entity
  already had and say why.

The harness ids are exactly the `META` list in `electron/harness-store.cjs`:
`claude`, `codex`, `gemini`, `opencode`, `pi`, `antigravity` (`agy`) and `hermes`;
anything else is an *unknown harness* problem. What is installed is not the same
question, and the answer is the scanned inventory, not a `which`:

```bash
jq -r '.hosts | to_entries[] | .key as $h | .value.harnesses[] | "\($h)\t\(.id)\t\(.default)"' \
  ~/.entity/workspaces/<id>/machine-facts.json
```

That file is written by an explicit scan (the app's *check this machine* step, or
an ssh test in the fleet panel), so it may be absent or stale. A stale entry is
not a promise — a harness that is listed but not on this machine fails at run
time, not at validation time.

---

## 11. Validate

`entity get` is the gate. Read `ok` and `problems`, every entity:

```bash
"$ENTITY" entity list --output json | jq -r '.data[] | "\(.name)\t\(.ok)\t\(.problems|join("; "))"'
```

`problemsFor()` reports exactly six things:

| Problem | Cause |
| --- | --- |
| `harness "x" is unknown` | not one of the supported harnesses |
| `dir is not set` | no `dir:` in the frontmatter |
| `dir … does not exist` | the path is not a directory on this machine |
| `harness "x" is unknown` | a harness this build does not run |
| `dir ~/x does not exist` | the working directory is not on this machine |
| `name "x" does not match the file name` | frontmatter/name drift |

`ok: true` is necessary, not sufficient. It cannot tell you that the body still
says "Multica", that the pool is missing a server a body relies on, or that the
mark is a grey smudge — all three of which happened in the port this document is
drawn from. Grep the bodies, check every server and skill they name exists in the
workspace, and eyeball the roster in the app.

---

## 12. What the audit log will and will not contain

Every CLI write lands in `<workspace>/audit.jsonl` — creates, `set-instructions`,
`set-fields`, `mcp add/remove`, `skill create/attach`. `entity audit --limit n`
reads it back.

Two gaps worth knowing before you claim a port is "recorded":

1. **In-place frontmatter edits are invisible.** A mark change (§9) or any fix you
   make with an editor does not appear. Do not append to `audit.jsonl` by hand to
   compensate — the log is append-only for a reason; note the change somewhere
   honest instead, or recreate the entity.
2. **Deletions and renames outside the CLI** are invisible for the same reason.

Back up before each batch. The workspace is small enough that
`cp -R ~/.entity/workspaces/<id> /tmp/backup-$(date +%s)` is the whole strategy.

---

## 13. Checklist

- [ ] CLI resolved, profile confirmed, `agent list --include-archived` exported
- [ ] every agent's full JSON dumped (full UUIDs)
- [ ] dumps scanned for internal names, hosts and keys before anything is committed
- [ ] target workspace read: entities, pool, skills, harnesses
- [ ] change set agreed in writing: N updates, M creates, exclusions listed
- [ ] MCP pool complete, including any hand-written `headers`
- [ ] skills attached or created, `references/` and `scripts/` copied in
- [ ] bodies ported with `--body-file`; platform sections stripped
- [ ] `grep -ri multica entities/` → clean, or every hit explained
- [ ] every server and skill the bodies name is in the workspace pool / `skills/` (no per-entity list)
- [ ] marks set on create; contested glyphs rendered before believing them
- [ ] `entity list` → every entity `ok: true`, `problems` empty
- [ ] every external server started, or its "not active" state handed over
- [ ] `audit.jsonl` covers the CLI writes; in-place edits noted separately

---

## 14. Worked example

One real port looked like this: sixteen Multica agents, eight excluded (one stray
duplicate plus seven `(Personal)` twins), eight ported into a workspace that
already held three entities. The rows below are representative rather than the
actual roster.

| Entity | Action | Body | Harness | MCP | Skills |
| --- | --- | ---: | --- | --- | --- |
| `dispatcher` | update | 3.1k | `pi` | notes, tracker | — |
| `builder` | create | 18.4k | `pi` | — | — |
| `architect` | create | 11.2k | `pi` | *(whole pool)* | — |
| `archivist` | update | 2.2k | `pi` | notes, tracker | `vault-index` |
| `analyst` | create | 5.0k | `codex` | tracker | — |
| `editor` | create | 4.1k | `pi` | notes | `house-style` |

What the checklist caught, in order:

1. The pool held **one** server and `strict` was on — three bearer servers had to
   be written by hand because `mcp add` has no header flag.
2. One entity's whole *Instructions* field was platform mechanics; nothing in it
   survived, so the entity became its system block alone.
3. A dozen dead pointers across five bodies ("put it on a Multica issue") →
   retargeted to the workspace's own tracker, with the tracker skill added to the
   entities whose Records section now points there.
4. The port had to decide, agent by agent, which servers to attach — the trap the
   old narrowing rule created. That decision is gone: the pool is the union, and
   every entity gets it.
5. Five entities were created with invented shape/colour ids and rendered as five
   identical gold squircles, one of them printing the word *energetic*.
6. The last mark fix was a compass emoji that was legal and still vanished at
   12px.

That is the whole reason §1's warning and §9 exist.

---

## 15. Deliberately not carried

| Left behind | Why |
| --- | --- |
| Archived agents and `(Personal)` twins | duplicates of a BASE agent; they would contend for the same work |
| Conversations, run logs, token spend | entity history starts at the first turn in this app |
| Autopilot / cron schedules, webhooks | schedules are per-machine here; re-create them deliberately, not by migration |
| Agent-level MCP *grants* | the pool belongs to the workspace; every entity gets all of it, so a per-agent grant has nothing to attach to |
| Issue tracker history | stays where it is; the briefs point at it instead of copying it |

Nothing above is lost by accident. Anything you actually need — a schedule, a
historical brief, an archive of what an agent said — should be moved on purpose,
and the runbook above is not the place for it.
