# Dependabot automation architecture

This repository owns the privileged Dependabot controller shared by every active
LCV Ideas Software repository. Consumer repositories keep only a thin event
wrapper and an exact list of stack-specific required checks.

## Trust boundary

- Pull-request CI intentionally receives a `write-all` `GITHUB_TOKEN` under the
  organization policy, so it is not itself an authorization boundary. It is
  responsible for build, test, dependency review, CodeQL and repository-specific
  gates, but it never receives `LCV_AUTOMATION_TOKEN`; the controller treats its
  results only as evidence that must be re-read and bound to the immutable head.
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
  Changed paths are restricted to the dependency manifests, lockfiles, the one
  operational pre-commit configuration, the central digest-pinned Zizmor
  Dockerfile and GitHub Actions workflows used by the ecosystems configured in
  this organization. Deno manifests and the nonstandard but supported
  `python-tools-requirements.in`/`.txt` pair are explicitly allowlisted; arbitrary
  Dockerfiles and similarly named files remain blocked.
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
- That `workflow_run` provenance correlation applies specifically to required
  checks produced by the GitHub Actions app (`app_id: 15368`). Required checks
  emitted by other configured producers, including GitHub Advanced Security's
  CodeQL/SARIF checks, remain bound to their configured app ID, exact head SHA,
  name and successful conclusion, but they do not expose a corresponding Actions
  check suite that `hasTrustedDependabotWorkflowProvenance` can correlate. This is
  an explicit residual asymmetry, not an implied provenance guarantee.
- GitHub API transport failures and HTTP 408, 429, 500, 502, 503 or 504 responses
  are retried at most three times only for `GET` requests and fail-closed
  GraphQL queries. HTTP 403 is retried only when GitHub supplies an explicit
  rate-limit signal. `Retry-After` and primary-limit reset hints are respected,
  while cumulative retry sleep for one read is capped at 60 seconds. REST
  writes and GraphQL mutations are attempted once, so an ambiguous response
  cannot duplicate approval, rebase requests or merge. Retry time counts toward
  the wrapper's absolute 10-minute job timeout; the bounded settle window remains
  180 seconds and does not weaken that outer cap.
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

## Dependency and Action coverage

- Every active, non-archived repository has a GitHub Actions update block and a
  block for every operational npm, Cargo, pip, Deno, Docker or pre-commit
  manifest. `cross-review` is the sole repository that executes pre-commit; the
  orphaned historical hook files were removed elsewhere.
- The central Zizmor reusable workflow builds the official image from
  `.github/zizmor/Dockerfile`. Its tag and OCI digest are updated together by the
  Docker ecosystem, while the audit remains offline, read-only and strict about
  collection errors. The reusable workflow checks out its own immutable source
  through `job.workflow_repository` and `job.workflow_sha`, so callers audit only
  their own checkout.
- Deno version updates cover `deno.json`/`deno.jsonc` and `deno.lock`, but not an
  HTTPS import in Slack's hook file and not security updates. A daily 07h17
  verification therefore queries the latest stable upstream hook release,
  validates the annotated tag, commit, locked source and integrity, and runs
  `deno audit` from low severity upward.
- Dependabot updates full-SHA `uses:` references when their same-line version
  comment resolves to an upstream tag. GitHub does not generate Dependabot alerts
  for Actions pinned by SHA, so every “Auditoria diária” also inventories all
  external and reusable `uses:` references, recursively checks local composite
  Actions, resolves each SHA to its official tag/release, verifies comment
  coherence and commit verification, queries reviewed and malware advisories for
  the canonical Action repository, and updates every outdated pin—including
  checkout, language setup, cache, artifact, SARIF upload, deployment, third-party
  and all `github/codeql-action/*` components—without replacing SHA pinning with
  mutable tags. The ordinary three-day dependency cooldown does not apply to
  GitHub-official or third-party software used by GitHub Actions; once its
  release, immutable SHA, provenance and compatibility are verified, the GHA pin
  is eligible immediately. Every `github-actions` block expresses that policy as
  `cooldown.default-days: 3` plus `cooldown.exclude: ["*"]`: GitHub accepts only
  one to ninety days, while the documented exclusion takes precedence and makes
  every Action eligible immediately.
- Versions embedded outside a supported manifest, including runtime and schema
  selectors, are part of the same daily drift inventory. A change is applied only
  after its official release and compatibility evidence are reviewed; behavioral
  switches such as Cloudflare compatibility dates are never advanced blindly.

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
- [Dependabot supported ecosystems and repositories](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories)
- [Dependabot alerts and the SHA-pinned Actions limitation](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-alerts)
- [Job context for immutable reusable-workflow source](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#job-context)
- [Automating Dependabot with GitHub Actions](https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/automate-dependabot-with-actions)
- [Dependabot pull-request comment commands](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-pull-request-comment-commands)
- [Managing Dependabot PRs and extra commits](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/manage-your-dependency-security/manage-dependabot-prs#allowing-dependabot-to-rebase-and-force-push-over-extra-commits)
- [REST pull-request endpoints](https://docs.github.com/en/rest/pulls/pulls)
- [REST compare-two-commits endpoint](https://docs.github.com/en/rest/commits/commits#compare-two-commits)
- [REST issue-comment endpoints](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment)
- [Dependabot issue #7898: recreate may open a replacement PR](https://github.com/dependabot/dependabot-core/issues/7898)
- [Dependabot issue #9854: rebase may incorrectly report an outdated head as current](https://github.com/dependabot/dependabot-core/issues/9854)
- [Dependabot issue #10504: recreate may close without replacement](https://github.com/dependabot/dependabot-core/issues/10504)
- [Dependabot issue #15566: command failures reported in 2026](https://github.com/dependabot/dependabot-core/issues/15566)
