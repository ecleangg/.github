# CI standard

How CI is shared across the ecleangg repos. The building blocks live in this repository
(`ecleangg/.github`) and are public so private repos on the Free plan can call them. Everything runs on
GitHub-hosted runners, nothing is uploaded to code scanning (private repos cannot use it), and every
result is a markdown table in the job summary plus the job's exit code.

## The `verify` contract

Every repo has one command named `verify` that runs lint, the format check, the type check and the
tests, and exits non-zero on any failure. CI runs that command; so does a developer before pushing.
How it is spelled is the repo's business (`bun run verify`, `just verify`, `make verify`,
`./scripts/verify`), but the name and the meaning are the same everywhere. Language-native audits
(below) are separate CI jobs, not part of `verify`, because they need the network.

## Native tool first

A shared tool is used only where the language's own tooling cannot do the job. The repos run the
native column themselves.

| Language or artifact | Dependencies | Static analysis | Shared tool |
| --- | --- | --- | --- |
| Rust | `cargo deny` / `cargo audit` | `clippy` | none |
| Go | `govulncheck` | `golangci-lint` (includes `gosec`) | none |
| Python | `pip-audit` / `uv audit` | `ruff` with the `S` rules | none |
| TypeScript, JavaScript (bun) | `bun audit` | Opengrep with the Semgrep TS/JS security rules | `security.yml` `opengrep` |
| Ansible | none | `ansible-lint` | none |
| Dockerfile | n/a | Trivy misconfiguration | `security.yml` `trivy-config` |
| Built or published image | Trivy (OS and language packages, secrets) | n/a | `actions/trivy-image`, `trivy-image-scheduled.yml` |
| GitHub Actions workflows | n/a | actionlint and zizmor | `security.yml` `workflows` |
| Secrets in git history | n/a | TruffleHog, verified only | `security.yml` `secrets` |
| Lockfiles of an ecosystem with no native audit | OSV-Scanner | n/a | `security.yml` `osv` (off by default) |
| Coverage report | n/a | n/a | `actions/coverage-summary` |
| SBOM | n/a | n/a | `actions/sbom` |

## Blocking policy

- A pull request fails on a HIGH or CRITICAL finding, or on any actionlint error or zizmor finding of
  severity high, and only on findings the pull request introduces. The baseline is the pull request base
  (the first parent of the merge commit). A push is compared with the commit before it. A run with
  nothing to compare with (`workflow_dispatch`, the first push of a branch) reports and does not fail.
- `schedule` runs list the whole backlog in the job summary and never fail.
- Coverage is report only.
- Secrets: TruffleHog with `--only-verified`; a verified live secret fails the run. The secret itself is
  never printed.
- Severity: OSV reads `database_specific.severity` of the entries (GHSA: LOW, MODERATE, HIGH, CRITICAL),
  and without it the group's highest CVSS base score (7.0 and up is HIGH, 9.0 and up CRITICAL). With
  neither it is UNKNOWN: reported, never blocking. Opengrep blocks on severity ERROR only; WARNING and
  INFO are listed. Trivy blocks on HIGH and CRITICAL.
- Runners: `ubuntu-slim` wherever it works (it has a 15-minute job limit and no Docker daemon). Jobs
  that need Docker run on `ubuntu-24.04`. `security.yml` takes `runs-on` to move its jobs.

## Calling the workflows

Every `uses:` is pinned to a full commit SHA with a trailing version comment; Renovate keeps the SHA
fresh (see the end). Callers grant the job at least `contents: read`.

### `security.yml`

```yaml
name: Security
on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: "17 4 * * 1"
  workflow_dispatch:
permissions:
  contents: read
jobs:
  security:
    permissions:
      contents: read
    uses: ecleangg/.github/.github/workflows/security.yml@<sha> # <ref>
    with:
      opengrep: true # TypeScript or JavaScript in the repo
      trivy-config: true # Dockerfiles in the repo
      exclude: |
        vendor
```

| Input | Default | Meaning |
| --- | --- | --- |
| `workflows` | `true` | actionlint and zizmor over `.github/workflows` and `.github/actions` |
| `secrets` | `true` | TruffleHog `--only-verified`, full history on `schedule`, the PR or push range otherwise |
| `osv` | `false` | OSV-Scanner over lockfiles (recursive), head against base, by (ecosystem, package, vulnerability) |
| `opengrep` | `false` | Opengrep with the Semgrep TypeScript and JavaScript security rules |
| `trivy-config` | `false` | Trivy misconfiguration scan of Dockerfiles, HIGH and CRITICAL |
| `runs-on` | `ubuntu-slim` | Runner label of every job |
| `path` | `.` | Directory to scan, relative to the repo root |
| `exclude` | empty | Newline-separated directories, relative to `path`, skipped by osv, opengrep and trivy-config |
| `baseline` | `true` | `false`: every finding blocks (used by the self-test) |
| `report-only` | `false` | Report, never fail |
| `concurrency-key` | empty | Suffix of the concurrency group, for callers that call the workflow twice |

Outputs: `workflows-blocking`, `secrets-blocking`, `osv-blocking`, `opengrep-blocking`,
`trivy-config-blocking` (counts). Concurrency cancels superseded pull request runs.

The Opengrep rules are the Semgrep rules repository at a pinned commit, checked out into
`.opengrep-rules` during the run. They fall under the Semgrep Rules License v1.0 (internal business
use): never commit them or copy them anywhere. Opengrep has no telemetry and no `--metrics` flag.

### `trivy-image-scheduled.yml`

Pulls a published ghcr image and reports the full backlog; never fails.

```yaml
name: Image scan
on:
  schedule:
    - cron: "37 5 * * *"
  workflow_dispatch:
permissions:
  contents: read
jobs:
  scan:
    permissions:
      contents: read
      packages: read
    uses: ecleangg/.github/.github/workflows/trivy-image-scheduled.yml@<sha> # <ref>
    with:
      image: ghcr.io/ecleangg/api-rs:latest
```

Inputs: `image` (required), `ignore-file` (default `.trivyignore`, read from the caller's repo),
`runs-on` (default `ubuntu-slim`).

### `stale.yml` and `delete-runs.yml`

```yaml
jobs:
  stale:
    permissions:
      actions: write
      issues: write
      pull-requests: write
    uses: ecleangg/.github/.github/workflows/stale.yml@<sha> # <ref>
  delete-runs:
    permissions:
      actions: write
      contents: read
    uses: ecleangg/.github/.github/workflows/delete-runs.yml@<sha> # <ref>
```

Neither takes inputs. This repo calls them from `stale-management.yml` and `delete-runs-scheduled.yml`.

## Composite actions

All three are used as `uses: ecleangg/.github/.github/actions/<name>@<sha> # <ref>`.

### `actions/trivy-image`

Scans an image (`image`, pulled from its registry) or a `docker save` archive (`tarball`) for fixed
HIGH and CRITICAL vulnerabilities and for secrets, without a Docker daemon.

| Input | Default | Meaning |
| --- | --- | --- |
| `image`, `tarball` | empty | Exactly one of them |
| `ignore-file` | `.trivyignore` | The baseline: findings listed there do not count. A missing file means none |
| `fail` | `true` | `false` reports only (use on `schedule`) |
| `severity` | `HIGH,CRITICAL` | Severities that count |
| `registry-username`, `registry-password` | empty | Credentials for a private image |
| `title` | the image | Summary heading |

Outputs: `findings`, `report-file`. Every `.trivyignore` entry needs a reason, as a comment on the line
above it or after it; an entry without one fails the step.

```yaml
- uses: ecleangg/.github/.github/actions/trivy-image@<sha> # <ref>
  with:
    tarball: ${{ runner.temp }}/image.tar
```

### `actions/coverage-summary`

Writes a coverage report to the job summary and, on pull requests, a sticky comment (one per `name`):
total line and branch coverage, the delta against the latest run on the default branch, the 10
lowest-covered files and a collapsed table of all of them. On a push to the default branch it uploads
the baseline artifact `coverage-<name>`. A missing baseline is stated in the report, never an error.

| Input | Default | Meaning |
| --- | --- | --- |
| `name` | required | Keys the comment header and the artifact |
| `format` | required | `lcov` (`cargo llvm-cov --lcov`, vitest), `go` (`go test -coverprofile`), `vitest-json` (`json-summary`) |
| `file` | required | The coverage file |
| `baseline-artifact` | `coverage-<name>` | Baseline artifact name |
| `fail-on-error` | `false` | Fail when the file cannot be parsed |
| `comment` | `true` | Post the pull request comment (fork pull requests cannot) |

Outputs: `line-percent`, `branch-percent`, `report-file`. The job needs `actions: read` (baseline
download) and `pull-requests: write` (comment). Go has no branch coverage; its statements are reported
as lines.

### `actions/sbom`

CycloneDX JSON SBOM of a `path` or an `image` (Syft through `anchore/sbom-action`), uploaded as an
artifact (`artifact-name`, `upload-artifact`) and, with `release-tag`, attached to that release (the
caller needs `contents: write`). `output-file` defaults to `sbom.cdx.json`. A directory works on
`ubuntu-slim`; an image in the local Docker daemon needs `ubuntu-24.04`.

## Baselines and suppressions

Every suppression says why. A suppression without a reason is a finding in review.

| Tool | Where | How |
| --- | --- | --- |
| Trivy (image and Dockerfile) | `.trivyignore` at the repo root (or `path`) | One ID per line, a comment above it with the reason. The file is the baseline for images |
| zizmor | `.github/zizmor.yml`, or `# zizmor: ignore[rule] reason` | Read automatically |
| actionlint | none | Fix it, or `# shellcheck disable=SCxxxx reason` for a script |
| Opengrep | `// nosemgrep: <rule-id> reason` on the line | Prefer fixing; the rule id is in the summary table |
| OSV | `osv-scanner.toml` with `[[IgnoredVulns]]`, `id` and `reason` | Read automatically |
| TruffleHog | none | Verified secrets are live: rotate them |

Pull requests are compared with their base, so an old finding never blocks an unrelated change. To see
the whole backlog, run the workflow by hand or wait for the `schedule` run.

## How the pins stay fresh

The org Renovate preset (`github>ecleangg/.github`) enables `helpers:pinGitHubActionDigests`, so
Renovate rewrites every `uses:` to a full SHA with a `# vX.Y.Z` comment and opens PRs when a new release
appears, for the `ecleangg/.github` reusable workflows and actions too. Org policy rejects a workflow
whose action or reusable workflow is not pinned to a full SHA, and only allows GitHub-owned actions,
verified creators and the org allowlist.

The scanner binaries inside `security.yml` and `actions/trivy-image` (actionlint, zizmor, TruffleHog,
OSV-Scanner, Opengrep, Trivy) are downloaded from the vendor release and verified with `sha256sum -c`
against a digest stored in the workflow. Renovate does not move those: bump the version and the digest
together by hand (the digest is `gh api repos/<owner>/<repo>/releases/latest --jq '.assets[] | select(.name == "<asset>") | .digest'`),
and the Semgrep rules commit the same way. The self-test (`selftest.yml`) must be green before merging
such a bump.
