#!/usr/bin/env bash
# Tests actions/changed-files (changed-files.sh, ci-scope, ci-go-packages, ci-rust-packages) and
# actions/local-cache (local backend) against throwaway repositories. Run from the repo root.
set -euo pipefail

# The runner's own pull request context must not leak into the simulated events below.
unset GITHUB_HEAD_REF GITHUB_BASE_REF ECLEAN_FULL ECLEAN_BASE ECLEAN_CHANGED_FILES ECLEAN_ACTIONS_CACHE

root="$(pwd)"
cf="$root/.github/actions/changed-files"
lc="$root/.github/actions/local-cache"
t="$(mktemp -d)"
trap 'rm -rf "$t"' EXIT
fail=0
check() { # check <name> <want> <got>
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: want [$2] got [$3]"; fail=1; fi
}
out() { sed -n "s/^$1=//p" "$t/out" | tail -n 1; }

g() { git -c user.email=t@t -c user.name=t -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }
mkdir "$t/repo" && cd "$t/repo"
g init -q -b main
mkdir -p src docs
echo a > src/a.ts && echo d > docs/x.md && echo '{}' > package.json
g add -A && g commit -qm base
base="$(git rev-parse HEAD)"
g checkout -q -b feat
echo b > src/b.ts && echo z >> docs/x.md && g rm -q src/a.ts && g add -A && g commit -qm feat
g checkout -q main && g merge -q --no-ff feat -m merge

export GITHUB_OUTPUT="$t/out" GITHUB_ENV="$t/env" GITHUB_PATH="$t/path" GITHUB_STEP_SUMMARY="$t/sum"
export RUNNER_TEMP="$t" GITHUB_ACTION_PATH="$cf"
run() { # run <event> [full-patterns]
  : > "$t/out"; : > "$t/env"
  EVENT_NAME="$1" PR_BASE_SHA="$base" INPUT_FULL_PATTERNS="${2:-}" INPUT_DEFAULT_FULL_PATTERNS=true \
    INPUT_FILTERS=$'code: * !docs/* !*.md\ndocs: docs/* *.md' INPUT_MAX_FILES=400 INPUT_TOKEN='' \
    bash "$cf/changed-files.sh"
}

run pull_request
check "merge commit: not full" false "$(out full)"
check "merge commit: files" "docs/x.md src/b.ts" "$(tr '\n' ' ' < "$t/eclean-changed-files.txt" | sed 's/ $//')"
check "merge commit: matches" '{"code":true,"docs":true}' "$(out matches)"
run push
check "push: full" true "$(out full)"
run pull_request 'src/*'
check "full pattern (deleted file counts)" true "$(out full)"
g checkout -q feat
run pull_request
check "head checkout: merge base" "$base" "$(out base)"
g checkout -q -b docs "$base" && echo q >> docs/x.md && g commit -qam docs
run pull_request
check "docs only: code false" '{"code":false,"docs":true}' "$(out matches)"
g checkout -q feat
echo '{"x":1}' > package.json && g commit -qam pkg
run pull_request
check "package.json: full by default" true "$(out full)"
g reset -q --hard HEAD~1

run pull_request
set -a
# shellcheck disable=SC1091 # Written by changed-files.sh above.
. "$t/env"
set +a
check "ci-scope: ts files" "LINT src/b.ts" "$(bash "$cf/bin/ci-scope" --ext ts -- echo LINT | tail -n 1)"
check "ci-scope: nothing matches" "" "$(bash "$cf/bin/ci-scope" --ext py -- echo LINT | grep -v '^ci-scope' || true)"
check "ci-scope: --no-files" "RUN" "$(bash "$cf/bin/ci-scope" --no-files --ext ts -- echo RUN | tail -n 1)"
check "ci-scope: --dir" "LINT b.ts" "$(bash "$cf/bin/ci-scope" --dir src -- echo LINT | tail -n 1)"
check "ci-scope: full" "FULL" "$(ECLEAN_FULL=true bash "$cf/bin/ci-scope" --full 'echo FULL' -- echo LINT | tail -n 1)"

if command -v go > /dev/null; then
  mkdir -p "$t/gomod" && cd "$t/gomod"
  g init -q -b main
  printf 'module example.com/m\n\ngo 1.22\n' > go.mod
  mkdir -p a b c
  printf 'package a\n\nfunc A() int { return 1 }\n' > a/a.go
  printf 'package b\n\nimport "example.com/m/a"\n\nfunc B() int { return a.A() }\n' > b/b.go
  printf 'package c\n\nfunc C() int { return 3 }\n' > c/c.go
  g add -A && g commit -qm base
  echo a/a.go > "$t/gofiles"
  check "ci-go-packages: importers" "example.com/m/a example.com/m/b" \
    "$(ECLEAN_FULL=false ECLEAN_CHANGED_FILES="$t/gofiles" bash "$cf/bin/ci-go-packages" | sort | tr '\n' ' ' | sed 's/ $//')"
  check "ci-go-packages: full" "./..." "$(ECLEAN_FULL=true bash "$cf/bin/ci-go-packages")"
  cd "$t/repo"
fi

if command -v cargo > /dev/null && command -v jq > /dev/null; then
  mkdir -p "$t/ws" && cd "$t/ws"
  g init -q -b main
  printf '[workspace]\nmembers = ["a", "b", "c"]\nresolver = "2"\n' > Cargo.toml
  for c in a b c; do mkdir -p "$c/src" && echo "" > "$c/src/lib.rs"; done
  printf '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n' > a/Cargo.toml
  printf '[package]\nname = "b"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\na = { path = "../a" }\n' > b/Cargo.toml
  printf '[package]\nname = "c"\nversion = "0.1.0"\nedition = "2021"\n' > c/Cargo.toml
  cargo generate-lockfile -q --offline 2> /dev/null || cargo generate-lockfile -q
  g add -A && g commit -qm base
  echo a/src/lib.rs > "$t/rsfiles"
  check "ci-rust-packages: dependents" "-p a -p b" \
    "$(ECLEAN_FULL=false ECLEAN_CHANGED_FILES="$t/rsfiles" bash "$cf/bin/ci-rust-packages")"
  check "ci-rust-packages: full" "--workspace" "$(ECLEAN_FULL=true bash "$cf/bin/ci-rust-packages")"
  cd "$t/repo"
fi

export ECLEAN_ACTIONS_CACHE="$t/cache" GITHUB_REPOSITORY=ecleangg/selftest GITHUB_REF_NAME=main DEFAULT_BRANCH=main
export INPUT_WORKING_DIRECTORY="$t/repo" INPUT_PATH=$'src\nmissing'
mkdir -p "$ECLEAN_ACTIONS_CACHE"
: > "$t/out"; INPUT_KEY=k-1 bash "$lc/lib/local-cache.sh" save
check "local-cache: saved" true "$([ -f "$t/cache/ecleangg/selftest/main/k-1.tar" ] && echo true || echo false)"
rm -rf src
: > "$t/out"; INPUT_KEY=k-1 bash "$lc/lib/local-cache.sh" restore
check "local-cache: exact hit" true "$(out cache-hit)"
check "local-cache: restored" b.ts "$(ls src)"
: > "$t/out"; GITHUB_HEAD_REF=pr INPUT_KEY=k-2 INPUT_RESTORE_KEYS=k- bash "$lc/lib/local-cache.sh" restore
check "local-cache: prefix from default branch" "false k-1" "$(out cache-hit) $(out matched-key)"
: > "$t/out"; GITHUB_HEAD_REF=pr INPUT_KEY=k-3 bash "$lc/lib/local-cache.sh" save
: > "$t/out"; INPUT_KEY=k-3 bash "$lc/lib/local-cache.sh" restore
check "local-cache: main never reads a pull request's entry" "false" "$(out cache-hit)"
: > "$t/out"; INPUT_BACKEND=auto bash "$lc/lib/decide.sh"
check "local-cache: local backend chosen" true "$(out local)"

exit "$fail"
