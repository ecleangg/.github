# CI standard

How CI is shared across the ecleangg repos. The building blocks live in this repository
(`ecleangg/.github`) and are public so private repos on the Free plan can call them. Workflows that
publish or hold deploy credentials live in the private `ecleangg/.github-private`. Nothing is uploaded to
code scanning (private repos cannot use it); every result is a markdown table in the job summary plus
the job's exit code.

## Runners

All shared workflows run on the self-hosted Linux pool by default. Every workflow takes a `runs-on`
input: a runner label (`ubuntu-24.04`) or a JSON array of labels.

| Pool | Labels | Use |
| --- | --- | --- |
| Linux | `["self-hosted","Linux","X64"]` (default) | Everything. Four ephemeral just-in-time lanes on one x64 host |
| Windows | `["self-hosted","Windows","X64"]` | Windows-only work that needs no secrets |
| GitHub-hosted | `ubuntu-24.04`, `ubuntu-slim` | Public repos: the self-hosted groups do not serve them. This repository's own self-test runs on `ubuntu-slim` |

The Linux lanes share persistent caches on the host: cargo, rustup, sccache, bun, npm, go, uv, the
runner tool cache, Playwright browsers, and `ECLEAN_ACTIONS_CACHE` (used by `actions/local-cache`).

Installed on the runners: Node 26 LTS, Bun, Go (`GOTOOLCHAIN=auto`), rustup with stable, uv, gh, jq,
ShellCheck, a C toolchain, CMake, Clang, ansible-lint, Docker with buildx, Playwright system libraries.
The setup actions (`setup-bun`, `setup-go`, Rust toolchain installs) run only on GitHub-hosted runners
(`runner.environment == 'github-hosted'`); on the self-hosted lanes the tool is already there.

## The `verify` contract

Every repo has one command named `verify` that runs lint, the format check, the type check and the
tests, and exits non-zero on any failure. CI runs that command; so does a developer before pushing.
How it is spelled is the repo's business (`bun run verify`, `just verify`, `make verify`,
`./scripts/verify`), but the name and the meaning are the same everywhere. Language-native audits
(below) are separate CI jobs, not part of `verify`, because they need the network.

CI always runs everything; it never trusts what ran on a developer machine. The local hooks are in
[local-first.md](local-first.md).

## Native tool first

A shared tool is used only where the language's own tooling cannot do the job. The repos run the
native column themselves.

| Language or artifact | Dependencies | Static analysis | Shared tool |
| --- | --- | --- | --- |
| Rust | `cargo deny` / `cargo audit` | `clippy` | none |
| Go | `govulncheck` | `golangci-lint` (includes `gosec`) | none |
| Python | `pip-audit` / `uv audit` | `ruff` with the `S` rules | none |
| TypeScript, JavaScript (bun) | `bun audit` | Opengrep with the Semgrep TS/JS security rules | `security.yml` `opengrep` |
| Ansible | none | `ansible-lint` (on the runners) | none |
| Dockerfile | n/a | Trivy misconfiguration | `security.yml` `trivy-config` |
| Built or published image | Trivy (OS and language packages, secrets) | n/a | `actions/trivy-image`, `trivy-image-scheduled.yml` |
| GitHub Actions workflows | n/a | actionlint and zizmor | `security.yml` `workflows` |
| Secrets in git history | n/a | TruffleHog, verified only | `security.yml` `secrets` |
| Lockfiles of an ecosystem with no native audit | OSV-Scanner | n/a | `security.yml` `osv` (off by default) |
| Coverage report | n/a | n/a | `actions/coverage-summary` |
| SBOM | n/a | n/a | `actions/sbom` |

## Draft pull requests

- Heavy jobs carry a job-level `if: ${{ !github.event.pull_request.draft }}`. GitHub skips them without
  assigning a runner, so a draft costs nothing. A skipped required check counts as passed.
- `security.yml` runs on drafts: the secret scan and the workflow lint are day-one checks. `osv`,
  `opengrep` and `trivy-config` wait for ready for review.
- The `ready_for_review` event starts full CI. Callers list it in `pull_request.types`.
- The `CI` summary job of `bun-ci`, `rust-ci`, `go-ci` and `verify` is skipped on drafts too.

## Changed-files policy

- A pull request checks only what it changes. `actions/changed-files` lists the changed files and
  `filters` decides whether the code steps run at all. Commands use `ci-scope` (format, lint),
  `vitest run --changed "$ECLEAN_BASE"` (tests), `ci-rust-packages` (`-p` arguments) and
  `ci-go-packages` (import paths).
- Pushes, schedules, manual runs, merge queues, pull requests touching a lockfile, a toolchain pin or
  tool configuration (built-in list, extended with `full-patterns`), and pull requests changing more
  than `max-files` files (400) check everything.
- A docs-only pull request (nothing matches the `code` filter) skips the steps; the `CI` summary job
  still runs and reports success, so branch protection needs only that one check.
- Audits (`audit` input) are not scoped by changes; they run on every non-draft event.

## Caching

| What | Where | Details |
| --- | --- | --- |
| Tool caches (cargo, rustup, sccache, bun, npm, go, uv, toolcache, Playwright) | Runner disk, shared by the lanes | Nothing to configure |
| Workspace paths (`cache-paths`, `build-cache-paths`) | `actions/local-cache` | `$ECLEAN_ACTIONS_CACHE/<owner>/<repo>/<ref>/<key>.tar`; reads the run's own ref first, then the default branch; entries are immutable; the oldest are evicted past `ECLEAN_ACTIONS_CACHE_MAX_GB` (40). Falls back to `actions/cache` where the variable is unset |
| Rust `target/` | `actions/local-cache` | Restored by every run, saved from the default branch once per toolchain and `Cargo.lock`. sccache covers the rest. Off with `cache-target: false` |
| BuildKit layers (`docker-build.yml`) | `$ECLEAN_ACTIONS_CACHE/<owner>/<repo>/buildx/<name>` | Read by every run, written from the default branch; GitHub-hosted runners use the Actions cache |
| Trivy vulnerability DB | `$ECLEAN_ACTIONS_CACHE/trivy-db/<day>` | One download per day per host |
| Scanner binaries (Trivy, actionlint, zizmor, TruffleHog, OSV-Scanner, Opengrep) | `$RUNNER_TOOL_CACHE/eclean-downloads/<sha256>` | Keyed by the pinned digest and re-verified with `sha256sum -c` on every use |

Release jobs set `cache-mode: none`: a release never restores a cache another job could have written.

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
- Runners: see [Runners](#runners). `security.yml` and every other workflow take `runs-on` to move their jobs.

## Callers

- Every `uses:` is pinned to a full commit SHA with a trailing ref comment:
  `uses: ecleangg/.github/.github/workflows/bun-ci.yml@<sha> # main`. Org policy rejects anything else.
- During a rollout branch, callers pin the branch SHA and comment the branch name
  (`# ci/self-hosted-overhaul`). After the branch merges they are re-pinned to `main`.
- Callers grant each job at least `contents: read`; the catalogue lists what more a workflow needs. A
  caller job cannot grant more than the caller workflow's own `permissions`.
- Workflow templates for new repos are in [`workflow-templates/`](../workflow-templates).
- Inside this repository the workflows reference their own actions as `$/.github/actions/<name>`
  (self-repository `uses`); callers always use the full `ecleangg/.github/.github/actions/<name>@<sha>`.
- The workflows use current GitHub Actions syntax: YAML anchors, `case()`, `parallel:` steps,
  `concurrency.queue: max`, job `cache-mode`, `$/` paths. actionlint 1.7.12 does not know some of these
  keys; `security.yml` and `.github/actionlint.yaml` ignore exactly those messages and nothing else.

## Catalogue

### Reusable workflows

`ecleangg/.github/.github/workflows/<file>@<sha> # <ref>`. Every workflow has the input `runs-on`
(default `["self-hosted","Linux","X64"]`); it is not repeated in the tables below. `outputs.result` of
`bun-ci`, `rust-ci`, `go-ci` and `verify` is `success` or `failure`.

#### bun-ci

`bun-ci.yml`: Bun/TypeScript. Jobs `verify` (install, format, lint and typecheck in parallel, tests,
extra, audit, coverage), `build` (when `build` is set) and `CI` (sums them up for branch protection).
Permissions: `contents: read`, `packages: read`, `actions: read`, `pull-requests: write` (coverage
comment).

| Input | Default | Meaning |
| --- | --- | --- |
| `working-directory` | `.` | Bun project directory |
| `bun-version-file` | `package.json` | File setup-bun reads the version from (GitHub-hosted runners only) |
| `registries` | empty | setup-bun `registries`, e.g. `@ecleangg:https://npm.pkg.github.com/\|$NODE_AUTH_TOKEN` (the workflow token) |
| `install` | `bun install --frozen-lockfile` | Install command |
| `env` | empty | `NAME=value` lines exported to every step (no secrets) |
| `filters` | `code: * !*.md !docs/* !LICENSE* ...` | `actions/changed-files` filters; steps run only when `code` matches |
| `full-patterns` | empty | Extra globs that make a pull request check everything |
| `format` | empty | Format check, e.g. `ci-scope --full "bun run format:check" -- bunx oxfmt --check` |
| `lint` | empty | Lint command(s) |
| `typecheck` | empty | Type check command(s) |
| `playwright-browsers` | empty | Browsers to install before the tests (system libraries are on the runner) |
| `test` | empty | Test command(s) |
| `extra` | empty | More checks after the tests (multi-line script) |
| `audit` | empty | Dependency audit; every non-draft event |
| `coverage-file` | empty | Coverage report for `actions/coverage-summary`; empty: none |
| `coverage-format` | `lcov` | `lcov`, `go` or `vitest-json` |
| `coverage-name` | repository name | Comment header and baseline artifact name |
| `cache-paths` | empty | Workspace paths kept between verify runs (`.svelte-kit`, `node_modules/.cache`) |
| `build` | empty | Build command(s); empty skips the build job |
| `build-cache-paths` | empty | Workspace paths kept between build runs |
| `verify-timeout-minutes` | `30` | Verify job limit |
| `build-timeout-minutes` | `20` | Build job limit |

```yaml
jobs:
  ci:
    permissions:
      contents: read
      packages: read
      actions: read
      pull-requests: write
    uses: ecleangg/.github/.github/workflows/bun-ci.yml@<sha> # <ref>
    with:
      lint: bunx oxlint
      typecheck: bun run typecheck
      test: bunx vitest run --changed "$ECLEAN_BASE"
```

#### rust-ci

`rust-ci.yml`: Rust workspace. Format, clippy and tests on the affected members, extra checks, audit,
and the `CI` job. Toolchain from `rust-toolchain.toml` through rustup, rustc behind sccache. Permissions:
`contents: read`.

| Input | Default | Meaning |
| --- | --- | --- |
| `working-directory` | `.` | Workspace root |
| `env` | empty | `NAME=value` lines (no secrets) |
| `filters` | `code: * !*.md ...` | `actions/changed-files` filters |
| `full-patterns` | empty | Extra globs that make a pull request check everything |
| `tools` | empty | Comma-separated cargo tools for `taiki-e/install-action`, e.g. `cargo-nextest,cargo-deny` |
| `postgres` | empty | Postgres image for the tests (`DATABASE_URL` is set for the test and extra steps) |
| `format` | `cargo fmt --all --check` | Format check |
| `lint` | `cargo clippy $PACKAGES --all-targets --locked -- -D warnings` | `$PACKAGES` is `-p a -p b` or `--workspace` |
| `test` | `cargo test $PACKAGES --locked` | Test command |
| `extra` | empty | More checks (multi-line script) |
| `audit` | empty | e.g. `cargo deny check advisories`; every non-draft event |
| `cache-target` | `true` | Keep `target/` between runs |
| `timeout-minutes` | `45` | Job limit |

```yaml
jobs:
  ci:
    permissions:
      contents: read
    uses: ecleangg/.github/.github/workflows/rust-ci.yml@<sha> # <ref>
    with:
      tools: cargo-nextest,cargo-deny
      test: cargo nextest run $PACKAGES --locked
      audit: cargo deny check advisories
```

#### go-ci

`go-ci.yml`: Go module. gofmt on changed files, vet, lint and tests on the affected packages, extra
checks, audit, and the `CI` job. Go comes from the runner (`GOTOOLCHAIN=auto` fetches the `go.mod`
version). Permissions: `contents: read`.

| Input | Default | Meaning |
| --- | --- | --- |
| `working-directory` | `.` | Module root |
| `env` | empty | `NAME=value` lines (no secrets) |
| `filters` | `code: * !*.md ...` | `actions/changed-files` filters |
| `full-patterns` | empty | Extra globs that make a pull request check everything |
| `tools` | empty | `go install` targets pinned to a version, e.g. `golang.org/x/vuln/cmd/govulncheck@v1.1.4` |
| `postgres` | empty | Postgres image for the tests (`DATABASE_URL` is set for the test and extra steps) |
| `format` | gofmt on changed files (`ci-scope --ext go`) | Format check |
| `lint` | `go vet $PACKAGES` | `$PACKAGES` is the affected packages or `./...` |
| `test` | `go test -race $PACKAGES` | Test command |
| `extra` | empty | More checks (multi-line script) |
| `audit` | empty | e.g. `govulncheck ./...`; every non-draft event |
| `timeout-minutes` | `30` | Job limit |

```yaml
jobs:
  ci:
    permissions:
      contents: read
    uses: ecleangg/.github/.github/workflows/go-ci.yml@<sha> # <ref>
    with:
      tools: golang.org/x/vuln/cmd/govulncheck@v1.1.4
      audit: govulncheck ./...
```

#### verify

`verify.yml`: repos whose checks are one command (Ansible, Compose, config, docs). Runs after
`actions/changed-files`, so the command can use `ci-scope`, `ECLEAN_FULL` and `ECLEAN_CHANGED_FILES`.
Permissions: `contents: read`.

| Input | Default | Meaning |
| --- | --- | --- |
| `working-directory` | `.` | Directory the command runs in |
| `command` | empty | Verify command (multi-line script); empty picks `bun run verify`, `cargo xtask verify` or `make verify`, in that order |
| `env` | empty | `NAME=value` lines (no secrets) |
| `filters` | `code: * !LICENSE* !.github/ISSUE_TEMPLATE/*` | `actions/changed-files` filters; the command runs only when `code` matches |
| `full-patterns` | empty | Extra globs that make a pull request check everything |
| `cache-paths` | empty | Workspace paths kept between runs |
| `cache-key` | `**/*.lock` | `hashFiles` pattern keying `cache-paths` |
| `timeout-minutes` | `20` | Job limit |

```yaml
jobs:
  verify:
    permissions:
      contents: read
    uses: ecleangg/.github/.github/workflows/verify.yml@<sha> # <ref>
    with:
      command: make verify
```

#### docker-build

`docker-build.yml`: builds an image without pushing it (pull request check) and scans it with
`actions/trivy-image`. Needs Docker. Publishing is `docker-publish.yml` in `.github-private`.
Permissions: `contents: read`.

| Input | Default | Meaning |
| --- | --- | --- |
| `name` | required | Image name, for the cache directory and the summary |
| `context` | `.` | Build context |
| `file` | `Dockerfile` | Dockerfile, relative to the repository root |
| `target` | empty | Build stage |
| `build-args` | empty | Newline-separated build arguments (no secrets) |
| `filters` | `image: * !*.md ...` | The build runs only when `image` matches |
| `scan` | `true` | Scan the built image (HIGH and CRITICAL fail) |
| `timeout-minutes` | `45` | Job limit |

```yaml
jobs:
  image:
    permissions:
      contents: read
    uses: ecleangg/.github/.github/workflows/docker-build.yml@<sha> # <ref>
    with:
      name: booky
```

#### pr-gate

`pr-gate.yml`: draft and changed-files gate for a repo with several CI jobs. Call it first and make the
heavy jobs `need` it. On a draft the gate job is skipped, so are the jobs that need it. Permissions:
`contents: read`.

| Input | Default | Meaning |
| --- | --- | --- |
| `filters` | `code: * !*.md ...` | `name: glob !glob` lines |
| `full-patterns` | empty | Extra globs that make a pull request run everything |

| Output | Meaning |
| --- | --- |
| `run-full` | `true` when the gate ran (any event but a draft pull request) |
| `full` | `true` when everything has to be checked |
| `reason` | Why `full` is true, or `changed files` |
| `matches` | JSON object, one boolean per filter name |

```yaml
jobs:
  gate:
    permissions:
      contents: read
    uses: ecleangg/.github/.github/workflows/pr-gate.yml@<sha> # <ref>
    with:
      filters: |
        rust: crates/** Cargo.*
  rust:
    needs: gate
    if: ${{ fromJSON(needs.gate.outputs.matches).rust }}
    uses: ./.github/workflows/rust.yml
```

#### security

`security.yml`: secret scan, workflow lint, OSV, Opengrep, Trivy misconfiguration. Runs on drafts for
`workflows` and `secrets`; the other three wait for ready for review. Concurrency cancels superseded
pull request runs. Permissions: `contents: read`.

| Input | Default | Meaning |
| --- | --- | --- |
| `workflows` | `true` | actionlint and zizmor over `.github/workflows` and `.github/actions` |
| `secrets` | `true` | TruffleHog `--only-verified`, full history on `schedule`, the PR or push range otherwise |
| `osv` | `false` | OSV-Scanner over lockfiles (recursive), head against base, by (ecosystem, package, vulnerability) |
| `opengrep` | `false` | Opengrep with the Semgrep TypeScript and JavaScript security rules |
| `trivy-config` | `false` | Trivy misconfiguration scan of Dockerfiles, HIGH and CRITICAL |
| `path` | `.` | Directory to scan, relative to the repo root |
| `exclude` | empty | Newline-separated directories, relative to `path`, skipped by osv, opengrep and trivy-config |
| `baseline` | `true` | `false`: every finding blocks (used by the self-test) |
| `report-only` | `false` | Report, never fail |
| `concurrency-key` | empty | Suffix of the concurrency group, for callers that call the workflow twice |

Outputs: `workflows-blocking`, `secrets-blocking`, `osv-blocking`, `opengrep-blocking`,
`trivy-config-blocking` (counts). The self-hosted lane is x64: the scanners do not run on arm.

The Opengrep rules are the Semgrep rules repository at a pinned commit, checked out into
`.opengrep-rules` during the run. They fall under the Semgrep Rules License v1.0 (internal business
use): never commit them or copy them anywhere. Opengrep has no telemetry and no `--metrics` flag.

```yaml
name: Security
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
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

#### trivy-image-scheduled

`trivy-image-scheduled.yml`: pulls a published ghcr image and reports the full backlog; never fails.
Permissions: `contents: read`, `packages: read`.

| Input | Default | Meaning |
| --- | --- | --- |
| `image` | required | Image reference or `@sha256` digest |
| `ignore-file` | `.trivyignore` | Path in the caller's repo; listed findings are not reported |

```yaml
on:
  schedule:
    - cron: "37 5 * * *"
jobs:
  scan:
    permissions:
      contents: read
      packages: read
    uses: ecleangg/.github/.github/workflows/trivy-image-scheduled.yml@<sha> # <ref>
    with:
      image: ghcr.io/ecleangg/api-rs:latest
```

#### pr-hygiene

`pr-hygiene.yml`: Conventional Commits title check, automatic labels (when the repo has
`.github/labeler.yml`) and an optional changeset reminder, for private repos without rulesets. No
checkout and no third-party actions besides the labeler. Runs on drafts. Call it on `pull_request` with
types `opened, edited, synchronize, reopened, ready_for_review, labeled, unlabeled`. Permissions:
`contents: read`, `pull-requests: write`.

| Input | Default | Meaning |
| --- | --- | --- |
| `types` | `feat,fix,docs,refactor,perf,test,build,ci,chore,revert` | Allowed Conventional Commits types |
| `require-lowercase` | `true` | Subject starts with a lowercase letter |
| `labeler` | `true` | Run `actions/labeler` when `.github/labeler.yml` exists |
| `changesets` | `false` | Require a `.changeset/*.md` or an exemption |
| `no-release-label` | `no release` | Label that exempts a pull request from the changeset |
| `exempt-authors` | `renovate[bot],dependabot[bot],github-actions[bot]` | Bot logins exempt from the changeset check |

```yaml
jobs:
  hygiene:
    permissions:
      contents: read
      pull-requests: write
    uses: ecleangg/.github/.github/workflows/pr-hygiene.yml@<sha> # <ref>
```

#### repo-health

`repo-health.yml`: weekly health check kept as one tracking issue: missing standard files, stale
`# vX.Y.Z` pin comments, failed default-branch runs, open Dependabot alerts. Created or updated while
there are problems, closed when there are none. Permissions: `contents: read`, `issues: write`,
`actions: read`, `security-events: read`.

| Input | Default | Meaning |
| --- | --- | --- |
| `label` | `repo-health` | Label of the tracking issue (created when missing) |
| `title` | `Repo health` | Issue title |
| `check-dependabot` | `true` | Count open Dependabot alerts |

```yaml
on:
  schedule:
    - cron: "41 5 * * 1"
  workflow_dispatch:
jobs:
  health:
    permissions:
      contents: read
      issues: write
      actions: read
      security-events: read
    uses: ecleangg/.github/.github/workflows/repo-health.yml@<sha> # <ref>
```

#### stale

`stale.yml`: wraps `actions/stale` with the org defaults. Call it from a daily or weekly schedule.
Permissions: `issues: write`, `pull-requests: write`.

| Input | Default | Meaning |
| --- | --- | --- |
| `days-before-stale` | `60` | Inactivity before an item is marked stale |
| `days-before-close` | `14` | Days after stale before it is closed |
| `stale-label` | `stale` | Label added |
| `exempt-labels` | `pinned,security,repo-health` | Never marked stale |
| `exempt-draft-pr` | `true` | Draft pull requests are exempt |
| `operations-per-run` | `100` | API operation limit |
| `stale-message` | text | Comment when marked stale |
| `close-message` | text | Comment when closed |

```yaml
jobs:
  stale:
    permissions:
      issues: write
      pull-requests: write
    uses: ecleangg/.github/.github/workflows/stale.yml@<sha> # <ref>
```

### Composite actions

`uses: ecleangg/.github/.github/actions/<name>@<sha> # <ref>`.

#### actions/changed-files

Lists the files a pull request changes and decides when everything must run. Needs a checkout with
history (the base commit is fetched with `token`). Puts `ci-scope`, `ci-go-packages` and
`ci-rust-packages` on `PATH` and sets `ECLEAN_FULL`, `ECLEAN_BASE` and `ECLEAN_CHANGED_FILES`.

| Input | Default | Meaning |
| --- | --- | --- |
| `full-patterns` | empty | Extra globs; a pull request touching one runs everything |
| `default-full-patterns` | `true` | Also use the built-in list of lockfiles, toolchain pins and tool configuration |
| `filters` | empty | `name: glob !glob` lines; each becomes a key of `matches` |
| `token` | `github.token` | Token to fetch the base commit with |
| `max-files` | `400` | More changed files than this runs everything |

| Output | Meaning |
| --- | --- |
| `full` | `true` when everything should be checked |
| `reason` | Why `full` is true, or `changed files` |
| `base` | Commit the changes are relative to (empty when full) |
| `files-file` | File listing the changed, non-deleted paths |
| `count` | Number of changed, non-deleted paths |
| `matches` | JSON object, one boolean per filter name (all true when full) |

Helpers on `PATH` after the action ran:

| Command | Does |
| --- | --- |
| `ci-scope [--ext 'ts\|tsx'] [--glob g] [--dir d] [--full cmd] [--no-files] -- cmd args` | Full run: `--full` (or `cmd args`). Pull request: `cmd args <changed files matching --ext/--glob>`; skips when none match. `--no-files` runs `cmd args` once for tools that find related work from `ECLEAN_BASE` |
| `ci-rust-packages` | `--workspace`, or `-p name` for each changed workspace member and every member depending on one; empty when none changed |
| `ci-go-packages` | `./...`, or the changed packages plus every package importing them; empty when none changed |

Permissions: `contents: read`.

```yaml
- uses: actions/checkout@<sha> # <ref>
  with:
    fetch-depth: 0
    persist-credentials: false
- id: changed
  uses: ecleangg/.github/.github/actions/changed-files@<sha> # <ref>
  with:
    filters: |
      code: * !*.md
- if: fromJSON(steps.changed.outputs.matches).code
  run: ci-scope --ext sh -- shellcheck
```

#### actions/local-cache

Two actions, `local-cache/restore` and `local-cache/save`. They keep a cache on the self-hosted
runner's disk (`ECLEAN_ACTIONS_CACHE`) with no network transfer, and use `actions/cache` where the
variable is not set. Save never overwrites an existing key. Layout and eviction: see [Caching](#caching).

| Input | Default | Meaning |
| --- | --- | --- |
| `path` | required | Newline-separated paths or globs, relative to `working-directory` |
| `key` | required | Exact key |
| `working-directory` | `github.workspace` | Directory the paths are relative to |
| `backend` | `auto` | `auto`, `local` or `remote`; `local` fails when the disk cache is not available |
| `restore-keys` | empty | Restore only: key prefixes tried in order on a miss |

Restore outputs: `cache-hit` (exact match), `matched-key`, `backend` (`local` or `remote`). Save has no
outputs. Permissions: none.

```yaml
- id: cache
  uses: ecleangg/.github/.github/actions/local-cache/restore@<sha> # <ref>
  with:
    path: .svelte-kit
    key: svelte-${{ hashFiles('bun.lock') }}
- if: steps.cache.outputs.cache-hit != 'true' && github.ref_name == github.event.repository.default_branch
  uses: ecleangg/.github/.github/actions/local-cache/save@<sha> # <ref>
  with:
    path: .svelte-kit
    key: svelte-${{ hashFiles('bun.lock') }}
```

#### actions/postgres

Starts a throwaway Postgres container on a free local port and waits until it accepts connections.
Needs Docker. A composite action has no post step: `docker rm -f` the `container` output in an
`if: always()` step, or let the ephemeral runner clean up.

| Input | Default | Meaning |
| --- | --- | --- |
| `image` | `postgres:18` | Image, pinned by tag or digest |
| `database` | `test` | Database to create |
| `user` | `postgres` | Superuser name |
| `password` | `postgres` | Superuser password (throwaway) |

Outputs: `url` (`postgres://` URL), `port`, `container`. Permissions: none.

```yaml
- id: pg
  uses: ecleangg/.github/.github/actions/postgres@<sha> # <ref>
- run: cargo test
  env:
    DATABASE_URL: ${{ steps.pg.outputs.url }}
```

#### actions/coverage-summary

Writes a coverage report to the job summary and, on pull requests, a sticky comment (one per `name`):
total line and branch coverage, the delta against the latest run on the default branch, the 10
lowest-covered files and a collapsed table of all of them. On a push to the default branch it uploads
the baseline artifact `coverage-<name>`. A missing baseline is stated in the report, never an error.
Go has no branch coverage; its statements are reported as lines.

| Input | Default | Meaning |
| --- | --- | --- |
| `name` | required | Keys the comment header and the artifact |
| `format` | required | `lcov` (`cargo llvm-cov --lcov`, vitest), `go` (`go test -coverprofile`), `vitest-json` (`json-summary`) |
| `file` | required | The coverage file |
| `baseline-artifact` | `coverage-<name>` | Baseline artifact name |
| `fail-on-error` | `false` | Fail when the file cannot be parsed |
| `comment` | `true` | Post the pull request comment (fork pull requests cannot) |
| `github-token` | `github.token` | Token for the baseline download and the comment |

Outputs: `line-percent`, `branch-percent`, `report-file`. Permissions: `actions: read`,
`pull-requests: write`.

```yaml
- uses: ecleangg/.github/.github/actions/coverage-summary@<sha> # <ref>
  with:
    name: api
    format: lcov
    file: coverage/lcov.info
```

#### actions/sbom

CycloneDX JSON SBOM of a `path` or an `image` (Syft through `anchore/sbom-action`), uploaded as an
artifact and, with `release-tag`, attached to that release.

| Input | Default | Meaning |
| --- | --- | --- |
| `path` | empty | Directory to catalog; this or `image` |
| `image` | empty | Registry reference, or `docker:<ref>` for the local daemon; this or `path` |
| `output-file` | `sbom.cdx.json` | File to write, relative to the workspace |
| `artifact-name` | `sbom` | Uploaded artifact name |
| `upload-artifact` | `true` | Upload the SBOM as an artifact |
| `release-tag` | empty | Attach to the release with this tag (must exist) |
| `github-token` | `github.token` | Token for the release upload |

Output: `sbom-file`. Permissions: `contents: write` only with `release-tag`.

```yaml
- uses: ecleangg/.github/.github/actions/sbom@<sha> # <ref>
  with:
    path: .
```

#### actions/trivy-image

Scans an image (`image`, pulled from its registry) or a `docker save` archive (`tarball`) for fixed
HIGH and CRITICAL vulnerabilities and for secrets, without a Docker daemon. The Trivy binary and the
vulnerability DB are cached on the runner's disk (see [Caching](#caching)). Every `.trivyignore` entry
needs a reason, as a comment on the line above it or after it; an entry without one fails the step.

| Input | Default | Meaning |
| --- | --- | --- |
| `image` | empty | Registry reference; exactly one of `image` and `tarball` |
| `tarball` | empty | Path to a `docker save` or OCI archive |
| `ignore-file` | `.trivyignore` | The baseline: listed findings do not count. A missing file means none |
| `fail` | `true` | `false` reports only (use on `schedule`) |
| `severity` | `HIGH,CRITICAL` | Severities that count |
| `registry-username` | empty | Credentials for a private image (ghcr.io: the actor) |
| `registry-password` | empty | Registry password or token (ghcr.io: a token with `packages: read`) |
| `title` | the image | Summary heading |

Outputs: `findings`, `report-file`. Permissions: `packages: read` for a private ghcr image.

```yaml
- uses: ecleangg/.github/.github/actions/trivy-image@<sha> # <ref>
  with:
    tarball: ${{ runner.temp }}/image.tar
```

## Baselines and suppressions

Every suppression says why. A suppression without a reason is a finding in review.

| Tool | Where | How |
| --- | --- | --- |
| Trivy (image and Dockerfile) | `.trivyignore` at the repo root (or `path`) | One ID per line, a comment above it with the reason. The file is the baseline for images |
| zizmor | `.github/zizmor.yml`, or `# zizmor: ignore[rule] reason` | Read automatically |
| actionlint | `.github/actionlint.yaml` for unsupported new syntax only | Fix it, or `# shellcheck disable=SCxxxx reason` for a script |
| Opengrep | `// nosemgrep: <rule-id> reason` on the line | Prefer fixing; the rule id is in the summary table |
| OSV | `osv-scanner.toml` with `[[IgnoredVulns]]`, `id` and `reason` | Read automatically |
| TruffleHog | none | Verified secrets are live: rotate them |

Pull requests are compared with their base, so an old finding never blocks an unrelated change. To see
the whole backlog, run the workflow by hand or wait for the `schedule` run.

## How the pins stay fresh

The org Renovate preset (`github>ecleangg/.github`) enables `helpers:pinGitHubActionDigests`, so
Renovate rewrites every `uses:` to a full SHA with a ref comment and opens PRs when a new release or
commit appears, for the `ecleangg/.github` and `ecleangg/.github-private` reusable workflows and
actions too (callers pin `# main`). `repo-health.yml` reports comments that fell behind. Org policy
rejects a workflow whose action or reusable workflow is not pinned to a full SHA, and only allows
GitHub-owned actions, verified creators and the org allowlist.

The scanner binaries inside `security.yml` and `actions/trivy-image` (actionlint, zizmor, TruffleHog,
OSV-Scanner, Opengrep, Trivy) are downloaded from the vendor release and verified with `sha256sum -c`
against a digest stored in the workflow. Renovate does not move those: bump the version and the digest
together by hand (the digest is `gh api repos/<owner>/<repo>/releases/latest --jq '.assets[] | select(.name == "<asset>") | .digest'`),
and the Semgrep rules commit the same way. The self-test (`selftest.yml`) must be green before merging
such a bump.
