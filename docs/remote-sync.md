[← README](../README.md)

# Remote workspaces (two-way sync)

The same app can run as a shared server. On the workspace picker **Connect remote**
asks for the server URL and your account, lists the workspaces you may open, and
clones the one you pick into a local workspace of the same name.

```mermaid
flowchart LR
  L["Local workspace<br/>sha256 per path"] --> D{"three-way diff"}
  B["base — last successful sync"] --> D
  R["Remote workspace<br/>sha256 per path"] --> D
  D -->|"local changed"| P["PUT blob<br/>x-entity-base"]
  D -->|"remote changed"| G["GET blob → guard → write"]
  D -->|"both changed"| C["remote keeps the path<br/>local bytes → artifacts/conflicts/"]
  D -->|"one side deleted"| T["the other side → .remote-trash/"]
```

A pass with nothing to do is one manifest request and one walk of the workspace on each
end — milliseconds, not a re-upload.

## What travels

| syncs | does not |
| --- | --- |
| `entities/**`, `artifacts/**` | chats and run logs |
| the artifact scope index (`artifacts/.scope.json`) | personal shelves under `.personal/` |
| attached skill **bodies** under `skills/` | machine capability snapshots (they describe local machines) |
| the MCP set, with every secret replaced by `***` | any MCP secret |
| workspace metadata: label, context, strictness, members, the artifact-retention rule | the workspace id and path, archive dates and opened stamps |

## The rules that keep it honest

- **Conflict copies, never silent loss.** If both sides changed a file, the remote
  version keeps the path and the local bytes go to
  `artifacts/conflicts/<path>.<stamp>.local.<ext>`. Deletes move to
  `.remote-trash/<stamp>/`. Writes are conditional (`x-entity-base`), so a concurrent
  edit answers `409` and is resolved on the next pass. A conflict copy is the sync
  engine's, never a turn's: it is never attached to a message as an artifact and it is
  never staged to a remote host (it is the largest thing on a shelf that has one).
- **MCP travels ready to use, except where it cannot work.** A portable server is
  enabled on the clone with no second setup step. A definition bound to the machine that
  wrote it — a loopback URL, a command inside a home directory — is still shared but
  lands parked with the reason; enabling it by hand pins it, and the next sync leaves it
  alone. A server a teammate parked is never switched on by a sync.
- **The guard runs first.** Every pulled text blob is scanned for prompt injection,
  credential export, shell pipes, invisible unicode and injected markup. A
  high-severity finding aborts before any write, marks the connection `blocked` and
  shows the excerpt. Approving binds to the exact `sha256`.
- **Second opinion (opt-in).** The connect dialog can run one installed CLI over the
  pulled bytes with a strict JSON brief. If that evaluator cannot run, the sync stops
  with an error rather than pretending it was checked. See
  [the sync evaluator](#the-sync-evaluator).

### The sync evaluator

Configured under **Sync evaluator**: a checkbox, a harness chosen from the installed
ones, and a model (labelled *Evaluator model*, placeholder *harness default*).

- A pi model name that matches more than one provider is refused:
  `The evaluator model "<m>" matches more than one provider: a, b. Save it as
  provider/model, e.g. a/<m>.` The panel offers the providers as buttons —
  `pi reports these providers:` — and the choices survive a runtime refusal, so a
  connect that failed after saving can be fixed without retyping the model.
- A resolved provider-qualified model is stored that way, so the next pass cannot
  silently pick a different provider.
- A missing CLI is stated, not swallowed: `The sync evaluator is set to X, but its CLI
  is not installed on this machine.` The pass fails closed.
- `ENTITY_GUARD_TIMEOUT_MS` bounds the reviewer (120 s by default);
  `ENTITY_SYNC_INTERVAL_MS` moves the six-hour poll.

## What a pass shows

The panel reports the phase it is in — reading both manifests, pulling *n* of *m*,
checking, reviewing, writing, pushing, removing — with a bar, the current path and
elapsed time. The pull side polls every six hours and after launch; a local edit
schedules a pass 2.5 s later, which batches an editor's save burst into one sync.

## State on disk

Connection state lives in `<ws>/.remote.json`; the bearer token in `<ws>/.remote.token`
(`0600`). **The password is not stored at all.**

## Related

- [Security](security.md) — the guard and the trust boundaries
- [Deploy the server](deploy.md) — the other end of this diagram
- [Skills](skills.md) — why bodies are copied, never linked
- [Limits](limits.md) — file-level, not a CRDT
