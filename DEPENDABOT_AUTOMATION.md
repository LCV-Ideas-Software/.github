# Dependabot automation architecture

This repository owns the privileged Dependabot controller shared by every active
LCV Ideas Software repository. Consumer repositories keep only a thin event
wrapper and an exact list of stack-specific required checks.

## Trust boundary

- Pull-request CI remains unprivileged and is responsible for build, test,
  dependency review, CodeQL and repository-specific gates.
- The privileged controller starts from `workflow_run`, `schedule` or
  `workflow_dispatch`. It loads this repository at an immutable commit and never
  checks out a pull-request ref, executes pull-request code, restores its cache or
  downloads its artifacts.
- A pull request is eligible only when it is open, non-draft, authored by the
  exact immutable `dependabot[bot]` account ID, originates in the same repository,
  targets `main`, uses a `dependabot/` branch and has a verified 40-character head
  SHA.
- Approval, rebase requests and merge require the full PR commit set to be exactly
  one verified Dependabot-authored commit, committed by either the exact immutable
  `dependabot[bot]` or `web-flow` account ID, with one parent. Login and numeric ID
  must be the matching pair; every other or mismatched identity fails closed.
  Changed paths are restricted to the dependency manifests, lockfiles, pre-commit
  configuration and GitHub Actions workflows used by the ecosystems configured in
  this organization.
- Any noncanonical commit set fails closed before reviews, comments, Git refs or
  merges can be written. This includes extra commits and GitHub-signed merge
  commits authored by the automation operator. The controller has no branch
  update, force-push, recovery-ref or `@dependabot recreate` path.
- Every configured required check must be present and successful on the exact head
  SHA. Every other attached check must be successful, skipped or neutral. Missing
  and pending checks fail closed. On `workflow_run` and manual dispatches, the
  controller gives checks that were already triggered a bounded 180-second settle
  window, polling every 10 seconds and revalidating the immutable PR head,
  identity and live `main` before every read. Scheduled fallbacks never poll, so a
  persistently pending check cannot consume runner minutes every hour. Required
  GitHub Actions checks must belong to a pull-request workflow run whose immutable
  actor ID is Dependabot's.
- An active `CHANGES_REQUESTED` review or unresolved inline thread from the exact
  `chatgpt-codex-connector` bot ID blocks approval and merge. Reviews, connector
  threads, checks, `main` and the PR head are all re-read after approval.

## Queue behavior

The pinned JavaScript Action and its wrapper serialize the whole repository and
perform at most one pull-request queue transition per run.

1. A canonical PR behind `main` receives one identity-bound `@dependabot rebase`
   request. Its marker contains the exact head and base SHAs, and only a recent
   comment from the exact login and numeric ID resolved from
   `LCV_AUTOMATION_TOKEN` suppresses a retry. After that deduplication read, the
   controller revalidates the PR identity, exact head, one-commit shape, changed
   paths, live `main`, canonical merge base and a coherent behind comparison. It
   then re-reads the head and `main` immediately before posting. Dependabot
   authors the replacement head, so normal restricted Dependabot pull-request CI
    runs on that SHA. If the immutable Dependabot identity returns its exact
    documented "already up-to-date" response while the live comparison still says
    the PR is behind, the controller waits at least ten minutes before performing
    one separately marked rebase retry. This avoids repeating the command against
    the same stale update-job snapshot during a burst of sequential Dependabot
    merges. A second authenticated no-op fails the controller visibly; it is
    never escalated to a destructive command.
2. A noncanonical PR is logged and skipped without any mutation. There is no
   automatic destructive fallback if rebase fails or if someone has edited the
   Dependabot branch.
3. If the exact canonical head is current, the controller first closes the short
   race in which CodeQL finishes just before another required workflow. The
   bounded settle loop performs reads only; any head, identity or base change
   defers without mutation. Once green, the controller performs a fresh per-PR
   detail read rather than relying on the list response. After GitHub computes
   `mergeable: true`, `GITHUB_TOKEN` records the approval for that SHA. A
   `mergeable: null` response or `mergeable_state: unknown` defers the transition;
   `mergeable: true` with `mergeable_state: blocked` remains eligible because the
   required checks and review policy are enforced explicitly by this controller.
   A definitive conflict is skipped without mutation so the scan can inspect the
   next PR.
4. The controller re-reads `main`, the PR head, checks, Actions provenance,
   reviews and connector threads after approval.
5. The automation credential squash-merges only the validated exact head SHA.
   GitHub's repository-level delete-after-merge setting owns branch deletion.
6. The resulting `main` update makes remaining PRs behind; a later serialized run
   asks Dependabot to rebase the next canonical PR. The hourly schedule remains a
   delayed safety net for missed workflow events, not the primary way to close the
   few-second check-completion race.

The final REST merge guard accepts an expected head SHA but GitHub does not offer
an expected base SHA for that endpoint. Immediately before it, the controller
requires a zero-behind `ahead` or `identical` comparison whose merge base is the
validated canonical parent, then performs another live base read. Those reads,
repository-wide serialization and the single-operator model narrow the residual
base-side race. If the organization later has concurrent maintainers, enable a
merge queue and migrate the final step to queue enrollment.

The REST issue-comment endpoint similarly accepts only the comment body; it has
no expected head or base SHA precondition. The live boundary revalidation above
therefore minimizes but cannot eliminate the narrow interval between its final
reads and the `@dependabot rebase` POST. The controller never turns that residual
race into a branch write: Dependabot remains the only actor that may replace its
head, and its documented default is to stop rebasing when extra commits are
present.

## Why recreation is excluded

GitHub documents that `@dependabot recreate` overwrites edits. Dependabot's public
issue tracker also contains real cases where recreation closed the original PR
and opened a differently named replacement, or closed it without opening a
replacement. A July 2026 report shows that rebase and recreate commands may fail
for a valid non-root manifest layout. The generic controller therefore never
tries to infer whether an operator-authored merge contained manual conflict
resolution and never escalates a failed rebase to recreation. Any exceptional
one-off recovery must be separately audited and preserve the exact old head
outside this reusable action.

## Credentials and effective permissions

- Every workflow and job intentionally declares `permissions: write-all`, as do
  the consumer wrappers. The controller still separates operations by token and
  has no generic command execution path.
- `GITHUB_TOKEN` is used only for API reads and exact-head approval.
- `LCV_AUTOMATION_TOKEN` is used only for guarded Dependabot rebase comments and
  exact-head squash merge. It is never printed or exposed to pull-request code.

## Deployment and rollback

1. The dedicated controller CI must pass both
   `node --check dependabot-automerge/main.mjs` and
   `node --test dependabot-automerge/main.test.mjs`. Lint every workflow with
   `actionlint` and audit it with zizmor.
2. Merge this repository first.
3. Pin the central `dependabot-automerge` JavaScript Action in every consumer
   wrapper to the reviewed commit SHA.
4. Deploy one consumer as a canary. Prove a Dependabot-authored rebase, required
   checks on the replacement SHA, automatic approval and an exact-head squash
   merge before completing the rollout.
5. Roll back by restoring the prior wrapper. The controller does not update or
   delete PR heads, branches, tags or other Git refs.

## Primary references

- [Events that trigger workflows: `workflow_run`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
- [Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)
- [Automating Dependabot with GitHub Actions](https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/automate-dependabot-with-actions)
- [Dependabot pull-request comment commands](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-pull-request-comment-commands)
- [Managing Dependabot PRs and extra commits](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/manage-your-dependency-security/manage-dependabot-prs#allowing-dependabot-to-rebase-and-force-push-over-extra-commits)
- [REST pull-request endpoints](https://docs.github.com/en/rest/pulls/pulls)
- [REST compare-two-commits endpoint](https://docs.github.com/en/rest/commits/commits#compare-two-commits)
- [REST issue-comment endpoints](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment)
- [Dependabot issue #7898: recreate may open a replacement PR](https://github.com/dependabot/dependabot-core/issues/7898)
- [Dependabot issue #10504: recreate may close without replacement](https://github.com/dependabot/dependabot-core/issues/10504)
- [Dependabot issue #15566: command failures reported in 2026](https://github.com/dependabot/dependabot-core/issues/15566)
