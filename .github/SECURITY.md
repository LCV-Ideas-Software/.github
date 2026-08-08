# Security Policy

## Reporting a Vulnerability

Please do not open a public issue for security vulnerabilities. Report privately to the maintainer instead.

**Contact:** lcv@lcv.dev

Include:
- affected repository and component
- impact and exploitability
- reproduction steps or proof of concept, if safe to share
- suggested fix, if available

The maintainer will triage as soon as practical. Critical reports that may expose user data, credentials, payment flows, deployment credentials, or CI/CD integrity are prioritized.

## Supported Versions

| Version | Supported |
| --- | --- |
| Latest release / `main` | Yes |
| Older releases | Security updates only when operationally practical |

## Operational Baseline

This repository follows the LCV Ideas & Software single-operator security baseline:
- GitHub secret scanning and push protection
- Dependabot alerts and security updates
- versioned CodeQL Advanced Setup workflows in public repositories containing code
- external GitHub Actions pinned by full commit SHA
- the organization-defined `permissions: write-all` workflow baseline, with privileged credentials isolated from pull-request code
- no long-lived secrets in source control

## Automation Policy

Dependabot patch and minor updates are intended to auto-merge after CI passes. Do not add reviewer gates that force manual approval for routine Dependabot updates unless a specific incident requires it.
