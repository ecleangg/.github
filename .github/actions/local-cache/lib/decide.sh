#!/usr/bin/env bash
# Picks the backend for local-cache/restore and /save: the runner's disk when ECLEAN_ACTIONS_CACHE
# names a writable directory (the ecleangg self-hosted runners set it), actions/cache otherwise.
set -euo pipefail
local=false
if [ "$INPUT_BACKEND" != remote ] && [ -n "${ECLEAN_ACTIONS_CACHE:-}" ] && [ -d "$ECLEAN_ACTIONS_CACHE" ] && [ -w "$ECLEAN_ACTIONS_CACHE" ]; then
  local=true
fi
[ "$INPUT_BACKEND" != local ] || [ "$local" = true ] || { echo "::error::backend local, but ECLEAN_ACTIONS_CACHE is not a writable directory"; exit 1; }
echo "local=$local" >> "$GITHUB_OUTPUT"
# actions/cache resolves relative paths against the workspace, not working-directory.
{
  echo "paths<<ECLEAN_PATHS_EOF"
  while IFS= read -r p; do
    p="${p#"${p%%[![:space:]]*}"}"
    [ -n "$p" ] || continue
    printf '%s/%s\n' "$INPUT_WORKING_DIRECTORY" "$p"
  done <<< "$INPUT_PATH"
  echo "ECLEAN_PATHS_EOF"
} >> "$GITHUB_OUTPUT"
