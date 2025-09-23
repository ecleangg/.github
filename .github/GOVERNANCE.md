# Governance at Eclean

This is the single place to find governance rules that apply across our projects: who is responsible for decisions, how we make larger decisions, how and where to report issues (including security), legal/licensing expectations, and the cadence for governance reviews.

## Roles & responsibilities

- **Core maintainers**: set strategy, resolve escalations, and make final governance decisions when consensus isn't reached.
- **Project maintainers**: run day-to-day project operations, review and merge changes according to project rules, and escalate governance questions to core maintainers when needed.
- **Community moderators**: ensure conduct and community interactions follow our code of conduct and help route governance and conduct reports to the right owners.

> [!TIP]
> When in doubt about authority or ownership for a repository, check the repository's `README` and `CODEOWNERS` file; if still unclear, tag a core maintainer.

## Decision making

1. **Consensus**: we aim for consensus via open discussion (issues, discussions, or RFCs).
2. **RFCs**: for major changes that affect project governance, APIs, release policy, or licensing, open an RFC. An RFC should describe the problem, proposed options, trade-offs, and the recommended path.
3. **Escalation**: if consensus cannot be reached within a reasonable time, core maintainers decide. Decisions should be recorded (linked PR/issue/RFC) and communicated to the project.

## Reporting: what, how, and where

### 📍 Where to report

- [GitHub Issues](https://github.com/ecleangg/.github/issues/new/choose) — for reproducible bugs, governance or process concerns tied to a repository.
- [GitHub Discussions](https://github.com/orgs/ecleangg/discussions) — for open-ended governance conversations and proposals not yet ready as RFCs.
- Email — for confidential or sensitive topics not suitable for public issues/discussions:
  - [community@eclean.gg](mailto:community@eclean.gg) — general governance questions
  - [legal@eclean.gg](mailto:legal@eclean.gg) — legal/CLA/licensing questions

### 📝 What to include

- A short summary of the issue or request.
- Relevant context (repository name, links to PRs/issues, dates, and affected versions).
- Any proposed remediation or preferred outcome.

### 🔁 How we handle reports

- Project maintainers or community moderators will acknowledge incoming reports within 3 business days.
- Confidential reports via email will be handled by core maintainers and appropriate stakeholders.
- Outcomes, decisions, and next steps are recorded publicly where possible (issue/PR/RFC) to preserve transparency.

## Security and incident reporting

Report security issues only via our [SECURITY.md](SECURITY.md) process. Do not post exploit details publicly. We maintain a coordinated disclosure process; security reports sent according to the security policy will be triaged by maintainers and our security contacts.

## Legal, licensing & contributor agreements

- Public projects must include a license file. If a contributor or project requires a CLA, follow the repository's stated process and route legal questions to [legal@eclean.gg](mailto:legal@eclean.gg).
- Respect third-party license obligations and disclose dependencies that have restrictive terms during RFCs for major architectural changes.

## Access control & protected branches

- Main branches are protected. Merges require at least one approval from a project maintainer and passing CI checks unless an explicit exception is granted by core maintainers.
- Access to private repositories or elevated permissions is granted on a need-to-work basis and reviewed regularly.

## Privacy & compliance

We follow privacy-by-design principles and relevant data protection regulations (e.g., GDPR/CCPA) where applicable. Projects that collect or process personal data must document the data flows and controls and consult legal when needed.

## Changes to this document

Changes to governance should be made via RFC or a tracked PR in this repository. Significant changes should be announced to the organization and linked from the accepting PR.

---

_If you need help finding the right place to report something, or you're unsure what to include, email [community@eclean.gg](mailto:community@eclean.gg) and we'll route it for you._
