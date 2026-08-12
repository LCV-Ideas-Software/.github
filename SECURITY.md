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
- a YAML-parsed canonical contract over all seven repository-local required contexts, run independently by Dependency Review and CodeQL on pull requests and merge groups. It fixes the exact triggers, check names and conditions, complete required-job structures, immutable Action references, commands, inputs and paths, and the sole approved Zizmor configuration. This closes single-runner structural regressions; coordinated rewrites of both runners and the candidate-head policy remain inside the external ruleset and review trust boundary;
- GitHub-to-Slack trigger acceptance is nonterminal: an authenticated pre-send boundary, unique
  Slack message-timestamp receipt, and paginated trace reconciliation are required before D1 calls
  a row delivered. Any uncertainty after the send boundary is retained for manual review and is
  never automatically resent. Dead letters and active manual review fail readiness; quarantined
  historical rows remain visibly `legacy_unverified` without authorizing a resend. The one known
  lost ID stays in manual review until an exact, audited, explicitly authorized one-time recovery.
  Expand rollout starts with delivery disabled and is serialized in one exact-SHA workflow. Queue
  consumers back off without D1 attempts or a Slack POST while Cloudflare and Slack receive the same
  new value only in their runtime `NEXT` slots. The new Worker control plane and monitor accept only
  `NEXT`; both hosted stores retain the old current key during expand, but only the Slack validator
  accepts it for inbound relay compatibility. Slack issues every new progress authorization and
  callback only with `NEXT`, so current never has to be recovered into GitHub. After migration and
  before either hosted deploy, a D1 preflight reads all six persisted activation fields. It permits
  only the initial inactive tuple with all activation metadata null or an active tuple whose SHA,
  schema and deterministic HMAC
  activation ID exactly match the staged signer; a later or partially written revision cannot replace
  the Worker until the reviewed contract removes that expand guard. After the Slack deploy, the workflow updates both fixed protected trigger IDs
  from their versioned definitions while suppressing the CLI response because it can contain bearer
  URLs. Only after the exact trigger inventory does a `NEXT`-key HMAC prove the Worker tag, Slack
  revision, and expanded
  schema and perform the only permitted false-to-true CAS while persisting an immutable activation
  ID, revision, and schema. One byte-identical retry may confirm the same CAS read-only after a lost
  response; a new ID, changed tuple, post-contract request, downgrade, wrong revision, wrong key,
  partial deploy, or incomplete schema fails closed. Deterministic reconciliation conflicts are 409;
  ambiguous persistence is retryable 503. Every signed relay carries its durable attempt number;
  D1 leases the pre-send boundary to one Slack `function_execution_id`, so only that execution may
  release `SendMessage` while a retry of the same execution remains idempotent. The retry transition
  and trace-applied marker are one atomic D1 batch. A retry is released only by authenticated proof that the
  failed pre-send step did not execute `SendMessage`, even if its D1 `send_started` CAS committed, and
  the report must bind that proof to the same relay attempt and Slack send-function execution that owns
  the durable lease; a competing or stale trace cannot release or attach to another attempt. The
  delivered rows remain retained until their applied terminal success or boundary-error trace is older
  than both retention cutoff and the durable activity-checkpoint overlap. The monitor timeout covers
  its bounded 100-page request, retry and reconciliation-report budget plus setup margin, preventing
  allowed throttling from starving every durable checkpoint update;
- external credentials assigned by purpose to protected environments restricted to `main`.
  `SLACK_SERVICE_TOKEN` and the production relay signer are held in `slack-production`. Before the
  receipt-protocol expand rollout, the same newly generated signer must be provisioned under the
  name `SLACK_RELAY_SIGNING_SECRET` in both `slack-production` and `cloudflare-production`. The
  workflows use it as a write-only source for the external runtime `NEXT` slots; they never read the
  old external current value. The Cloudflare GitHub copy is a temporary rollout artifact and must be
  removed by the separately reviewed contract phase after promotion and drain evidence. The
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
