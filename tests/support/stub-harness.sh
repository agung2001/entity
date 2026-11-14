#!/bin/sh
# A deterministic stand-in for a harness CLI, used only by the E2E suite.
#
# It is installed as `claude`, `claude-fail` and `claude-flaky` in the scratch
# profile by `seed-profile.mjs`. It understands a few prompt markers so the
# suite can prove the app's plumbing without calling a model:
#
#   E2E-SLOW        emit one thinking step, then wait to be stopped
#   E2E-SELF-EDIT   read this entity with the real CLI, then rewrite it
#   E2E-ARTIFACT    write a file onto the workspace artifact shelf
#   E2E-ATTACH      answer; the prompt log proves the attachment block arrived
#   E2E-401         fail like an unauthenticated harness
#   E2E-BOOM        fail like a transient upstream error
#
# The `claude-fail` copy always fails with an auth error; `claude-flaky` fails
# once, then answers `E2E-FLAKY-RETRY-OK`.
#
# No credentials are read, written or logged. The only environment values
# recorded are the workspace/entity identifiers the app itself injects.

set -u

MODE="$(basename "$0")"
LOG="${E2E_STUB_LOG:-/tmp/entity-e2e-harness}"
mkdir -p "$LOG"
STAMP="$(date +%s)-$$"

{
  printf 'argv:'
  for arg in "$@"; do printf ' %s' "$arg"; done
  printf '\n'
  printf 'cwd: %s\n' "$(pwd)"
  printf 'entity: %s\n' "${ENTITY_ENTITY:-}"
  printf 'workspace: %s\n' "${ENTITY_WORKSPACE:-}"
  printf 'cli: %s\n' "${ENTITY_CLI_PATH:-}"
} > "$LOG/$STAMP.meta"

PROMPT="$(cat)"
printf '%s' "$PROMPT" > "$LOG/$STAMP.prompt"

# Keep a copy of the first attached file so a test can prove the bytes travelled.
ATTACH="$(printf '%s\n' "$PROMPT" | awk '/Attached files/{found=1; next} found && /^- /{sub(/^- /, ""); print; exit}')"
if [ -n "$ATTACH" ] && [ -f "$ATTACH" ]; then
  cp "$ATTACH" "$LOG/$STAMP.attachment"
fi

emit() {
  printf '{"type":"system","subtype":"init","model":"e2e-stub"}\n'
  printf '{"type":"assistant","message":{"model":"e2e-stub","content":[{"type":"thinking","thinking":"e2e thinking step"},{"type":"text","text":"%s"}]}}\n' "$1"
  printf '{"type":"result","subtype":"success","result":"%s"}\n' "$1"
}

case "$MODE" in
  *fail*)
    printf '401 unauthorized: not signed in\n' >&2
    exit 1
    ;;
  *flaky*)
    n="$(cat "$LOG/flaky-count" 2>/dev/null || echo 0)"
    printf '%s\n' "$((n + 1))" > "$LOG/flaky-count"
    if [ "$n" -lt 1 ]; then
      printf 'E2E-FLAKY: transient upstream failure\n' >&2
      exit 2
    fi
    emit "E2E-FLAKY-RETRY-OK"
    exit 0
    ;;
esac

case "$PROMPT" in
  *E2E-401*)
    printf '401 unauthorized: not signed in\n' >&2
    exit 1
    ;;
  *E2E-BOOM*)
    printf 'E2E-BOOM: transient upstream failure\n' >&2
    exit 2
    ;;
  *E2E-SLOW*)
    printf '{"type":"system","subtype":"init","model":"e2e-stub"}\n'
    printf '{"type":"assistant","message":{"model":"e2e-stub","content":[{"type":"thinking","thinking":"e2e slow step"}]}}\n'
    sleep 30
    emit "E2E-SLOW-DONE"
    exit 0
    ;;
  *E2E-SELF-EDIT*)
    if [ -z "${ENTITY_CLI_PATH:-}" ]; then
      printf 'E2E self-edit: ENTITY_CLI_PATH is not set\n' >&2
      exit 3
    fi
    "$ENTITY_CLI_PATH" entity get self-editor --output json > "$LOG/$STAMP.get.json" 2> "$LOG/$STAMP.get.err" || true
    BODY='# Self Editor

E2E-CANARY-EDIT-APPLIED

## Rules
- Edited by the E2E stub through the real entity CLI.
'
    if ! printf '%s' "$BODY" | "$ENTITY_CLI_PATH" entity set-instructions self-editor --body-stdin > "$LOG/$STAMP.set.json" 2> "$LOG/$STAMP.set.err"; then
      printf 'E2E self-edit failed\n' >&2
      cat "$LOG/$STAMP.set.err" >&2 2>/dev/null || true
      exit 4
    fi
    emit "E2E-SELF-EDIT-DONE"
    exit 0
    ;;
  *E2E-ARTIFACT*)
    if [ -z "${ENTITY_HOME:-}" ] || [ -z "${ENTITY_WORKSPACE:-}" ]; then
      printf 'E2E artifact: missing ENTITY_HOME or ENTITY_WORKSPACE\n' >&2
      exit 5
    fi
    ART="$ENTITY_HOME/workspaces/$ENTITY_WORKSPACE/artifacts"
    mkdir -p "$ART"
    printf '# E2E artifact\n\nE2E-ARTIFACT-CANARY\n' > "$ART/e2e-turn-note.md"
    emit "E2E-ARTIFACT-DONE"
    exit 0
    ;;
  *E2E-ATTACH*)
    emit "E2E-ATTACH-OK"
    exit 0
    ;;
  *E2E-READ-EXTERNAL*)
    # The harness runs with cwd = the entity's dir, outside the workspace.
    # Keep what it could read so the test can prove the bytes, not the model.
    {
      cat brief.md 2>/dev/null || true
      cat nested/deep.txt 2>/dev/null || true
      cat "with space/quarterly report.txt" 2>/dev/null || true
    } > "$LOG/$STAMP.external"
    emit "E2E-EXTERNAL-OK"
    exit 0
    ;;
  E2E-SECRETARY-READ*)
    # A mentioned entity doing real work: read a file from its own dir and put
    # the canary in the answer that the main turn receives.
    {
      cat brief.md 2>/dev/null || true
    } > "$LOG/$STAMP.secretary"
    emit "E2E-SECRETARY-OK-E2E-EXTERNAL-CANARY-42"
    exit 0
    ;;
  *E2E-CREATE-SKILL*)
    # An entity creating a new workspace skill through the first-class CLI verb.
    if [ -z "${ENTITY_CLI_PATH:-}" ]; then
      printf 'E2E create-skill: ENTITY_CLI_PATH is not set\n' >&2
      exit 6
    fi
    BODY='# Writing Skill

Use short sentences, name the reader, and end with one clear next step.

When loaded, begin your reply with E2E-WRITING-SKILL-LOADED.'
    if ! printf '%s' "$BODY" | "$ENTITY_CLI_PATH" skill create writing-skill --description "Created from a chat turn by the E2E harness" --body-stdin > "$LOG/$STAMP.skill.json" 2> "$LOG/$STAMP.skill.err"; then
      printf 'E2E create-skill failed\n' >&2
      cat "$LOG/$STAMP.skill.err" >&2 2>/dev/null || true
      exit 6
    fi
    emit "E2E-CREATE-SKILL-DONE"
    exit 0
    ;;
esac

emit "E2E-STUB-OK"
