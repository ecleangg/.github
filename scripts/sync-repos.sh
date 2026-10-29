#!/usr/bin/env bash
# Apply settings.yml and the label set to every non-archived repo in the org.
# Needs a token with repo + admin:org scope. Pass DRY_RUN=1 to only print.
set -euo pipefail

ORG=ecleangg
ROOT=$(cd "$(dirname "$0")/.." && pwd)
run() { if [ "${DRY_RUN:-}" = 1 ]; then echo "+ $*"; else "$@"; fi; }

# Flatten settings.yml into gh api -F/-f flags.
flags=()
while IFS=': ' read -r key value; do
  case $value in true | false) flags+=(-F "$key=$value") ;; *) flags+=(-f "$key=$value") ;; esac
done < <(grep -E '^  [a-z_]+: ' "$ROOT/settings.yml" | sed 's/^  //')

for repo in $(gh repo list "$ORG" --no-archived --limit 300 --json name --jq '.[].name'); do
  echo "== $repo"
  run gh api -X PATCH "repos/$ORG/$repo" "${flags[@]}" --silent
  run gh api -X PUT "repos/$ORG/$repo/vulnerability-alerts" --silent
  run gh api -X PUT "repos/$ORG/$repo/automated-security-fixes" --silent

  # Labels: copy this repo's set to every other repo, then delete strays.
  while IFS=$'\t' read -r name color desc; do
    enc=$(jq -rn --arg n "$name" '$n|@uri')
    run gh api -X POST "repos/$ORG/$repo/labels" -f name="$name" -f color="$color" -f description="$desc" --silent 2>/dev/null ||
      run gh api -X PATCH "repos/$ORG/$repo/labels/$enc" -f color="$color" -f description="$desc" --silent
  done < <(gh api "repos/$ORG/.github/labels" --paginate --jq '.[]|[.name,.color,.description]|@tsv')

  comm -13 <(gh api "repos/$ORG/.github/labels" --paginate --jq '.[].name' | sort) \
    <(gh api "repos/$ORG/$repo/labels" --paginate --jq '.[].name' | sort) |
    while read -r stray; do
      run gh api -X DELETE "repos/$ORG/$repo/labels/$(jq -rn --arg n "$stray" '$n|@uri')" --silent
    done
done
