# Security Policy

## Supported status

The current default branch and currently maintained deployments are supported. This institutional repository does not publish versioned releases.

## Reporting a vulnerability

Please do not open a public issue for suspected vulnerabilities, credential leaks, private data exposure, authentication bypasses, payment-flow issues, supply-chain issues, or deployment misconfiguration.

Use GitHub's [private vulnerability reporting form](https://github.com/LCV-Ideas-Software/.github/security/advisories/new) or report privately by email:

- security@lcv.dev

Please include:

- affected repository, component, route, package, workflow, or public surface;
- affected commit SHA or deployment URL when known;
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
- direct, SHA-pinned official CodeQL, Dependency Review, Zizmor, and OpenSSF Scorecard Actions. CodeQL remains the native merge-protection signal; Zizmor and Scorecard publish SARIF for stateful security visibility without repository-owned gates, baselines, wrappers, or workflow-contract validators;
- the official Zizmor Action does not yet expose `--strict-collection` ([upstream #141](https://github.com/zizmorcore/zizmor-action/issues/141)), so collection syntax or schema errors can remain warnings. This accepted upstream limitation is tracked without adding a repository-owned executor or gate;
- external credentials assigned by purpose to protected environments restricted to `main`. GitHub
  does not inject these values automatically: an authorized job receives a secret only when its
  workflow explicitly references it. Workflows triggered by fork pull requests and by Dependabot
  receive no user-managed Actions secret;
- pull requests, squash-only merges, resolved conversations, and required checks enforced by effective rulesets and GitHub's native merge queue;
- no long-lived secrets in source control.

## Automation policy

Dependabot checks every supported ecosystem daily, automatically rebases its pull requests, and relies on GitHub's post-merge branch deletion. GitHub Actions updates are evaluated immediately, so that a release can be adopted as soon as its provenance, security, and compatibility are validated; every other ecosystem applies a seven-day cooldown to ordinary version updates for stability. Dependabot security updates are exempt from that delay. Required security and quality checks are never bypassed.

Queue admission is human for human-authored pull requests. Canonical same-repository pull requests authored by `dependabot[bot]` are the deliberate exception: a least-privilege protected credential may rebase an explicitly stale branch with `expectedHeadOid`, then enable native auto-merge or enqueue the exact validated head. The native merge queue still runs every required check on its synthetic `merge_group` revision; the automation cannot bypass rules, merge directly, or process forks, drafts, conflicting heads, or any other author.

Dependabot Custom Auto-merge is implemented and operated exclusively from `github-operations`; no reusable action, controller, scheduler, canary, or privileged credential for that system is maintained here. Repository-local workflows may secure and publish this repository's own institutional surfaces. Enterprise or organization rules, settings, applications, and secrets require separate explicit operator consent before any change.
