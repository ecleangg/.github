# Local-first checks, attestation and drafts

Two layers keep Actions minutes low without weakening the gates.

| Layer | Where | What runs | Skippable |
| --- | --- | --- | --- |
| 1. pre-commit | developer machine | the repo's own fast hook, then the repo's full `verify` (lint, format, typecheck, tests); on success, a signed attestation is stored automatically | `ECLEAN_SKIP_VERIFY=1` skips verify/attestation (loudly logged); `--no-verify` skips the hook entirely |
| 2. Full CI | GitHub Actions | verify (unless attested), coverage, scans, builds | no |

A pre-push hook does nothing by default: heavy work runs in CI, or already happened in pre-commit.

## Developer setup (once)

```sh
git clone https://github.com/ecleangg/.github && cd .github
chmod +x scripts/* githooks/*         # files arrive without the executable bit
scripts/install-githooks              # machine-wide hook dispatcher
scripts/eclean-attest-setup           # ed25519 signing key, gpg.format=ssh, commit.gpgsign=true
```

`eclean-attest-setup` prints a line. Submit it by pull request to
`.github/attestation/allowed_signers` (format `email namespaces="eclean-verify" ssh-ed25519 AAAA...`),
and upload the same public key to GitHub as a Signing Key (the public repos require signed commits).
Until your key is merged your attestations are simply invalid and CI runs verify normally. Without a
signing key configured at all, pre-commit still runs full verify but warns once and skips
attestation rather than blocking the commit.

## What pre-commit does now

Every `git commit` (once `install-githooks` is set up) runs, in order:

1. The repo's own lightweight hook, if any (`.githooks/pre-commit`, `.husky/pre-commit`, or
   `lefthook run pre-commit`) — unchanged from before.
2. The repo's full verify command, auto-detected the same way as `eclean-attest`
   (`bun run verify`, then `cargo xtask verify`, then `make verify`).
3. On success, a signed attestation for the commit being created is stored automatically under
   `refs/notes/eclean-verify` and pushed to origin — the same mechanism `eclean-attest` uses by hand
   (and still provides, for attesting a commit after the fact, e.g. one made with `--no-verify` or on
   another machine). This step is skipped (with a one-time warning) when no SSH signing key is
   configured; it does not block the commit.
4. On failure, the commit is blocked. The hook prints which command failed and the tail of its
   output.

### Skipping the full verify step

- `ECLEAN_SKIP_VERIFY=1 git commit ...` skips the full verify and attestation step only, and prints a
  loud warning so the skip is never silent. The repo's lightweight hook (step 1) still runs.
- `git commit --no-verify` skips every hook, including the lightweight one, with git's own (silent)
  convention.

## Attesting a commit by hand

To attest a commit after the fact (made with `--no-verify`, on a machine without a signing key at the
time, or from another machine), run from the repo checkout:

```sh
/path/to/.github/scripts/eclean-attest          # or: eclean-attest --cmd "make verify" --key ~/.ssh/key
```

It refuses a dirty tree, runs the repo's verify command (`bun run verify`, `cargo xtask verify`,
`make verify`, in that order), and on success stores a signed note under `refs/notes/eclean-verify`
on HEAD and pushes it to origin. The attestation is bound to the TREE of HEAD plus hashes of
`bun.lock`, `Cargo.lock`, `rust-toolchain.toml`, `go.sum`, `uv.lock` and `package.json` engines. Any
content change invalidates it; an amend or rebase that keeps the same tree does not. Squash-merging
changes the tree, which is why pushes to main always run everything.

## What CI does with it

`actions/verify-attestation` fetches the notes, checks the SSH signature (namespace `eclean-verify`)
against `allowed_signers` read from `ecleangg/.github@main` (a protected branch, so revocations apply
at once; pin another ref through `allowed-signers-source` if you prefer), and requires: same repo, same
tree as the PR head, same lockfile/toolchain hashes, age under `max-age-days` (default 7), attester
not a bot. It never fails the job: `valid=false` plus a reason just means verify runs. The job summary
says `verify skipped: attested by <email> at <time>` or why verify runs.

## Trust model and limits

- A valid attestation lets CI skip only lint, format, typecheck, tests and coverage generation. It never
  skips secret scanning, zizmor/actionlint, Trivy, Opengrep, native dependency audits or image builds.
- A developer machine vouches for its own run. A compromised developer key (or a developer who
  attests without really running verify) can vouch for a bad tree. Mitigations: keep `max-age-days`
  short, review every `allowed_signers` change like a CODEOWNERS change, remove keys when people leave.
- The attestation covers the PR head tree, not the merge with a moved main. Pushes to main run the full CI.
- Only pull requests can skip verify; push, schedule and manual runs always run it.

## Drafts

CI does not run on draft pull requests, except cheap always-on checks: secret scanning and workflow
lint. Full CI runs when a PR is opened ready or marked ready for review, and on pushes to main.

Caller pattern (every repo's CI workflow):

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, converted_to_draft]
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  gate:
    permissions:
      contents: read
    uses: ecleangg/.github/.github/workflows/pr-gate.yml@<sha> # main
  cheap:                     # always, also on drafts
    permissions:
      contents: read
    uses: ecleangg/.github/.github/workflows/security.yml@<sha> # main
    with: { workflows: true, secrets: true }
  security-full:             # skipped on drafts; no change to security.yml needed
    needs: gate
    if: needs.gate.outputs.run-full == 'true'
    permissions:
      contents: read
    uses: ecleangg/.github/.github/workflows/security.yml@<sha> # main
    with:
      workflows: false
      secrets: false
      opengrep: true
      trivy-config: true
      concurrency-key: full
  verify:
    needs: gate
    if: needs.gate.outputs.run-full == 'true' && needs.gate.outputs.skip-verify != 'true'
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      # checkout, toolchain setup, then the repo's verify command
      - run: bun run verify
  ci:                        # the one required check
    needs: [gate, cheap, security-full, verify]
    if: always()
    runs-on: ubuntu-slim
    steps:
      - env:
          RESULTS: ${{ join(needs.*.result, ' ') }}
          SKIPPED: ${{ needs.gate.outputs.skip-verify }}
          DRAFT: ${{ needs.gate.outputs.draft }}
        run: |
          case " $RESULTS " in *" failure "*|*" cancelled "*) exit 1 ;; esac
          [ "$SKIPPED" = true ] && echo "verify skipped by attestation"
          [ "$DRAFT" = true ] && echo "draft: only cheap checks ran"
          exit 0
```

`security.yml` needed no new input: its jobs are already switched by booleans, so the caller runs it
twice (cheap on drafts, heavy when `run-full`), using different `concurrency-key` values.
The required aggregate check passes on drafts and on attested PRs, so branch protection stays satisfied.
