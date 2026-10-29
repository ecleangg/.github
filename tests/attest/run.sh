#!/usr/bin/env bash
# Tests for eclean-attest, eclean-attest-verify, install-githooks and the hook dispatcher.
# Plain bash with assertions; uses throwaway repos and freshly generated ed25519 keys.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../../scripts/eclean-attest-lib.sh
. "$root/scripts/eclean-attest-lib.sh"
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

# --- pre-commit: full verify + automatic attestation ---
git config --global gpg.format ssh
git config --global user.signingkey "$t/key1"

git init -q --bare "$t/pc-origin.git"
git init -q "$t/pc" && cd "$t/pc" || exit 1
git remote add origin "$t/pc-origin.git"
repo_pc="$(git remote get-url origin | sed -E 's#\.git$##; s#^.*[:/]([^/:]+/[^/:]+)$#\1#')"
printf 'verify:\n\t@true\n' >Makefile
echo a >file.txt
git add -A

out="$(git commit -qm init 2>&1)"
if [ $? -eq 0 ]; then ok "(a) commit with working verify succeeds"; else echo "$out"; bad "(a) commit with working verify succeeds"; fi
git notes --ref="$EA_NOTES_REF" list HEAD >/dev/null 2>&1 && ok "(a) note written automatically on commit" || bad "(a) note written automatically on commit"
expect "(a) auto-attested commit verifies" true "$(verify --repo "$repo_pc")"

before="$(git rev-parse HEAD)"
printf 'verify:\n\t@false\n' >Makefile
git add -A
out="$(git commit -qm broken 2>&1)"
if [ $? -ne 0 ]; then ok "(b) failing verify blocks the commit"; else bad "(b) failing verify blocks the commit"; fi
case "$out" in *"commit blocked"*) ok "(b) failure output names the blocked commit" ;; *) bad "(b) failure output names the blocked commit ($out)" ;; esac
after="$(git rev-parse HEAD)"
[ "$before" = "$after" ] && ok "(b) HEAD did not move" || bad "(b) HEAD did not move"
git notes --ref="$EA_NOTES_REF" list HEAD >/dev/null 2>&1
[ "$(git notes --ref="$EA_NOTES_REF" list | wc -l | tr -d ' ')" = 1 ] && ok "(b) no new attestation written" || bad "(b) no new attestation written"

out="$(ECLEAN_SKIP_VERIFY=1 git commit -qam skip 2>&1)"
if [ $? -eq 0 ]; then ok "(c) ECLEAN_SKIP_VERIFY lets a failing-verify commit through"; else echo "$out"; bad "(c) ECLEAN_SKIP_VERIFY lets a failing-verify commit through"; fi
case "$out" in *"ECLEAN_SKIP_VERIFY=1 set"*) ok "(c) skip is logged loudly" ;; *) bad "(c) skip is logged loudly ($out)" ;; esac
[ "$(git notes --ref="$EA_NOTES_REF" list | wc -l | tr -d ' ')" = 1 ] && ok "(c) skipped commit has no attestation" || bad "(c) skipped commit has no attestation"

printf 'verify:\n\t@true\n' >Makefile
git add -A
git config --global --unset gpg.format
git config --global --unset user.signingkey
out="$(git commit -qm fixed 2>&1)"
if [ $? -eq 0 ]; then ok "(e) commit succeeds with no signing key configured"; else echo "$out"; bad "(e) commit succeeds with no signing key configured"; fi
case "$out" in *"no signing key configured"*) ok "(e) missing signing key warns" ;; *) bad "(e) missing signing key warns ($out)" ;; esac
[ "$(git notes --ref="$EA_NOTES_REF" list | wc -l | tr -d ' ')" = 1 ] && ok "(e) no attestation written without a signing key" || bad "(e) no attestation written without a signing key"
git config --global gpg.format ssh
git config --global user.signingkey "$t/key1"

# (d) repo-local pre-commit hook chaining is covered above ("repo hook then .git/hooks chained" etc.),
# re-run here with full verify active to prove it still fires alongside the new behaviour.
mkdir .githooks
printf '#!/bin/sh\necho repo >>"%s/marks3"\n' "$t" >.githooks/pre-commit
chmod +x .githooks/pre-commit
echo b >>file.txt && git add -A && git commit -qm chained >/dev/null 2>&1
[ -f "$t/marks3" ] && ok "(d) repo-local pre-commit hook still chains alongside full verify" || bad "(d) repo-local pre-commit hook still chains alongside full verify"

cd "$t" || exit 1

echo
[ "$fails" -eq 0 ] && echo "all tests passed" || { echo "$fails test(s) failed"; exit 1; }
