# Dependabot automation architecture

This repository owns the privileged Dependabot controller shared by every active
LCV Ideas Software repository. Consumer repositories keep only a thin event
wrapper and an exact list of stack-specific required checks.

## Trust boundary

- Pull-request CI remains unprivileged and is responsible for build, test,
  dependency review, CodeQL, Socket and repository-specific gates.
- The privileged controller starts from `workflow_run`, `schedule` or
  `workflow_dispatch`. It loads this repository at an immutable commit and never
  checks out a pull-request ref, executes pull-request code, restores its cache or
  downloads its artifacts.
- A pull request is eligible only when it is open, non-draft, authored by
  `dependabot[bot]`, originates in the same repository, targets `main`, uses a
  `dependabot/` branch and has a verified 40-character head commit.
- Approval and merge require the full PR commit set to be exactly one verified
  Dependabot-authored commit with one parent. A PR with extra commits is never
  approved: after path checks and veto/connector checks, the controller asks
  Dependabot to `recreate` it, which restores bot authorship while overwriting
  the noncanonical edits. Changed paths are restricted to the dependency
  manifests, lockfiles, pre-commit configuration and GitHub Actions workflows
  used by the ecosystems configured in this organization.
- Every configured required check must be present and successful on the exact
  head SHA. Every other attached check must be successful, skipped or neutral.
  Missing and pending checks fail closed.

## Queue behavior

The pinned JavaScript Action and its wrapper serialize the whole repository and
perform at most one queue mutation per run.

1. If the oldest candidate contains extra commits, the automation credential
   posts a guarded `@dependabot recreate` command. This recovers branches changed
   by GitHub's update button or by manual edits; no approval is possible until
   Dependabot replaces the head with its canonical single verified commit.
2. If the oldest eligible PR is behind `main`, the credential posts a guarded
   `@dependabot rebase` command. Both commands are de-duplicated against the exact
   login and numeric ID resolved from the automation token. Dependabot therefore
   authors the replacement head and triggers the normal restricted Dependabot CI
   path; the privileged controller does not rewrite the branch itself.
3. If the exact head is current and green, `GITHUB_TOKEN` records the approval.
4. The controller re-reads `main`, the PR head and all checks after approval.
5. The automation credential squash-merges only that exact head SHA. GitHub's
   repository-level delete-after-merge setting owns branch deletion.
6. The resulting `main` update makes the remaining PRs behind; the next run asks
   Dependabot to rebase one of them. An hourly schedule recovers missed events.

The final REST merge guard accepts an expected head SHA but GitHub does not offer
an expected base SHA for that endpoint. Two live base reads, repository-wide
serialization and the single-operator model narrow that residual race. If the
organization later has concurrent maintainers, enable a merge queue and migrate
the final step to queue enrollment.

## Credentials

- `GITHUB_TOKEN`: checks read, contents read, statuses read and pull requests
  write. It is not used to update branches or merge.
- `LCV_AUTOMATION_TOKEN`: repository-scoped pull-request/comment and contents
  write access, plus workflow write access so reviewed GitHub Actions dependency
  updates can merge. It is never printed or exposed to pull-request code.

A dedicated least-privilege GitHub App installation token is the preferred
future replacement for the personal automation token. The current token remains
the deployable option because the same named secret is already provisioned in all
active repositories.

## Deployment and rollback

1. Test the controller with `node --test dependabot-automerge/main.test.mjs` and
   lint every workflow with `actionlint`.
2. Merge this repository first.
3. Pin the central `dependabot-automerge` JavaScript Action in every consumer
   wrapper to the reviewed commit SHA.
4. Deploy one consumer as a canary. Prove a Dependabot-authored rebase, checks on
   the replacement SHA, automatic approval and an exact-head squash merge before
   completing the rollout.
5. Roll back by restoring the prior wrapper. Existing PR heads and branches are
   not deleted by the controller.

## Primary GitHub references

- [Events that trigger workflows: `workflow_run`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
- [Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)
- [Automating Dependabot with GitHub Actions](https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/automate-dependabot-with-actions)
- [Dependabot comment commands](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/managing-pull-requests-for-dependency-updates#comment-commands-for-dependabot)
- [Managing Dependabot PRs and extra commits](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/manage-your-dependency-security/manage-dependabot-prs#allowing-dependabot-to-rebase-and-force-push-over-extra-commits)
- [REST pull-request endpoints](https://docs.github.com/en/rest/pulls/pulls)
- [Authenticating with a GitHub App installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
