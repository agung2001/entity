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
# `REPORT_ONLY=1` skips the harness/model probes and prints the report below,
# so the local machine can run this same file instead of a second script.
#
# The report is five field groups in the same pass (`machine-scan.cjs`):
#
#   ovf    <key> <value>                              overview scalars
#   disk   <mount> <fs> <size> <used> <avail> <pct>   one per `df` row
#   cron   <schedule> <user> <source> <command>       user | system | dropin
#   timer  <unit> <nextRun>
#   docker <name> <image> <state> <ports> <uptime>
#   image  <ref> <size>
#   ddisk  <type> <count> <size> <reclaimable>
#   skill  <root> <name> <described 0|1>
#   skillroot <path> <count>
#   orcaf  raw <json>                                 parsed by machine-scan.cjs
#   worktree / anomaly / term                         from the Orca JSON, never here
#   set    <group> <key> <value>                      a group scalar no record carries
#   error  <group> <reason>                           one per probe that failed
#
# One failed probe prints its `error` line and the rest of the pass still runs,
# so a dead docker socket cannot blank the four sections it does not own.
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

if [ -z "${REPORT_ONLY:-}" ]; then
  scan_harness claude 'Claude Code' claude
  scan_harness codex 'Codex CLI' codex
  scan_harness gemini 'Gemini CLI' gemini
  scan_harness opencode 'opencode' opencode
  scan_harness pi 'pi' pi
fi

# ── the report ────────────────────────────────────────────────────────────
# Every value is flattened: a tab would end the field, a newline the record,
# and the page truncates at its own column anyway.
flat() {
  tr '\t\r\n' '   ' | cut -c1-400
}

emit_ovf() {
  printf 'ovf\t%s\t%s\n' "$1" "$(printf '%s' "$2" | flat)"
}

emit_err() {
  printf 'error\t%s\t%s\n' "$1" "$(printf '%s' "$2" | flat)"
}

# Arithmetic on an empty string is an error in dash, so a value is only used
# as a number once it has been proven to be one.
is_number() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

fmt_epoch() {
  is_number "$1" || return 0
  case "$(uname -s 2>/dev/null)" in
    Darwin | FreeBSD | OpenBSD | NetBSD) date -r "$1" '+%Y-%m-%d %H:%M' 2>/dev/null ;;
    *) date -d "@$1" '+%Y-%m-%d %H:%M' 2>/dev/null ;;
  esac
}

probe_overview() {
  now=$(date +%s 2>/dev/null)
  is_number "$now" || now=''

  up=''
  boot=''
  if [ -r /proc/uptime ]; then
    up=$(cut -d' ' -f1 /proc/uptime 2>/dev/null)
    up=${up%%.*}
    is_number "$up" && is_number "$now" && boot=$((now - up))
  elif command -v sysctl >/dev/null 2>&1; then
    boot=$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/^.*{[[:space:]]*sec[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p')
  fi
  is_number "$boot" || boot=''

  uptime_sec=''
  if is_number "$boot" && is_number "$now"; then
    uptime_sec=$((now - boot))
  fi

  load1=''
  load5=''
  load15=''
  if [ -r /proc/loadavg ]; then
    set -- $(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)
    load1=${1:-}
    load5=${2:-}
    load15=${3:-}
  elif command -v sysctl >/dev/null 2>&1; then
    set -- $(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}')
    load1=${1:-}
    load5=${2:-}
    load15=${3:-}
  fi

  mem_total=''
  mem_avail=''
  swap_total=''
  swap_free=''
  if [ -r /proc/meminfo ]; then
    mem_total=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2>/dev/null)
    mem_avail=$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo 2>/dev/null)
    if [ -z "$mem_avail" ]; then
      mem_avail=$(awk '/^MemFree:/ { free = $2 } /^Buffers:/ { buffers = $2 } /^Cached:/ { cached = $2 } END { if (free != "") print free + buffers + cached }' /proc/meminfo 2>/dev/null)
    fi
    swap_total=$(awk '/^SwapTotal:/ { print $2 }' /proc/meminfo 2>/dev/null)
    swap_free=$(awk '/^SwapFree:/ { print $2 }' /proc/meminfo 2>/dev/null)
  elif command -v vm_stat >/dev/null 2>&1; then
    # A Mac has no /proc: free + inactive pages is the honest stand-in for
    # "available", and `vm.swapusage` prints human units rather than kilobytes.
    mem_total=$(sysctl -n hw.memsize 2>/dev/null)
    is_number "$mem_total" && mem_total=$((mem_total / 1024)) || mem_total=''
    mem_avail=$(vm_stat 2>/dev/null | awk '
      /page size of/ { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+$/) size = $i }
      /Pages free/ { free = $3 }
      /Pages inactive/ { inactive = $3 }
      END {
        if (size == "" || free == "") exit
        gsub(/\./, "", free)
        if (inactive != "") gsub(/\./, "", inactive)
        printf "%d", (free + inactive) * size / 1024
      }')
    swap=$(sysctl -n vm.swapusage 2>/dev/null)
    swap_total=$(printf '%s\n' "$swap" | awk '{ for (i = 1; i <= NF; i++) if ($i == "total") t = $(i + 2); if (t ~ /^[0-9.]+[MG]$/) { u = substr(t, length(t), 1); sub(/[MG]$/, "", t); printf "%d", (u == "G" ? t * 1024 * 1024 : t * 1024) } }')
    swap_free=$(printf '%s\n' "$swap" | awk '{ for (i = 1; i <= NF; i++) if ($i == "free") f = $(i + 2); if (f ~ /^[0-9.]+[MG]$/) { u = substr(f, length(f), 1); sub(/[MG]$/, "", f); printf "%d", (u == "G" ? f * 1024 * 1024 : f * 1024) } }')
  fi

  kernel=$(uname -sr 2>/dev/null)
  arch=$(uname -m 2>/dev/null)

  cpu=''
  if [ -r /proc/cpuinfo ]; then
    cpu=$(sed -n 's/^model name[[:space:]]*:[[:space:]]*//p' /proc/cpuinfo 2>/dev/null | head -n 1)
  fi
  if [ -z "$cpu" ] && command -v sysctl >/dev/null 2>&1; then
    cpu=$(sysctl -n machdep.cpu.brand_string 2>/dev/null)
  fi

  cores=''
  if command -v nproc >/dev/null 2>&1; then
    cores=$(nproc 2>/dev/null)
  elif command -v sysctl >/dev/null 2>&1; then
    cores=$(sysctl -n hw.ncpu 2>/dev/null)
  else
    cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null)
  fi

  os_name=''
  if [ -r /etc/os-release ]; then
    os_name=$(sed -n 's/^PRETTY_NAME="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /etc/os-release 2>/dev/null | head -n 1)
  fi
  if [ -z "$os_name" ] && command -v sw_vers >/dev/null 2>&1; then
    os_name="macOS $(sw_vers -productVersion 2>/dev/null)"
  fi
  [ -n "$os_name" ] || os_name=$(uname -s 2>/dev/null)

  emit_ovf uptime_sec "$uptime_sec"
  emit_ovf booted_at "$(fmt_epoch "$boot")"
  emit_ovf load1 "$load1"
  emit_ovf load5 "$load5"
  emit_ovf load15 "$load15"
  emit_ovf cores "$cores"
  emit_ovf mem_total_kb "$mem_total"
  emit_ovf mem_avail_kb "$mem_avail"
  emit_ovf swap_total_kb "$swap_total"
  emit_ovf swap_free_kb "$swap_free"
  emit_ovf kernel "$kernel"
  emit_ovf os "$os_name"
  emit_ovf cpu "$cpu"
  emit_ovf clock "$(date '+%Y-%m-%d %H:%M' 2>/dev/null)"
}

probe_disks() {
  # `-P` together with `-h` is the pair both implementations honour in this
  # order: BSD `df -hP` drops `-h` and prints 512-byte blocks, and a block
  # count is a number the page cannot read.
  df -Ph 2>/dev/null | awk '
    # `map` is an autofs alias and `devfs` a device directory: neither is
    # storage, and both sit at 100% on a Mac, which would make a device the
    # fullest disk on the page if they were counted.
    NR > 1 && NF >= 6 && $1 != "map" && $1 != "devfs" && $5 != "-" {
      mount = $6
      for (i = 7; i <= NF; i++) mount = mount " " $i
      printf "disk\t%s\t%s\t%s\t%s\t%s\t%s\n", mount, $1, $2, $3, $4, $5
    }' | cut -c1-400
}

# A crontab line is `@keyword command` or `m h dom mon dow command`; `/etc/crontab`
# and `/etc/cron.d/*` carry a user column the per-user crontab does not.
cron_parse() {
  printf '%s\n' "$1" | awk -v owner="$2" -v source="$3" -v hasuser="$4" '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/ { next }
    NF == 0 { next }
    {
      if ($1 ~ /^@/) {
        schedule = $1
        user = (hasuser == 1) ? $2 : owner
        start = (hasuser == 1) ? 3 : 2
      } else {
        schedule = $1 " " $2 " " $3 " " $4 " " $5
        user = (hasuser == 1) ? $6 : owner
        start = (hasuser == 1) ? 7 : 6
      }
      if (NF < start || user == "") next
      command = ""
      for (i = start; i <= NF; i++) command = command (i > start ? " " : "") $i
      printf "cron\t%s\t%s\t%s\t%s\n", schedule, user, source, command
    }' | cut -c1-400
}

probe_cron() {
  cron_files=0
  me=$(id -un 2>/dev/null || whoami 2>/dev/null)
  own=$(crontab -l 2>/dev/null)
  if [ -n "$own" ]; then
    cron_files=$((cron_files + 1))
    cron_parse "$own" "$me" user 0
  fi
  # Other users' crontabs need root, and this scan never asks for it: what was
  # read is what is counted.
  for file in /etc/crontab /etc/cron.d/*; do
    [ -f "$file" ] && [ -r "$file" ] || continue
    text=$(cat "$file" 2>/dev/null)
    [ -n "$text" ] || continue
    cron_files=$((cron_files + 1))
    case "$file" in
      /etc/crontab) cron_parse "$text" '' system 1 ;;
      *) cron_parse "$text" '' dropin 1 ;;
    esac
  done
  if [ "$cron_files" -gt 0 ]; then
    printf 'set\tcron\tfiles\t%s\n' "$cron_files"
  fi
}

probe_timers() {
  command -v systemctl >/dev/null 2>&1 || return 0
  systemctl list-timers --all --no-pager 2>/dev/null | awk '
    {
      unit = ""
      at = 0
      for (i = 1; i <= NF; i++) if ($i ~ /\.timer$/) { unit = $i; at = i; break }
      if (unit == "") next
      # NEXT is the first column group; beyond four words it would swallow LEFT
      n = at - 1
      if (n > 4) n = 4
      next_run = ""
      for (i = 1; i <= n; i++) next_run = next_run (i > 1 ? " " : "") $i
      printf "timer\t%s\t%s\n", unit, next_run
    }' | cut -c1-400
}

probe_docker() {
  command -v docker >/dev/null 2>&1 || return 0
  version=$(docker info --format '{{.ServerVersion}}' 2>/dev/null)
  if [ -z "$version" ]; then
    emit_err docker 'docker is installed but the daemon did not answer'
    return 0
  fi

  # Nothing is printed until all three reads have answered: a partial table
  # reads as a complete one, and "9 containers" would be a lie about 14.
  containers=$(docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Ports}}\t{{.Status}}' 2>/dev/null)
  containers_rc=$?
  images=$(docker images --format '{{.Repository}}\t{{.Tag}}\t{{.Size}}' 2>/dev/null)
  images_rc=$?
  disk_fmt=$(docker system df --format '{{.Type}}\t{{.TotalCount}}\t{{.Size}}\t{{.Reclaimable}}' 2>/dev/null)
  disk_rc=$?

  if [ "$containers_rc" -ne 0 ] || [ "$images_rc" -ne 0 ]; then
    emit_err docker "docker ps exited $containers_rc, docker images exited $images_rc"
    return 0
  fi

  printf 'set\tdocker\tversion\t%s\n' "$(printf '%s' "$version" | flat)"
  printf '%s\n' "$containers" | awk -F'\t' 'NF >= 3 { printf "docker\t%s\t%s\t%s\t%s\t%s\n", $1, $2, $3, $4, $5 }' | cut -c1-400
  printf '%s\n' "$images" | awk -F'\t' 'NF >= 3 { ref = ($2 == "<none>" || $2 == "") ? $1 : $1 ":" $2; printf "image\t%s\t%s\n", ref, $3 }' | cut -c1-400
  if [ "$disk_rc" -eq 0 ] && [ -n "$disk_fmt" ]; then
    printf '%s\n' "$disk_fmt" | awk -F'\t' 'NF >= 4 { printf "ddisk\t%s\t%s\t%s\t%s\n", $1, $2, $3, $4 }' | cut -c1-400
  else
    # A dockerd too old for --format still prints the table.
    docker system df 2>/dev/null | awk '
      NR > 1 && NF >= 4 {
        if ($1 == "Local" && $2 == "Volumes") { type = "Local Volumes"; count = $3; size = $5; reclaim = $6 }
        else if ($1 == "Build" && $2 == "Cache") { type = "Build Cache"; count = $3; size = $5; reclaim = $6 }
        else { type = $1; count = $2; size = $4; reclaim = $5 }
        sub(/\(.*/, "", reclaim)
        printf "ddisk\t%s\t%s\t%s\t%s\n", type, count, size, reclaim
      }' | cut -c1-400
  fi
}

probe_skills() {
  for root in "${HOME:-}/.pi/agent/skills" "${HOME:-}/.claude/skills" "${HOME:-}/.codex/skills" "${HOME:-}/.agents/skills" "${PWD:-.}/.pi/skills"; do
    # A root that is not on this host is not a failure: most hosts have two of
    # these five, and an `error` line per absent root would drown the real ones.
    [ -d "$root" ] || continue
    count=0
    for file in "$root"/*/SKILL.md; do
      [ -f "$file" ] || continue
      name=$(basename "$(dirname "$file")")
      described=0
      grep -q '^description:' "$file" 2>/dev/null && described=1
      printf 'skill\t%s\t%s\t%s\n' "$root" "$name" "$described"
      count=$((count + 1))
    done
    printf 'skillroot\t%s\t%s\n' "$root" "$count"
  done
}

probe_orca() {
  command -v orca >/dev/null 2>&1 || {
    emit_err orca 'orca is not in PATH'
    return 0
  }
  raw=$(orca status --json 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    emit_err orca "$(printf '%s' "$raw" | head -n 1)"
    return 0
  fi
  if [ -z "$raw" ]; then
    emit_err orca 'orca status printed nothing'
    return 0
  fi
  bytes=$(printf '%s' "$raw" | wc -c | tr -d ' ')
  if is_number "$bytes" && [ "$bytes" -gt 204800 ]; then
    emit_err orca 'the status JSON is larger than 200 KB'
    return 0
  fi
  # The JSON is parsed by machine-scan.cjs, not by a shell that would need an
  # awk JSON parser on every host.
  printf 'orcaf\traw\t%s\n' "$(printf '%s' "$raw" | tr '\t\r\n' '   ')"
}

probe_overview
probe_disks
probe_cron
probe_timers
probe_docker
probe_skills
probe_orca

printf 'done\n'
