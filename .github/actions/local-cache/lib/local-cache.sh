#!/usr/bin/env bash
# Local cache on a self-hosted runner's persistent disk, used by local-cache/restore and /save.
#
# Layout: $CI_LOCAL_CACHE/<owner>/<repo>/<scope>/<key>.tar, one plain tar per entry (the disk is
# local, so compressing costs more than it saves). <scope> is the ref that saved the entry. A run reads
# entries of its own ref first, then of the default branch, like GitHub's cache. Entries are immutable:
# a key that exists is never written again. Writes go to a temporary file renamed into place, so
# concurrent jobs never see half an entry. A save deletes its scope's entries whose keys start with one of
# INPUT_SUPERSEDES, so a key family keeps only its newest entry. The oldest entries (by last use) are
# evicted when the whole cache grows past CI_LOCAL_CACHE_MAX_GB (default 40) or the disk has less than
# CI_LOCAL_CACHE_MIN_FREE_PCT percent free (default 20).
set -euo pipefail

mode="${1:?restore or save}"

sanitize() { printf '%s' "$1" | tr -c 'A-Za-z0-9._+=-' '_'; }

to_unix() { # Git Bash on Windows understands C:/ paths; tar wants them without a drive colon issue.
  if command -v cygpath > /dev/null; then cygpath -u "$1"; else printf '%s' "$1"; fi
}

root="$(to_unix "$CI_LOCAL_CACHE")/$(sanitize "${GITHUB_REPOSITORY%%/*}")/$(sanitize "${GITHUB_REPOSITORY#*/}")"
workspace="$(to_unix "$INPUT_WORKING_DIRECTORY")"
own_scope="$(sanitize "${GITHUB_HEAD_REF:-${GITHUB_REF_NAME:-unknown}}")"
default_scope="$(sanitize "${DEFAULT_BRANCH:-main}")"

paths=()
while IFS= read -r p; do
  p="${p#"${p%%[![:space:]]*}"}"
  p="${p%"${p##*[![:space:]]}"}"
  [ -n "$p" ] || continue
  case "$p" in
    /* | ~* | [A-Za-z]:*) echo "::error::local-cache paths are relative to working-directory: $p"; exit 1 ;;
  esac
  paths+=("$p")
done <<< "$INPUT_PATH"
[ ${#paths[@]} -gt 0 ] || { echo "::error::local-cache: no path"; exit 1; }

key="$(sanitize "$INPUT_KEY")"

restore() {
  local scope file prefix hit="" matched=""
  for scope in "$own_scope" "$default_scope"; do
    file="$root/$scope/$key.tar"
    if [ -f "$file" ]; then hit="$file"; matched="$INPUT_KEY"; break; fi
  done
  if [ -z "$hit" ]; then
    while IFS= read -r prefix; do
      prefix="${prefix#"${prefix%%[![:space:]]*}"}"
      [ -n "$prefix" ] || continue
      prefix="$(sanitize "$prefix")"
      for scope in "$own_scope" "$default_scope"; do
        [ -d "$root/$scope" ] || continue
        # Newest entry (by last use) whose key starts with the prefix.
        file="$(find "$root/$scope" -maxdepth 1 -type f -name "$prefix*.tar" -printf '%T@ %p\n' 2> /dev/null |
          sort -rn | head -n 1 | cut -d' ' -f2-)"
        if [ -n "$file" ]; then hit="$file"; matched="$(basename "$file" .tar)"; break 2; fi
      done
    done <<< "${INPUT_RESTORE_KEYS:-}"
  fi
  if [ -z "$hit" ]; then
    echo "local-cache: miss for $INPUT_KEY"
    { echo "cache-hit=false"; echo "matched-key="; } >> "$GITHUB_OUTPUT"
    return
  fi
  mkdir -p "$workspace"
  tar -xf "$hit" -C "$workspace"
  touch "$hit" # Last use, for eviction and the weekly prune.
  local exact=false
  [ "$matched" != "$INPUT_KEY" ] || exact=true
  echo "local-cache: restored $matched ($(du -sh "$hit" | cut -f1))"
  { echo "cache-hit=$exact"; echo "matched-key=$matched"; } >> "$GITHUB_OUTPUT"
}

evict() {
  local cache max_kb used_kb size_kb avail_kb need_kb short_kb kb file
  cache="$(to_unix "$CI_LOCAL_CACHE")"
  [ -d "$cache" ] || return 0
  max_kb=$(( ${CI_LOCAL_CACHE_MAX_GB:-40} * 1024 * 1024 ))
  used_kb="$(du -sk "$cache" | cut -f1)"
  read -r size_kb avail_kb < <(df -Pk "$cache" | awk 'NR == 2 { print $2, $4 }')
  need_kb=$((used_kb - max_kb))
  short_kb=$(( size_kb * ${CI_LOCAL_CACHE_MIN_FREE_PCT:-20} / 100 - avail_kb ))
  [ "$short_kb" -le "$need_kb" ] || need_kb=$short_kb
  [ "$need_kb" -gt 0 ] || return 0
  find "$cache" -type f -name '*.tar' -printf '%T@ %k %p\n' | sort -n |
    while read -r _ kb file; do
      [ "$need_kb" -gt 0 ] || break
      rm -f "$file" && need_kb=$((need_kb - kb))
      echo "local-cache: evicted $file"
    done
}

supersede() { # $1: the entry just saved.
  local prefix old
  while IFS= read -r prefix; do
    prefix="${prefix#"${prefix%%[![:space:]]*}"}"
    prefix="${prefix%"${prefix##*[![:space:]]}"}"
    [ -n "$prefix" ] || continue
    for old in "$(dirname "$1")/$(sanitize "$prefix")"*.tar; do
      [ -f "$old" ] && [ "$old" != "$1" ] || continue
      if rm -f "$old"; then echo "local-cache: superseded $(basename "$old" .tar)"; fi
    done
  done <<< "${INPUT_SUPERSEDES:-}"
}

save() {
  local scope_dir file tmp existing=()
  scope_dir="$root/$own_scope"
  file="$scope_dir/$key.tar"
  if [ -f "$file" ] || [ -f "$root/$default_scope/$key.tar" ]; then
    echo "local-cache: $INPUT_KEY exists, not saving"
    return
  fi
  for p in "${paths[@]}"; do
    # Globs are expanded relative to the working directory.
    # shellcheck disable=SC2086
    for match in $(cd "$workspace" && compgen -G "$p" || true); do existing+=("$match"); done
  done
  if [ ${#existing[@]} -eq 0 ]; then
    echo "local-cache: none of the paths exist, not saving"
    return
  fi
  evict
  mkdir -p "$scope_dir"
  tmp="$file.tmp.$$"
  tar -cf "$tmp" -C "$workspace" -- "${existing[@]}"
  mv -f "$tmp" "$file"
  echo "local-cache: saved $INPUT_KEY ($(du -sh "$file" | cut -f1))"
  supersede "$file"
  evict
}

"$mode"
