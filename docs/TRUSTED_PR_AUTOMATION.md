# LCV Trusted PR Automation

This document describes the fail-closed automation that may be attached to an
organization ruleset after a monitored canary. The checked-in change does not
create, update, or activate a ruleset.

## Decision

`LCV Trusted Gate` is a public, central ruleset workflow. It is preferred over
a PAT-created commit status or check run because:

- GitHub can require a public workflow from `.github` in every repository in
  the organization, and the target pull request cannot replace the workflow
  source selected by the ruleset;
- GitHub Actions creates the `LCV Trusted Gate` check for the exact pull-request
  or merge-group SHA without an administrative PAT;
- classic PATs cannot create or update Check Runs. A commit status would lose
  the stronger workflow identity and would add a mutable status-writing path.

The administrative PAT remains confined to the protected
`github-administration` environment. Its mutations are limited to requesting a
Codex review, requesting a GitHub Copilot code review, requesting a
conflict-only Dependabot rebase, recovering one attributable late-review
timeout, or enqueueing an already trusted pull request. It never publishes the
gate result and never merges directly.
Read-only REST and GraphQL operations have bounded transient retries. Comments,
reruns, and GraphQL mutations are attempted once so an ambiguous write can
never be duplicated by the client.

## Components

- `.github/workflows/trusted-pr-gate.yml` is the public ruleset workflow. It
  handles `pull_request` and `merge_group`, retains `permissions: write-all`,
  uses only `github.token`, and checks out its source with
  `job.workflow_repository` plus `job.workflow_sha`. Pull-request activity
  explicitly includes `ready_for_review`, so making a draft ready creates a
  fresh gate run without requiring an unrelated push.
- `.github/workflows/trusted-pr-controller.yml` tests the controller and then,
  only on signed `main`, uses `LCV_AUTOMATION_TOKEN` from the protected
  `github-administration` environment. It runs every five minutes and is
  idempotent.
- `.github/workflows/trusted-pr-controller-ci.yml` runs the syntax and unit
  suite on pull-request and merge-group heads without loading the protected
  environment or its secret.
- `trusted-pr-automation/policy.json` binds each active repository to exact
  check names and GitHub App IDs, separating producers guaranteed on both PR
  and merge-group heads from wrappers guaranteed only on merge-group heads. It
  also pins the live Copilot reviewer Bot identity by database ID, node ID, and
  the three context-specific login forms exposed by REST and GraphQL.
- `trusted-pr-automation/main.mjs` is the shared fail-closed engine.

Local workflow validation uses actionlint 1.7.12 with a narrow ignore for its
outdated schema errors on the documented `job.workflow_repository` and
`job.workflow_sha` workflow-identity fields. The YAML parser and every other
expression remain checked; this is not a blanket actionlint suppression.

## Gate contract

Every accepted pull request must satisfy all of these conditions at the same
time:

1. It is open, not a draft, targets `main`, and its head and base belong to the
   same repository. Forks are rejected.
2. Its author identity exactly matches both login and numeric ID for `lcv-leo`
   or `dependabot[bot]`. Display names and login-only matches are insufficient.
3. The event SHA and current pull-request head agree. A branch that is merely
   behind `main` is allowed because the merge queue constructs and tests a
   synthetic commit against the latest base. Exact base identity is rechecked
   at the enqueue boundary and again on `merge_group`.
4. Every pull-request commit has GitHub's `verification.verified=true`, and the
   final returned commit is the exact head.
5. All issue comments, reviews, and review threads are read. Every connector
   thread must be resolved, no current-head change request may remain, and the
   exact head must have the connector's clean-review message or its `+1`
   reaction on the exact marked review request. A textual success must be
   authored by bot ID `199175422` through GitHub App ID `1144995`; its abbreviated
   reviewed SHA is resolved through GitHub's commit endpoint before comparison.
   A reaction counts only from bot ID `199175422`. EYES, a pending run, or a
   `COMMENTED` review with a finding is not success. Thread attribution uses
   `pullRequestReview.commit.oid`, not GitHub's mutable remapping in
   `comment.commit.oid`. The marked request must equal the canonical two-line
   request exactly, contain one SHA marker, and be immutable: its valid
   `created_at` and `updated_at` values must be identical. A connector `+1`
   counts only when its valid `created_at` is strictly later than that request
   timestamp. Editing a reacted comment invalidates it permanently; the
   controller posts a new canonical request instead. This prevents a reaction
   for an older body from being rebound to a new head.
   Review-state vetoes are evaluated per reviewer and exact head using the
   latest decisive state among `CHANGES_REQUESTED`, `APPROVED`, and
   `DISMISSED`; a later `COMMENTED` review is non-decisive and cannot erase a
   change request. A later `APPROVED` or `DISMISSED` from that same reviewer
   clears its earlier veto, but a decision from a different reviewer does not.
6. GitHub Copilot code review is an independent mandatory reviewer. Its Bot
   identity must match database ID `175728472`, node ID
   `BOT_kgDOCnlnWA`, and one of the API-context login forms
   `copilot-pull-request-reviewer[bot]`, `copilot-pull-request-reviewer`, or
   `Copilot`. No inferred GitHub App ID is trusted. The exact head must have at
   least one review with structured state `COMMENTED`, and every thread that
   contains a Copilot comment—including a thread from an older head—must be
   resolved. Thread attribution again uses the immutable
   `pullRequestReview.commit.oid`; a remapped inline-comment commit is not
   evidence. Any Copilot inline comment attributed to the current head rejects
   that SHA even after the conversation is resolved; remediation requires a new
   SHA and a fresh review. Resolved stale-head threads do not contaminate the new
   SHA, while unresolved stale threads still block.

   GitHub documents that Copilot uses Comment, not Approve or Request changes,
   so `COMMENTED` alone is never approval. The review body is classified through
   a closed allowlist. A normal completion must contain the standard line
   `Copilot reviewed X out of Y changed files ... generated no [new] comments`;
   both counts must be safe integers, `Y` must equal the complete paginated
   changed-file inventory, and `reviewable-path count <= X <= Y` with `X >= 1`.
   The lower bound proves that every skipped file fits the explicit excluded
   allowlist without requiring equality: GitHub sometimes counts excluded files
   as reviewed. A zero-review normal completion is rejected; an all-excluded
   diff is neutral only through the separate standard unreviewable message.

   Every exact-head review body is also inspected for both known suppressed
   finding labels: `Suppressed comments (N)` and
   `Comments suppressed due to low confidence (N)`. A positive count rejects
   that SHA even if a newer same-SHA review looks clean; only a new commit and
   review can release it. A zero count is harmless, while malformed or
   ambiguous suppressed metadata fails closed. An inline finding or a standard
   positive generated-comment count has the same current-head permanence.

   The only neutral completion is the standard all-files-unreviewable message,
   and its text is never sufficient by itself: the changed-file inventory must
   prove that every path is in the explicit official excluded-file allowlist.
   That allowlist mirrors the documented basenames and patterns for
   dependency/configuration files, logs, SVG, generated/vendor/output paths and
   binary directories, including the documented Rust and Hybris `bin`
   exceptions. An empty, malformed, mixed, or unknown file set fails closed.
   File status must be a documented REST value; a rename must provide both
   current and previous paths, and both must be excluded. A known service-error
   body, quota-exhaustion body, empty body, unknown marker, partial/malformed
   completion, or count mismatch is not success. A later valid same-SHA review
   may supersede a service error, but the controller does not repeatedly request
   reviews after an exact-head error artifact exists. The canary must exercise
   normal reviewable, excluded-only, mixed, renamed, error/quota, suppressed,
   and exception-path diffs.

7. Every configured check is present as the exact `{name, app_id}` pair and has
   conclusion `success`; skipped or neutral is never enough for a configured
   requirement. `required_checks` applies to both PR and merge-group heads;
   `merge_group_required_checks` is added only for the synthetic group, where
   path-filtered PR workflows are guaranteed to run without path filters.
   Missing or running required checks are polled. If a group-only wrapper does
   run on a PR, it remains part of the observed inventory and a bad conclusion
   still fails closed. For other observed jobs, intentionally conditional
   `skipped` or `neutral` conclusions are accepted, while failure, cancelled,
   timed-out, action-required, startup-failure, stale, or unknown conclusions
   fail closed. Check runs are fetched with `filter=all` and full pagination,
   then reduced locally only within the same `{name, app_id, check_suite.id}`.
   Thus a higher-ID same-name success from another suite cannot hide a genuine
   pending or failed producer; a newer run in the same suite supersedes its
   own earlier attempt. An Actions check without a positive safe check-suite
   ID fails closed. Every legacy commit status must be successful.
8. The raw CodeQL executor jobs (`Analyze <language>`) and the raw zizmor job
   (`Run zizmor` or `Run zizmor / Run zizmor`) are required in addition to the
   corresponding GitHub Advanced Security upload results. A green SARIF upload
   cannot mask a failing zero-findings executor.
9. Only after the exact-head executor and GHAS checks are green, the gate
   refreshes the PR's code-scanning alert inventory and requires zero open
   alerts at any supported severity. A stale open alert observed while a fixing
   analysis is still running cannot terminally fail the controller. Pull,
   commit, connector, review, and thread evidence is reread after the CI wait,
   then reread again after the code-scanning inventory; the exact associated
   head (and merge-group base, for a synthetic head) must remain unchanged at
   both final trust boundaries. The exact-SHA check runs and legacy statuses
   are then read and classified once more. The complete order-independent
   check/status fingerprint captured immediately before the alert scan must
   equal the fingerprint captured after the scan and final pull reassessment;
   a new or changed run/status therefore blocks completion instead of letting
   an alert-producing analysis race past a stale green snapshot.

The bootstrap also refuses to authenticate required Actions producers by
display name and App ID. It retains and evaluates every latest-per-suite run,
which prevents one observed suite from masking another, but the REST inventory
has not yet been bound to each configured producer's workflow ID, path, and
source revision. Therefore an otherwise-green inventory returns
`required-check-producer-provenance-unverified`; the controller cannot scan,
rerun, or enqueue from it. The observational `.github-private` canary must
capture a server-verifiable producer binding for every required wrapper, and a
follow-up reviewed patch must encode those exact bindings before authority is
enabled.

The controller never trusts the `LCV Trusted Gate` display name and GitHub
Actions App ID alone. Before even considering success or timeout recovery,
every matching check is resolved through its exact check-suite ID and
the canonical run/job IDs parsed from `details_url`; the job ID, which is not
assumed to equal the check-run ID, is used with `GET /actions/jobs/{job-id}`.
The job must point back to the exact check and parsed run before that suite is
resolved to one workflow run for the exact head. The controller then verifies canonical
check/job/run URLs, IDs, names, status/conclusion, target and head repository,
event, source workflow ID `329989853`, source path
`.github/workflows/trusted-pr-gate.yml`, and the active workflow resource in
`LCV-Ideas-Software/.github`. A same-name job from the target repository,
ambiguous suite mapping, missing field, or inconsistent payload fails closed;
it cannot mask a pending or failed central gate.

That REST chain does **not** currently expose `job.workflow_sha`, so it cannot
prove which source revision the ruleset pinned—especially in the source
`.github` repository, where an ordinary PR run retains the same workflow ID,
URL and path. This bootstrap intentionally returns
`trusted-gate-provenance-unverified` for every otherwise-valid bare-path run;
the controller cannot enqueue or rerun it. A visually plausible `@sha` suffix
or `referenced_workflows` object is also not accepted without captured live
evidence and a regression test. The `.github-private` required-workflow canary
must reveal a server-observable binding from its check/run to the ruleset's
source SHA. A follow-up reviewed patch will encode only that demonstrated
shape. Inspecting the active ruleset can be an additional precondition, but it
cannot substitute for associating the specific run with the pinned revision.

Retargeting an existing PR from another base branch to `main` is deliberately
unsupported. GitHub's `edited` activity would need to be added consistently to
every required check producer in all covered repositories; triggering only the
central gate would leave the producer checks absent and time out. Automation
must create each trusted PR directly against `main`; a retargeted PR remains
fail-closed and must be closed and recreated against `main`.

When an exact head has no clean connector review, the controller posts this
idempotent request once for that SHA:

```text
@codex review

<!-- LCV-TRUSTED-REVIEW-HEAD:<40-character SHA> -->
```

A later push has a different marker and therefore receives a new review
request. The controller does not enqueue while the only signal is EYES,
pending, or a review containing a finding. Missing or running CI is also a
normal observational outcome for the scheduled controller: it logs and waits
without enqueueing and without failing the five-minute run. A terminal bad
conclusion remains an error.

When the exact head has no Copilot `COMMENTED` review, the controller first
checks the structured `requested_reviewers` identities. If Copilot is already
requested it only observes; otherwise it makes one non-retried REST review
request for `copilot-pull-request-reviewer[bot]` and never enqueues in that
cycle. The organization `copilot_code_review` ruleset will additionally be
configured with `review_on_push=true`, so every new exact head receives a fresh
automatic review. `review_draft_pull_requests` is unnecessary because trusted
PRs are created open and drafts are rejected. An exhausted user, enterprise, or
cost-center AI-credit budget can either prevent a review or produce a
`COMMENTED` quota-error artifact; both outcomes intentionally remain
fail-closed, and the latter is not automatically re-requested on every
controller cycle.

Within the required gate, mutable review states that can settle without
changing the commit—no clean connector response, an unresolved connector or
stale-head Copilot thread, or no exact-head Copilot `COMMENTED` review
yet—remain pending and are polled fail-closed until the same bounded deadline.
Every polling iteration first reaffirms that the reread pull-request head is
the event's exact expected SHA. A missing or changed head is a terminal stale-
head error before any pending classification or sleep; the gate never keeps
polling bot evidence for a superseded commit.
This avoids a race in which the workflow starts before an agent can reply to
and resolve a fixed thread. The controller never treats those states as
trusted: unresolved threads are reported as bot-specific blockers, and only
the gate may wait. A current-head Copilot finding remains terminal even if its
thread is resolved. Invalid identity, a bot thread without an immutable review
commit, an unreviewable mixed/unknown diff, and other incoherent evidence are
also immediate terminal failures.

After the canary-derived source-provenance binding is implemented, if the
required gate timed out while mutable bot-review evidence was unsettled, the
controller can recover without a human click. Recovery is allowed only
after all non-gate evidence is currently valid and the failed check resolves to
an Actions run for the exact head. The failed check must also carry the gate's
dedicated `LCV_GATE_LATE_REVIEW_TIMEOUT` annotation; functional failures do not
carry it. The clean signal need not postdate completion because an unresolved
thread can be resolved after timeout while its already-valid clean signal keeps
the earlier timestamp. The controller calls `rerun-failed-jobs` only when
`run_attempt=1`. A running second attempt is observed as pending; a failed
completed second attempt is terminal and is never rerun again.

## Merge queue identity

The ruleset rollout must configure the merge queue with
`maximumEntriesToBuild=1` and `maximumEntriesToMerge=1`. On `merge_group`, the
gate does not trust `sender` and does not parse `head_ref`. It requires all of
the following:

- the event base is still current `main`;
- REST commit-to-pull-request association returns exactly one trusted PR;
- GraphQL returns the same PR in exactly one merge-queue entry;
- the queue entry base equals the event base and its head equals the synthetic
  group head exactly;
- the pull-request head is an ancestor of the synthetic group head;
- the complete configured check inventory is green on the synthetic group
  head.

The controller calls `enqueuePullRequest` only when GraphQL still reports the
same open, non-draft head/base and a merge queue. The mutation includes
`expectedHeadOid` and `jump:false`. An existing queue entry is an idempotent
success; absence of a queue never falls back to direct merge. Immediately
after rereading the pull request, REST `mergeable=null`/missing remains the
normal `mergeability-pending` outcome because GitHub documents that this means
its background mergeability computation has not finished. `mergeable=false`
is a conflict; for Dependabot it follows the existing exact-head rebase path.
With `mergeable=true`, `unknown`/missing state remains pending, `dirty` is a
conflict, and only the explicit GraphQL-enum allowlist `clean`, `has_hooks`,
`blocked`, `behind`, or `unstable` may continue. `blocked` and `unstable` are not treated
as independently sufficient: they proceed only into the same all-green
checks/statuses, zero-alert, exact-bot and fixed-point boundaries below, and
the merge queue retests the combined head. A malformed type, `draft`, or an
unrecognized state other than canonical `unknown` is terminally incoherent.
The same classification is repeated
at both final reassessments; a late unknown/conflict cannot reach the mutation.
At the final mutation boundary, the controller rereads the complete pull,
commit, review,
thread, connector, and current-main evidence and reaffirms the exact head/base;
it then rereads every exact-SHA check/status, requires the trusted gate itself
to remain successful, refreshes Code Scanning after that green inventory, and
repeats pull plus check validation once more. Late feedback, a superseding
check run/status, or a late alert therefore blocks enqueue rather than merely
occupying the one-entry queue until the synthetic gate rejects it.

## Dependabot transition

The existing Dependabot controller remains unchanged during evaluation. It can
continue to rebase and merge before a merge-queue ruleset is active. The new
controller independently recognizes the pinned Dependabot login and numeric
ID, requests an exact-head Codex review, and can enqueue it. A Dependabot branch
that is only behind `main` goes directly to the queue; the queue performs the
fresh-base test. A genuine merge conflict instead produces one idempotent
`@dependabot rebase` request for that exact head and waits for the new SHA. The
controller never uses `gh pr update-branch` for Dependabot.

Before changing the ruleset from `evaluate` to `active`, disable the old direct
merge mutation or update that workflow to delegate the merge step to this
queue controller. Otherwise the old controller will attempt a direct merge
that the new ruleset is designed to reject. Dependabot update creation,
rebasing, checks, and branch deletion remain separate and must be proven by a
canary after that topology change.

## Rollout (not performed by this change)

1. Merge this bootstrap source only after its PR has exact-head connector clearance, an
   accepted exact-head Copilot completion, all bot threads resolved, and all
   local and remote gates green. At this point the scheduled controller is
   deliberately non-authoritative: every otherwise-valid central gate remains
   `trusted-gate-provenance-unverified`, and every required Actions inventory
   remains `required-check-producer-provenance-unverified`, so no enqueue or
   timeout rerun can occur.
2. Create one organization branch ruleset in `evaluate` mode targeting only
   `.github-private` and `main`. That single ruleset must contain both the
   `workflows` rule selecting
   `.github/.github/workflows/trusted-pr-gate.yml` and the
   `copilot_code_review` rule with `review_on_push=true` and
   `review_draft_pull_requests=false`; these two rules share one target and one
   rollout lifecycle. Prove the workflow evaluation produces the expected
   exact-head check without blocking changes. Capture the complete check, job,
   run, workflow, ruleset and rule-suite payloads, including any observable
   source revision/ref binding for the central gate and the workflow ID, path,
   and revision binding for every configured required Actions producer. Do not
   activate the rule or queue yet.
3. Emit a follow-up source patch that recognizes only the exact gate and
   producer provenance shapes observed in step 2, rejects missing, unknown, or
   mismatched identities/revisions, and has regression tests for every
   captured payload. Give that patch fresh exact-head reviews from both bots
   and merge it only with all gates green.
4. Change that same single organization ruleset to `active` while it still
   targets only `.github-private`. The active `workflows` rule is the immutable
   identity anchor; an ordinary required-status context with the same display
   name is not an equivalent substitute and is not added by default. Confirm
   automatic exact-head Copilot reviews and the controller's REST fallback
   without widening the target.
5. Create a separate `.github-private` repository canary ruleset in `active`
   mode, without bypass. Require pull requests, signed commits, and merge queue
   with both maxima set to one. Run one `lcv-leo` canary and prove the exact PR
   head, accepted exact connector and Copilot reviews, every bot thread resolved, all
   check identities—including the complete check-to-job-to-run-to-central-
   workflow chain—zero alerts, verified commits, queue entry, synthetic
   `merge_group` head, automatic merge, and branch deletion. After the merge,
   also prove that the Enterprise Pages site
   was not regressed: repository visibility remains private (`public=false`),
   `build_type=workflow`, CNAME `enterprise.lcv.dev`, `https_enforced=true`, an
   approved certificate, a green Pages deployment, and successful HTTP-to-HTTPS
   redirect plus HTTPS response.
6. Inspect ruleset insights and audit logs. Resolve every discrepancy before
   expanding the single organization ruleset beyond `.github-private`.
7. Select one of the eleven public repositories that actually has Dependabot
   update automation. Disable its old direct-merge controller, extend the
   active organization ruleset's two rules to that single repository, and
   activate a matching repository merge-queue ruleset without bypass. Run one real
   Dependabot PR through review, conflict-only rebase if needed, every required
   wrapper, queue retest, automatic merge, and automatic branch deletion.
   `.github-private` has no Dependabot configuration and therefore is not a
   valid Dependabot canary.
8. Only after both narrow canaries are green may the single organization
   ruleset's two rules be expanded atomically in batches. Recheck insights,
   audit logs, controller behavior, and repository
   invariants after every batch.

## Primary GitHub documentation

- [Available rules for rulesets — require workflows to pass](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-workflows-to-pass-before-merging)
- [Contexts reference — workflow identity in the `job` context](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#example-usage-of-job-context-workflow-identity)
- [Events that trigger workflows — `merge_group`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group)
- [Webhook payload for `merge_group`](https://docs.github.com/en/webhooks/webhook-events-and-payloads#merge_group)
- [GraphQL pull-request mutations — `enqueuePullRequest`](https://docs.github.com/en/graphql/reference/pulls#enqueuepullrequest)
- [REST Check Runs authorization](https://docs.github.com/en/enterprise-cloud@latest/rest/checks/runs#create-a-check-run)
- [REST list check runs for a Git reference (`filter=all`)](https://docs.github.com/en/enterprise-cloud@latest/rest/checks/runs#list-check-runs-for-a-git-reference)
- [REST Check Run annotations](https://docs.github.com/en/enterprise-cloud@latest/rest/checks/runs#list-check-run-annotations)
- [REST workflow jobs](https://docs.github.com/en/enterprise-cloud@latest/rest/actions/workflow-jobs#get-a-job-for-a-workflow-run)
- [REST workflow runs](https://docs.github.com/en/enterprise-cloud@latest/rest/actions/workflow-runs#list-workflow-runs-for-a-repository)
- [REST get a pull request — `mergeable` true/false/null semantics](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request)
- [GraphQL `MergeStateStatus` values](https://docs.github.com/en/graphql/reference/enums#mergestatestatus)
- [REST workflows](https://docs.github.com/en/enterprise-cloud@latest/rest/actions/workflows#get-a-workflow)
- [REST code-scanning alerts for a repository](https://docs.github.com/en/enterprise-cloud@latest/rest/code-scanning/code-scanning#list-code-scanning-alerts-for-a-repository)
- [REST pull-request commits](https://docs.github.com/en/enterprise-cloud@latest/rest/pulls/pulls#list-commits-on-a-pull-request)
- [REST pull requests associated with a commit](https://docs.github.com/en/enterprise-cloud@latest/rest/commits/commits#list-pull-requests-associated-with-a-commit)
- [REST compare two commits](https://docs.github.com/en/enterprise-cloud@latest/rest/commits/commits#compare-two-commits)
- [REST issue-comment reactions](https://docs.github.com/en/enterprise-cloud@latest/rest/reactions/reactions#list-reactions-for-an-issue-comment)
- [Using GitHub Copilot code review on GitHub](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/copilot-code-review)
- [Configuring automatic Copilot code review](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/configure-automatic-review)
- [About GitHub Copilot code review — usage and budget behavior](https://docs.github.com/en/copilot/concepts/agents/code-review)
- [Files excluded from GitHub Copilot code review](https://docs.github.com/en/copilot/reference/review-excluded-files)
- [REST organization rules — `copilot_code_review`](https://docs.github.com/en/rest/orgs/rules)
- [REST review requests](https://docs.github.com/en/rest/pulls/review-requests#request-reviewers-for-a-pull-request)
- [REST rerun failed workflow jobs](https://docs.github.com/en/enterprise-cloud@latest/rest/actions/workflow-runs#re-run-failed-jobs-from-a-workflow-run)
- [REST commit statuses](https://docs.github.com/en/enterprise-cloud@latest/rest/commits/statuses#list-commit-statuses-for-a-reference)

## Observed Copilot payload evidence

These public artifacts are regression fixtures, not substitutes for the
primary documentation above:

- [Exact-head review with a positive `Suppressed comments` section](https://github.com/LCV-Ideas-Software/.github/pull/78#pullrequestreview-4889079285)
- [Documented `Comments suppressed due to low confidence` body variant](https://github.com/orgs/community/discussions/157330)
- [Service-error `COMMENTED` review body](https://github.com/bootstrap-vue-next/bootstrap-vue-next/pull/3216#pullrequestreview-4365036615)
- [Quota-exhaustion `COMMENTED` review body](https://github.com/jackwener/OpenCLI/pull/2012#pullrequestreview-4559017397)
- [Review-count evidence showing that excluded paths and displayed counts do not map one-to-one](https://github.com/bootstrap-vue-next/bootstrap-vue-next/pull/3216#pullrequestreview-4358924527)
