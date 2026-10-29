#!/usr/bin/env bash
# Require review and limit deploy branches on production environments. Needs a paid plan for private repos.
# usage: protect-environments.sh <reviewer-login> [<reviewer-login>...]
set -euo pipefail

ORG=ecleangg
ENVIRONMENTS=("website:production" "containers:production" "control-center:production" "desktop-app:windows-release")

reviewers=()
for login in "$@"; do
  reviewers+=("$(gh api "users/$login" --jq '{type:"User",id:.id}')")
done
reviewers_json=$(printf '%s\n' "${reviewers[@]}" | jq -s .)

for entry in "${ENVIRONMENTS[@]}"; do
  repo=${entry%%:*}
  env=${entry#*:}
  echo "protect $repo/$env"
  jq -n --argjson r "$reviewers_json" \
    '{reviewers:$r,prevent_self_review:false,deployment_branch_policy:{protected_branches:false,custom_branch_policies:true}}' |
    gh api -X PUT "repos/$ORG/$repo/environments/$env" --input - --silent
  gh api -X POST "repos/$ORG/$repo/environments/$env/deployment-branch-policies" -f name=main -f type=branch --silent 2>/dev/null || true
done
