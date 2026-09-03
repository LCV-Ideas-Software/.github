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
- GitHub code scanning default setup for CodeQL with the extended query suite;
- external GitHub Actions pinned by full commit SHA;
- workflow-level `permissions: {}` with the least `GITHUB_TOKEN` grant required by each job;
- direct, SHA-pinned official Dependency Review, Zizmor, and OpenSSF Scorecard Actions. CodeQL default setup remains the native merge-protection signal; Zizmor and Scorecard publish SARIF for stateful security visibility without repository-owned gates, baselines, wrappers, lockfiles, or workflow-contract validators;
- the official Zizmor Action does not yet expose `--strict-collection` ([upstream #141](https://github.com/zizmorcore/zizmor-action/issues/141)), so collection syntax or schema errors can remain warnings. This accepted upstream limitation is tracked without adding a repository-owned executor or gate;
- external credentials assigned by purpose to protected environments restricted to `main`, with one
  documented exception: the Dependabot auto-merge workflow reads a fine-grained personal access
  token (Contents, Pull requests and Workflows, read and write) from the Dependabot secret
  `DEPENDABOT_AUTOMERGE_TOKEN`, because a workflow triggered by a Dependabot pull request can read
  Dependabot secrets only. GitHub does not inject these values automatically: an authorized job
  receives a secret only when its workflow explicitly references it. The auto-merge workflow runs
  only on Dependabot's own pull requests from this repository, grants no `GITHUB_TOKEN`
  permission, binds the arming request to the exact event head, ends without arming anything
  when the run carries no Dependabot secret (an event initiated by a person), and runs no Action,
  checkout, cache, artifact, or pull-request-controlled command. Fork and non-Dependabot pull
  requests never run it;
- pull requests, squash-only merges, resolved conversations, and required checks enforced by the effective Enterprise and repository rulesets;
- no long-lived secrets in source control.

## Automation policy

Dependabot checks every supported ecosystem weekly, groups minor and patch updates per ecosystem, automatically rebases its pull requests, and relies on GitHub's post-merge branch deletion. Official Actions under `actions/*` and `github/*` are evaluated immediately, so that a release can be adopted as soon as its provenance, security, and compatibility are validated; third-party GitHub Actions and every other ecosystem apply a seven-day cooldown to ordinary version updates for stability. Dependabot security updates are exempt from that delay. Required security and quality checks are never bypassed.

Dependabot pull requests are the only automatically admitted change. The repository-local workflow `.github/workflows/dependabot-auto-merge.yml` runs on Dependabot's own `pull_request` events with no `GITHUB_TOKEN` permission, no Action, and no checkout, and enables GitHub's native auto-merge (squash) on the pull request with a fine-grained personal access token stored as the Dependabot secret `DEPENDABOT_AUTOMERGE_TOKEN`. GitHub performs the merge only after every rule of the effective rulesets and every required check is satisfied; the workflow cannot bypass rules, merge directly, update branches, repair lockfiles, or process forks or any other author. There is no GitHub App, merge queue, organization-wide controller, or scheduler.

Repository-local workflows may secure and publish only this repository's own institutional surfaces. Enterprise or organization rules, settings, applications, and secrets require separate explicit operator consent before any change.
