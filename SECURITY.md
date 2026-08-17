# Security Policy

## Supported status

The current default branch and currently maintained deployments are supported. This institutional repository does not publish versioned releases.

## Reporting a vulnerability

Please do not open a public issue for suspected vulnerabilities, credential leaks, private data exposure, authentication bypasses, payment-flow issues, supply-chain issues, or deployment misconfiguration.

Use GitHub's [private vulnerability reporting form](https://github.com/LCV-Ideas-Software/.github/security/advisories/new) or report privately by email:

- lcv@lcv.dev

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
- GitHub-to-Slack security alerts follow the ADR-002 two-state design: a delivery is accepted only
  when its durable D1 row is written; rows are only `pending` or `sent`, nothing is terminal, and
  the single scheduler (the cron plus the version-pinned ingress stamp) retries with exponential
  backoff saturating at 24 h. The consumer posts with `chat.postMessage` and marks `sent` only on
  Slack's `ok:true`; the platform queue never retries (`max_retries: 0`, no dead-letter queue). A
  scheduled watchdog reads `/alerts/status` behind a shared secret with a 32-byte floor and fails
  loud when the oldest pending row exceeds one hour. The legacy Slack workflow-app pipeline (hosted
  app, signing slots, delivery-protocol tables) was retired on 2026-08-17: its data was archived and
  dropped by migration 0011, and the app is no longer hosted;
- external credentials assigned by purpose to protected environments restricted to `main`. The
  `SLACK_BOT_TOKEN` and status/webhook secrets live only in the Cloudflare Secrets Store. The
  `SLACK_REDELIVERY_APP_PRIVATE_KEY` secret and `SLACK_REDELIVERY_APP_CLIENT_ID` variable are held
  `SLACK_REDELIVERY_APP_PRIVATE_KEY` secret and `SLACK_REDELIVERY_APP_CLIENT_ID` variable are held
  in `webhook-recovery`, which only the organization-webhook redelivery job declares.
  Outside that reviewed HMAC transition, `cloudflare-production` contains only `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID`, and only the Pages and relay deployment jobs declare it. A zero-downtime
  credential migration may temporarily retain rollback copies of the App pair there until
  exact-`main` canaries succeed; those copies are migration artifacts and must be removed before
  [#175](https://github.com/LCV-Ideas-Software/.github/issues/175) is closed. The dedicated,
  account-owned Cloudflare token `github-dotgithub-production` is limited to the exact organization
  account and the four grants those deploys require: `Pages Write`, `Workers Scripts Write`,
  `D1 Write`, and `Secrets Store Write`. Repository-level copies of the Cloudflare credentials are
  absent here; the remaining organization-wide rollout is tracked in
  [#169](https://github.com/LCV-Ideas-Software/.github/issues/169). GitHub does not inject these
  values automatically: an authorized job receives a secret only when its workflow explicitly
  references it. Workflows triggered by fork pull requests and by Dependabot receive no
  user-managed Actions secret;
- pull requests, squash-only merges, resolved conversations, and required checks enforced by effective rulesets and GitHub's native merge queue;
- no long-lived secrets in source control.

## Automation policy

Dependabot checks every supported ecosystem daily, automatically rebases its pull requests, and relies on GitHub's post-merge branch deletion. GitHub Actions updates are evaluated immediately, so that a release can be adopted as soon as its provenance, security, and compatibility are validated; every other ecosystem applies a seven-day cooldown to ordinary version updates for stability. Dependabot security updates are exempt from that delay. Required security and quality checks are never bypassed. Queue admission remains an authorized human action until a repository-scoped GitHub App with only the necessary permissions is separately approved and deployed.

Repository-local workflow and ruleset maintenance may implement this baseline. Enterprise or organization rules, settings, applications, and secrets require separate explicit operator consent before any change.
