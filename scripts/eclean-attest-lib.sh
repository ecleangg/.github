# shellcheck shell=bash disable=SC2034
# Shared by eclean-attest and eclean-attest-verify (sourced, not executed).
# Fingerprint of the files whose change must invalidate an attestation, read from a commit so the
# result does not depend on the working tree.

EA_NOTES_REF="refs/notes/eclean-verify"
EA_NAMESPACE="eclean-verify"

# ea_files_json [ref]: compact JSON object {"file":"blob sha",...} in a fixed order.
ea_files_json() {
  local ref="${1:-HEAD}" f out="" sep="" h
  for f in bun.lock Cargo.lock rust-toolchain.toml go.sum uv.lock; do
    if git cat-file -e "$ref:$f" 2>/dev/null; then
      out="$out$sep\"$f\":\"$(git rev-parse "$ref:$f")\""
      sep=","
    fi
  done
  if git cat-file -e "$ref:package.json" 2>/dev/null; then
    h="$(git show "$ref:package.json" | awk '/"engines"[[:space:]]*:/{f=1} f{print} f&&/}/{exit}' | git hash-object --stdin)"
    out="$out$sep\"package.json#engines\":\"$h\""
  fi
  printf '{%s}' "$out"
}

# ea_field name payload-file: value of a string or number field of the (signature-checked) payload.
ea_field() {
  sed -n -e "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p" -e "s/.*\"$1\":\\([0-9][0-9]*\\).*/\\1/p" "$2" | head -n 1
}

# ea_detect_verify_cmd: echoes the repo's verify command, or returns 1 if none is found.
ea_detect_verify_cmd() {
  if [ -f package.json ] && grep -q '"verify"[[:space:]]*:' package.json; then echo "bun run verify"
  elif [ -f Cargo.toml ] && [ -d xtask ]; then echo "cargo xtask verify"
  elif [ -f Makefile ] && grep -q '^verify:' Makefile; then echo "make verify"
  else return 1
  fi
}

# ea_resolve_repo: echoes owner/name derived from the origin remote, or returns 1.
ea_resolve_repo() {
  local url
  url="$(git remote get-url origin 2>/dev/null)" || return 1
  printf '%s' "$url" | sed -E 's#\.git$##; s#^.*[:/]([^/:]+/[^/:]+)$#\1#'
}

# ea_resolve_key: echoes the configured ssh signing key path, or returns 1 if not configured.
ea_resolve_key() {
  local key
  [ "$(git config --get gpg.format || true)" = "ssh" ] || return 1
  key="$(git config --get user.signingkey || true)"
  [ -n "$key" ] || return 1
  case "$key" in "~/"*) key="$HOME/${key#"~/"}" ;; esac
  [ -e "$key" ] || return 1
  printf '%s' "$key"
}

# ea_clean value: redact a value for embedding in the JSON payload.
ea_clean() { printf '%s' "$1" | tr -d '"' | tr -d '\\' | tr -d '\000-\037' | cut -c1-200; }

# ea_tools_json: compact JSON object {"tool":"version",...} of the tools available on PATH.
ea_tools_json() {
  local tools="" sep="" t v
  for t in bun node rustc go uv; do
    command -v "$t" >/dev/null 2>&1 || continue
    if [ "$t" = go ]; then v="$(go version 2>&1 | head -n 1)" || true; else v="$("$t" --version 2>&1 | head -n 1)" || true; fi
    tools="$tools$sep\"$t\":\"$(ea_clean "$v")\""
    sep=","
  done
  printf '%s' "$tools"
}

# ea_e2e_cmd: echoes the repo's optional end-to-end command (`bun run verify:e2e`), or returns 1.
ea_e2e_cmd() {
  if [ -f package.json ] && grep -q '"verify:e2e"[[:space:]]*:' package.json; then echo "bun run verify:e2e"
  else return 1
  fi
}

# ea_write_note repo cmd key push [suites]: build the signed payload for HEAD and store/push the note.
# Assumes the working tree is already clean and that `cmd` (and the end-to-end command, when suites
# is "verify,e2e") already ran successfully against it. suites defaults to "verify"; notes without
# the field count as "verify".
ea_write_note() {
  local repo="$1" cmd="$2" key="$3" push="$4" suites="${5:-verify}"
  local attester now stamp commit tree tmp
  attester="$(git config --get user.email || true)"
  [ -n "$attester" ] || { echo "eclean-attest: git user.email is not set" >&2; return 1; }
  now="$(date -u +%s)"
  stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  commit="$(git rev-parse HEAD)"
  tree="$(git rev-parse 'HEAD^{tree}')"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  printf '{"v":1,"repo":"%s","commit":"%s","tree":"%s","cmd":"%s","suites":"%s","files":%s,"tools":{%s},"epoch":%s,"time":"%s","attester":"%s"}\n' \
    "$(ea_clean "$repo")" "$commit" "$tree" "$(ea_clean "$cmd")" "$(ea_clean "$suites")" "$(ea_files_json HEAD)" "$(ea_tools_json)" "$now" "$stamp" "$(ea_clean "$attester")" >"$tmp/payload"
  ssh-keygen -Y sign -n "$EA_NAMESPACE" -f "$key" "$tmp/payload" >/dev/null || { echo "eclean-attest: signing failed" >&2; return 1; }
  cat "$tmp/payload" "$tmp/payload.sig" >"$tmp/note"

  # Merge notes other developers pushed first so the push is a fast-forward.
  if [ "$push" = 1 ] && git fetch -q origin "+$EA_NOTES_REF:refs/eclean-tmp/notes" 2>/dev/null; then
    if git rev-parse -q --verify "$EA_NOTES_REF" >/dev/null; then
      git notes --ref="$EA_NOTES_REF" merge -s ours refs/eclean-tmp/notes >/dev/null 2>&1 || true
    else
      git update-ref "$EA_NOTES_REF" refs/eclean-tmp/notes
    fi
    git update-ref -d refs/eclean-tmp/notes
  fi
  git notes --ref="$EA_NOTES_REF" add -f -F "$tmp/note" HEAD
  if [ "$push" = 1 ]; then
    git push -q origin "$EA_NOTES_REF" || { echo "eclean-attest: could not push $EA_NOTES_REF (note kept locally)" >&2; return 2; }
  fi
  echo "eclean-attest: attested ${commit:0:12} (tree ${tree:0:12}) as $attester"
}
