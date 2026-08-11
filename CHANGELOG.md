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
  with `permissions: write-all`. What remains is read-only: `github-slack-hook-audit.mjs` audits the
  hook by GET, and `github-slack-webhook-redelivery.yml` recovers failed deliveries without ever
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

### Known issues

- `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are repository-scoped secrets rather than
  environment-scoped ones, so the `cloudflare-production` branch policy does not gate them. This
  diverges from the protected-environment baseline of Discussion #150 §4 and no authorized exception
  is recorded for it. The same placement is reported across the repositories that deploy to
  Cloudflare, which makes the decision organization-wide rather than local to this repository.
  Tracked in [#169](https://github.com/LCV-Ideas-Software/.github/issues/169).
- A protected environment is shared by every job that declares it, so
  `SLACK_REDELIVERY_APP_PRIVATE_KEY` — which mints tokens with `Organization webhooks: write` — is
  reachable from the two deploy jobs that declare `cloudflare-production` without using it. Both run
  only on `main`, so the exposure is contained, but the credential is segregated by provider rather
  than by purpose. Tracked in [#175](https://github.com/LCV-Ideas-Software/.github/issues/175).
- None of the seven required status-check contexts is protected against structural regression. The
  live re-read widened this beyond the two gates originally reported: a job disabled with `if: false`
  reports **Success** and does not block the merge, so a workflow that only tests itself stops
  protecting anything the moment its own job is skipped; `continue-on-error` is unguarded on the
  enforcement steps; `pages.yml` is read by no test at all; and in `.github/zizmor.yml`
  a `rules.<id>.disable: true` entry would be a real bypass even under `--no-ignores`, which
  suppresses ignores without making the configuration inert — the file carries no such entry today,
  and nothing would fail if one were added. No active defect exists in the current YAML —
  the gap is that nothing stops one line from removing each guarantee. Tracked in
  [#170](https://github.com/LCV-Ideas-Software/.github/issues/170), to be remediated in its own pull
  request rather than mixed into documentation work.
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
