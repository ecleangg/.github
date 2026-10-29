# Org rulesets

Applied with `scripts/apply-rulesets.sh`. Org rulesets, required reviewers and environment protection need a paid
GitHub plan; the files are kept here so upgrading is one command.

- `main-protection`: default branch of every repo. No deletion or force push, linear history, PR required with squash only,
  stale approvals dismissed, conversations resolved. Org admins can bypass through a PR.
- `signed-commits-public`: signed commits on the public repos (`.github`, `mta-sts`).
- `release-tags`: `v*` tags cannot be deleted, moved or force-pushed.

When upgrading to a paid plan also: run `scripts/apply-rulesets.sh`, run `scripts/protect-environments.sh <reviewers>`,
turn on GitHub Secret Protection and Code Security for the org (secret scanning, push protection, code scanning on private repos),
raise `required_approving_review_count` to 1 where more than one person works on a repo, add `required_status_checks` once
CI is refactored, and add CODEOWNERS where reviewers should be requested automatically.
