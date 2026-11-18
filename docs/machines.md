[← README](../README.md)

# Machines

<picture><source srcset="assets/readme-features/machines.webp" type="image/webp" /><img src="assets/readme-features/machines.poster.jpg" alt="A machine list with the sweep badge, and the harness and model inventory stored for one workspace" width="820" /></picture>

Two rules make the scope coherent:

1. **The workspace is data; the machine is the source.** `~/.ssh/config` is the only
   list of hosts, and it stays user-local. Nothing is attached to a workspace.
2. **No cross-workspace references.** A skill or MCP server belongs to its own
   workspace and resolves only there. The same name in two workspaces is two
   unrelated things.

## Which machine a turn runs on

```mermaid
sequenceDiagram
  participant You
  participant App as Entity (this window)
  participant Box as ssh host
  participant H as Harness there
  You->>App: send in a thread pinned to "root-ubuntu"
  App->>App: stage a temporary workspace
  App->>Box: ssh -tt + rsync/scp the payload
  Box->>H: run the installed CLI, cwd staged dir
  H-->>Box: JSONL stream
  Box-->>App: stream back over ssh
  App-->>You: live steps, then the answer
  App->>Box: pull artifacts back, delete the run directory
```

The staged payload is bounded. `entities/` and `skills/` travel whole (kilobytes), and
`artifacts/` travels **newest first up to 24 MB / 120 files**, minus the sync engine's
`conflicts/` copies — a working shelf can hold
hundreds of megabytes of renders, and staging all of it made every remote turn wait a
minute before the harness started. When files stay behind, the prompt says so, so the
model reports the absence instead of guessing; attach a specific old file to send it.
The transfer's deadline follows the payload rather than a fixed minute. Raise the
budget with `ENTITY_REMOTE_ARTIFACT_MB` when a workspace lives on a fast link.

Runs still execute on the machine whose window started them. The stored inventory is a
capability snapshot, not a placement engine or a credential — see
[Limits](../docs/limits.md).

## Test & scan

**Test & scan** probes a host, runs a read-only scanner over ssh, and stores the result
in the workspace's `machine-facts.json`: installed harnesses, their paths, the models
each CLI reports, and the configured default.

No private key and no ssh config enters the workspace, and the inventory is not a
secret. A host that disappears from `~/.ssh/config` simply stops appearing in the list.

## The machine that sweeps

Artifact retention runs on exactly one machine per workspace, because two clones
sweeping one shared shelf would race each other's moves. The Machines page shows a
`sweep` tag on the card that runs it and a **Run the sweep here** button on the others
— the local card, a pinned `machine`, or the `host` that serves the shared workspace.

- The **owner's** first signed-in machine takes it until somebody picks another.
- A sync host runs it with no desktop open, so it gets a card of its own.
- Every other clone stands down: `The artifact sweep runs on <label>; this machine
  does not sweep it.`
- The executor's **local clock** is the deadline's clock. A sync host in a container
  usually runs UTC, so its `03:00` is not your `03:00`.

The rule, the forecast and the two clocks are in
[Artifacts → the archive shelf](artifacts.md#the-archive-shelf).

## The terminal follows the thread

``Ctrl+` `` opens a shell beside the conversation. A thread pinned to another machine
opens the shell *there*, over `ssh -tt` with the alias from `~/.ssh/config` and
nothing else — no password prompt, no stored key. A local thread opens it in the
thread's base directory. The picker that routes the turn also routes the shell, so the
shell and the answer run on the same host.

- The relay is util-linux `script` on Linux and `python3` on macOS. macOS `script`
  calls `tcgetattr` on its own stdin and exits when that is not a terminal, which is
  what Electron always hands a child, so `python3` allocates the pty itself.
- Inside the shell every key belongs to the shell, including `Esc`, the interrupt and
  reverse search. The terminal shortcut is the one exception, because it has to be able
  to close the panel from inside it.
- Scrollback lives in the main process, so hiding and reopening the panel comes back to
  the same prompt. Closing the window ends the shell.

The server build does not offer a terminal: a shell is code execution on the host that
serves the page, so the shared server reports why instead of half-offering one.

## Related

- [Conversations](conversations.md) — the thread that carries the pin
- [Limits](limits.md) — remote chat is one ssh turn at a time
- [Security](security.md) — what a run may reach
