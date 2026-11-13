#!/bin/sh
# Read-only capability scan for the Fleet view.
#
# This file is piped to `ssh <alias> sh -s`; it never touches the remote
# filesystem. Output is TSV because the remote may have no Node or Python:
#
#   meta     <hostname> <os> <arch>
#   harness  <id> <label> <path>
#   model    <id> <model>
#   default  <id> <model>
#   done
#
# machine-scan.cjs parses it. Keep this POSIX sh: dash, bash and BusyBox ash
# all run it.
set -u

printf 'meta\t%s\t%s\t%s\n' \
  "$(hostname 2>/dev/null || uname -n 2>/dev/null || printf 'unknown')" \
  "$(uname -s 2>/dev/null || printf 'unknown')" \
  "$(uname -m 2>/dev/null || printf 'unknown')"

# The first "model": "..." in a JSON settings file. Harnesses that do not
# expose a model list still usually record their configured default here.
json_model() {
  [ -f "$1" ] || return 0
  sed -n 's/.*"model"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -n 1
}

scan_harness() {
  scan_id=$1
  scan_label=$2
  scan_command=$3
  scan_path=$(command -v "$scan_command" 2>/dev/null || true)
  [ -n "$scan_path" ] || return 0

  printf 'harness\t%s\t%s\t%s\n' "$scan_id" "$scan_label" "$scan_path"
  scan_default=''

  case "$scan_id" in
    pi)
      scan_default=$(json_model "${HOME:-}/.pi/agent/settings.json")
      "$scan_path" --list-models 2>/dev/null \
        | awk 'NF >= 2 && $1 !~ /^provider$/ { print $1 "/" $2 }' \
        | while IFS= read -r scan_model; do
            [ -n "$scan_model" ] && printf 'model\t%s\t%s\n' "$scan_id" "$scan_model"
          done
      ;;
    opencode)
      "$scan_path" models 2>/dev/null \
        | awk 'NF == 1 { print }' \
        | while IFS= read -r scan_model; do
            [ -n "$scan_model" ] && printf 'model\t%s\t%s\n' "$scan_id" "$scan_model"
          done
      ;;
    claude)
      scan_default=$(json_model "${HOME:-}/.claude/settings.json")
      ;;
    codex)
      if [ -f "${HOME:-}/.codex/config.toml" ]; then
        scan_default=$(awk -F= '
          /^[[:space:]]*model[[:space:]]*=/ {
            value=$2
            gsub(/"/, "", value)
            gsub(/\047/, "", value)
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
            print value
            exit
          }
        ' "${HOME:-}/.codex/config.toml" 2>/dev/null)
      fi
      ;;
    gemini)
      scan_default=$(json_model "${HOME:-}/.gemini/settings.json")
      ;;
  esac

  [ -n "$scan_default" ] && printf 'default\t%s\t%s\n' "$scan_id" "$scan_default"
}

scan_harness claude 'Claude Code' claude
scan_harness codex 'Codex CLI' codex
scan_harness gemini 'Gemini CLI' gemini
scan_harness opencode 'opencode' opencode
scan_harness pi 'pi' pi

printf 'done\n'
