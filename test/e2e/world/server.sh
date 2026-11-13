#!/usr/bin/env bash
# Starts or stops the headless test server for the end-to-end world tier (docs/design/10, tier
# "e2e world"; docs/briefs/world/test-setup.md). Works for any NeoForge server folder that has the
# installer's libraries/ (the Craftoria server pack, or a vanilla NeoForge server install).
#
#   test/e2e/world/server.sh start <server dir> [--jar <mod jar>] [--xmx 8G]
#   test/e2e/world/server.sh stop  <server dir>
#   test/e2e/world/server.sh wait  <server dir> [seconds]   # until "Done (" and the pairing file
#
# start: copies the mod jar (default mod/build/libs/autosketch-*.jar) into <server dir>/mods,
# makes sure RCON is on in server.properties (port 25575, password autosketch-e2e unless set), and
# launches the server in the background with Java 21, logging to <server dir>/logs/e2e-console.log.
# It never touches eula.txt: the user accepts the EULA for each server themselves.
set -euo pipefail

cmd=${1:-}
dir=${2:-}
[[ -n "$cmd" && -n "$dir" ]] || { sed -n '2,13p' "$0"; exit 2; }
dir=$(cd "$dir" && pwd)
repo=$(cd "$(dirname "$0")/../../.." && pwd)
java=${E2E_JAVA:-/usr/lib/jvm/java-21-openjdk-amd64/bin/java}

pidfile="$dir/logs/e2e-server.pid"
console="$dir/logs/e2e-console.log"

case "$cmd" in
start)
  shift 2
  jar=""; xmx=8G
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --jar) jar=$2; shift 2 ;;
      --xmx) xmx=$2; shift 2 ;;
      *) echo "unknown option $1" >&2; exit 2 ;;
    esac
  done
  if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "already running (pid $(cat "$pidfile"))"; exit 0
  fi
  grep -qs '^eula=true' "$dir/eula.txt" || { echo "eula.txt in $dir is not accepted; the user must accept it" >&2; exit 3; }
  if [[ -z "$jar" ]]; then jar=$(ls "$repo"/mod/build/libs/autosketch-*.jar 2>/dev/null | head -1 || true); fi
  [[ -f "$jar" ]] || { echo "mod jar not found; build it with (cd mod && ./gradlew build)" >&2; exit 2; }
  mkdir -p "$dir/mods" "$dir/logs"
  rm -f "$dir"/mods/autosketch-*.jar
  cp "$jar" "$dir/mods/"
  props="$dir/server.properties"
  touch "$props"
  setprop() { grep -q "^$1=" "$props" && sed -i "s|^$1=.*|$1=$2|" "$props" || echo "$1=$2" >> "$props"; }
  setprop enable-rcon true
  grep -q '^rcon.port=' "$props" || setprop rcon.port 25575
  grep -q '^rcon.password=.\+' "$props" || setprop rcon.password autosketch-e2e
  args=$(ls "$dir"/libraries/net/neoforged/neoforge/*/unix_args.txt | head -1)
  [[ -f "$args" ]] || { echo "no NeoForge unix_args.txt under $dir/libraries" >&2; exit 2; }
  cd "$dir"
  nohup "$java" "-Xmx$xmx" -Xms2G -XX:+UseG1GC "@${args#"$dir/"}" nogui > "$console" 2>&1 < /dev/null &
  echo $! > "$pidfile"
  echo "started pid $! (log $console)"
  ;;
stop)
  [[ -f "$pidfile" ]] || { echo "not running"; exit 0; }
  pid=$(cat "$pidfile")
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    for _ in $(seq 1 120); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid"
  fi
  rm -f "$pidfile"
  echo "stopped"
  ;;
wait)
  secs=${3:-900}
  for _ in $(seq 1 "$secs"); do
    if grep -q 'Done (' "$console" 2>/dev/null && [[ -f "$dir/config/autosketch-bridge.toml" ]]; then echo ready; exit 0; fi
    if [[ -f "$pidfile" ]] && ! kill -0 "$(cat "$pidfile")" 2>/dev/null; then echo "server exited; see $console" >&2; exit 1; fi
    sleep 1
  done
  echo "timed out" >&2; exit 1
  ;;
*) sed -n '2,13p' "$0"; exit 2 ;;
esac
