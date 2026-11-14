# Tests

Two layers, one command family:

| Layer | What it proves | Where |
| --- | --- | --- |
| **Unit** (`node:test`) | Store contracts, parsing, containment, privacy, sync, the static UI contract | `tests/unit/` |
| **E2E** (Playwright) | The chat surface a person actually uses, against the Vite dev server and a disposable profile | `tests/e2e/` |

The E2E pack is the executable half of [`reports/tests/chat.md`](../reports/tests/chat.md).
That document remains the manual acceptance reference; this directory automates
the cases that are deterministic and cheap to repeat.

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests + the UI contract (`test:unit`) |
| `npm run test:unit` | `node --test "tests/unit/**/*.test.cjs"` |
| `npm run test:smoke` | The release-blocking E2E subset in `tests/e2e/smoke/` (includes real **opencode** and **pi** turns) |
| `npm run test:regression` | The deterministic E2E coverage in `tests/e2e/full/` |
| `npm run test:e2e` | Both E2E directories |
| `npm run test:gate` | `test:unit` then `test:smoke` — the release gate |
| `npm run test:all` | `test:unit` then `test:e2e` |
| `npm run test:e2e:ui` | Playwright's UI mode for debugging |

The first E2E run starts its own Vite server on **5199** and seeds a throwaway
profile. Nothing else needs to be running. `npm run dev` is not required (and
should not be on that port).

## No credentials, by construction

- The profile lives in `.tmp/` (gitignored) and is rebuilt on each run.
- The account is synthetic (`e2e-<random>@example.test`). Its password is
  generated in memory and **never written to the state file or the repository**.
- Tests start with the session the app persists after a real sign-in. The app
  still validates that identity against `auth.json`; no auth check is bypassed.
- **No SSH host, token, MCP secret or account value is committed.** Remote tests
  read `E2E_REMOTE_HOST` from the environment and skip when it is absent.
- The real `opencode` and `pi` tests use whatever auth those CLIs already have on
  the machine. The tests never read or print it.
- `claude` is pinned to a deterministic stub in the scratch profile so the bulk
  of the pack is fast and repeatable. The real harnesses are still exercised by
  the two smoke specs.

Changing the profile location or port:

```bash
E2E_PORT=5299 E2E_REUSE_PROFILE=1 npm run test:smoke
```

`E2E_REUSE_PROFILE=1` reuses the seeded profile instead of rebuilding it; remove
`.tmp/` to force a clean slate. `E2E_REUSE=1` reuses an already-running server.

Remote cases are skipped by default. To run them against a host you have
already scanned on the Fleet page:

```bash
E2E_REMOTE_HOST=<alias-from-ssh-config> E2E_REMOTE_SCAN=1 npm run test:regression
# also installs //workspace:e2e-remote-alpha on the host, then removes that one:
E2E_REMOTE_HOST=<alias> E2E_REMOTE_SCAN=1 E2E_REMOTE_SKILL=1 npm run test:regression
```

`E2E_REMOTE_SCAN=1` runs one read-only capability scan first. The `//` case is
gated separately because it writes a uniquely named skill into the host's
harness library (the behaviour under test); `afterAll` removes that directory,
but a host that vanishes during the test can leave it behind. No host name is
stored in the repository.

YouTrack and Maka mention tests read the user's global harness MCP config at
run time. Enable them explicitly:

```bash
E2E_MCP_GLOBAL=1 npm run test:regression
```

Orca needs no flag; it skips when no Orca project is available. No credentials
or server URLs are written to the repository or its output.

## Layout

```
tests/
  unit/                     the 19 migrated electron tests + the CLI boundary test
  e2e/
    fixtures.js             session-injected browser context; readProfile()
    helpers/
      app.js                selectors: open, new thread, send, answer, toast
      cli.js                drive entity cli.cjs against the scratch profile
      profile.js            read threads, entity files, audit, prompt logs
      rpc.js                arrange state through POST /__entity/call
    smoke/                  @smoke — the release gate
      01-shell.spec.js      composer help + keyboard guide
      02-thread.spec.js     send, trace, timeline, reload, attachment
      03-skills-mentions.spec.js  /workspace: and @artifact:
      04-self-edit.spec.js  the entity rewrites its own instructions
      05-stop.spec.js       cancellation is not a failure
      06-opencode.spec.js   real OpenCode turn
      07-pi.spec.js         real pi turn
      08-external-files.spec.js  cwd + reads outside the workspace
      09-entity-mention.spec.js  @secretary reads a file; answer injected
      10-agent-creates-skill.spec.js  skill create + live / menu refresh
      11-concurrent-threads.spec.js  two turns at once + delete lock
    full/                   deterministic regression
      01-thread-lifecycle.spec.js
      02-composer-attachments.spec.js
      03-mentions-skills.spec.js
      04-errors-retry.spec.js
      05-artifacts.spec.js
      06-cli-security.spec.js
      07-remote.spec.js     opt-in: E2E_REMOTE_HOST=<alias>
      09-mentions-sources.spec.js  Orca (+ YouTrack/Maka behind E2E_MCP_GLOBAL=1)
      08-contract.spec.js
  support/
    e2e-server.mjs          reset + seed + start Vite for Playwright
    seed-profile.mjs        account, workspaces, entities, skill, fixtures
    stub-harness.sh         deterministic claude stand-in (no model)
playwright.config.js        port, timeouts, one worker, trace on failure
```

## Smoke vs regression

**Smoke** answers: *can a person talk to this build at all?* It covers the
composer, one deterministic turn, attachments, both mention/skill languages,
self-modification, cancellation, and one real turn on each of the owner's
harnesses (OpenCode and pi). It is the gate before a release.

**Regression** answers: *do the edges still behave?* Titles, pin/delete, deep
links, rail search, empty sends, duplicate/oversized attachments, mention
limits and failure modes, retries, artifacts, CLI concurrency/containment and
the UI contract. It is deterministic (stub harness, no network) and should run on
every change.

## Coverage of `reports/tests/chat.md`

Automation is intentional, not exhaustive. Cases that need a second account, an
ambiguous multi-library skill, the app quit path or visual judgement stay manual
in the UAT document. Remote and MCP cases are automated but opt-in because they
need a host or the user's existing credentials.

| UAT suite | Automated here | Left manual / environment |
| --- | --- | --- |
| A · Thread lifecycle | title, pin/delete, rail search, deep/dead links, context lock, reload, **two turns at once + delete lock** | crash relaunch |
| B · Composer | empty/whitespace, attach/remove, dedupe, 25 MB skip, attachment-only, typed path | folder drop, 1,000-file cap, drag hover |
| C · Self-edit | agent rewrites its body via the real CLI, audit row, UI refresh, stale stamp, empty body, name/path containment, cross-workspace refusal | human save race, sibling edit, config effect per pinned thread |
| D · External files | typed `@file:` from an absolute path, artifact write/read | harness `cwd`/absolute read with a real model (real harness depends on the model's tool use), missing dir, unicode |
| E · Mentions | entity sub-runs (including a secretary reading a file), two-entity cap, artifact hit/miss, email, `@@`, unknown name, unknown `@mcp:`, Orca (+ YouTrack/Maka with `E2E_MCP_GLOBAL=1`) | menu paging |
| F · Skills | `/workspace:` resolve, unknown name, bare name forwarded, **agent creates a workspace skill + live menu refresh**, remote `//` documented | ambiguity across two libraries, remote install (no host), attach/detach |
| G · MCP | missing server, `@mcp:` refusal, no secret in the transcript | positive pool materialisation, secret/`ps` checks (need a server) |
| H · Remote | opt-in and **run against a real host**: real turn, local attachment, `@@` resolved locally, `//workspace:` install + cleanup | a scanned ssh host is required; `//` also needs `E2E_REMOTE_SKILL=1` |
| I · Transcript | fold, timeline, artifacts, save response, retry, reload | long-thread minimap, legacy artifacts, copy/share clipboard |
| J · Errors | signed-out, missing binary, transient retry, stop | 15-minute idle timeout, hard-kill orphan reaping |
| K · Privacy | unit: account-scoped threads; CLI containment; help tokens | two-account server run, token/`ps` inspection |
| L · Quality | help contract, `?`-in-composer guard, lazy-load contract (unit) | screen reader pass, sound/notifications, path quoting on Windows |

## Containment

`entity ... --workspace <other>` is refused when `ENTITY_WORKSPACE` is set; the
CLI is pinned to the workspace the run was started in. The E2E and unit packs
both assert this, including that the other workspace's file is byte-identical
after the refusal.

## Adding a case

1. Put it in `full/` unless it is one of the seven release-blocking behaviours;
   then put it in `smoke/` and keep it under a minute.
2. Prefer the helpers in `e2e/helpers/` over new selectors. If you need a new
   selector, add it to `app.js` so the pack has one vocabulary.
3. Assert against the thread JSON, audit log or prompt log when the UI cannot be
   trusted to prove the contract (that is what the stub log is for).
4. Never read the developer's real `~/.entity`, `~/.ssh/config` or MCP secrets.
   Seed what you need in `seed-profile.mjs`.
5. If a case needs a host or a server, gate it on an environment variable and
   document the skip.
