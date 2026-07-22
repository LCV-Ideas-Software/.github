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
  approved. It is recoverable only when the original verified Dependabot commit
  is followed exclusively by verified merge commits created by the exact
  automation identity, each with the exact GitHub `Merge branch 'main' into …`
  message, a first parent equal to the preceding commit and a second parent
  proven to be an ancestor of current `main`. Manual commits fail closed.
  Changed paths are restricted to the dependency manifests, lockfiles,
  pre-commit configuration and GitHub Actions workflows used by the ecosystems
  configured in this organization.
- Before the destructive `@dependabot recreate` command, the controller creates
  and re-reads a durable preservation branch named
  `dependabot-recovery/pr-<number>-<head-prefix>` at the exact old head. It never
  updates or deletes that ref. Any inline `chatgpt-codex-connector` thread in the
  PR history blocks recreation, including resolved or outdated threads.
- Every configured required check must be present and successful on the exact
  head SHA. Every other attached check must be successful, skipped or neutral.
  Missing and pending checks fail closed.

## Queue behavior

The pinned JavaScript Action and its wrapper serialize the whole repository and
perform at most one pull-request queue transition per run. A recovery
transaction additionally creates its mandatory preservation ref before the
single Dependabot command.

1. If the oldest candidate contains only the strictly proven mechanical merge
   chain described above, the automation credential first preserves the exact
   head, repeats identity/history/path/review/connector validation, performs one
   final head read and then posts a guarded `@dependabot recreate` command.
   The marker is bound to PR, command and old head, so a later `main` advance
   cannot duplicate the destructive request. Manual edits are never recreated.
   A bounded watchdog recognizes a replaced head or replacement PR, fails if the
   original closes without a trusted replacement, and otherwise leaves a
   visible pending state for the hourly reconciliation run.
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

## Credentials and effective permissions

- Every workflow and job intentionally declares `permissions: write-all`, as do
  the consumer wrappers. The controller still separates operations by token and
  has no generic command execution path.
- `GITHUB_TOKEN` is used only for API reads and exact-head approval.
- `LCV_AUTOMATION_TOKEN` is used only for the durable recovery-ref creation,
  guarded Dependabot comments and exact-head squash merge. It is never printed
  or exposed to pull-request code.

## Deployment and rollback

1. Test the controller with `node --test dependabot-automerge/main.test.mjs` and
   lint every workflow with `actionlint`.
2. Merge this repository first.
3. Pin the central `dependabot-automerge` JavaScript Action in every consumer
   wrapper to the reviewed commit SHA.
4. Deploy one consumer as a canary. Prove a Dependabot-authored rebase, checks on
   the replacement SHA, and—when recovery is required—the preserved old head,
   one recreation command and reconciled canonical head. Then prove automatic
   approval and an exact-head squash merge before completing the rollout.
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
