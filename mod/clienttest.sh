#!/usr/bin/env bash
# Client test harness (docs/design/16-in-game-ui.md, *Testing*, client half): boots a real Minecraft
# client headless (Xvfb, Mesa software rendering) with the mod and the gametest source set, runs the
# client test suites against the mod and a fake MCP, and exits non-zero on any failed step or a hang.
#
#   mod/clienttest.sh [suite,suite...]     default: every suite ("all"), one client boot
#   CLIENTTEST_TIMEOUT=900                 seconds before the game is killed (the driver's own
#                                          watchdog fires 60 s earlier and writes the report)
#   CLIENTTEST_DISPLAY=:0                  draw on an existing display (WSLg) instead of Xvfb, to watch
#   CLIENTTEST_FRESH=1                     delete the test world first (it is created when missing)
#   CLIENTTEST_GAME_DIR=run/clienttest     the game directory, relative to mod/
#   CLIENTTEST_XMX=3G                      the game's heap
#
# Report: <game dir>/report.txt; screenshots: <game dir>/clienttest-screenshots/; game log:
# <game dir>/logs/latest.log; fake MCP log: <game dir>/logs/fake-mcp-*.log (game dir: mod/run/clienttest).
set -euo pipefail

cd "$(dirname "$0")"
suites="${1:-all}"
timeout_s="${CLIENTTEST_TIMEOUT:-900}"
run_dir="${CLIENTTEST_GAME_DIR:-run/clienttest}"
report="$run_dir/report.txt"

# Gradle 9 needs JDK 17+; the dev machine's login shell may export JDK 11.
if [[ -z "${JAVA_HOME:-}" ]] || ! "$JAVA_HOME/bin/java" -version 2>&1 | grep -qE 'version "(1[7-9]|2[0-9])'; then
  if [[ -x /usr/lib/jvm/java-21-openjdk-amd64/bin/java ]]; then export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64; fi
fi

# The fake MCP CLI (test/support/fake-mcp.ts) runs with tsx from the repository's node_modules.
if [[ -f ../test/support/fake-mcp.ts && ! -x ../node_modules/.bin/tsx ]]; then
  echo "clienttest: node_modules missing; running npm install" >&2
  (cd .. && npm install --no-audit --no-fund)
fi

if [[ "${CLIENTTEST_FRESH:-}" == 1 ]]; then rm -rf "$run_dir/saves/autosketch-clienttest"; fi
mkdir -p "$run_dir"
rm -f "$report"

export LIBGL_ALWAYS_SOFTWARE=1
# The driver's watchdog (in the game JVM) fires first, so a hang still leaves a report.
gradle=(./gradlew --console=plain :neoforge:1.21.1:runClientTest "-PclientTestSuites=$suites"
  "-PclientTestTimeout=$((timeout_s - 60))" "-PclientTestGameDir=$run_dir" "-PclientTestXmx=${CLIENTTEST_XMX:-3G}")

start=$(date +%s)
marker="$run_dir/.clienttest-start"
touch "$marker"
if [[ -n "${CLIENTTEST_DISPLAY:-}" ]]; then
  DISPLAY="$CLIENTTEST_DISPLAY" timeout --kill-after=30 "$timeout_s" "${gradle[@]}" &
else
  command -v xvfb-run >/dev/null || { echo "clienttest: xvfb-run not found (apt install xvfb)" >&2; exit 2; }
  timeout --kill-after=30 "$timeout_s" xvfb-run -a -s "-screen 0 1280x720x24" "${gradle[@]}" &
fi
run_pid=$!
# A crash before the driver runs (a mod failing to load) leaves the game on an error screen, where no
# watchdog of ours is running: stop the run as soon as a new crash report appears.
crashed=""
while kill -0 "$run_pid" 2>/dev/null; do
  if [[ -d "$run_dir/crash-reports" ]] && [[ -n "$(find "$run_dir/crash-reports" -newer "$marker" -type f 2>/dev/null | head -1)" ]]; then
    crashed="$(find "$run_dir/crash-reports" -newer "$marker" -type f | head -1)"
    sleep 5
    pkill -TERM -f "fml.modFolders=.*$(pwd)" 2>/dev/null || true
    break
  fi
  sleep 2
done
status=0
wait "$run_pid" || status=$?
elapsed=$(( $(date +%s) - start ))
if [[ -n "$crashed" ]]; then
  echo "clienttest: the game crashed: $crashed" >&2
  grep -m 20 -E 'Description|requires|Exception|Error' "$crashed" >&2 || true
fi

echo
echo "── client test report ($report, ${elapsed}s) ──"
if [[ ! -f "$report" ]]; then
  echo "clienttest: no report written (gradle exit $status; see $run_dir/logs/latest.log)" >&2
  exit 1
fi
grep -E '^(SUITE|TIME|INFO|WARN|FAIL|SKIP|RENDERER|RESULT)' "$report" || true
grep -cE '^PASS' "$report" | sed 's/^/passed steps: /'
if grep -qx 'RESULT pass' "$report" && [[ $status -eq 0 ]]; then
  echo "clienttest: pass"
  exit 0
fi
echo "clienttest: FAIL (gradle exit $status)" >&2
exit 1
