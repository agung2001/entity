#!/usr/bin/env bash
# Stops development leftovers from this checkout and removes the disposable
# headless-Chrome profiles used for visual checks. Safe to run at any time: it
# only targets Vite from this repository and Chrome launched with an
# /tmp/entity-chrome-* profile.
set -u

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pids_for_vite() {
  ps -axo pid=,comm=,command= |
    awk -v root="$root" -v self="$$" -v parent="$PPID" '
      $2 == "node" &&
      index($0, root "/node_modules/.bin/vite") &&
      $1 != self && $1 != parent { print $1 }'
}

pids_for_headless_chrome() {
  ps -axo pid=,comm= | awk '
    {
      pid = $1
      sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "")
      if ($0 ~ /^Google Chrome/) print pid
    }'
}

kill_pids() {
  local signal="$1"
  shift
  [ "$#" -gt 0 ] || return 0
  kill "-$signal" "$@" 2>/dev/null || true
}

vite_pids="$(pids_for_vite)"
if [ -n "$vite_pids" ]; then
  echo "Stopping Vite dev server: $vite_pids"
  # shellcheck disable=SC2086
  kill_pids TERM $vite_pids
  sleep 1
  vite_pids="$(pids_for_vite)"
  # shellcheck disable=SC2086
  [ -z "$vite_pids" ] || kill_pids KILL $vite_pids
else
  echo "No Vite dev server from this checkout is running."
fi

# The visual-check browser is always launched with --headless and a
# /tmp/entity-chrome-* profile. Never touch a normal Chrome window.
chrome_pids=""
for pid in $(pids_for_headless_chrome); do
  args="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  case "$args" in
    *--headless*--user-data-dir=/tmp/entity-chrome-*) chrome_pids="$chrome_pids $pid" ;;
  esac
done
if [ -n "$chrome_pids" ]; then
  echo "Stopping headless Chrome for screenshot checks:$chrome_pids"
  # shellcheck disable=SC2086
  kill_pids TERM $chrome_pids
  sleep 1
  chrome_pids=""
  for pid in $(pids_for_headless_chrome); do
    args="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    case "$args" in
      *--headless*--user-data-dir=/tmp/entity-chrome-*) chrome_pids="$chrome_pids $pid" ;;
    esac
  done
  # shellcheck disable=SC2086
  [ -z "$chrome_pids" ] || kill_pids KILL $chrome_pids
else
  echo "No headless screenshot Chrome is running."
fi

# Chrome's crashpad helper can outlive a hard-killed headless parent. Only
# touch them when no regular Chrome is running, so the user's browser keeps its
# own handler. Headless checks should be launched with --disable-crash-reporter
# so a hard-killed browser cannot leave a new one behind.
normal_chrome=""
for pid in $(pids_for_headless_chrome); do
  args="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  case "$args" in
    *--headless*) ;;
    *) normal_chrome="$normal_chrome $pid" ;;
  esac
done
if [ -z "$normal_chrome" ]; then
  crash_pids="$(ps -axo pid=,command= | awk '
    /^[[:space:]]*[0-9]+ \/Applications\/Google Chrome\.app\/.*chrome_crashpad_handler/ { print $1 }')"
  if [ -n "$crash_pids" ]; then
    echo "Stopping orphaned Chrome crashpad handlers: $crash_pids"
    # shellcheck disable=SC2086
    kill_pids TERM $crash_pids
  fi
else
  echo "Regular Chrome is running; leaving its crashpad handler alone."
fi

rm -rf /tmp/entity-chrome-* 2>/dev/null || true
echo "Removed /tmp/entity-chrome-* profiles."
