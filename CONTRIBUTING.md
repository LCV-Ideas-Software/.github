# Contributing

This repository is maintained by LCV Ideas & Software. Contributions should preserve the security, automation, and release posture of .github.

## Baseline

- Direct signed, fast-forward pushes to `main` are permitted; pull requests are optional and, when used, should remain focused and small enough to review safely.
- Do not commit secrets, tokens, private keys, credentials, generated build output, or local environment files.
- Preserve the organization's explicit `permissions: write-all` workflow baseline unless the operator authorizes a change.
- Authorized exception: `.github/workflows/scorecard.yml` runs under least privilege (`security-events: write`, `contents: read`, `actions: read`). The operator authorized this on 2026-08-10 after the baseline was traced as the cause of a blocked merge queue: OpenSSF's publication API rejects organization-mandated `write-all`, which is why `publish_results` had been disabled. Every permission in that workflow carries an inline comment, as zizmor's `undocumented-permissions` audit requires. Any further exception needs the same explicit authorization and an entry here.
- Pin external GitHub Actions to immutable commit SHAs.
- Preserve Dependabot automation. Do not add required reviewers or CODEOWNERS rules that force manual approval for routine Dependabot updates.
- Prefer squash merges for automation and keep the default branch as `main`.

## Validation

Before pushing directly, opening a pull request, or merging changes, run the repository-specific checks documented in the README, package scripts, or workflow files. For security-sensitive changes, retain evidence of the checks performed in the associated change record or pull request.
