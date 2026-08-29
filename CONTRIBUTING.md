# Contributing

This repository is maintained by LCV Ideas & Software. Contributions should preserve the public institutional, community-health, security, and site surfaces of `.github`.

## Baseline

- Every change to `main` must use a pull request. Direct pushes, administrative merges, REST merges, force pushes, and ruleset bypasses are prohibited.
- Squash is the only merge method. An authorized human places an eligible human-authored pull request in GitHub's native merge queue only after the effective Enterprise, organization, and repository rulesets and all required checks are satisfied. Canonical same-repository Dependabot pull requests are admitted automatically on their exact head SHA and remain subject to the same queue and checks.
- Do not commit secrets, tokens, private keys, credentials, generated build output, or local environment files.
- Set workflow-level permissions to `{}` and grant each job only the `GITHUB_TOKEN` capabilities it demonstrably needs. The automatic Dependabot path starts with a `pull_request` signal that has no token permission, secret, Action, checkout, cache, artifact, or pull-request-controlled command. Mutation occurs only in the trusted default-branch `workflow_run` follow-up, whose App key is read from the `dependabot-automation` Actions environment. The same environment protects the explicit `workflow_dispatch` fallback. No workflow references a Dependabot-store copy of that key.
- Pin external GitHub Actions to immutable commit SHAs.
- Preserve daily Dependabot checks, automatic rebasing, and GitHub's post-merge branch deletion. Official Actions under `actions/*` and `github/*` are evaluated immediately; third-party GitHub Actions and ordinary version updates in every other ecosystem observe a seven-day cooldown. Security updates are not delayed by that cooldown.
- Dependabot prepares and rebases its pull requests automatically. This repository independently enables GitHub native auto-merge for a canonical same-repository Dependabot pull request on the exact event head SHA. Dependabot-emitted `opened` and `synchronize` events produce only an unprivileged `pull_request` signal; the secret-bearing mutator is a `workflow_run` loaded from `main`. It resolves the source workflow by immutable ID and path, resolves exactly one live pull request through GitHub's commit-association API, rejects every workflow-file change, verifies the signed head, and rereads the PR and complete file inventory before `gh pr merge --auto --squash --match-head-commit`. A rare manual ready/reopen transition requires another Dependabot synchronization or an explicit `workflow_dispatch` from `main`; only the sole operator `lcv-leo` (immutable account ID `268063598`) can invoke that fallback. The no-bypass Enterprise Required Workflow `Dependabot head authorization` revalidates every later head before merge, including a head updated while auto-merge was already armed. Neither local path checks out repository content, bypasses the merge queue or required checks, updates branches, or repairs lockfiles.
- Use `https://registry.npmjs.org/` by default. A different npm registry is allowed only through an intentional, versioned, applicable `.npmrc` rule.
- Do not change Enterprise or organization rules, settings, applications, or secrets without separate explicit operator consent.

## Validation

Before opening or updating a pull request, run the repository-specific checks documented in the README, package scripts, or workflow files. For security-sensitive changes, retain evidence of the checks performed in the associated Issue, Project item, Discussion, or pull request.
