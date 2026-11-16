#!/usr/bin/env bash
# Checks a mod release can go out before anything is published (docs/design/14-distribution.md,
# *Publishing*). Used by .github/workflows/mod-release.yml; runnable locally.
#
#   mod/release/preflight.sh [--dry-run]
#
# Reads from the environment:
#   RELEASE_TAG            the pushed tag, mod-v<version> (optional with --dry-run)
#   CURSEFORGE_TOKEN       repository secret: a CurseForge API token (author settings, API tokens)
#   MODRINTH_TOKEN         repository secret: a Modrinth personal access token with "Create versions"
#   CURSEFORGE_PROJECT_ID  repository variable: the numeric CurseForge project id
#   MODRINTH_PROJECT_ID    repository variable: the Modrinth project id or slug
#
# Without --dry-run every problem is an error and the script exits non-zero, so the publish job
# never starts with one platform missing. With --dry-run problems are warnings.
set -euo pipefail

dry=false
[[ "${1:-}" == "--dry-run" ]] && dry=true
here=$(cd "$(dirname "$0")/.." && pwd)
version=$(sed -n 's/^mod_version=//p' "$here/gradle.properties")
problems=()

if [[ -n "${RELEASE_TAG:-}" ]]; then
  [[ "$RELEASE_TAG" == "mod-v$version" ]] || problems+=("tag $RELEASE_TAG doesn't match mod_version=$version in mod/gradle.properties (expected mod-v$version)")
elif ! $dry; then
  problems+=("no release tag (RELEASE_TAG); releases are made by pushing a tag mod-v<version>")
fi
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || problems+=("mod_version=$version is not semantic versioning (14, Release naming)")

for name in CURSEFORGE_TOKEN MODRINTH_TOKEN; do
  [[ -n "${!name:-}" ]] || problems+=("repository secret $name is not set (Settings > Secrets and variables > Actions > Secrets)")
done
for name in CURSEFORGE_PROJECT_ID MODRINTH_PROJECT_ID; do
  [[ -n "${!name:-}" ]] || problems+=("repository variable $name is not set (Settings > Secrets and variables > Actions > Variables)")
done
if [[ -n "${CURSEFORGE_PROJECT_ID:-}" && ! "$CURSEFORGE_PROJECT_ID" =~ ^[0-9]+$ ]]; then
  problems+=("CURSEFORGE_PROJECT_ID=$CURSEFORGE_PROJECT_ID is not a numeric project id")
fi

if (( ${#problems[@]} == 0 )); then
  echo "preflight: release $version can be published to CurseForge and Modrinth"
  exit 0
fi
level=error
$dry && level=warning
for p in "${problems[@]}"; do
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then echo "::$level::$p"; else echo "$level: $p" >&2; fi
done
if $dry; then
  echo "preflight (dry run): ${#problems[@]} problem(s); a real release would stop here and publish nothing"
  exit 0
fi
echo "preflight: ${#problems[@]} problem(s); nothing was published" >&2
exit 1
