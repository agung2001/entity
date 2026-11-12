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
"$ENTITY_CLI_PATH" workspace get | workspace set-context --context-stdin
```

`--workspace` defaults to `$ENTITY_WORKSPACE` (this one), so you rarely pass it.
Other workspaces are not reachable from here, by design.

A person points you at a skill by starting a message with `/workspace:<name>`,
`/<harness>:<name>`, or a bare `/<name>` when exactly one library on this
machine has it; the app resolves it to a path before you see the prompt. If
someone asks how to use a skill, that is the answer — `entity skill list` shows
what this workspace has attached.

- `--help` on any verb beats guessing a flag.
- A name is not an id: `list` first, then act on what it returned.
- `--output json` writes to stdout; diagnostics go to stderr. Never merge them.
- A write changes what every later run of that entity does, including your own.
  Propose it before doing it unless the user asked for exactly that change.
- Every write is appended to `<workspace>/audit.jsonl`. Assume it is read.
