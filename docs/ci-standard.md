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
runner tool cache, Playwright browsers, and `CI_LOCAL_CACHE` (used by `actions/local-cache`).

Installed on the runners: Node 26 LTS, Bun, Go (`GOTOOLCHAIN=auto`), rustup with stable, uv, gh, jq,
ShellCheck, a C toolchain, CMake, Clang, ansible-lint, Docker with buildx, Playwright system libraries.
The setup actions (`setup-bun`, `setup-go`, Rust toolchain installs) run only on GitHub-hosted runners
(`runner.environment == 'github-hosted'`); on the self-hosted lanes the tool is already there.

## Heavy-job slots

A runner takes one job, and a host has more runners than CPU for heavy jobs: prd-ams-ci-01 (Linux) is a
10 vCPU / 32 GiB VM with about 5 runners, prd-ams-ci-02 (Windows) a 12 vCPU / 40 GiB VM with 4 lanes.
Rust build and test (`rust-ci`), browser E2E (`bun-ci` with `playwright-browsers`) and image builds
(`docker-build`) therefore call [`actions/host-slot`](#actionshost-slot) before their heavy steps: a host
runs at most N of them at once and the rest queue, holding a runner but no CPU. Lint, format, secret scans,
actionlint and every other job stay fully parallel. Set `heavy-slots: false` on a workflow to opt out.

The counts are the variables `CI_HEAVY_SLOTS_LINUX` (default 3) and `CI_HEAVY_SLOTS_WINDOWS` (default 2),
set per repository or for the org; `0` turns the limit off. A concurrency group does not do this: it holds
one running and one pending job and cancels the rest (`queue: max` only serializes, `concurrency-group` in
`rust-ci` uses it for that).

## Artifacts

The org is on the free plan: 500 MB of Actions storage, counted in GB-hours over the month (372 GB-hours
for November). When it is used up, every `upload-artifact` fails with `Artifact storage quota has been
hit` until the month turns. Shared workflows keep uploads small and short-lived: PR comment bodies 1 day,
Opengrep reports 1 day, SBOMs 3 days (30 with a release tag), coverage baselines 14 days. Anything else a
repo uploads needs `retention-days` of 1 to 3 (longer only for release artifacts), no build output or
caches, and `if: failure()` for debug reports. `repo-health` deletes artifacts of non-release runs after
3 days when it runs daily.

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
- A skipped job counts as passed for required checks, so a draft never blocks on them.
- A new push to a pull request cancels that pull request's older runs; every other event (push to `main`, schedule, release, dispatch) gets a run-unique concurrency group and is never cancelled or deduplicated. Callers use `group: ${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.event.pull_request.number || github.run_id }}` with `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`.

## Changed-files policy

- A pull request checks only what it changes. `actions/changed-files` lists the changed files and
  `filters` decides whether the code steps run at all. Commands use `ci-scope` (format, lint),
  `vitest run --changed "$CI_CHANGES_BASE"` (tests), `ci-rust-packages` (`-p` arguments) and
  `ci-go-packages` (import paths).
- A push checks what changed since the commit the branch was at before it (`github.event.before`;
  `push-diff`), the same way. Jobs reporting a coverage baseline turn that off and check everything.
- Schedules, manual runs, merge queues, forced pushes, new branches, changes touching a lockfile, a
  toolchain pin or tool configuration (built-in list, extended with `full-patterns`), and changes of
  more than `max-files` files (400) check everything.
- A docs-only pull request (nothing matches the `code` filter) skips the steps, but the `Verify` job
  still runs and reports success, so `Verify` is the one check branch protection needs. There is no
  separate summary job: each costs a runner start on a small pool. A repo calling several workflows
  keeps one summary job of its own.
- Audits (`audit` input) are not scoped by changes; they run on every non-draft event.

## Test results

A job that passes records it against the git tree it ran on (`actions/test-results`: job kind, runner
OS, a hash of the inputs that tell jobs apart, and the tree). Another run on the same tree skips its
checks and links the run that passed: the push of a squash-merged pull request (its tree is the
pull request's merge commit), re-runs, manual runs. The caller's commands live in its workflow file,
which is part of the tree, so a changed command is a different tree. Exceptions: schedules always
run, audits always run, and the default branch still runs when it reports a coverage baseline or
(Rust) has no `target` entry for its key yet. `reuse-results: false` turns it off. Entries are in
local-cache's shared scope on the self-hosted runners; GitHub-hosted runners never skip.

## Caching

| What | Where | Details |
| --- | --- | --- |
| Tool caches (cargo, rustup, sccache, bun, npm, go, uv, toolcache, Playwright) | Runner disk, shared by the lanes | Nothing to configure |
| Workspace paths (`cache-paths`, `build-cache-paths`) | `actions/local-cache` | `$CI_LOCAL_CACHE/<owner>/<repo>/<ref>/<key>.tar`; reads the run's own ref first, then the default branch; every ref saves its own entry and `supersedes` keeps only its newest; entries are immutable. A save first makes room for itself: other refs' entries go first, then the default branch's, oldest last use first, until the cache stays under `CI_LOCAL_CACHE_MAX_GB` (40) and the disk keeps `CI_LOCAL_CACHE_MIN_FREE_PCT` (20) percent free with the new entry on it; when that is impossible the save is skipped with a warning. Falls back to `actions/cache` where the variable is unset |
| Rust `target/` | `actions/local-cache` | One entry per job variant (enabled steps, `env`, `tools`, `cache-key`), toolchain and `Cargo.lock`, so jobs building different things (clippy and tests, coverage) never share one. Holds compiled dependencies only: workspace members, incremental state, coverage data and test binaries are trimmed before saving. Restored by every run (same variant and toolchain as fallback); any ref saves when no entry for the exact key exists. sccache covers the rest. Off with `cache-target: false` |
| Test results | `actions/test-results` (local-cache, shared scope) | See [Test results](#test-results) |
| BuildKit layers and `RUN --mount=type=cache` (`docker-build.yml`) | The Docker daemon's BuildKit on the runner | Self-hosted builds use the buildx `docker` driver, so layers and cache mounts persist and every branch shares them; the daemon's builder GC (playbooks `docker` role) bounds them. GitHub-hosted runners use the Actions cache, written from the default branch |
| Trivy vulnerability DB | `$CI_LOCAL_CACHE/trivy-db/<day>` | One download per day per host |
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
extra, audit, coverage) and `build` (when `build` is set), in parallel.
Permissions: `contents: read`, `packages: read`, `actions: read` (coverage baseline). The coverage comment
is posted by [`pr-comments`](#pr-comments).

| Input | Default | Meaning |
| --- | --- | --- |
| `working-directory` | `.` | Bun project directory |
| `bun-version-file` | `package.json` | File setup-bun reads the version from (GitHub-hosted runners only) |
| `registries` | empty | setup-bun `registries`, e.g. `@ecleangg:https://npm.pkg.github.com/\|$NODE_AUTH_TOKEN` (the workflow token) |
| `forgejo-npm` | `false` | Read `@ecleangg` packages from our Forgejo registry: `NODE_AUTH_TOKEN` becomes the read-only token in OpenBao (`kv/ci/npm-read/forgejo-registry`, through the `ci-npm-read` role), so pull requests can install them too. Set `registries` to `@ecleangg:https://git.eclean.gg/api/packages/ecleangg/npm/\|$NODE_AUTH_TOKEN`. The caller's job needs `id-token: write` (every `bun-ci` job asks for it) |
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
| `reuse-results` | `true` | Skip the checks when the job already passed on the same tree ([Test results](#test-results)) |
| `verify-timeout-minutes` | `30` | Verify job limit |
| `build-timeout-minutes` | `20` | Build job limit |

```yaml
jobs:
  ci:
    permissions:
      contents: read
      packages: read
      actions: read
    uses: ecleangg/.github/.github/workflows/bun-ci.yml@<sha> # <ref>
    with:
      lint: bunx oxlint
      typecheck: bun run typecheck
      test: bunx vitest run --changed "$CI_CHANGES_BASE"
```

#### rust-ci

`rust-ci.yml`: Rust workspace. Format, clippy and tests on the affected members, extra checks, audit,
and the `CI` job. Toolchain from `rust-toolchain.toml` through rustup, rustc behind sccache. Every step
runs in bash, so a Windows runner works too (`runs-on: '["self-hosted","Windows","X64"]'`, Git Bash).
Permissions: `contents: read`; with `coverage` also `actions: read` (the job requests it, so the caller
must grant it). The coverage comment is posted by [`pr-comments`](#pr-comments).

| Input | Default | Meaning |
| --- | --- | --- |
| `working-directory` | `.` | Workspace root |
| `env` | empty | `NAME=value` lines (no secrets) |
| `filters` | `code: * !*.md ...` | `actions/changed-files` filters |
| `full-patterns` | empty | Extra globs that make a pull request check everything |
| `setup` | empty | Multi-line script after the toolchain, before format and lint (`bun install --frozen-lockfile`, code generation) |
| `tools` | empty | Comma-separated cargo tools for `taiki-e/install-action`, e.g. `cargo-nextest,cargo-deny` |
| `postgres` | empty | Postgres image for the tests (`DATABASE_URL` is set for the test and extra steps) |
| `compose-file` | empty | Compose file (relative to `working-directory`): `docker compose up -d --wait` before the tests, `down -v` at the end |
| `compose-profiles` | empty | Comma- or space-separated profiles to enable |
| `compose-project` | `<repo>-<run id>-<job>` | Compose project name (`COMPOSE_PROJECT_NAME`, lowercased) so parallel runs do not collide |
| `concurrency-group` | empty | Serializes `Verify` jobs sharing the group (`queue: max`); needed when the Compose file has fixed container names or ports |
| `format` | `cargo fmt --all --check` | Format check |
| `lint` | `cargo clippy $PACKAGES --all-targets --locked -- -D warnings` | `$PACKAGES` is `-p a -p b` or `--workspace` |
| `test` | `cargo test $PACKAGES --locked` | Test command |
| `extra` | empty | More checks (multi-line script) |
| `coverage` | empty | Command writing an lcov file after the tests, e.g. `cargo llvm-cov $PACKAGES --locked --lcov --output-path lcov.info` |
| `coverage-file` | `lcov.info` | The lcov file, for `actions/coverage-summary` |
| `coverage-name` | repository name | Name of the coverage comment and baseline artifact |
| `audit` | empty | e.g. `cargo deny check advisories`; every non-draft event |
| `cache-target` | `true` | Keep `target/` between runs |
| `bun-version-file` | empty | Pins the Bun the `setup` uses (`packageManager`/`engines.bun` in a package.json, or `.bun-version`), via `actions/bun-pin` |
| `cache-key` | empty | Extra part of the `target` and result keys, for jobs that differ only in their commands |
| `reuse-results` | `true` | Skip the checks when this job variant already passed on the same tree |
| `timeout-minutes` | `45` | Job limit |

```yaml
jobs:
  ci:
    permissions:
      contents: read
      actions: read
    uses: ecleangg/.github/.github/workflows/rust-ci.yml@<sha> # <ref>
    with:
      setup: bun install --frozen-lockfile
      tools: cargo-nextest,cargo-deny,cargo-llvm-cov
      compose-file: compose.test.yml
      compose-profiles: test
      concurrency-group: api-rs-compose
      test: cargo nextest run $PACKAGES --locked
      coverage: cargo llvm-cov nextest $PACKAGES --locked --lcov --output-path lcov.info
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
| `coverage-file` | empty | Go coverage profile (`-coverprofile`) for `actions/coverage-summary` |
| `coverage-name` | repository name | Coverage comment and baseline artifact name |
| `reuse-results` | `true` | Skip the checks when the job already passed on the same tree ([Test results](#test-results)) |
| `timeout-minutes` | `30` | Job limit |

```yaml
jobs:
  ci:
    permissions:
      contents: read
      actions: read # Coverage baseline.
    uses: ecleangg/.github/.github/workflows/go-ci.yml@<sha> # <ref>
    with:
      tools: golang.org/x/vuln/cmd/govulncheck@v1.1.4
      audit: govulncheck ./...
```

#### verify

`verify.yml`: repos whose checks are one command (Ansible, Compose, config, docs). Runs after
`actions/changed-files`, so the command can use `ci-scope`, `CI_CHANGES_FULL` and `CI_CHANGES_FILES`.
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
| `reuse-results` | `true` | Skip the checks when the job already passed on the same tree ([Test results](#test-results)) |
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
| `packages-secret` | `false` | Pass the workflow token as the BuildKit secret `github_packages_token` |
| `forgejo-npm` | `false` | Pass a read-only Forgejo token from OpenBao (`kv/ci/npm-read/forgejo-registry`, role `ci-npm-read`) as the BuildKit secret `forgejo_packages_token`, to install `@ecleangg` packages from git.eclean.gg. The caller's job needs `id-token: write` (the job asks for it, so every caller must grant it when it re-pins) |
| `scan` | `true` | Scan the built image (HIGH and CRITICAL fail) |
| `heavy-slots` | `true` | Queue for a [heavy-job slot](#heavy-job-slots) before the build |
| `timeout-minutes` | `45` | Job limit |

```yaml
jobs:
  image:
    permissions:
      contents: read
      packages: read
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

`trivy-image-scheduled.yml`: pulls a published image and reports the full backlog; never fails. An image on
`ghcr.io` is pulled with the workflow token; any other (our Forgejo registry, `git.eclean.gg`) with the login
in OpenBao at `kv/ci/<repo>/forgejo-registry`, read through the repo's `ci-<repo>` role.
Permissions: `contents: read`, `packages: read`, `id-token: write`.

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
      id-token: write # the OpenBao login for a Forgejo image
    uses: ecleangg/.github/.github/workflows/trivy-image-scheduled.yml@<sha> # <ref>
    with:
      image: git.eclean.gg/ecleangg/api-rs:latest
```

#### pr-hygiene

`pr-hygiene.yml`: Conventional Commits title check, automatic labels (when the repo has
`.github/labeler.yml`), for private repos without rulesets. No
checkout and no third-party actions besides the labeler. Runs on drafts. Call it on `pull_request` with
types `opened, edited, synchronize, reopened, ready_for_review, labeled, unlabeled`. Permissions:
`contents: read`, `pull-requests: write`.

| Input | Default | Meaning |
| --- | --- | --- |
| `types` | `feat,fix,docs,refactor,perf,test,build,ci,chore,revert` | Allowed Conventional Commits types |
| `require-lowercase` | `true` | Subject starts with a lowercase letter |
| `labeler` | `true` | Run `actions/labeler` when `.github/labeler.yml` exists |

```yaml
jobs:
  hygiene:
    permissions:
      contents: read
      pull-requests: write
    uses: ecleangg/.github/.github/workflows/pr-hygiene.yml@<sha> # <ref>
```

#### repo-health

`repo-health.yml`: weekly housekeeping in four independent jobs, each turned off by a boolean input
(all default on). Packages are no longer pruned here: see [package-prune](#package-prune).
It opens no issue. Call it from a weekly `schedule` and `workflow_dispatch`.

| Job | Input | Does |
| --- | --- | --- |
| `files` | `files` | Job-summary table of standard files in the repo, inherited from the org `.github` repo, or missing (never fails) |
| `stale` | `stale` | `actions/stale`: warning comment, then closes; drafts included |
| `runs` | `runs` | Deletes logs (run metadata stays) of runs older than `max-age-days`, and artifacts: `artifact-max-age-days` for non-release runs, `max-age-days` for release runs |
| `caches` | `caches` | Deletes Actions caches not accessed for `cache-max-age-days` |

Job permissions: `contents: read` everywhere, `issues: write`, `pull-requests: write` and `id-token: write`
(`stale`), `actions: write` (`runs`, `caches`). The caller grants the union: `contents: read`, `issues: write`,
`pull-requests: write`, `actions: write`, `id-token: write`.

`stale` acts as eclean-ci[bot]: it logs in to OpenBao with the job's OIDC token (role `ci-<repository
name without a leading dot>`, bound to `refs/heads/main`, so call it from a schedule or dispatch on the
default branch) and mints an app token. Without the role it falls back to the workflow token (the
`issues` and `pull-requests` grants) and says so in the job summary. Logs, artifacts and caches
are deleted with the workflow token.

| Input | Default | Meaning |
| --- | --- | --- |
| `dry-run` | `false` | `runs`, `caches` and `stale` only list what they would delete or mark |
| `files`, `stale`, `runs`, `caches` | `true` | Turn a job off |
| `days-before-stale` | `90` | Inactivity before the warning |
| `days-before-close` | `14` | Days after the warning before it is closed |
| `exempt-labels` | `pinned,security,keep` | Never marked stale |
| `max-age-days` | `7` | Age after which run logs, and the artifacts of release runs, are deleted |
| `artifact-max-age-days` | `3` | Age after which artifacts of non-release runs are deleted. Call the workflow daily so this holds |
| `release-ref-pattern` | version-like name | Extended regex on the run's branch or tag name (`v1.2.3`, `desktop-v1.2.3`): matching runs are release runs |
| `lookback-days` | `14` | Runs visited: created up to this many days before the cutoff (`0`: all). Keeps a weekly run from re-requesting logs already deleted |
| `max-deletions` | `1000` | Cap on log and artifact deletions per run (API rate limits); the next run continues |
| `cache-max-age-days` | `3` | Days without access after which a cache is deleted |
| `packages`, `package-names`, `keep-versions` | | Deprecated and ignored (the `packages` job is gone); callers that still pass them keep working |

Runs are limited by the API to 1000 results per query; the job
continues below the oldest run it saw, up to five queries.

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
      pull-requests: write
      actions: write
      id-token: write
    uses: ecleangg/.github/.github/workflows/repo-health.yml@<sha> # <ref>
```

#### package-prune

`package-prune.yml`: keeps only the latest version of each container image and npm package of the org,
plus everything still in use, and deletes the rest. One job; replaces the `packages` job of
`repo-health.yml`, which ignored production pins and deleted versions part by part.

- **KEEP** the newest build per image (newest `keep-latest` builds by creation time, and any build carrying
  `latest`), and the newest npm version(s); every container build pinned by production, found as
  `ghcr.io/<org>/<name>:<tag>@sha256:<digest>` (also tag-only and bare references) in
  `<org>/containers` (`podman/stacks`) and `<org>/playbooks`; every npm version a consumer lockfile locks
  (`bun.lock`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`), or the highest published version a
  `package.json` range resolves to when no lockfile covers it, in every non-archived repository of the org;
  anything younger than `min-age-hours`.
- **DELETE** everything else, a container as a whole build: the tagged index, platform images, the buildx
  attestation manifest, the cosign bundle and the referrers fallback-tag index `sha256-<digest>` go
  together, found by walking the registry manifests (not by timestamps). A part reachable from a kept
  build is never deleted. Unreachable untagged versions older than `min-age-hours` are orphans and go too.
- **Fails closed.** Nothing is deleted, for any package of the run, when a pin source cannot be read or is
  empty, a pinned digest or tag is not in the registry (the run names it), a registry call fails, the
  image has no tagged build, or a package has no pin while `require-pins` is on. A build with any part
  younger than `min-age-hours` waits. At most `max-deletions` versions per run; builds are never split,
  the next run continues. Before and after deleting, the kept manifests are read from the registry.
- **Report.** The job summary has a KEEP / DELETE / DEFER table with a reason per version and the commands
  to restore every deleted version (GitHub restores a deleted package version for 30 days).
- **Dry run by default.**

Identities: the pin sources are read as eclean-ci[bot] with `contents: read` on every repository the app
is installed on (OpenBao role `ci-<repository>`, bound to `refs/heads/main`: call it from a schedule,
`workflow_dispatch` or `workflow_run` on the default branch). Without the app token the run stops with an
error. Versions are listed and deleted, and the registry is read, with the workflow token
(`packages: write`, for packages linked to the repository).

Permissions: `contents: read`, `packages: write`, `id-token: write`.

| Input | Default | Meaning |
| --- | --- | --- |
| `packages` | required | `container:<name>` / `npm:<name>` lines (npm without the scope: `npm:ui` is `@ecleangg/ui`) |
| `dry-run` | `true` | Only report |
| `keep-latest` | `1` | Newest builds (npm: versions) kept per package |
| `max-deletions` | `20` | Most versions deleted per run |
| `min-age-hours` | `2` | Nothing younger is deleted (publishes in flight) |
| `pin-repos` | empty | `owner/repo[:path]` lines scanned for container references; default `<org>/containers:podman/stacks` and `<org>/playbooks` |
| `consumer-repos` | `*` | `owner/repo` lines whose manifests and lockfiles pin npm versions; `*`: every non-archived repository of the org |
| `require-pins` | `true` | Abort when a container package has no pin |

Call it daily and after each publish. A publishing repository adds `.github/workflows/package-prune.yml`
(the workflow name below is the `name:` of its publish workflow). Scheduled and `workflow_run` runs are
dry runs until the repository variable `PACKAGE_PRUNE_LIVE` is `true`; `workflow_dispatch` takes `dry-run`.

```yaml
name: Package prune
on:
  schedule:
    - cron: "23 3 * * *" # daily, off the hour
  workflow_dispatch:
    inputs:
      dry-run:
        type: boolean
        default: true
  workflow_run: # zizmor: ignore[dangerous-triggers] reads and prunes packages only; runs no pull request code
    workflows: ["Build and publish Docker image"]
    types: [completed]
permissions: {}
concurrency:
  group: package-prune
  cancel-in-progress: false
jobs:
  prune:
    if: ${{ github.event_name != 'workflow_run' || (github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event != 'pull_request') }}
    permissions:
      contents: read
      packages: write
      id-token: write
    uses: ecleangg/.github/.github/workflows/package-prune.yml@<sha> # <ref>
    with:
      packages: container:booky
      dry-run: ${{ !((github.event_name == 'workflow_dispatch' && inputs.dry-run != true) || (github.event_name != 'workflow_dispatch' && vars.PACKAGE_PRUNE_LIVE == 'true')) }}
```

#### pr-comments

`pr-comments.yml`: posts the pull request comments that CI runs prepared, as eclean-ci[bot]. A pull
request run cannot read the app's key (OpenBao issues it only to runs from the default branch), so it
uploads each comment as an artifact `pr-comment-<header>` with the file `body.md` (the coverage
summary action does: `pr-comment-coverage-<name>`). A `workflow_run` workflow in the repo, which always
runs the default branch's code, calls this one after the CI run completed. It acts only when the run was
a `pull_request`, takes the pull request number from the event (runs without one, such as fork pull
requests, are skipped), downloads the `pr-comment-*` artifacts of that run, and creates or updates one
sticky comment per artifact keyed by the name after `pr-comment-`. Artifacts are untrusted text: only
regular `body.md` files of at most 60000 bytes are posted, and never interpolated into a command.
Without the repo's OpenBao role the comment is posted with the workflow token and the job summary says so.
Permissions: `actions: read`, `id-token: write`, `pull-requests: write` (the last only for that fallback).

```yaml
on:
  workflow_run: # zizmor: ignore[dangerous-triggers] relays artifacts to comments; runs no pull request code
    workflows: ["CI"] # the `name:` of each workflow that posts comments
    types: [completed]
permissions: {}
jobs:
  comments:
    permissions:
      actions: read
      id-token: write
      pull-requests: write
    uses: ecleangg/.github/.github/workflows/pr-comments.yml@<sha> # <ref>
```

#### stale

`stale.yml`: superseded by the `stale` job of `repo-health.yml` (90 days, drafts included, exempt
`pinned,security,keep`); new callers use that. Kept unchanged for existing callers: wraps `actions/stale`
with the former defaults. Permissions: `issues: write`, `pull-requests: write`, `id-token: write` (it acts as
eclean-ci[bot] like the `stale` job of `repo-health.yml`, with the same fallback).

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

### Composite actions

`uses: ecleangg/.github/.github/actions/<name>@<sha> # <ref>`.

#### actions/changed-files

Lists the files a pull request changes and decides when everything must run. Needs a checkout with
history (the base commit is fetched with `token`). Puts `ci-scope`, `ci-go-packages` and
`ci-rust-packages` on `PATH` and sets `CI_CHANGES_FULL`, `CI_CHANGES_BASE` and `CI_CHANGES_FILES`.

| Input | Default | Meaning |
| --- | --- | --- |
| `full-patterns` | empty | Extra globs; a pull request touching one runs everything |
| `default-full-patterns` | `true` | Also use the built-in list of lockfiles, toolchain pins and tool configuration |
| `filters` | empty | `name: glob !glob` lines; each becomes a key of `matches` |
| `token` | `github.token` | Token to fetch the base commit with |
| `max-files` | `400` | More changed files than this runs everything |
| `push-diff` | `true` | On a push, check the files changed since `github.event.before` (not on forced pushes or new branches) |

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
| `ci-scope [--ext 'ts\|tsx'] [--glob g] [--dir d] [--full cmd] [--no-files] -- cmd args` | Full run: `--full` (or `cmd args`). Pull request: `cmd args <changed files matching --ext/--glob>`; skips when none match. `--no-files` runs `cmd args` once for tools that find related work from `CI_CHANGES_BASE` |
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

#### actions/host-slot

Queues for one of N slots of a class (default `heavy`) on the runner's host. The slots are file locks
under `$CI_LOCAL_CACHE/slots/<class>` (the one directory every runner of a host can write), held by a
small background process that the runner kills at the end of the job, so a crashed or cancelled job frees
its slot. Linux uses `flock`, Windows an exclusive file handle. Without `CI_LOCAL_CACHE` or `flock` it does
nothing, so it is safe on GitHub-hosted runners. Waiting is not FIFO (a waiter retries every 2 to 4 s).
`actions/host-slot/release` hands the slot back before the job's last steps.

| Input | Default | Meaning |
| --- | --- | --- |
| `class` | `heavy` | Slot class; each is counted separately |
| `slots-linux`, `slots-windows` | `3`, `2` | Slots per host; pass `vars.CI_HEAVY_SLOTS_LINUX` and `vars.CI_HEAVY_SLOTS_WINDOWS`; `0` is no limit |
| `wait-minutes` | `90` | Queue time; `0` tries once |
| `on-timeout` | `proceed` | `proceed` warns and runs without a slot; `fail` fails the step |
| `hold-minutes` | `240` | Longest a slot is held if the job's cleanup never kills the holder |
| `directory` | `$CI_LOCAL_CACHE/slots` | Where the locks live |

Outputs: `acquired` (`true` or `false`), `slot`. The wait counts against the job's `timeout-minutes`.

#### actions/local-cache

Two actions, `local-cache/restore` and `local-cache/save`. They keep a cache on the self-hosted
runner's disk (`CI_LOCAL_CACHE`) with no network transfer, and use `actions/cache` where the
variable is not set. Save never overwrites an existing key. Layout and eviction: see [Caching](#caching).

| Input | Default | Meaning |
| --- | --- | --- |
| `path` | required | Newline-separated paths or globs, relative to `working-directory` |
| `key` | required | Exact key |
| `working-directory` | `github.workspace` | Directory the paths are relative to |
| `backend` | `auto` | `auto`, `local` or `remote`; `local` fails when the disk cache is not available |
| `restore-keys` | empty | Restore only: key prefixes tried in order on a miss |
| `scope` | `ref` | `ref`, or `shared`: one scope every ref reads and writes, for keys that pin their content (a tree hash) |
| `lookup-only` | `false` | Restore only: report `cache-hit` and `matched-key` without extracting |

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

#### actions/test-results

Remembers that a job's checks passed on a git tree (see [Test results](#test-results)). `mode: lookup`
before the checks sets `hit` (and `run-url`); `mode: record` after they passed stores the result.
`kind` names the job, `variant` is everything besides the tree that decides the outcome, `path` the
directory whose tree counts (default the whole repository). Only on runners with `CI_LOCAL_CACHE`;
elsewhere a lookup misses and a record does nothing.

```yaml
- id: results
  uses: ecleangg/.github/.github/actions/test-results@<sha> # <ref>
  with:
    mode: lookup
    kind: e2e
- if: steps.results.outputs.hit != 'true'
  run: bunx playwright test
- if: success() && steps.results.outputs.hit != 'true'
  uses: ecleangg/.github/.github/actions/test-results@<sha> # <ref>
  with:
    mode: record
    kind: e2e
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
| `comment` | `true` | On pull requests, upload the comment body as the artifact `pr-comment-coverage-<name>` for [`pr-comments`](#pr-comments) to post |
| `github-token` | `github.token` | Token for the baseline download |

Outputs: `line-percent`, `branch-percent`, `report-file`. Permissions: `actions: read`. The pull request run
never posts the comment.

```yaml
- uses: ecleangg/.github/.github/actions/coverage-summary@<sha> # <ref>
  with:
    name: api
    format: lcov
    file: coverage/lcov.info
```

#### actions/package-prune

The script behind [`package-prune.yml`](#package-prune) (`prune.js`, with `plan.js`, `pins.js`, `semver.js`
and unit tests in `plan.test.js` over `tests/fixtures/package-prune`). Needs Node 18 or later and git.
Inputs: `packages`, `token`, `pin-token` (required), `dry-run`, `keep-latest`, `max-deletions`,
`min-age-hours`, `pin-repos`, `consumer-repos`, `require-pins`, as in the workflow. Dry run by default.

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
actions too (callers pin `# main`). Org policy
rejects a workflow whose action or reusable workflow is not pinned to a full SHA, and only allows
GitHub-owned actions, verified creators and the org allowlist.

The scanner binaries inside `security.yml` and `actions/trivy-image` (actionlint, zizmor, TruffleHog,
OSV-Scanner, Opengrep, Trivy) are downloaded from the vendor release and verified with `sha256sum -c`
against a digest stored in the workflow. Renovate does not move those: bump the version and the digest
together by hand (the digest is `gh api repos/<owner>/<repo>/releases/latest --jq '.assets[] | select(.name == "<asset>") | .digest'`),
and the Semgrep rules commit the same way. The self-test (`selftest.yml`) must be green before merging
such a bump.
