# Local-first checks and drafts

Two layers keep Actions minutes low without weakening the gates.

| Layer | Where | What runs | Skippable |
| --- | --- | --- | --- |
| 1. pre-commit | developer machine | the repo's own fast hook, then the repo's full `verify` (lint, format, typecheck, tests); a failure blocks the commit | `ECLEAN_SKIP_VERIFY=1` skips verify (loudly logged); `--no-verify` skips the hook entirely |
| 2. CI | GitHub Actions | everything, every time | no |

A pre-push hook does nothing: heavy work runs in pre-commit and CI.

## Developer setup (once)

```sh
git clone https://github.com/ecleangg/.github && cd .github
chmod +x scripts/* githooks/*         # files arrive without the executable bit
scripts/install-githooks              # machine-wide hook dispatcher
scripts/setup-commit-signing          # ed25519 signing key, gpg.format=ssh, commit.gpgsign=true
```

`setup-commit-signing` prints the public key. Upload it to GitHub as a Signing Key (the public repos
require signed commits).

## What pre-commit does

Every `git commit` (once `install-githooks` is set up) runs, in order:

1. The repo's own lightweight hook, if any (`.githooks/pre-commit`, `.husky/pre-commit`, or
   `lefthook run pre-commit`), unchanged.
2. The repo's full verify command, auto-detected: `bun run verify`, then `cargo xtask verify`, then
   `make verify`. On failure the commit is blocked; the hook prints the failed command and the tail of
   its output.

Each hook then chains to the repo's own `.git/hooks/<name>`, if present.

### Skipping

- `ECLEAN_SKIP_VERIFY=1 git commit ...` skips the full verify only, with a loud warning. The repo's
  lightweight hook still runs.
- `git commit --no-verify` skips every hook.

## CI

CI always runs everything: it never trusts what ran on a developer machine. Draft pull requests run
only the cheap security checks (secret scan and workflow lint). Full CI starts when the PR is marked
ready for review, and on pushes to main.
