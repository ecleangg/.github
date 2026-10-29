#!/usr/bin/env bash
# Tests for eclean-attest, eclean-attest-verify, install-githooks and the hook dispatcher.
# Plain bash with assertions; uses throwaway repos and freshly generated ed25519 keys.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
t="$(mktemp -d)"
trap 'rm -rf "$t"' EXIT
export GIT_CONFIG_GLOBAL="$t/gitconfig" GIT_CONFIG_SYSTEM=/dev/null HOME="$t/home"
mkdir -p "$HOME"
git config --global user.email dev@eclean.gg
git config --global user.name Dev
git config --global init.defaultBranch main
git config --global commit.gpgsign false

fails=0
ok() { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fails=$((fails + 1)); }
expect() { # expect <label> <expected valid> <output>
  if printf '%s\n' "$3" | grep -qx "valid=$2"; then ok "$1"; else bad "$1 ($(printf '%s' "$3" | tr '\n' ' '))"; fi
}

ssh-keygen -q -t ed25519 -N "" -C dev -f "$t/key1"
ssh-keygen -q -t ed25519 -N "" -C other -f "$t/key2"
printf 'dev@eclean.gg namespaces="eclean-verify" %s\n' "$(cut -d' ' -f1,2 "$t/key1.pub")" >"$t/allowed"

git init -q --bare "$t/origin.git"
git init -q "$t/work"
cd "$t/work" || exit 1
git remote add origin "$t/origin.git"
echo '{"name":"x","engines":{"node":">=22"}}' >package.json
echo lock1 >bun.lock
echo a >file.txt
git add -A && git commit -qm init

attest() { bash "$root/scripts/eclean-attest" --cmd true --repo ecleangg/test "$@" 2>&1; }
verify() { bash "$root/scripts/eclean-attest-verify" --repo "${REPO:-ecleangg/test}" --allowed-signers "${SIGNERS:-$t/allowed}" "$@"; }

echo dirty >>file.txt
if attest --key "$t/key1" >/dev/null; then bad "attest refuses a dirty tree"; else ok "attest refuses a dirty tree"; fi
git checkout -q file.txt

if out="$(attest --key "$t/key1")"; then ok "attest runs and pushes"; else echo "$out"; bad "attest runs and pushes"; fi
git --git-dir="$t/origin.git" rev-parse -q --verify refs/notes/eclean-verify >/dev/null && ok "notes ref reached origin" || bad "notes ref reached origin"
expect "attest then verify -> valid" true "$(verify)"

git push -q origin main
git clone -q "$t/origin.git" "$t/clone"
git -C "$t/clone" fetch -q origin +refs/notes/eclean-verify:refs/notes/eclean-verify
expect "fresh clone verifies the pushed note" true "$(cd "$t/clone" && verify)"

git commit -q --amend -m "reworded"
expect "amend with the same tree stays valid" true "$(verify)"

REPO=ecleangg/other
expect "wrong repo -> invalid" false "$(verify)"
unset REPO
: >"$t/empty"
SIGNERS="$t/empty" expect "empty allowed_signers -> invalid" false "$(SIGNERS="$t/empty" verify)"
expect "old attestation -> invalid" false "$(ECLEAN_ATTEST_NOW=$(($(date +%s) + 8 * 86400)) verify)"
expect "fresh attestation within max age" true "$(ECLEAN_ATTEST_NOW=$(($(date +%s) + 6 * 86400)) verify)"

echo b >>file.txt && git commit -qam change
expect "modified file -> invalid (tree changed)" false "$(verify)"
git reset -q --hard HEAD~1

echo lock2 >bun.lock && git commit -qam lock
expect "changed lockfile -> invalid" false "$(verify)"
git reset -q --hard HEAD~1

git checkout -q -b other
echo c >file.txt && git commit -qam c
attest --key "$t/key2" >/dev/null
expect "unknown signer -> invalid" false "$(verify)"
git checkout -q main

# --- hooks ---
H="$t/home/.config/eclean/githooks"
bash "$root/scripts/install-githooks" >/dev/null && ok "install-githooks" || bad "install-githooks"
[ -x "$H/pre-commit" ] && [ -x "$H/dispatch" ] && [ -x "$H/commit-msg" ] && ok "dispatcher and stubs installed executable" || bad "dispatcher and stubs installed"
bash "$root/scripts/install-githooks" >/dev/null && ok "install-githooks is idempotent" || bad "install-githooks is idempotent"
git config --global core.hooksPath /elsewhere
if bash "$root/scripts/install-githooks" >/dev/null 2>&1; then bad "refuses to clobber another hooksPath"; else ok "refuses to clobber another hooksPath"; fi
[ "$(git config --global core.hooksPath)" = /elsewhere ] && ok "clobber refusal left config untouched" || bad "clobber refusal left config untouched"
bash "$root/scripts/install-githooks" --force >/dev/null && ok "--force replaces it" || bad "--force replaces it"

git init -q "$t/hk" && cd "$t/hk" || exit 1
mkdir .githooks
printf '#!/bin/sh\necho repo >>"%s/marks"\n' "$t" >.githooks/pre-commit
printf '#!/bin/sh\necho local >>"%s/marks"\n' "$t" >.git/hooks/pre-commit
printf '#!/bin/sh\necho prepush >>"%s/marks"\n' "$t" >.git/hooks/pre-push
chmod +x .git/hooks/pre-commit .git/hooks/pre-push .githooks/pre-commit
echo x >f && git add f && git commit -qm one
[ "$(tr '\n' ' ' <"$t/marks")" = "repo local " ] && ok "repo hook then .git/hooks chained" || bad "repo hook then .git/hooks chained ($(tr '\n' ' ' <"$t/marks"))"

rm "$t/marks"
chmod -x .githooks/pre-commit
echo y >f && git commit -qam two
[ "$(tr '\n' ' ' <"$t/marks")" = "local " ] && ok "non-executable repo hook falls through" || bad "non-executable repo hook falls through"

rm "$t/marks"
git init -q --bare "$t/hk-origin.git"
git remote add origin "$t/hk-origin.git"
git push -q origin main 2>/dev/null
[ "$(tr '\n' ' ' <"$t/marks")" = "prepush " ] && ok "pre-push only chains .git/hooks" || bad "pre-push only chains .git/hooks"

git init -q "$t/hk2" && cd "$t/hk2" || exit 1
git config core.hooksPath .repohooks
mkdir .repohooks && printf '#!/bin/sh\necho repowins >>"%s/marks2"\n' "$t" >.repohooks/pre-commit && chmod +x .repohooks/pre-commit
warn="$(bash "$H/dispatch" pre-commit 2>&1)"
case "$warn" in *warning*) ok "local core.hooksPath: warning printed" ;; *) bad "local core.hooksPath: warning printed" ;; esac
[ -f "$t/marks2" ] && ok "local core.hooksPath: repo hook wins" || bad "local core.hooksPath: repo hook wins"

echo
[ "$fails" -eq 0 ] && echo "all tests passed" || { echo "$fails test(s) failed"; exit 1; }
