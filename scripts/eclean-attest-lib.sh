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
