# Changelog

Notable changes to this repository are recorded here **from 11/08/2026 onward**. Earlier work is not
summarized in this file; see [Earlier history](#earlier-history) for where it is verifiable.

This repository is **not versioned**: it publishes the organization profile, the static organization
site, the sponsor page, and shared community-health defaults. It does not publish packages or a
numbered application artifact. Entries are grouped by date rather than semantic version.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) as far as it applies to
an unversioned repository. Dates are written `DD/MM/AAAA` in Brasília time (UTC−03:00), the
presentation rule this organization applies to text meant for people
([`.github/WORK-TRACKING.md`](./.github/WORK-TRACKING.md)).

## 22/08/2026 — Linear Release oficial

### Added

- Added a repository-local `Linear Release` workflow for pushes to `main`, using Linear's official
  `linear/linear-release-action` `v0.16.0` pinned to immutable commit
  `0a25abab892a91062ebf42260dbb2ce6277aa205`.
- Preserved the continuous `.github-org` pipeline, complete Git history, dedicated
  `linear-release` environment, least-privilege `contents: read` grant, non-canceling concurrency,
  and best-effort behavior. The workflow records only this repository's commits and is not an
  organization-wide operational system.
- Refined the institutional-boundary gate so it continues to reject migrated controllers and
  integrations while explicitly requiring the repository-local writer's trigger, permissions,
  environment, full history, immutable Action pin, and absence of shell downloaders.
- Documented the accepted upstream supply-chain gap: the Action pin protects the Action source,
  but its installer still downloads the selected CLI without authenticating its bytes. The issue
  remains tracked in `linear/linear-release-action#59` / `LIN-82854`.

## 21/08/2026 — Dependabot Custom Auto-merge

### Removed

- Removed the short-lived reusable Dependabot action and its tests from this special `.github`
  repository. The complete controller, scheduler, canaries, credentials, and operational ownership
  now live exclusively in `github-operations`
  ([controller #101](https://github.com/LCV-Ideas-Software/github-operations/pull/101),
  [ruleset validation #102](https://github.com/LCV-Ideas-Software/github-operations/pull/102),
  [cleanup #271](https://github.com/LCV-Ideas-Software/.github/pull/271)).
- Removed the exception that allowed operational system code in `.github`; this repository retains
  only its institutional public surfaces and the workflows that secure or publish those surfaces.

### Changed

- Distinguished human-authored pull requests, which retain human queue admission, from Dependabot
  updates, whose admission is intentionally automated by Dependabot Custom Auto-merge from
  `github-operations`. Both paths remain squash-only, have no bypass actor, and must pass the same
  required checks again on the synthetic `merge_group` SHA.

## 20/08/2026 — Separação da operação interna

### Removed

- Removed the GitHub-to-Slack, Cloudflare Worker/D1, and GitHub–Linear operational implementations,
  their workflows, tests, runbooks, and dedicated dependencies from the public institutional
  branch after their migration to `github-operations` was validated
  ([github-operations#8](https://github.com/LCV-Ideas-Software/github-operations/pull/8),
  [tracker #3](https://github.com/LCV-Ideas-Software/github-operations/issues/3)).
- Removed all seven disabled operational workflow files still present on `main`. The two other
  disabled catalog entries, `native-pr-feedback-signal.yml` and `add-to-project.yml`, were already
  absent from the branch and therefore required no versioned deletion.

### Changed

- Reduced the root npm dependency graph and Dependabot configuration to the tooling still used by
  the two public-site deployments.
- Kept the organization profile, public and sponsor sites, community-health defaults, and active
  public security/governance workflows in this repository.
- Preserved all Git history, tags, releases, and immutable component references. Existing consumers
  pinned to the historical public `codeql-sarif-gate` commit remain unaffected by this branch-only
  cleanup.

## 15/08/2026 — Official security automation

### Changed

- Incorporated the CodeQL 4.37.7 update from Dependabot PR #197 and replaced repository-owned
  workflow wrappers with direct, SHA-pinned official Actions.
- Kept CodeQL, Dependency Review, Zizmor, and OpenSSF Scorecard active with least-privilege job
  permissions and native Code Scanning uploads.
- Moved the organization site's Cloudflare Pages deployment to the official Wrangler Action.
- Recorded the accepted upstream limitation that the official Zizmor Action does not yet expose
  `--strict-collection`, without recreating a local wrapper or parallel gate.

## 14/08/2026 — Zizmor baseline do astrologo-app

### Fixed

- Pre-authorized the exact reviewed base and least-privilege rollout blobs for the `astrologo-app`
  deploy workflow, trusted Dependency Review workflow, and Zizmor configuration. Evidence: #189 and
  `astrologo-app#294`.

## 13/08/2026 — Zizmor consumer policy recovery

### Fixed

- Restored each consumer's reviewed Zizmor policy after `zizmor/v2.2.0` replaced it with a central
  configuration and disabled all ignores. The reviewed contract was released as `zizmor/v2.3.0`;
  existing component tags remain immutable. Evidence: #189.

## 11/08/2026 — GitHub Actions governance sanitation

### Removed

- Retired the repository-owned auto-merge and governance controllers in favor of GitHub's native
  merge queue and effective Enterprise, organization, and repository rulesets
  ([#151](https://github.com/LCV-Ideas-Software/.github/pull/151)).
- Consolidated the public-site format check into the Pages artifact build and removed the duplicate
  workflow and check context ([#151](https://github.com/LCV-Ideas-Software/.github/pull/151)).

### Changed

- Applied least privilege across workflows and retained immutable SHA pins for external Actions
  ([#149](https://github.com/LCV-Ideas-Software/.github/pull/149),
  [#151](https://github.com/LCV-Ideas-Software/.github/pull/151)).
- Aligned Dependabot so GitHub Actions updates can be evaluated immediately while ordinary updates
  in other ecosystems keep a seven-day cooldown; security updates remain exempt
  ([#164](https://github.com/LCV-Ideas-Software/.github/pull/164)).
- Kept the Enterprise hardened OIDC issuer for Scorecard while preserving the official scanner and
  native SARIF upload ([#165](https://github.com/LCV-Ideas-Software/.github/pull/165)).

### Added

- Native static Issue and Discussion forms plus
  [`.github/WORK-TRACKING.md`](./.github/WORK-TRACKING.md) for public, non-sensitive work
  ([#161](https://github.com/LCV-Ideas-Software/.github/pull/161)).
- This changelog ([#168](https://github.com/LCV-Ideas-Software/.github/pull/168)).

### Fixed

- Aligned documentation and public surfaces with repository policy, current organization facts,
  and the visible site ([#167](https://github.com/LCV-Ideas-Software/.github/issues/167),
  [#168](https://github.com/LCV-Ideas-Software/.github/pull/168)).
- Replaced the public site's broken invisible contact anchor with its documented email link
  ([#174](https://github.com/LCV-Ideas-Software/.github/issues/174),
  [#168](https://github.com/LCV-Ideas-Software/.github/pull/168)).

## Earlier history

Before this changelog, the repository evolved through its commit history, covering the organization
profile, the static site at <https://www.lcv.dev>, the GitHub Pages mirror, the sponsor page, and
successive security and community-health baselines. That history is left where it is verifiable: in
the signed commits and pull requests that carried it.
