#!/usr/bin/env bash
# Local cache on a self-hosted runner's persistent disk, used by local-cache/restore and /save.
#
# Layout: $CI_LOCAL_CACHE/<owner>/<repo>/<scope>/<key>.tar, one plain tar per entry (the disk is
# local, so compressing costs more than it saves). <scope> is the ref that saved the entry. A run reads
# entries of its own ref first, then of the default branch, like GitHub's cache. Entries are immutable:
# a key that exists is never written again. Writes go to a temporary file renamed into place, so
# concurrent jobs never see half an entry. A save deletes its scope's entries whose keys start with one of
# INPUT_SUPERSEDES, so a key family keeps only its newest entry. Before writing, a save makes room for
# the entry it is about to write: entries are evicted (other refs' first, then the default branch's,
# oldest last use first) until the cache stays under CI_LOCAL_CACHE_MAX_GB (default 40) and the disk
# keeps CI_LOCAL_CACHE_MIN_FREE_PCT percent free (default 20) with the new entry on it; when even that
# cannot be met, the save is skipped rather than filling the disk.
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
# INPUT_SCOPE=shared: one scope every ref reads and writes, for entries whose key already pins their
# content (a test result keyed by the tree it passed on).
if [ "${INPUT_SCOPE:-ref}" = shared ]; then own_scope=_shared; default_scope=_shared; fi

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
  touch "$hit" # Last use, for eviction and the weekly prune.
  if [ "${INPUT_LOOKUP_ONLY:-false}" != true ]; then
    mkdir -p "$workspace"
    tar -xf "$hit" -C "$workspace"
  fi
  local exact=false
  [ "$matched" != "$INPUT_KEY" ] || exact=true
  echo "local-cache: $([ "${INPUT_LOOKUP_ONLY:-false}" = true ] && echo found || echo restored) $matched ($(du -sh "$hit" | cut -f1))"
  { echo "cache-hit=$exact"; echo "matched-key=$matched"; } >> "$GITHUB_OUTPUT"
}

evict() { # $1: KB about to be written, kept free on top of the limits. Returns 1 when that cannot fit.
  local reserve_kb="${1:-0}" cache max_kb used_kb size_kb avail_kb need_kb short_kb kb file
  cache="$(to_unix "$CI_LOCAL_CACHE")"
  [ -d "$cache" ] || return 0
  # Half-written entries of jobs that died mid-save.
  find "$cache" -type f -name '*.tar.tmp.*' -mmin +120 -delete 2> /dev/null || true
  max_kb=$(( ${CI_LOCAL_CACHE_MAX_GB:-40} * 1024 * 1024 ))
  used_kb="$(du -sk "$cache" | cut -f1)"
  read -r size_kb avail_kb < <(df -Pk "$cache" | awk 'NR == 2 { print $2, $4 }')
  need_kb=$((used_kb + reserve_kb - max_kb))
  short_kb=$(( size_kb * ${CI_LOCAL_CACHE_MIN_FREE_PCT:-20} / 100 + reserve_kb - avail_kb ))
  [ "$short_kb" -le "$need_kb" ] || need_kb=$short_kb
  [ "$need_kb" -gt 0 ] || return 0
  # Other refs' entries go before the default branch's, each oldest (by last use) first.
  while read -r _ _ kb file; do
    [ "$need_kb" -gt 0 ] || break
    rm -f "$file" && need_kb=$((need_kb - kb))
    echo "local-cache: evicted $file"
  done < <(find "$cache" -type f -name '*.tar' -printf '%T@ %k %p\n' |
    awk -v d="/$default_scope/" '{ print (index($3, d) ? 1 : 0), $0 }' | sort -k1,1n -k2,2n)
  [ "$need_kb" -le 0 ]
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
  local scope_dir file tmp reserve_kb existing=()
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
  reserve_kb="$(cd "$workspace" && du -skc -- "${existing[@]}" | tail -n 1 | cut -f1)"
  if ! evict "$reserve_kb"; then
    echo "::warning title=local-cache::not saving $INPUT_KEY ($((reserve_kb / 1024)) MB): the runner disk has no room for it"
    return
  fi
  mkdir -p "$scope_dir"
  tmp="$file.tmp.$$"
  trap 'rm -f "$tmp"' EXIT
  tar -cf "$tmp" -C "$workspace" -- "${existing[@]}"
  mv -f "$tmp" "$file"
  trap - EXIT
  echo "local-cache: saved $INPUT_KEY ($(du -sh "$file" | cut -f1))"
  supersede "$file"
}

"$mode"
