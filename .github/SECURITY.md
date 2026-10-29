# Security Policy

We care about security and want reports to be easy and useful. This document explains how, where, and what to report if you find a security issue affecting eclean projects.

## What to report

Report anything that could lead to information disclosure, data loss, privilege escalation, remote code execution, account takeover, or other security or privacy issues.

> [!IMPORTANT]
> If you're unsure whether something is a security issue or not, report it — we'll triage it.

## Where to report

Email [security@eclean.gg](mailto:security@eclean.gg) with details. If the issue is time-sensitive or clearly exploitable in production, put "URGENT" at the start of the subject line.

Do not create public issues, pull requests, or otherwise disclose the details publicly before we've had a chance to investigate and coordinate a fix.

To encrypt your report, use our OpenPGP key at [eclean.gg/pgp](https://eclean.gg/pgp). Our [security.txt](https://eclean.gg/.well-known/security.txt) lists the same contact details, and researchers we credit are listed on [eclean.gg/acknowledgements](https://eclean.gg/acknowledgements).

For our public repositories you can also use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**.

## How to report and what to include

Please include as much as you can — more detail speeds up fixes.

- **Short summary & scope:** a plain-English one-line summary of the issue, its impact, and which repository/service/URL is affected.
- **Reproduction & proof:** exact steps, commands, requests or a minimal proof‑of‑concept (attach or paste exploit/PoC); include request/response examples when relevant.
- **Evidence & context:** logs, error messages, screenshots, recordings, or other artifacts that illustrate the issue.
- **Observed vs expected:** what happened vs what you expected, and an estimated severity/impact.
- **Contact & disclosure preference:** your contact info and whether you prefer anonymous, credited, or no public credit; attach files when possible.

## What we will do and timelines

1. **Acknowledgment:** We'll confirm we received your report within 48 hours.
2. **Triage & assessment:** We'll reproduce the issue and assess severity.
3. **Coordination:** We'll keep you updated while we work on a fix.
4. **Resolution:** When fixed, we'll notify you and coordinate any disclosure.

### Timelines (typical aims — may vary by complexity)

- **Critical issues:** target fix within 7 days
- **High severity:** target fix within 30 days
- **Other issues:** target fix within 90 days

## Responsible disclosure & safe harbor

We ask that reporters avoid public disclosure until we have had a chance to coordinate a fix. In return, we will provide timely acknowledgement and status updates, refrain from pursuing legal action for good‑faith security research, and work with you on disclosure timing — including crediting your contribution when you permit it.

### Out of scope

Safe harbor applies to good-faith research that stays within these limits. Please do not:

- use social engineering against our staff or users, including phishing
- attack our premises or equipment physically
- run denial-of-service or volumetric tests
- test third-party services we use, for example by attacking their infrastructure; report issues in those services to their owners
- access or modify other people's data beyond what you need to demonstrate the issue, and stop and tell us if you come across such data

---

_Thanks for helping keep eclean safe. We appreciate reports, clear steps, and people who help us improve security._
