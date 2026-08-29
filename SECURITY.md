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
  workflow explicitly references it. The repository-local Dependabot admission App key is
  referenced only from the `dependabot-automation` Actions environment by workflows loaded from
  the default branch. The automatic `pull_request` stage is an unprivileged signal with no token
  permission, secret, Action, checkout, cache, artifact, or pull-request-controlled command. No
  workflow references a Dependabot-store copy of the App key; any legacy copy is an external
  configuration defect to remove after rollout. Fork and non-Dependabot runs receive no
  user-managed secret;
- pull requests, squash-only merges, resolved conversations, and required checks enforced by effective rulesets and GitHub's native merge queue;
- no long-lived secrets in source control.

## Automation policy

Dependabot checks every supported ecosystem daily, automatically rebases its pull requests, and relies on GitHub's post-merge branch deletion. Official Actions under `actions/*` and `github/*` are evaluated immediately, so that a release can be adopted as soon as its provenance, security, and compatibility are validated; third-party GitHub Actions and every other ecosystem apply a seven-day cooldown to ordinary version updates for stability. Dependabot security updates are exempt from that delay. Required security and quality checks are never bypassed.

Queue admission is human for human-authored pull requests. Canonical same-repository pull requests authored by `dependabot[bot]` are the deliberate exception. Dependabot-emitted `opened` and `synchronize` events execute only an unprivileged `pull_request` signal. A `workflow_run` follow-up loaded from `main` authenticates the registered signal by workflow ID and path, validates the exact source run and actors, and resolves exactly one live pull request through GitHub's official commit-association API. Before the App key is read, it requires an open, non-draft, same-repository PR to `main`, a `dependabot/**` head, the exact event SHA, the Dependabot account, GitHub's `web-flow` committer, a valid GitHub signature, a complete paginated file inventory, and no added, changed, renamed, or removed file under `.github/workflows/**`. GitHub may omit `workflow_run.pull_requests`; an empty list is never treated as identity evidence and is resolved fail-closed through the commit endpoint. Immediately before admission, the mutator rereads the PR and file inventory and uses `gh pr merge --auto --squash --match-head-commit`.

Dependabot auto-merge is intentionally independent per repository and uses GitHub's native auto-merge and merge queue rather than an organization-wide controller or scheduler. The App key is consumed only from the protected `dependabot-automation` Actions environment after the trusted follow-up has proved provenance. It is exchanged at runtime for a short-lived token limited to pull-request, merge-queue, and repository-content merge operations, as required by GitHub's native merge API. A rare ready/reopen transition requires another Dependabot synchronization or the explicit `workflow_dispatch` fallback loaded from `main` and restricted to the sole operator `lcv-leo` by immutable account ID. Neither path checks out or executes repository content, and neither updates branches nor repairs lockfiles. The native merge queue still runs every required check on its synthetic `merge_group` revision; the automation cannot bypass rules, merge directly, or process forks, drafts, conflicting heads, or any other author.

`--match-head-commit` pins the admission operation to the verified head, but GitHub documents automatic cancellation after a later push only for actors without write permission. The no-bypass Enterprise Required Workflow `Dependabot head authorization` is therefore the authoritative per-head control: it runs again for every pull-request snapshot, validates the live actor, sender, PR and exact signed head, and prevents the merge queue from accepting a later unauthorized update even if a prior auto-merge request remains armed. The repository-local signal and mutator provide safe admission; the Required Workflow provides continuous head authorization. Repository-local workflows may secure and publish only this repository's own institutional surfaces. Enterprise or organization rules, settings, applications, and secrets require separate explicit operator consent before any change.
