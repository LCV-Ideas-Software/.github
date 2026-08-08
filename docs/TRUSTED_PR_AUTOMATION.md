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
Codex review, requesting a conflict-only Dependabot rebase, recovering one
attributable late-review timeout, or enqueueing an already trusted pull request.
It never publishes the gate result and never merges directly.
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
  and merge-group heads from wrappers guaranteed only on merge-group heads.
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
   `comment.commit.oid`.
6. Every configured check is present as the exact `{name, app_id}` pair and has
   conclusion `success`; skipped or neutral is never enough for a configured
   requirement. `required_checks` applies to both PR and merge-group heads;
   `merge_group_required_checks` is added only for the synthetic group, where
   path-filtered PR workflows are guaranteed to run without path filters.
   Missing or running required checks are polled. If a group-only wrapper does
   run on a PR, it remains part of the observed inventory and a bad conclusion
   still fails closed. For other observed jobs, intentionally conditional
   `skipped` or `neutral` conclusions are accepted, while failure, cancelled,
   timed-out, action-required, startup-failure, stale, or unknown conclusions
   fail closed. Every legacy commit status must be successful.
7. The raw CodeQL executor jobs (`Analyze <language>`) and the raw zizmor job
   (`Run zizmor` or `Run zizmor / Run zizmor`) are required in addition to the
   corresponding GitHub Advanced Security upload results. A green SARIF upload
   cannot mask a failing zero-findings executor.
8. Only after the exact-head executor and GHAS checks are green, the gate
   refreshes the PR's code-scanning alert inventory and requires zero open
   alerts at any supported severity. A stale open alert observed while a fixing
   analysis is still running cannot terminally fail the controller. Pull,
   commit, connector, review, and thread evidence is reread after the CI wait,
   then reread again after the code-scanning inventory; the exact associated
   head (and merge-group base, for a synthetic head) must remain unchanged at
   both final trust boundaries.

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

If the required gate timed out before the clean connector signal arrived, the
controller can recover without a human click. Recovery is allowed only after
all non-gate evidence is currently valid, the clean signal timestamp is later
than the failed gate completion, and the failed check resolves to an Actions
run for the exact head. The failed check must also carry the gate's dedicated
`LCV_GATE_LATE_REVIEW_TIMEOUT` annotation; functional failures do not carry it.
It calls `rerun-failed-jobs` only when `run_attempt=1`.
A running second attempt is observed as pending; a failed completed second
attempt is terminal and is never rerun again. A gate that failed after clean
evidence existed is treated as a functional failure, not as a timeout recovery.

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
success; absence of a queue never falls back to direct merge.

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

1. Merge this source only after its PR has exact-head connector clearance and
   all local and remote gates are green.
2. Create an organization required-workflow ruleset in `evaluate` mode
   targeting only `.github-private` and `main`. Select
   `.github/.github/workflows/trusted-pr-gate.yml` and first prove that the
   evaluation produces the expected exact-head check without blocking changes.
3. Change that same organization workflow ruleset to `active` while it still
   targets only `.github-private`. The active `workflows` rule is the immutable
   identity anchor; an ordinary required-status context with the same display
   name is not an equivalent substitute and is not added by default.
4. Create a separate `.github-private` repository canary ruleset in `active`
   mode, without bypass. Require pull requests, signed commits, and merge queue
   with both maxima set to one. Run one `lcv-leo` canary and prove the exact PR
   head, exact connector review, all check identities, zero alerts, verified
   commits, queue entry, synthetic `merge_group` head, automatic merge, and
   branch deletion. After the merge, also prove that the Enterprise Pages site
   was not regressed: repository visibility remains private (`public=false`),
   `build_type=workflow`, CNAME `enterprise.lcv.dev`, `https_enforced=true`, an
   approved certificate, a green Pages deployment, and successful HTTP-to-HTTPS
   redirect plus HTTPS response.
5. Inspect ruleset insights and audit logs. Resolve every discrepancy before
   expanding the organization workflow ruleset beyond `.github-private`.
6. Select one of the eleven public repositories that actually has Dependabot
   update automation. Disable its old direct-merge controller, extend the
   active organization workflow rule to that single repository, and activate a
   matching repository merge-queue ruleset without bypass. Run one real
   Dependabot PR through review, conflict-only rebase if needed, every required
   wrapper, queue retest, automatic merge, and automatic branch deletion.
   `.github-private` has no Dependabot configuration and therefore is not a
   valid Dependabot canary.
7. Only after both narrow canaries are green may the targets be expanded in
   batches. Recheck insights, audit logs, controller behavior, and repository
   invariants after every batch.

## Primary GitHub documentation

- [Available rules for rulesets — require workflows to pass](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-workflows-to-pass-before-merging)
- [Contexts reference — workflow identity in the `job` context](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#example-usage-of-job-context-workflow-identity)
- [Events that trigger workflows — `merge_group`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group)
- [Webhook payload for `merge_group`](https://docs.github.com/en/webhooks/webhook-events-and-payloads#merge_group)
- [GraphQL pull-request mutations — `enqueuePullRequest`](https://docs.github.com/en/graphql/reference/pulls#enqueuepullrequest)
- [REST Check Runs authorization](https://docs.github.com/en/enterprise-cloud@latest/rest/checks/runs#create-a-check-run)
- [REST Check Run annotations](https://docs.github.com/en/enterprise-cloud@latest/rest/checks/runs#list-check-run-annotations)
- [REST code-scanning alerts for a repository](https://docs.github.com/en/enterprise-cloud@latest/rest/code-scanning/code-scanning#list-code-scanning-alerts-for-a-repository)
- [REST pull-request commits](https://docs.github.com/en/enterprise-cloud@latest/rest/pulls/pulls#list-commits-on-a-pull-request)
- [REST pull requests associated with a commit](https://docs.github.com/en/enterprise-cloud@latest/rest/commits/commits#list-pull-requests-associated-with-a-commit)
- [REST compare two commits](https://docs.github.com/en/enterprise-cloud@latest/rest/commits/commits#compare-two-commits)
- [REST issue-comment reactions](https://docs.github.com/en/enterprise-cloud@latest/rest/reactions/reactions#list-reactions-for-an-issue-comment)
- [REST rerun failed workflow jobs](https://docs.github.com/en/enterprise-cloud@latest/rest/actions/workflow-runs#re-run-failed-jobs-from-a-workflow-run)
- [REST commit statuses](https://docs.github.com/en/enterprise-cloud@latest/rest/commits/statuses#list-commit-statuses-for-a-reference)
