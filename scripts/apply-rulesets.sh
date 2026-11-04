#!/usr/bin/env bash
# Create or update the org rulesets in rulesets/*.json. Org rulesets need a paid plan (Team or higher);
# on Free the API answers 403/404, so this is safe to run any time and takes effect on upgrade.
# Add a required_status_checks rule to main-protection.json once the CI check names are stable.
set -euo pipefail

ORG=ecleangg
ROOT=$(cd "$(dirname "$0")/.." && pwd)

for file in "$ROOT"/rulesets/*.json; do
  name=$(jq -r .name "$file")
  id=$(gh api "orgs/$ORG/rulesets" --jq ".[]|select(.name==\"$name\")|.id" 2>/dev/null || true)
  if [ -n "$id" ]; then
    echo "update $name"
    gh api -X PUT "orgs/$ORG/rulesets/$id" --input "$file" --silent
  else
    echo "create $name"
    gh api -X POST "orgs/$ORG/rulesets" --input "$file" --silent
  fi
done
