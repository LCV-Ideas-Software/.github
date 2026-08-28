# Contributing

This repository is maintained by LCV Ideas & Software. Contributions should preserve the public institutional, community-health, security, and site surfaces of `.github`.

## Baseline

- Every change to `main` must use a pull request. Direct pushes, administrative merges, REST merges, force pushes, and ruleset bypasses are prohibited.
- Squash is the only merge method. An authorized human places an eligible human-authored pull request in GitHub's native merge queue only after the effective Enterprise, organization, and repository rulesets and all required checks are satisfied. Canonical same-repository Dependabot pull requests are admitted automatically on their exact head SHA and remain subject to the same queue and checks.
- Do not commit secrets, tokens, private keys, credentials, generated build output, or local environment files.
- Set workflow-level permissions to `{}` and grant each job only the `GITHUB_TOKEN` capabilities it demonstrably needs. Keep privileged external credentials in protected environments and out of pull-request jobs.
- Pin external GitHub Actions to immutable commit SHAs.
- Preserve daily Dependabot checks, automatic rebasing, and GitHub's post-merge branch deletion. Official Actions under `actions/*` and `github/*` are evaluated immediately; third-party GitHub Actions and ordinary version updates in every other ecosystem observe a seven-day cooldown. Security updates are not delayed by that cooldown.
- Dependabot prepares and rebases its pull requests automatically. Each repository independently uses a repository-local workflow to enable GitHub native auto-merge for a canonical same-repository Dependabot pull request on the exact event head SHA. The workflow accepts only events emitted by the immutable Dependabot App identity, executes no pull-request code, uses a short-lived repository-scoped GitHub App token, and cannot bypass the merge queue or required checks. It does not update branches or repair lockfiles.
- Use `https://registry.npmjs.org/` by default. A different npm registry is allowed only through an intentional, versioned, applicable `.npmrc` rule.
- Do not change Enterprise or organization rules, settings, applications, or secrets without separate explicit operator consent.

## Validation

Before opening or updating a pull request, run the repository-specific checks documented in the README, package scripts, or workflow files. For security-sensitive changes, retain evidence of the checks performed in the associated Issue, Project item, Discussion, or pull request.
