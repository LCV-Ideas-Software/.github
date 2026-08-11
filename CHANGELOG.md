# Changelog

All notable changes to this repository are recorded here.

This repository is **not versioned**: it publishes the organization profile, the static
organization site, the sponsor page, the GitHub-to-Slack relay and the shared community-health
defaults, none of which carry a release number. Entries are therefore grouped by date rather than
by semantic version, and each one names the pull request that carried it so the full diff, its
reviews and its checks stay reachable.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) as far as it applies to
an unversioned repository.

## 2026-08-11 — GitHub Actions governance sanitation

First repository of the enterprise-wide governance rollout described in
[Discussion #150](https://github.com/orgs/LCV-Ideas-Software/discussions/150) and executed under
[#148](https://github.com/LCV-Ideas-Software/.github/issues/148). Every change below reached `main`
through the native merge queue with signed squash commits and no ruleset bypass.

### Removed

- Retired the repository-owned `native-auto-merge` controller and the `native-governance`
  reconciler, together with their workflows, action, scripts and documentation. Both were local
  creations rather than native GitHub features: the first armed human pull requests automatically
  and re-validated bot prose inside the merge group; the second scheduled mutations of rulesets and
  settings. Pull requests now enter GitHub's native merge queue by explicit human admission
  ([#151](https://github.com/LCV-Ideas-Software/.github/pull/151)).
- Consolidated `format-public.yml` into the `Build Pages artifact` job and removed the duplicated
  workflow and check context ([#151](https://github.com/LCV-Ideas-Software/.github/pull/151)).
- Removed the legacy `LCV_AUTOMATION_TOKEN`, `SLACK_RELAY_GITHUB_WEBHOOK_SECRET`,
  `LCV_NATIVE_RECONCILE_ENABLED` and `SLACK_RELAY_LAST_REDELIVERY` secrets and variables, and the
  orphaned `dependabot-automation`, `github-administration` and `projects-automation` environments,
  after the recovery canary proved green.

### Changed

- Applied least privilege across all workflows: `permissions: {}` at workflow level, minimal grants
  per job, `default_workflow_permissions=read` and GitHub Actions no longer able to approve pull
  requests. `permissions: write-all` is gone from the repository
  ([#149](https://github.com/LCV-Ideas-Software/.github/pull/149),
  [#151](https://github.com/LCV-Ideas-Software/.github/pull/151)).
- Pinned Wrangler by exact version in the manifests and lockfiles and removed `wrangler@latest`;
  every workflow now verifies the effective npm registry before `npm ci`
  ([#149](https://github.com/LCV-Ideas-Software/.github/pull/149)).
- Restricted the repository to `allowed_actions=selected` with SHA pinning required, admitting only
  GitHub-owned actions plus `denoland/setup-deno` and `ossf/scorecard-action`.
- Reduced the repository ruleset to the seven functional check contexts that the inherited
  Enterprise and organization rulesets cannot express, and removed `Test native auto-merge`,
  `Test native governance`, `OpenSSF Scorecard` and `Check index.html formatting`.
- Restored the exact Slack scope set required by the official `SendMessage` backend —
  `chat:write`, `chat:write.public`, `channels:read` — as a narrow, documented exception
  ([#156](https://github.com/LCV-Ideas-Software/.github/pull/156)).
- Moved organization-webhook audit and redelivery onto the dedicated GitHub App
  `lcv-slack-webhook-recovery`, installed only on this repository, with ephemeral tokens minted
  read-only for audit and write-scoped only for recovery, and revoked by the post-job step
  ([#163](https://github.com/LCV-Ideas-Software/.github/pull/163)).
- Aligned the Dependabot policy: GitHub Actions updates are evaluated immediately; every other
  ecosystem keeps a seven-day cooldown for ordinary version updates; security updates are never
  delayed ([#164](https://github.com/LCV-Ideas-Software/.github/pull/164)).
- Kept the Enterprise hardened OIDC issuer for Scorecard and disabled only the incompatible public
  result publication, preserving the official scanner, the SARIF upload and the fail-closed policy
  ([#165](https://github.com/LCV-Ideas-Software/.github/pull/165)).
- Bound the Actions pin auditor to component release families so an internal component pin must
  match its own release tag ([#166](https://github.com/LCV-Ideas-Software/.github/pull/166)).

### Added

- Native static Issue and Discussion forms plus
  [`.github/WORK-TRACKING.md`](./.github/WORK-TRACKING.md), the ritual for recording work in
  Issues, Projects and Discussions. Project inclusion and status are updated manually; this
  repository declares no automatic backfill
  ([#161](https://github.com/LCV-Ideas-Software/.github/pull/161)).
- This changelog, as the canonical history required by the canonical-artifact directive recorded in
  Discussion #150.

### Fixed

- Aligned the documentation and the public surface with the repository's real state: the Dependabot
  cooldown wording in `README.md`, `SECURITY.md`, `CONTRIBUTING.md` and `profile/README.md`; the
  public repository count on `site/index.html`; a typo in the site heading; the third-party
  inventory in `THIRDPARTY.md`; and a nonexistent label declared by the Engineering task issue form
  ([#167](https://github.com/LCV-Ideas-Software/.github/issues/167),
  [#168](https://github.com/LCV-Ideas-Software/.github/pull/168)).

### Known issues

- `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` remain repository-scoped secrets rather than
  environment-scoped ones, an organization-wide convention shared by every repository that deploys
  to Cloudflare. Tracked in [#169](https://github.com/LCV-Ideas-Software/.github/issues/169).
- Two fail-closed gates are not protected by a regression assertion: the step that invokes the
  CodeQL SARIF gate is not asserted free of `continue-on-error`, and `.github/zizmor.yml` is read by
  no test. Tracked in [#170](https://github.com/LCV-Ideas-Software/.github/issues/170).
- Workflow run
  [31509445513](https://github.com/LCV-Ideas-Software/.github/actions/runs/31509445513) is stuck in
  `queued` with no job; cancel and force-cancel return HTTP 500 and delete returns 403. It never
  materialized a job, so nothing executed. Tracked in
  [#125](https://github.com/LCV-Ideas-Software/.github/issues/125).

## Earlier history

Before this sanitation the repository grew through 255 commits on `main` covering the organization
profile, the static site at <https://www.lcv.dev>, the GitHub Pages mirror, the sponsor page, the
GitHub-to-Slack relay and successive iterations of security and automation baselines. That history
was never summarized in a changelog; rather than reconstruct it after the fact, it is left where it
is verifiable — in the commit history and in the pull requests it references.
