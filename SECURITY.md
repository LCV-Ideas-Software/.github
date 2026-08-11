# Security Policy

## Supported status

The current default branch and currently maintained releases and deployments are supported. Older releases receive security updates only when operationally practical.

## Reporting a vulnerability

Please do not open a public issue for suspected vulnerabilities, credential leaks, private data exposure, authentication bypasses, payment-flow issues, supply-chain issues, or deployment misconfiguration.

Use GitHub's [private vulnerability reporting form](https://github.com/LCV-Ideas-Software/.github/security/advisories/new) or report privately by email:

- lcv@lcv.dev

Please include:

- affected repository, component, route, package, workflow, or public surface;
- affected version, release tag, commit SHA, or deployment URL when known;
- impact and exploitability;
- reproduction steps or a safe proof of concept, if available;
- whether any credential, personal data, payment data, private editorial material, or operational secret may be involved.

## Scope

In scope: application code, Workers/Pages functions, package publication, GitHub Actions, dependency and supply-chain configuration, repository publication boundaries, security documentation, and documented public service configuration.

Out of scope: social engineering, physical attacks, denial-of-service testing without prior written authorization, spam, automated noisy scanning, and reports that rely only on outdated browser or dependency versions without a concrete vulnerable path in this repository.

## Coordinated disclosure

LCV Ideas & Software will triage reports privately, request clarification when needed, and coordinate remediation before public disclosure. Public disclosure should wait until a fix or mitigation is available, unless there is an immediate user-safety reason to do otherwise.

## Operational baseline

This repository follows the LCV Ideas & Software single-operator security baseline:

- GitHub secret scanning and push protection;
- Dependabot alerts and security updates;
- versioned CodeQL Advanced Setup workflows in public repositories containing code;
- external GitHub Actions pinned by full commit SHA;
- workflow-level `permissions: {}` with the least `GITHUB_TOKEN` grant required by each job;
- external credential isolation is **partial today**, and the two gaps are stated rather than
  implied. `SLACK_SERVICE_TOKEN` is held in the protected environment `slack-production` and
  `SLACK_REDELIVERY_APP_PRIVATE_KEY` in `cloudflare-production`, both restricted to `main` — but an
  environment is shared by every job that declares it, so the two deploy jobs that also declare
  `cloudflare-production` can reach the App key without using it. The Cloudflare deployment
  credentials are not in an environment at all: they are repository-scoped, and although GitHub
  hands a secret only to a job that references it, any workflow here may reference them without
  declaring the environment, so no branch policy gates them. Both gaps are tracked in
  [#169](https://github.com/LCV-Ideas-Software/.github/issues/169). Workflows triggered by fork pull
  requests and by Dependabot receive no user-managed Actions secret;
- pull requests, squash-only merges, resolved conversations, and required checks enforced by effective rulesets and GitHub's native merge queue;
- no long-lived secrets in source control.

## Automation policy

Dependabot checks every supported ecosystem daily, automatically rebases its pull requests, and relies on GitHub's post-merge branch deletion. GitHub Actions updates are evaluated immediately, so that a release can be adopted as soon as its provenance, security, and compatibility are validated; every other ecosystem applies a seven-day cooldown to ordinary version updates for stability. Dependabot security updates are exempt from that delay. Required security and quality checks are never bypassed. Queue admission remains an authorized human action until a repository-scoped GitHub App with only the necessary permissions is separately approved and deployed.

Repository-local workflow and ruleset maintenance may implement this baseline. Enterprise or organization rules, settings, applications, and secrets require separate explicit operator consent before any change.
