#!/usr/bin/env bash
# One command for a hands-on in-game test: build everything, make sure the MCP server is
# registered and boots, wait for the game's bridge, then open Claude Code on the channel
# (Claude Code spawns the MCP server over stdio, so that is where it "spins up").
# Internal dev tool: run it from the VS Code integrated terminal (WSL) at the repo root.
#
#   scripts/test.sh            prep -> mcp check -> wait for bridge -> launch Claude Code
#   scripts/test.sh --no-wait  skip waiting for the bridge (launch now; connect the game later)
#
# Steps are shared with scripts/ingame-setup.sh. AUTOSKETCH_INSTANCE and WAIT_SECS apply here too.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SETUP="$REPO/scripts/ingame-setup.sh"
INSTANCE="${AUTOSKETCH_INSTANCE:-/mnt/c/Users/kevin/curseforge/minecraft/Instances/Craftoria}"
SERVER="$REPO/dist/server/index.js"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

wait=1
case "${1:-}" in
  "")        ;;
  --no-wait) wait=0 ;;
  *)         fail "usage: $0 [--no-wait]" ;;
esac

bash "$SETUP" prep

say "MCP server registration"
if claude mcp get autosketch >/dev/null 2>&1; then
  echo "autosketch is registered"
else
  (cd "$REPO" && claude mcp add -s local autosketch -- node "$SERVER" --instance "$INSTANCE")
  echo "registered autosketch (local scope)"
fi

say "MCP server boot check"
init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test.sh","version":"0"}}}'
log="$(mktemp)"
reply="$(printf '%s\n' "$init" | timeout 60 node "$SERVER" --instance "$INSTANCE" 2>"$log" | head -n 1 || true)"
if [[ "$reply" == *'"serverInfo":{"name":"autosketch"'* ]]; then
  echo "server answers initialize"
  rm -f "$log"
else
  cat "$log" >&2
  fail "the MCP server did not answer initialize (stderr above)"
fi

(( wait )) && bash "$SETUP" wait
exec bash "$SETUP" launch
