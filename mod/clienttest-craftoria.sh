#!/usr/bin/env bash
# Craftoria-sized client test run (docs/design/16-in-game-ui.md, *Testing*: "a Craftoria-sized client
# runs occasionally, not on every change"). Manual, not in CI: needs a Craftoria install and about
# 8 GB for the game.
#
#   CRAFTORIA=<Craftoria client instance> mod/clienttest-craftoria.sh [suite,...]
#
# CRAFTORIA is a folder with the pack's mods/ and config/: the CurseForge client instance (from WSL,
# /mnt/c/Users/<you>/curseforge/minecraft/Instances/Craftoria). The server pack at ~/servers/craftoria
# (the default; docs/briefs/world/test-setup.md, step 2) lacks the pack's client-only mods, which
# other mods require, so the client stops at the loading error screen with it.
#
# It links the pack's mods/*.jar into run/clienttest-craftoria/mods/ (except Autosketch, which the dev
# run provides, and Cloth Config, a dev dependency already), copies config/, defaultconfigs/ and
# kubejs/ once, then runs mod/clienttest.sh with that game directory, a larger heap and a longer
# timeout.
set -euo pipefail

cd "$(dirname "$0")"
pack="${CRAFTORIA:-$HOME/servers/craftoria}"
dir="run/clienttest-craftoria"
EXCLUDE='^(autosketch-|cloth-config-)'

[[ -d "$pack/mods" ]] || { echo "clienttest-craftoria: no mods folder in $pack (set CRAFTORIA)" >&2; exit 2; }
mkdir -p "$dir/mods"
find "$dir/mods" -maxdepth 1 -type l -delete
n=0
for jar in "$pack"/mods/*.jar; do
  name="$(basename "$jar")"
  [[ "$name" =~ $EXCLUDE ]] && continue
  ln -s "$(realpath "$jar")" "$dir/mods/$name"
  n=$((n + 1))
done
for sub in config defaultconfigs kubejs; do
  if [[ -d "$pack/$sub" && ! -e "$dir/$sub" ]]; then cp -r "$pack/$sub" "$dir/$sub"; fi
done
echo "clienttest-craftoria: $n Craftoria jars linked into $dir/mods"

CLIENTTEST_GAME_DIR="$dir" CLIENTTEST_XMX="${CLIENTTEST_XMX:-8G}" CLIENTTEST_TIMEOUT="${CLIENTTEST_TIMEOUT:-2400}" exec ./clienttest.sh "${1:-all}"
