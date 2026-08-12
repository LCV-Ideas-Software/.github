# Changelog

Notable changes to this repository are recorded here **from 11/08/2026 onward**. Earlier work is not
summarized in this file; see [Earlier history](#earlier-history) for where it is verifiable.

This repository is **not versioned**: it publishes the organization profile, the static
organization site, the sponsor page, the GitHub-to-Slack relay and the shared community-health
defaults, and none of them is released under a number. The one manifest that carries a `version`
field, `workers/github-slack-relay/package.json` at `0.1.0`, is `private: true` and is never
published to any registry — the Worker is deployed from this repository's source by
`wrangler deploy`, and that field does not gate, tag or name any deployment.

Two **components** hosted here are released under numbers, and their history is their tags, not this
file: the reusable Zizmor workflow (`zizmor/v2.2.0` at the time of writing) and the CodeQL SARIF gate
action (`codeql-sarif-gate/v1.0.0`). **External** consumers pin them by commit SHA, so for those a
change takes effect only once a new tag is cut and the pin is bumped. Inside this repository the
consumption is local and immediate: `.github/workflows/codeql.yml:60` invokes the gate as
`uses: ./codeql-sarif-gate`, and the Zizmor workflow runs from the branch under test. Entries are therefore grouped by date rather than
by semantic version. Each entry names the record that carries its evidence: the pull request, for a
versioned change, so the full diff, its reviews and its checks stay reachable; or the execution issue
for a change marked _(out-of-band)_, which by definition has no diff.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) as far as it applies to
an unversioned repository. Dates are written `DD/MM/AAAA` in Brasília time (UTC−03:00), the
presentation rule this organization applies to text meant for people
([`.github/WORK-TRACKING.md`](./.github/WORK-TRACKING.md)).

## 11/08/2026 — GitHub Actions governance sanitation

First repository of the enterprise-wide governance rollout described in
[Discussion #150](https://github.com/orgs/LCV-Ideas-Software/discussions/150) and executed under
[#148](https://github.com/LCV-Ideas-Software/.github/issues/148).

Every **versioned** change below reached `main` through the native merge queue, with signed squash
commits and no ruleset bypass. Some entries also required repository-setting mutations — deleting
secrets, variables and environments, and changing Actions permissions and the repository ruleset —
which do not pass through a merge queue and leave no commit. Those are marked _(out-of-band)_; their
evidence is the execution trail recorded in
[#148](https://github.com/LCV-Ideas-Software/.github/issues/148), not this file.

### Removed

- Retired the repository-owned `native-auto-merge` controller and the `native-governance`
  reconciler, together with their workflows, action, scripts and documentation. Both were local
  creations rather than native GitHub features: the first armed human pull requests automatically
  and re-validated bot prose inside the merge group; the second scheduled mutations of rulesets and
  settings. Pull requests now enter GitHub's native merge queue by explicit human admission
  ([#151](https://github.com/LCV-Ideas-Software/.github/pull/151)).
- Consolidated `format-public.yml` into the `Build Pages artifact` job and removed the duplicated
  workflow and check context ([#151](https://github.com/LCV-Ideas-Software/.github/pull/151)).
- Removed the manual organization-webhook control surface: the
  `github-slack-hook-management.yml` workflow and its `github-slack-hook-management.mjs` controller,
  which offered `provision`, `activate`, `deactivate` and `ping` operations against the hook and ran
  with `permissions: write-all`. What remains is read-only: `scripts/github-slack-hook-audit.mjs` audits the
  hook by GET, and `.github/workflows/github-slack-webhook-redelivery.yml` recovers failed deliveries without ever
  creating or reconfiguring a hook
  ([#151](https://github.com/LCV-Ideas-Software/.github/pull/151)).
- _(out-of-band)_ Removed the legacy `LCV_AUTOMATION_TOKEN`, `SLACK_RELAY_GITHUB_WEBHOOK_SECRET`,
  `LCV_NATIVE_RECONCILE_ENABLED` and `SLACK_RELAY_LAST_REDELIVERY` secrets and variables, and the
  orphaned `dependabot-automation`, `github-administration` and `projects-automation` environments,
  after the recovery canary proved green
  ([#148](https://github.com/LCV-Ideas-Software/.github/issues/148)).

### Changed

- Applied least privilege across all workflows: `permissions: {}` at workflow level, minimal grants
  per job, `default_workflow_permissions=read` and GitHub Actions no longer able to approve pull
  requests. `permissions: write-all` is gone from the repository
  ([#149](https://github.com/LCV-Ideas-Software/.github/pull/149),
  [#151](https://github.com/LCV-Ideas-Software/.github/pull/151)).
- Pinned Wrangler by exact version in the manifests and lockfiles and removed `wrangler@latest`;
  every workflow now verifies the effective npm registry before `npm ci`
  ([#149](https://github.com/LCV-Ideas-Software/.github/pull/149)).
- _(out-of-band)_ Restricted the repository to `allowed_actions=selected` with SHA pinning
  required, admitting only GitHub-owned actions plus `denoland/setup-deno` and
  `ossf/scorecard-action`; set `default_workflow_permissions=read` and disabled pull-request
  approval by GitHub Actions
  ([#148](https://github.com/LCV-Ideas-Software/.github/issues/148)).
- _(out-of-band)_ Reduced the repository ruleset to the seven functional check contexts that the
  inherited Enterprise and organization rulesets cannot express, and removed
  `Test native auto-merge`, `Test native governance`, `OpenSSF Scorecard` and
  `Check index.html formatting` ([#148](https://github.com/LCV-Ideas-Software/.github/issues/148)).
- Restored the exact Slack scope set required by the official `SendMessage` backend —
  `chat:write`, `chat:write.public`, `channels:read` — as a narrow, documented exception
  ([#156](https://github.com/LCV-Ideas-Software/.github/pull/156)).
- Moved organization-webhook audit and redelivery onto the dedicated GitHub App
  `lcv-slack-webhook-recovery`, installed only on this repository, with ephemeral tokens minted
  read-only for audit and write-scoped only for recovery, and revoked by the post-job step
  ([#163](https://github.com/LCV-Ideas-Software/.github/pull/163)).
- Aligned the Dependabot policy: GitHub Actions updates are evaluated immediately; every other
  ecosystem keeps a seven-day cooldown for ordinary version updates; the cooldown does not apply to
  security updates ([#164](https://github.com/LCV-Ideas-Software/.github/pull/164)).
- Kept the Enterprise hardened OIDC issuer for Scorecard and disabled only the incompatible public
  result publication, preserving the official scanner, the SARIF upload and the fail-closed policy
  ([#165](https://github.com/LCV-Ideas-Software/.github/pull/165)).
- Bound the Actions pin auditor to component release families so an internal component pin must
  match its own release tag ([#166](https://github.com/LCV-Ideas-Software/.github/pull/166)).
- Granted the reusable Zizmor workflow the `actions: read` scope that
  `codeql-action/upload-sarif` needs to read workflow-run metadata, which was blocking
  cross-repository SARIF uploads, and added the first structural assertions protecting a required
  context from regression: the suite now rejects an inline permission bypass, a `write-all` grant,
  an unexpected job list and a job-permission set other than the approved one. Released as
  `zizmor/v2.2.0` at `97627f2`
  ([#173](https://github.com/LCV-Ideas-Software/.github/pull/173)).

### Added

- Native static Issue and Discussion forms plus
  [`.github/WORK-TRACKING.md`](./.github/WORK-TRACKING.md), the ritual for recording work in
  Issues, Projects and Discussions. Project inclusion and status are updated manually; this
  repository declares no automatic backfill
  ([#161](https://github.com/LCV-Ideas-Software/.github/pull/161)).
- This changelog, as the canonical history required by the canonical-artifact directive recorded in
  Discussion #150 ([#168](https://github.com/LCV-Ideas-Software/.github/pull/168)).

### Fixed

- Segregated the organization-webhook recovery App into the dedicated, protected
  `webhook-recovery` environment. A YAML-parsed inventory now fixes every workflow job/environment
  tuple and rejects any second job or workflow that references the App Client ID or private key;
  the temporary rollback copies in `cloudflare-production` are removed only after exact-`main`
  recovery canaries succeed
  ([#175](https://github.com/LCV-Ideas-Software/.github/issues/175),
  [#179](https://github.com/LCV-Ideas-Software/.github/pull/179)).
- Closed the one-line structural regression escape shared by all seven repository-local required contexts. A single
  YAML-parsed contract now fixes the exact `pull_request` and `merge_group` triggers, context names
  and conditions, complete required-job structures, critical Actions, commands, inputs and paths,
  and the sole approved Zizmor configuration. Dependency Review and both CodeQL matrix jobs execute
  the contract and its in-memory mutation suite independently, so a regression confined to either
  runner is detected by the other. A coordinated rewrite of both runners and the candidate-head
  policy remains governed by external rulesets and review rather than authenticated by this
  contract. Full immutable Action references are inside the digest, while the pin auditor
  independently validates their release provenance
  ([#170](https://github.com/LCV-Ideas-Software/.github/issues/170),
  [#177](https://github.com/LCV-Ideas-Software/.github/pull/177)).
- Aligned the documentation and the public surface with the repository's real state: the Dependabot
  cooldown wording in `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `profile/README.md` and the
  explanatory comment in `.github/zizmor.yml`; the
  public repository count and the AI-roster claims on `site/index.html`; a typo in the site heading;
  a false credential-isolation claim in `SECURITY.md`; the private-board links in
  `.github/WORK-TRACKING.md`; the canonical-artifact coverage in `.github/CODEOWNERS`; and the
  third-party inventory in `THIRDPARTY.md`
  ([#167](https://github.com/LCV-Ideas-Software/.github/issues/167),
  [#168](https://github.com/LCV-Ideas-Software/.github/pull/168)).
- The footer contact link on the public site. It rendered as `Contatolcv@lcv.dev` and, without
  JavaScript, went nowhere: a placeholder `href="#contact"`, a `::before` rule supplying the label
  and an inline script rewriting the href at load. The obfuscation kept nothing hidden — the address
  was served inside that same script, and is published in plain text in `SECURITY.md`,
  `CODE_OF_CONDUCT.md` and `profile/README.md`. The footer now carries a plain
  `mailto:` link, and the script and the `::before` rule are gone
  ([#174](https://github.com/LCV-Ideas-Software/.github/issues/174),
  [#168](https://github.com/LCV-Ideas-Software/.github/pull/168)).
- _(out-of-band)_ Created the repository label `maintenance`, declared by
  `.github/ISSUE_TEMPLATE/engineering_task.md` but absent from the repository, so every issue opened
  through that form was silently created unlabelled. Labels are not versioned here, so this change
  has no file diff ([#167](https://github.com/LCV-Ideas-Software/.github/issues/167)).
- Corrected the GitHub-to-Slack delivery model exposed by the missing
  `de345e40-95b1-11f1-8d38-fac15f0bb4cd` message: trigger `ok: true` is now the
  nonterminal `accepted_by_trigger`; the Slack workflow authenticates a
  pre-`SendMessage` boundary and an idempotent post-message receipt carrying
  Slack's timestamp; and the fully paginated monitor durably correlates the
  actual Slack trace. Only a complete error trace with an explicit failed
  validator or pre-send step and no send boundary can be retried; ambiguous
  trigger network/5xx outcomes and stale
  `sending` rows are also never resent. Historical trigger acceptances remain
  explicitly unverified, and the known loss migrates to `manual_review` instead
  of being relabelled as delivered. The migration remains compatible with the
  previously deployed Worker; its in-window acceptances are trigger-quarantined.
  Production rollout is now one same-SHA workflow. Its required predecessor
  verifies both the Worker and the complete Slack app candidate before the
  serialized migration, activation-tuple preflight, Cloudflare `NEXT` staging,
  inactive Worker deploy,
  Slack `NEXT` staging, Slack deploy, protected-trigger inventory, and
  activation. The same newly generated
  value must first be stored under `SLACK_RELAY_SIGNING_SECRET` in both protected
  GitHub environments; the jobs write it only in request bodies to the two
  external `NEXT` slots and never recover or log the old current value. The
  Worker and monitor select `NEXT` for new traffic. Both hosted stores retain
  current during expand, but only the Slack validator accepts it for inbound
  relay compatibility; the Worker control plane accepts `NEXT` only. A relay
  admitted by either Slack verifier receives progress authorization and
  callbacks only under `NEXT`, so the monitor correlates it without recovering
  old current into GitHub. Before either hosted deploy, the activation-tuple
  preflight permits only the initial inactive state or the already activated
  exact SHA, preventing a later revision from replacing the live Worker until a
  reviewed contract removes the expand latch. A
  `NEXT`-key HMAC binds the exact main
  SHA to the Worker's immutable version tag, proves the expanded schema, and
  performs a one-way activation CAS that persists an activation ID derived from
  that SHA and schema. One byte-identical retry can confirm a response lost after
  CAS without another mutation, while a new ID, changed tuple, post-contract
  request, partial deploy, wrong key/SHA, or downgrade remains closed without a
  Slack POST or D1 delivery attempt. After the app deploy, both protected
  trigger IDs are updated in place from their versioned definitions with all
  CLI output suppressed, then the exact mapping inventory must pass before
  activation. Deterministic reconciliation conflicts
  return 409 while persistence failure or a response lost after a write returns
  retryable 503. Competing receipt/progress writes converge only after an exact
  reread. Each dispatch attempt is signed into the Slack workflow, and a durable
  lease on Slack's `function_execution_id` lets only one workflow execution
  cross `SendMessage`; retries by that same execution remain idempotent. The
  safe-retry delivery transition and terminal-trace marker commit in one D1
  batch, so a lost response cannot let the old trace release a later attempt.
  The activity monitor reports the signed attempt and Slack step
  `function_execution_id`; D1 requires both to match the live lease before a
  trace can release, attach to, or make purgable a delivery. Authenticated proof
  that a failed pre-send progress step never
  reached `SendMessage` safely releases even a locally recorded `send_started`
  CAS. Late trace evidence is merged, delivered rows without a Slack trace are
  retained, and purging cannot cross the durable activity checkpoint minus its
  overlap window; a delivered row remains eligible when its applied terminal
  trace is success or a boundary-confirmed error caused by a lost receipt reply.
  Terminally contradictory traces are rejected before any reconciliation
  mutation; empty activity scans cannot advance to wall clock; D1 causally clamps
  the monitor checkpoint behind uncorrelated live attempts; the scheduled job's
  timeout covers the full bounded 100-page retry/report plan plus setup margin,
  so throttling cannot force the same uncommitted window to restart forever;
  and the known ID has
  a fixed one-time audited release requiring separate absence proof and explicit
  ID/destination authorization before its normal receipt path. The former
  `workflow_run` checkout and `GITHUB_PATH` mutation were removed from this
  privileged rollout
  ([#171](https://github.com/LCV-Ideas-Software/.github/issues/171)).

### Issues discovered during this audit

- At the snapshot that opened #169, `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` were
  repository-scoped secrets rather than environment-scoped ones, so the `cloudflare-production`
  branch policy did not gate them. This repository has since moved the pair into the protected
  environment and removed the repository-level copies. The same original placement was found in
  seven other deploy repositories, so the remaining organization-wide rollout stays tracked in
  [#169](https://github.com/LCV-Ideas-Software/.github/issues/169).
- At the snapshot that opened #175, the protected `cloudflare-production` environment was shared by
  every job that declared it, so `SLACK_REDELIVERY_APP_PRIVATE_KEY` — which mints tokens with
  `Organization webhooks: write` — was authorized for two deploy jobs that did not reference it.
  The dedicated `webhook-recovery` environment now provides the App pair only to the controller;
  rollback copies remain temporarily in the old environment until the exact-`main` canaries pass,
  as recorded in the Fixed entry above. Tracked in
  [#175](https://github.com/LCV-Ideas-Software/.github/issues/175).
- A GitHub-to-Slack delivery can be recorded as accepted and never reach the channel. On 11/08/2026
  the trigger endpoint answered `{"ok":true}`, D1 stored `accepted_by_slack`, and the asynchronous
  workflow execution then ended in `TIMEOUT`; that message does not exist in the channel. Terminal
  states are not retried, and GitHub webhook redelivery cannot repair it because the same
  `delivery_id` is idempotently recognized as already accepted. Acceptance by the trigger is not
  confirmation that the message was delivered, and the two are not distinguished today. Tracked in
  [#171](https://github.com/LCV-Ideas-Software/.github/issues/171).

### Platform defect, no longer tracked as a pendency

Workflow run [31509445513](https://github.com/LCV-Ideas-Software/.github/actions/runs/31509445513)
is permanently `queued` with no job: cancel and force-cancel return HTTP 500 and delete returns 403,
because deletion requires a completed run. It never materialized a job, so nothing executed and the
fail-closed containment held. Its tracker
[#125](https://github.com/LCV-Ideas-Software/.github/issues/125) was closed as completed; the run is
superseded by the scheduled executions that succeeded after it, and is recorded here only so a
future audit does not reopen it as an unexplained non-terminal run.

## Earlier history

Before this sanitation the repository grew through 247 commits on `main` — the count at
`e327307^`, immediately before the first change listed above — covering the organization
profile, the static site at <https://www.lcv.dev>, the GitHub Pages mirror, the sponsor page, the
GitHub-to-Slack relay and successive iterations of security and automation baselines. That history
was never summarized in a changelog; rather than reconstruct it after the fact, it is left where it
is verifiable — in the commit history and in the pull requests it references.
