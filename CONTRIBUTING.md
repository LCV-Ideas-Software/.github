# Contributing

This repository is maintained by LCV Ideas & Software. Contributions should preserve the security, automation, and release posture of .github.

## Baseline

- Every change to `main` must use a pull request. Direct pushes, administrative merges, REST merges, force pushes, and ruleset bypasses are prohibited.
- Squash is the only merge method. An authorized human places an eligible pull request in GitHub's native merge queue only after the effective Enterprise, organization, and repository rulesets and all required checks are satisfied.
- Do not commit secrets, tokens, private keys, credentials, generated build output, or local environment files.
- Set workflow-level permissions to `{}` and grant each job only the `GITHUB_TOKEN` capabilities it demonstrably needs. Keep privileged external credentials in protected environments and out of pull-request jobs.
- Pin external GitHub Actions to immutable commit SHAs.
- Preserve daily Dependabot checks, automatic rebasing, and GitHub's post-merge branch deletion. Ordinary version updates observe a seven-day cooldown; security updates are not delayed by that cooldown.
- Dependabot may prepare and rebase pull requests automatically, but final queue admission remains a human action until a repository-scoped GitHub App with the exact required permissions is separately authorized.
- Use `https://registry.npmjs.org/` by default. A different npm registry is allowed only through an intentional, versioned, applicable `.npmrc` rule.
- Do not change Enterprise or organization rules, settings, applications, or secrets without separate explicit operator consent.

## Validation

Before opening or updating a pull request, run the repository-specific checks documented in the README, package scripts, or workflow files. For security-sensitive changes, retain evidence of the checks performed in the associated Issue, Project item, Discussion, or pull request.
