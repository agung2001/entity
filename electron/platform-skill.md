## This machine runs inside Entity

Every agent here is a markdown file in `~/.entity/workspaces/<id>/entities/`.
The body is what you are reading as instructions; the frontmatter is its config.
You may read and rewrite those files, and this workspace's MCP pool and skills,
through the `entity` CLI:

```
"$ENTITY_CLI_PATH" entity list
"$ENTITY_CLI_PATH" entity create <name> [--harness h] [--description <one line>] [--body-stdin]
"$ENTITY_CLI_PATH" entity clone <name> [--from <workspace>] [--to <workspace>] [--name <new>]
"$ENTITY_CLI_PATH" entity get <name> --output json
"$ENTITY_CLI_PATH" entity set-instructions <name> --body-stdin
"$ENTITY_CLI_PATH" entity set-fields <name> --harness <h> --model <m> --dir <d>
"$ENTITY_CLI_PATH" mcp list | mcp add <name> --command <cmd> | mcp remove <name>
"$ENTITY_CLI_PATH" skill list | skill attach <name> | skill detach <name>
"$ENTITY_CLI_PATH" skill create <name> --description "<one line>" --body-stdin
"$ENTITY_CLI_PATH" workspace get | workspace set-context --context-stdin
```

`--workspace` defaults to `$ENTITY_WORKSPACE` (this one), so you rarely pass it.
Other workspaces are read-only from here, by design. Copying an entity into one
is the exception: `entity clone <name> --to <workspace>` returns
`needs_consent` and writes nothing there until the person allows that exact
content in the window. Tell them what is waiting, then retry after they allow
it. The same command from a person's shell (including the in-app terminal)
performs the copy without asking.

If someone asks you to create a new entity, propose its name and one-line
purpose, then write it with `entity create`. Add `--body-stdin` for a custom
brief; without it the command writes the standard brief. `--harness` defaults to
the current entity's harness. Never write `entities/*.md` by hand and never
append to `audit.jsonl`: the command already writes the file and its audit row.
Do not inspect the Entity source tree to learn the format — `entity get` shows
the full frontmatter, including the mark keys.

If someone asks you to create a new workspace skill, propose the name and the
one-line description first, then write it with `skill create`. The new skill is
attached to this workspace and usable as `/workspace:<name>` immediately; do not
overwrite an existing name. Use `skill attach` only for a skill that already
exists in a harness library.

A person points you at a skill by starting a message with `/workspace:<name>`,
`/<harness>:<name>`, or a bare `/<name>` when exactly one library on this
machine has it; the app resolves it to a path before you see the prompt. If
someone asks how to use a skill, that is the answer — `entity skill list` shows
what this workspace has attached.

A message may also start with a `/…` skill reference or contain `@…` mentions
(an entity, an Orca path, an artifact, a Maka note, a YouTrack issue). Both are
resolved before you see the prompt, and the resolved values are listed above it.
Treat the `@tokens` as references to those values; do not try to resolve them
yourself.

The same works for MCP: servers in `<workspace>/mcp.json` apply to every entity in
this workspace, so a server someone added there is already yours to use — do not
ask to have it bound, and do not try to have one attached to a single entity: the
pool belongs to the workspace, and `harness`, `model`, `dir` and `prefer` are the
only fields that are per entity. `prefer:` is a bookmark, though: it reorders that
entity's `/` menu and never adds or removes a skill.

- `--help` on any verb beats guessing a flag.
- A name is not an id: `list` first, then act on what it returned.
- `--output json` writes to stdout; diagnostics go to stderr. Never merge them.
- A write changes what every later run of that entity does, including your own.
  Propose it before doing it unless the user asked for exactly that change.
- Every write is appended to `<workspace>/audit.jsonl`. Assume it is read.
