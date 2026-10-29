# Contributing to eclean

This document covers how we work in our repositories: how changes are proposed, reviewed, and merged.

## Who can contribute

Our repositories are worked on by eclean team members and invited collaborators. GitHub Issues and pull requests are limited to them, and private repositories cannot be forked. If you'd like to contribute and aren't on the team, email [community@eclean.gg](mailto:community@eclean.gg) first. To report a bug or suggest an idea without contributing code, see [SUPPORT.md](SUPPORT.md).

## Quick start

- Create a branch from `main`, named for the work, e.g. `feat/auth` or `fix/login-bug`.
- Follow the repository `README.md` to install dependencies and set up your environment.
- Keep each branch focused on one change.

## Issues and planning

Bugs, ideas and tasks are tracked as GitHub Issues in the relevant repository, and the [organization Projects](https://github.com/orgs/ecleangg/projects) collect them across repositories.

Every repository uses the same labels. New issues start as `needs-triage`; `needs-info` waits on the reporter, `ready-for-agent` is fully specified for a coding agent, and `ready-for-human` needs a person.

When you open a bug, include a short title, steps to reproduce, what you expected versus what happened, and the environment and any logs. When you propose a change, describe the problem, your proposed solution, and who benefits.

## Pull request guidelines

- Link the related issue in the description (e.g. "Fixes #123").
- Use a clear title and describe what changed and why. We squash-merge, so the PR title and description become the commit message.
- Keep PRs small and focused; large changes may be split into several.
- Run the repository's full check before opening a PR (for example `bun run verify`; see the repository `README.md`) and add or update tests for new behavior.
- Respond to review feedback and keep the branch up to date with `main`.
- Resolve every conversation before merging.

## Commit and PR titles

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): short description
```

Common types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`.

Commits to our public repositories must be signed.

## Dependency updates

[Renovate](https://docs.renovatebot.com/) opens dependency update pull requests. Non-major updates are grouped into one PR per repository and arrive early on Monday mornings; major updates and security fixes get their own PRs. Review them like any other change.

---

_If you need more help setting up your development environment, refer to the repository `README.md`._
