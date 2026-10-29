# Governance at eclean

This is the single place to find governance rules that apply across our projects: who is responsible for decisions, how we make larger decisions, how and where to report issues (including security), legal/licensing expectations, and the cadence for governance reviews.

## Roles & responsibilities

- **Core maintainers**: set strategy, resolve escalations, and make final governance decisions when consensus isn't reached.
- **Project maintainers**: run day-to-day project operations, review and merge changes according to project rules, and escalate governance questions to core maintainers when needed.
- **Community moderators**: ensure conduct and community interactions follow our code of conduct and help route governance and conduct reports to the right owners.

> [!TIP]
> When in doubt about authority or ownership for a repository, check the repository's `README` and `CODEOWNERS` file; if still unclear, tag a core maintainer.

## Decision making

1. **Consensus**: we aim for consensus via open discussion (issues or RFCs).
2. **RFCs**: for major changes that affect project governance, APIs, release policy, or licensing, open an RFC. An RFC should describe the problem, proposed options, trade-offs, and the recommended path.
3. **Escalation**: if consensus cannot be reached within a reasonable time, core maintainers decide. Decisions should be recorded (linked PR/issue/RFC) and communicated to the project.

## Reporting: what, how, and where

### 📍 Where to report

Our repositories are not open to public issues, so reports go to the people who own the topic:

- [community@eclean.gg](mailto:community@eclean.gg): general governance and process questions.
- [legal@eclean.gg](mailto:legal@eclean.gg): legal, CLA and licensing questions.
- [privacy@eclean.gg](mailto:privacy@eclean.gg): data protection questions.
- [report.eclean.gg](https://report.eclean.gg): confidential reports of corruption, misconduct or compliance concerns, anonymous if you prefer.
- Team members and collaborators can also raise governance topics as GitHub Issues in the relevant repository, or open an RFC using the [issue template chooser](https://github.com/ecleangg/.github/issues/new/choose).

The full list of inboxes is at [eclean.gg/contact](https://eclean.gg/contact).

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

- Changes to default branches go through pull requests and are squash-merged. The public repositories also require signed commits, resolved conversations and a linear history, and block force pushes and deletion. We follow the same flow in private repositories, enforced where GitHub's plan allows.
- Access to private repositories or elevated permissions is granted on a need-to-work basis and reviewed regularly.

## Privacy & compliance

We follow privacy-by-design principles and relevant data protection regulations (e.g., GDPR/CCPA) where applicable. Projects that collect or process personal data must document the data flows and controls and consult legal when needed.

## Changes to this document

Changes to governance should be made via RFC or a tracked PR in this repository. Significant changes should be announced to the organization and linked from the accepting PR.

---

_If you need help finding the right place to report something, or you're unsure what to include, email [community@eclean.gg](mailto:community@eclean.gg) and we'll route it for you._
