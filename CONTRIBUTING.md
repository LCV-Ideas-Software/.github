# Contributing

This repository is maintained by LCV Ideas & Software. Contributions should preserve the public institutional, community-health, security, and site surfaces of `.github`.

## Baseline

- Every change to `main` must use a pull request. Direct pushes, administrative merges, REST merges, force pushes, and ruleset bypasses are prohibited.
- Squash is the only merge method. A human-authored pull request is merged by the maintainer only after the effective Enterprise and repository rulesets and all required checks are satisfied. Dependabot pull requests receive GitHub's native auto-merge and remain subject to the same rules and checks.
- Do not commit secrets, tokens, private keys, credentials, generated build output, or local environment files.
- Set workflow-level permissions to `{}` and grant each job only the `GITHUB_TOKEN` capabilities it demonstrably needs. The Dependabot auto-merge workflow grants no `GITHUB_TOKEN` capability and uses only the Dependabot secret `DEPENDABOT_AUTOMERGE_TOKEN`.
- Pin external GitHub Actions to immutable commit SHAs.
- Preserve weekly Dependabot checks, grouped minor and patch updates, automatic rebasing, and GitHub's post-merge branch deletion. Official Actions under `actions/*` and `github/*` are evaluated immediately; third-party GitHub Actions and ordinary version updates in every other ecosystem observe a seven-day cooldown. Security updates are not delayed by that cooldown.
- Dependabot prepares and rebases its pull requests automatically. This repository enables GitHub native auto-merge for each Dependabot pull request through `.github/workflows/dependabot-auto-merge.yml`, which runs no Action, checks out nothing, and cannot bypass rulesets or required checks. Do not add lockfile repair, branch updates, or merge automation for any other author.
- Use `https://registry.npmjs.org/` by default. A different npm registry is allowed only through an intentional, versioned, applicable `.npmrc` rule.
- Do not change Enterprise or organization rules, settings, applications, or secrets without separate explicit operator consent.

## Validation

Before opening or updating a pull request, run the repository-specific checks documented in the README, package scripts, or workflow files. For security-sensitive changes, retain evidence of the checks performed in the associated Issue, Project item, Discussion, or pull request.
