# Local-first checks and drafts

Two layers keep Actions minutes low without weakening the gates.

| Layer | Where | What runs | Skippable |
| --- | --- | --- | --- |
| 1. pre-commit | developer machine | the repo's own fast hook, then the repo's `verify` on the staged files only; a failure blocks the commit | `ECLEAN_SKIP_VERIFY=1` skips verify (loudly logged); `--no-verify` skips the hook entirely |
| 2. CI | GitHub Actions | what the pull request or push changed, skipping a tree that already passed in CI | no |

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
2. The repo's verify command, auto-detected: `bun run verify`, then `cargo xtask verify`, then
   `make verify`, on the staged files only. The hook sets the same contract CI's
   `actions/changed-files` does (`CI_CHANGES_FULL=false`, `CI_CHANGES_FILES` listing the staged paths,
   `CI_CHANGES_BASE=HEAD`) and puts `ci-scope`, `ci-rust-packages` and `ci-go-packages` on `PATH`, so a
   verify written with them formats and lints the staged files and tests the affected packages. A
   verify that does not use that contract would check the whole repository, so the hook leaves it to
   CI and says so; `ECLEAN_FULL_VERIFY=1 git commit ...` runs it in full. A staged tree that already
   passed is not verified again. On failure the commit is blocked; the hook prints the failed command
   and the tail of its output.

Each hook then chains to the repo's own `.git/hooks/<name>`, if present.

### Skipping

- `ECLEAN_SKIP_VERIFY=1 git commit ...` skips the verify only, with a loud warning. The repo's
  lightweight hook still runs.
- `git commit --no-verify` skips every hook.

## CI

CI never trusts what ran on a developer machine; nothing a hook does lets CI skip work. CI checks what
the pull request or push changed, and skips a job whose variant already passed on the same tree in CI
(see [Test results](ci-standard.md#test-results)). Draft pull requests run only the cheap security
checks (secret scan and workflow lint). Full CI starts when the PR is marked ready for review.
