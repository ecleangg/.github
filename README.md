# ecleangg/.github

Shared GitHub configuration for the ecleangg org: reusable CI workflows and composite actions, workflow
templates for new repos, the Renovate preset, org rulesets, repo settings and the local git hooks. The
repository is public so private repos on the Free plan can call the workflows. Workflows that publish
or hold deploy credentials are in the private `ecleangg/.github-private`.

Everything runs on the self-hosted Linux pool by default. How it fits together, the policies and the
full input tables are in [docs/ci-standard.md](docs/ci-standard.md).

## Reusable workflows

| Workflow | Purpose |
| --- | --- |
| [`bun-ci.yml`](docs/ci-standard.md#bun-ci) | Format, lint, typecheck, tests, audit, coverage and build for a Bun/TypeScript repo |
| [`rust-ci.yml`](docs/ci-standard.md#rust-ci) | Format, clippy, tests and audit on the affected workspace members |
| [`go-ci.yml`](docs/ci-standard.md#go-ci) | gofmt, vet, tests and vulnerability audit on the affected packages |
| [`verify.yml`](docs/ci-standard.md#verify) | One `verify` command, for infra, config and docs repos |
| [`docker-build.yml`](docs/ci-standard.md#docker-build) | Build an image without pushing it and scan it |
| [`pr-gate.yml`](docs/ci-standard.md#pr-gate) | Draft and changed-files gate for repos with several CI jobs |
| [`security.yml`](docs/ci-standard.md#security) | Secret scan, workflow lint, OSV, Opengrep, Trivy configuration scan |
| [`trivy-image-scheduled.yml`](docs/ci-standard.md#trivy-image-scheduled) | Scheduled scan of a published image |
| [`pr-hygiene.yml`](docs/ci-standard.md#pr-hygiene) | Conventional Commits title (release-please reads these), labels |
| [`repo-health.yml`](docs/ci-standard.md#repo-health) | Weekly health check kept as one issue |
| [`stale.yml`](docs/ci-standard.md#stale) | Stale issue and pull request handling |

## Composite actions

| Action | Purpose |
| --- | --- |
| [`changed-files`](docs/ci-standard.md#actionschanged-files) | Changed-file list, full-run decision, `ci-scope`, `ci-rust-packages`, `ci-go-packages` |
| [`local-cache`](docs/ci-standard.md#actionslocal-cache) | Cache on the self-hosted runner's disk (`restore`, `save`) |
| [`postgres`](docs/ci-standard.md#actionspostgres) | Throwaway Postgres container for tests |
| [`coverage-summary`](docs/ci-standard.md#actionscoverage-summary) | Coverage report in the job summary and a sticky PR comment |
| [`sbom`](docs/ci-standard.md#actionssbom) | CycloneDX SBOM as an artifact or release asset |
| [`trivy-image`](docs/ci-standard.md#actionstrivy-image) | Image or tarball vulnerability and secret scan |

## Elsewhere in this repository

| Path | Contents |
| --- | --- |
| [`workflow-templates/`](workflow-templates) | Starter workflows offered to new org repos (Bun, Rust, Go, verify, security, PR hygiene, repo health) |
| [`docs/local-first.md`](docs/local-first.md) | Local git hooks and the draft policy |
| [`rulesets/`](rulesets) | Org rulesets, applied with `scripts/apply-rulesets.sh` |
| [`scripts/`](scripts) | Hook installer, commit signing setup, ruleset, environment and repo sync scripts |
| `renovate.json`, `default.json` | The org Renovate preset (`github>ecleangg/.github`) |
| `settings.yml` | Repo settings |
