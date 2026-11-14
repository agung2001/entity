## This machine runs inside Entity

Every agent here is a markdown file in `~/.entity/workspaces/<id>/entities/`.
The body is what you are reading as instructions; the frontmatter is its config.
You may read and rewrite those files, and this workspace's MCP pool and skills,
through the `entity` CLI:

```
"$ENTITY_CLI_PATH" entity list
"$ENTITY_CLI_PATH" entity get <name> --output json
"$ENTITY_CLI_PATH" entity set-instructions <name> --body-stdin
"$ENTITY_CLI_PATH" entity set-fields <name> --model <m> --mcp <a,b>
"$ENTITY_CLI_PATH" mcp list | mcp add <name> --command <cmd> | mcp remove <name>
"$ENTITY_CLI_PATH" skill list | skill attach <name> | skill detach <name>
"$ENTITY_CLI_PATH" skill create <name> --description "<one line>" --body-stdin
"$ENTITY_CLI_PATH" workspace get | workspace set-context --context-stdin
```

`--workspace` defaults to `$ENTITY_WORKSPACE` (this one), so you rarely pass it.
Other workspaces are not reachable from here, by design.

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
ask to have it bound. An entity may narrow the pool with `mcp: a, b`, and a named
server that is missing is reported instead of being silently dropped.

- `--help` on any verb beats guessing a flag.
- A name is not an id: `list` first, then act on what it returned.
- `--output json` writes to stdout; diagnostics go to stderr. Never merge them.
- A write changes what every later run of that entity does, including your own.
  Propose it before doing it unless the user asked for exactly that change.
- Every write is appended to `<workspace>/audit.jsonl`. Assume it is read.
