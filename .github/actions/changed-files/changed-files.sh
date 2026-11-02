#!/usr/bin/env bash
# Computes the changed-file list for actions/changed-files. Runs on Linux and on Git Bash (Windows).
set -euo pipefail

# Lockfiles, toolchain pins and tool configuration: a change to one of them can change the result of
# any lint, format or test run, so the pull request runs everything. `*` also matches `/`, and a
# leading `**/` also matches the repository root.
DEFAULT_FULL_PATTERNS='
.github/workflows/*
.github/actions/*
**/package.json
**/bun.lock
**/bun.lockb
**/bunfig.toml
**/tsconfig*.json
**/jsconfig*.json
**/*.config.js
**/*.config.cjs
**/*.config.mjs
**/*.config.ts
**/*.config.mts
**/.oxlintrc*
**/.oxfmtrc*
**/oxlint*.json
**/rsvelte-*.json
**/biome.json*
**/.prettierrc*
**/eslint.config.*
**/svelte.config.*
**/wrangler.json*
**/wrangler.toml
**/Cargo.lock
**/Cargo.toml
**/rust-toolchain*
**/.cargo/*
**/clippy.toml
**/.clippy.toml
**/rustfmt.toml
**/.rustfmt.toml
**/deny.toml
**/.config/nextest.toml
**/go.mod
**/go.sum
**/go.work
**/go.work.sum
**/.golangci*
**/Makefile
**/justfile
**/Justfile
**/.tool-versions
**/mise.toml
**/.bun-version
**/.node-version
**/.nvmrc
'

out="${RUNNER_TEMP:-/tmp}/eclean-changed-files.txt"
: > "$out"

matches() { # matches <path> <glob>
  local path="$1" glob="$2"
  # shellcheck disable=SC2053 # The glob is meant to be a pattern.
  [[ "$path" == $glob ]] && return 0
  if [[ "$glob" == '**/'* ]]; then
    # shellcheck disable=SC2053
    [[ "$path" == ${glob#\*\*/} ]] && return 0
  fi
  return 1
}

emit() { # emit <full> <reason> <base> <count> <matches-json>
  {
    echo "full=$1"
    echo "reason=$2"
    echo "base=$3"
    echo "files-file=$out"
    echo "count=$4"
    echo "matches=$5"
  } >> "$GITHUB_OUTPUT"
  {
    echo "ECLEAN_FULL=$1"
    echo "ECLEAN_BASE=$3"
    echo "ECLEAN_CHANGED_FILES=$out"
  } >> "$GITHUB_ENV"
  echo "$GITHUB_ACTION_PATH/bin" >> "$GITHUB_PATH"
  if [ "$1" = true ]; then
    echo "Checking everything: $2." >> "$GITHUB_STEP_SUMMARY"
  else
    echo "Checking the $4 changed files against \`${3:0:12}\`." >> "$GITHUB_STEP_SUMMARY"
  fi
}

filter_names() {
  printf '%s\n' "$INPUT_FILTERS" | sed -n 's/^[[:space:]]*\([A-Za-z0-9_-]*\):.*/\1/p'
}

all_true_json() {
  local json="{" sep="" name
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    json+="$sep\"$name\":true"
    sep=","
  done < <(filter_names)
  echo "$json}"
}

full() {
  emit true "$1" "" 0 "$(all_true_json)"
  exit 0
}

case "$EVENT_NAME" in
  pull_request | pull_request_target) ;;
  *) full "\`$EVENT_NAME\` event" ;;
esac

git rev-parse --is-inside-work-tree > /dev/null 2>&1 || full "no git checkout"

fetch() {
  # The token goes to git through the environment (never argv or .git/config), for checkouts made
  # with persist-credentials: false.
  if [ -n "${INPUT_TOKEN:-}" ]; then
    local basic
    basic="$(printf 'x-access-token:%s' "$INPUT_TOKEN" | base64 | tr -d '\n')"
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="http.${GITHUB_SERVER_URL:-https://github.com}/.extraheader" \
      GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $basic" \
      git -c protocol.version=2 fetch --quiet --no-tags --no-recurse-submodules "$@"
  else
    git -c protocol.version=2 fetch --quiet --no-tags --no-recurse-submodules "$@"
  fi
}

# actions/checkout checks out the pull request's merge commit by default: its first parent is the
# base branch, so the diff against it is exactly the pull request. One extra commit is enough.
base=""
parents="$(git rev-list --parents -n 1 HEAD)"
if [ "$(wc -w <<< "$parents")" -eq 3 ]; then
  base="$(cut -d' ' -f2 <<< "$parents")"
  git cat-file -e "$base^{commit}" 2> /dev/null || fetch --depth=1 origin "$base" || full "base commit not fetchable"
else
  # A checkout of the head commit: diff against the merge base with the pull request base.
  [ -n "${PR_BASE_SHA:-}" ] || full "no pull request base"
  git cat-file -e "$PR_BASE_SHA^{commit}" 2> /dev/null || fetch --depth=1 origin "$PR_BASE_SHA" || full "base commit not fetchable"
  depth=32
  until base="$(git merge-base "$PR_BASE_SHA" HEAD 2> /dev/null)"; do
    [ "$depth" -le 4096 ] || full "no merge base within 4096 commits"
    fetch --deepen="$depth" origin HEAD "$PR_BASE_SHA" || full "could not deepen the history"
    depth=$((depth * 2))
  done
fi

all="$(git diff --name-only --no-renames "$base" HEAD)"
git diff --name-only --no-renames --diff-filter=d "$base" HEAD > "$out"
count="$(grep -c . "$out" || true)"

[ "$count" -le "$INPUT_MAX_FILES" ] || full "$count changed files (more than $INPUT_MAX_FILES)"

patterns="$INPUT_FULL_PATTERNS"
[ "$INPUT_DEFAULT_FULL_PATTERNS" != true ] || patterns="$DEFAULT_FULL_PATTERNS"$'\n'"$patterns"
while IFS= read -r file; do
  [ -n "$file" ] || continue
  while IFS= read -r glob; do
    glob="${glob#"${glob%%[![:space:]]*}"}"
    [ -n "$glob" ] || continue
    if matches "$file" "$glob"; then full "\`$file\` changed"; fi
  done <<< "$patterns"
done <<< "$all"

json="{" sep=""
while IFS= read -r line; do
  name="$(sed -n 's/^[[:space:]]*\([A-Za-z0-9_-]*\):.*/\1/p' <<< "$line")"
  [ -n "$name" ] || continue
  hit=false
  read -r -a globs <<< "${line#*:}"
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    # A file counts when it matches a glob and no `!glob` after it.
    want=false
    for glob in "${globs[@]}"; do
      if [[ "$glob" == '!'* ]]; then
        if [ "$want" = true ] && matches "$file" "${glob#!}"; then want=false; fi
      elif matches "$file" "$glob"; then
        want=true
      fi
    done
    if [ "$want" = true ]; then hit=true; break; fi
  done <<< "$all"
  json+="$sep\"$name\":$hit"
  sep=","
done <<< "$INPUT_FILTERS"
json+="}"

emit false "changed files" "$base" "$count" "$json"
