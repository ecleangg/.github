# Contributing to eclean

Thank you for wanting to contribute! This document focuses only on practical contribution guidelines: how to get set up, report issues, propose changes, and open pull requests.

## Quick start

- Fork the repository (external contributors) or create a branch from the main branch (team members).
- Follow the repository `README.md` to install dependencies and set up your environment.
- Create a focused branch for your work, e.g. `feat/auth` or `fix/login-bug`.

## Reporting bugs

When you open an issue for a bug, include:

- A short, descriptive title.
- Steps to reproduce.
- What you expected vs what happened.
- Environment details (OS, browser, versions) and any relevant logs or error messages.

> [!TIP]
> Search existing issues before opening a new one — someone may have already reported it.

## Proposing changes or new features

Open an issue first describing:

- The problem you're solving.
- Your proposed solution and any alternatives considered.
- Who benefits from the change.

If the maintainers ask you to implement the change, work on a dedicated branch and keep changes focused to the single issue.

## Pull request guidelines

- Link the related issue in the PR description (e.g. "Fixes #123").
- Use a clear title and describe what changed and why.
- Keep PRs small and focused where possible; large changes may be split into multiple PRs.
- Run tests and linters locally before opening a PR.
- Respond to review feedback and update the branch (rebase or merge main to stay current).

## Code style & quality

- Follow the project's existing code style. If a formatter or linter is configured, run it before committing.
- Write clear, self-documenting code and add or update tests for new behavior.

### Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/). Format commits like:

```
type(scope): short description
```

Common types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`.

---

_If you need more help setting up your development environment, refer to the repository `README.md`._
