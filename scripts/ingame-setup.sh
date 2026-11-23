#!/usr/bin/env bash
# Prepares an in-game test against the Craftoria client and opens the agent session.
# Internal dev tool: run it from the VS Code integrated terminal (WSL) at the repo root.
# Not shipped (scripts/ is outside package.json "files").
#
#   scripts/ingame-setup.sh           prep, wait for the bridge, then launch Claude Code on the channel
#   scripts/ingame-setup.sh prep      WSL networking check, build MCP + mod, install the jar into the instance
#   scripts/ingame-setup.sh wait      wait until a world is open and the mod's bridge is up
#   scripts/ingame-setup.sh launch    start Claude Code with the autosketch development channel
#
# AUTOSKETCH_INSTANCE overrides the instance folder (default: the Craftoria CurseForge instance).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTANCE="${AUTOSKETCH_INSTANCE:-/mnt/c/Users/kevin/curseforge/minecraft/Instances/Craftoria}"
JAVA21=/usr/lib/jvm/java-21-openjdk-amd64
JAR="$REPO/mod/neoforge/versions/1.21.1/build/libs/autosketch-neoforge-1.21.1-0.1.0.jar"
PAIRING="$INSTANCE/config/autosketch-bridge.toml"
WAIT_SECS="${WAIT_SECS:-900}"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

prep() {
  say "WSL networking"
  mode="$(wslinfo --networking-mode 2>/dev/null || echo unknown)"
  [[ "$mode" == mirrored ]] || fail "networking mode is '$mode', need 'mirrored' (.wslconfig: networkingMode=mirrored, then wsl --shutdown)"
  echo "mirrored"

  say "Building the MCP (dist/)"
  (cd "$REPO" && npm run build --silent)

  say "Building the mod jar"
  (cd "$REPO/mod" && JAVA_HOME="$JAVA21" ./gradlew build -x test -q)
  [[ -f "$JAR" ]] || fail "jar not found at $JAR"

  say "Installing the jar into $INSTANCE/mods"
  [[ -d "$INSTANCE/mods" ]] || fail "no mods folder at $INSTANCE/mods"
  dest="$INSTANCE/mods/$(basename "$JAR")"
  if [[ -f "$dest" ]] && cmp -s "$JAR" "$dest"; then
    echo "already up to date: $(basename "$dest")"
  else
    shopt -s nullglob
    for old in "$INSTANCE"/mods/autosketch-*.jar; do
      echo "removing $(basename "$old")"
      rm -f "$old" 2>/dev/null || fail "can't remove $(basename "$old"): Minecraft is probably running and holds the jar. Close the game and rerun."
    done
    cp "$JAR" "$dest" || fail "copy failed (is the game running?)"
    echo "installed $(basename "$dest")"
  fi
}

bridge_up() {
  [[ -f "$PAIRING" ]] || return 1
  pid="$(sed -n 's/^pid = \([0-9]*\).*/\1/p' "$PAIRING")"
  [[ -n "$pid" ]] || return 1
  # A crashed game leaves the file behind; make sure its process is alive.
  tasklist.exe /FI "PID eq $pid" /NH 2>/dev/null | grep -qi java
}

wait_bridge() {
  if bridge_up; then say "Bridge is open ($(sed -n 's/^port = //p' "$PAIRING"))"; return; fi
  say "Start Craftoria and open your test world (Creative, cheats on). Waiting for the bridge (up to ${WAIT_SECS}s)..."
  for ((i = 0; i < WAIT_SECS; i += 3)); do
    if bridge_up; then say "Bridge is open (port $(sed -n 's/^port = //p' "$PAIRING"))"; return; fi
    sleep 3
  done
  fail "no bridge after ${WAIT_SECS}s: is a world open? ($PAIRING)"
}

launch() {
  say "Launching Claude Code on the autosketch channel"
  cd "$REPO"
  exec claude --dangerously-load-development-channels server:autosketch
}

case "${1:-all}" in
  prep)   prep ;;
  wait)   wait_bridge ;;
  launch) launch ;;
  all)    prep; wait_bridge; launch ;;
  *)      fail "usage: $0 [prep|wait|launch]" ;;
esac
