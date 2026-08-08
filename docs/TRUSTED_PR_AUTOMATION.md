# LCV Trusted PR Automation

This document describes the fail-closed automation that may be attached to an
organization ruleset after a monitored canary. The checked-in policy grants
provenance authority only to `.github-private`, and only after its already
created canary ruleset is changed from `evaluate` to `active`. This repository
does not create, update, or activate that ruleset.

## Decision

`LCV Trusted Gate` is a public central ruleset workflow. GitHub can require that
workflow in every covered repository. The required workflow creates its check
on the exact pull-request or merge-group SHA and prevents a target pull request
from replacing the workflow selected by the ruleset. This is stronger than a
PAT-authored commit status and does not require an administrative token to
publish a gate result.

The administrative PAT remains confined to the protected
`github-administration` environment. It may perform only three mutation
classes:

- post one conflict-only `@dependabot rebase` command after a final exact-head
  revalidation;
- rerun failed jobs once when a specifically attributable bot-review veto has
  since been resolved on the same SHA; or
- enqueue an already trusted pull request with `expectedHeadOid` and
  `jump:false`.

It never publishes the gate result and never merges directly. Bot review
requests are not part of this controller. Read operations have bounded
transient retries; comments, reruns, and GraphQL mutations are attempted once
so the client cannot duplicate an ambiguous write.

## Components

- `.github/workflows/trusted-pr-gate.yml` is the public ruleset workflow. It
  handles `pull_request` and `merge_group`, preserves `permissions: write-all`,
  uses only `github.token`, and checks out its source with
  `job.workflow_repository` plus `job.workflow_sha`.
- `.github/workflows/trusted-pr-controller.yml` runs the controller from signed
  `main` every five minutes and obtains `LCV_AUTOMATION_TOKEN` only from the
  protected `github-administration` environment.
- `.github/workflows/trusted-pr-controller-ci.yml` runs syntax and unit tests on
  pull-request and merge-group heads without loading the protected environment.
- `trusted-pr-automation/policy.json` binds every active repository to exact
  check names and GitHub App IDs. It records the canonical Copilot identity;
  the connector identity is pinned in the engine constants.
- `trusted-pr-automation/main.mjs` is the shared fail-closed engine.

Local workflow validation uses actionlint 1.7.12 with a narrow ignore for its
outdated schema errors on GitHub's documented `job.workflow_repository` and
`job.workflow_sha` fields. All other expressions and YAML remain checked.

## Pull-request trust contract

Every accepted pull request must satisfy all conditions below at the same
time.

1. The REST payload says `state=open` and `draft=false` exactly. Missing, null,
   string, numeric, or true draft state fails closed. The PR must target `main`,
   and both head and base must belong to the same repository; forks are
   rejected.
2. The author matches both login and numeric ID for `lcv-leo` or
   `dependabot[bot]`. Display names, login-only matches, and ID-only matches are
   insufficient.
3. The event SHA and current PR head agree. A branch merely behind `main` may
   enter the merge queue because the queue tests a synthetic commit against the
   latest base. Exact head and base are rechecked at every mutation boundary.
4. Every PR commit has `verification.verified=true`, and the final returned
   commit is the exact current head.
5. All issue comments, reviews, and review threads are read for both canonical
   GraphQL bot identities, `chatgpt-codex-connector` and
   `copilot-pull-request-reviewer`. Thread attribution uses the immutable
   `pullRequestReview.commit.oid`, not the remapped inline-comment commit.
6. Every configured CI or security requirement is present as the exact
   `{name, app_id}` pair and concludes `success`. Missing, running, skipped, or
   neutral is not enough for a configured requirement. A required neutral or
   skipped result remains pending because GitHub may update the same aggregate
   check after its raw analyzer finishes; it must converge to success before
   the timeout. Failure, cancellation, and timeout conclusions remain terminal.
   Every legacy commit status must be successful.
7. Only after required checks are green, the gate refreshes Code Scanning and
   requires zero open alerts at every supported severity. The raw CodeQL
   `Analyze <language>` and raw zizmor jobs remain required in addition to their
   GitHub Advanced Security upload checks, so a green uploader cannot hide a
   failing zero-findings wrapper.

### Bot evidence is optional and veto-only

The two bot reviews complement mandatory static analysis; they are not a
coverage meter. Absence of a review, EYES, a request awaiting a response, or a
known service, quota, or unable-to-review response neither authorizes nor
blocks a PR. The gate does not request reviews, poll for bot completion, or
require clean wording. It reads whatever evidence exists and blocks only an
actual negative signal.

For the Codex connector:

- identity must simultaneously match GraphQL Bot type, database ID
  `199175422`, node ID `BOT_kgDOC98s_g`, and login
  `chatgpt-codex-connector`. Lookalikes are ignored rather than promoted into
  evidence;
- clean summaries, EYES, service messages, and unknown prose are
  informational. Only the connector's exact structured
  `### 💡 Codex Review` heading is treated as an explicit finding signal;
- an explicit current-head finding must correlate to at least one canonical
  thread by exact review ID and immutable review commit. Every related thread
  must be resolved. A finding with no provable resolution surface is a
  nonrecoverable veto;
- any canonical unresolved connector thread is itself a recoverable veto,
  including a historical thread. A resolved thread is handled evidence;
  malformed correlation on a resolved informational thread is ignored; and
- the latest decisive state per reviewer and exact head is evaluated from
  `CHANGES_REQUESTED`, `APPROVED`, and `DISMISSED`. `COMMENTED` is
  non-decisive. A later approval or dismissal by the same reviewer clears its
  earlier change request; another reviewer cannot clear it.

For Copilot code review:

- identity must match database ID `175728472`, node ID
  `BOT_kgDOCnlnWA`, Bot type, and the context-specific GraphQL login.
  Lookalikes are ignored;
- completion counts and partial coverage are informational. The canonical
  full-line summary reporting one or more generated comments is an explicit
  finding signal only; mentions in prose, quotes, or code examples are not;
- an explicit current-head finding must have at least one strongly correlated
  thread by review ID and immutable review commit. Once all correlated threads
  are resolved, the finding is handled. A finding without such a thread is a
  nonrecoverable veto;
- any unresolved Copilot thread, including one on an older head, blocks until
  it is resolved;
- a positive suppressed-comment count on the current head blocks even if a
  later review on that same SHA looks clean, because suppressed feedback has no
  resolution surface. Only canonical metadata with an integer greater than
  zero is a signal; malformed labels, unknown prose, quotes, and inline,
  fenced, or indented examples are neutral;
- service errors, quota exhaustion, unable-to-review responses, absent reviews,
  and unknown bodies are neutral because bot review is optional; and
- `CHANGES_REQUESTED` follows the same latest-decisive-state semantics.

Resolved bot threads are handled evidence; they do not require another commit
or a later clean review. Suppressed findings and explicit findings with no
provable thread are non-recoverable on that SHA. Invalid correlation on a
resolved informational thread does not create a finding by itself.

Reviews, issue comments, and review threads are captured in one GraphQL
`PullRequest` query. Its PR number, head, base, target, state, and draft flag
must match the REST PR used by the remaining trust checks. Each of the three
top-level connections and every nested thread-comment connection must provide
an array and explicit `hasNextPage=false`; missing structure or pagination is a
non-recoverable `BOT_EVIDENCE_INVALID` or `BOT_EVIDENCE_TRUNCATED` failure.
GraphQL does not expose `performed_via_github_app` for `IssueComment`, so App ID
is not an authorization input. The immutable Bot node/database identity is the
authorization boundary; REST App attribution can still be audited externally.

## Check inventory and fixed point

`required_checks` applies to both PR and merge-group heads.
`merge_group_required_checks` is added only for the synthetic group because
some repository workflows are path-filtered on ordinary PRs. A group-only
wrapper that happens to run on a PR is still observed and a bad conclusion
still blocks.

Check runs are fetched with `filter=all` and complete pagination, then reduced
locally within the same `{name, app_id, check_suite.id}`. An Actions check with
no positive safe check-suite ID fails closed. Historical jobs from an older
attempt of the same authenticated workflow run cannot override its current
attempt. After authenticating every candidate, the controller selects the
single current job for the run's current `run_attempt`, then the newest logical
run. A separate legitimate pending or failed run still blocks; a same-name
spoof cannot mask it.

The gate polls only mandatory CI/check evidence. Bot evidence is read once at
the initial exact-head boundary and again at the final boundaries; it is never
polled for completion. After CI becomes green, the order is:

1. reread the PR, commits, bot reviews, comments, and threads;
2. read and fingerprint the complete exact-SHA check/status inventory;
3. require zero open Code Scanning alerts;
4. reread all PR evidence; and
5. reread and fingerprint checks/statuses again.

The two fingerprints must be identical. A new or superseded run appearing
while alerts are checked therefore blocks rather than racing past stale green
evidence.

## Authenticated workflow provenance and canary limit

The controller never trusts `LCV Trusted Gate` by display name and App ID
alone. Every matching check is resolved through its check-suite ID and the
canonical run and job IDs parsed from `details_url`. The required workflow has
the target-local synthetic workflow ID `330131320`; its deprecated REST URL is
not dereferenced. Instead, GraphQL `WorkflowRun.file` must bind that run to
`LCV-Ideas-Software/.github`, path
`.github/workflows/trusted-pr-gate.yml`, and commit
`50fdb99aae9864da829d649e695ac3c4729f18b7`. The source file must retain blob
`3d61c1c7a3cc909537d34f824bdd9574ffeb285e`.

Ruleset `20591490` must independently contain the same source repository ID,
path, and immutable commit, must target only `.github-private`'s default
branch, must have no bypass actors, and must preserve the paired Copilot rule.
`evaluate` is observational and always returns
`trusted-gate-provenance-unverified`; only exact `active` state can grant
authority. The permanent `50fdb99…` pin is intentional: the required workflow
uses `job.workflow_sha` to check out both the YAML and its trusted automation
engine from that commit. The later controller implementation runs separately
from current `.github/main`.

Every matching required Actions check is authenticated before the current run
attempt is selected. The controller binds check to job, suite, run, active
workflow resource, GraphQL workflow file at the exact PR head, and an
allowlisted workflow blob. Governance, CodeQL, and the local Zizmor wrapper are
the only producer bindings. The Zizmor wrapper must also retain its exact
reusable workflow SHA and blob. Missing fields, pagination overflow, duplicate
runs, additional same-name producers, source changes, or reference changes
fail closed.

No other repository has provenance authority. It continues to return
`required-check-producer-provenance-unverified` and
`trusted-gate-provenance-unverified` even when its checks are green.

## Minimal same-SHA bot-veto recovery

The required gate emits the dedicated annotation title
`LCV_GATE_BOT_REVIEW_VETO` only when a typed bot veto fails the job. The message
contains the exact repository, PR, head SHA, and a subtype. Only these
dirimible subtypes are eligible for same-SHA recovery:

- unresolved connector thread;
- unresolved Copilot thread;
- connector `CHANGES_REQUESTED`; or
- Copilot `CHANGES_REQUESTED`.

Suppressed findings, explicit findings with no resolvable thread, human change
requests, snapshot-integrity failures, ordinary CI failures, Code Scanning
alerts, timeouts, and missing bot responses are never recovery-eligible.

After source and producer provenance are implemented, the scheduled controller
may request `rerun-failed-jobs` exactly once only when:

- a fresh exact-head assessment finds no remaining bot veto;
- the one authenticated current gate run is a completed first attempt with
  conclusion `failure`;
- exactly one gate annotation has the dedicated title, `failure` level, exact
  head identity, and an allowlisted subtype;
- a fresh GET still reports that same run, repository, head, source workflow,
  failed conclusion, and `run_attempt=1`; and
- one final exact-head/base assessment immediately before POST remains clean.

Attempt 2 is never auto-rerun. A persisted veto, changed head/base, ambiguous
annotations, nonrecoverable subtype, wrong run, or API inconsistency produces
zero mutation.

## Merge queue and mutation boundaries

The merge queue must use `maximumEntriesToBuild=1` and
`maximumEntriesToMerge=1`. On `merge_group`, the gate does not trust `sender`
or parse `head_ref`. It derives identity from exactly one GraphQL
`MergeQueueEntry` whose `headCommit` and `baseCommit` equal the event, then
cross-checks that entry's PR number, head, base, repository, actor, and `main`
target against a fresh REST PR read. It never uses commit-to-PR association or
PR-head ancestry: the queue head is a temporary synthetic commit, and with
`SQUASH` it need not descend from the PR head.

The controller calls `enqueuePullRequest` only when GraphQL still reports the
same open, non-draft head/base and a merge queue. Existing queue membership is
idempotent success; absence of a queue never falls back to direct merge.

REST mergeability is tri-state:

- `null` or missing, or canonical state `unknown`, is pending;
- `false` or state `dirty` is a conflict; and
- `true` with `clean`, `has_hooks`, `blocked`, `behind`, or `unstable` may
  continue only into the complete bot/check/scan fixed point.

An invalid type, `draft`, or another state is terminal. `blocked` and
`unstable` never authorize enqueue by themselves. Mergeability is checked at
both final reassessments.

For a real Dependabot conflict, the controller first reads fresh comments for
an exact-SHA idempotency marker, then current `main`, and finally the complete
PR immediately before POST. That final payload must still be open,
`draft=false`, same-repository, same exact head/base, authored by the pinned
Dependabot identity, and stably conflicting. Head/base/identity drift, pending
mergeability, or a resolved conflict produces no command. A merely behind
branch goes to the queue; the controller never uses `gh pr update-branch`.

Retargeting an existing PR to `main` is unsupported. The central gate alone
cannot recreate all producer checks for an `edited` event. Trusted automation
must create the PR directly against `main`.

## Remaining canary rollout

The signed bootstrap and provenance binding are merged. The first active queue
attempt proved automatic controller enqueue, then failed closed because the
pinned bootstrap runtime used commit-to-PR association for the synthetic queue
SHA. The repository queue ruleset remains disabled while this source runtime is
repaired.

1. Merge the source-runtime repair only with signed commits, all mandatory
   checks green, zero alerts, and every actual bot finding resolved. Bot absence
   or partial review coverage is not a gate.
2. Keep the repository queue ruleset disabled. Repin the narrow organization
   ruleset to the signed source merge SHA, run a new PR-head provenance probe,
   and capture the required-workflow identity emitted for that immutable SHA.
3. In a separate signed binding change, update the controller policy to the new
   source SHA and captured identity. The mismatch intervals remain fail-closed;
   a source commit never attempts to embed its own SHA.
4. After the binding is green, reactivate the no-bypass repository queue
   ruleset and resume the existing `lcv-leo` canary. Read every actual bot
   finding and prove signed commits, all check identities, zero alerts, queue
   entry, `merge_group`, automatic merge, and branch deletion.
5. After the `.github-private` merge, prove Enterprise Pages remained private,
   uses `build_type=workflow`, keeps CNAME `enterprise.lcv.dev`, enforces HTTPS,
   has an approved certificate, and serves a green HTTP redirect and HTTPS
   response.
6. On one public repository with Dependabot, disable the old direct-merge
   mutation, activate the same narrow rules plus queue, and prove a real
   Dependabot PR including conflict-only rebase if needed and branch deletion.
7. Expand the one organization ruleset atomically in monitored batches only
   after both canaries are green.

## Primary GitHub documentation

- [Require workflows with rulesets](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-workflows-to-pass-before-merging)
- [Workflow identity in the `job` context](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#example-usage-of-job-context-workflow-identity)
- [`merge_group` workflow event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group)
- [GraphQL `MergeQueueEntry`](https://docs.github.com/en/graphql/reference/pulls#mergequeueentry)
- [`enqueuePullRequest`](https://docs.github.com/en/graphql/reference/pulls#enqueuepullrequest)
- [List check runs with `filter=all`](https://docs.github.com/en/enterprise-cloud@latest/rest/checks/runs#list-check-runs-for-a-git-reference)
- [Check Run annotations](https://docs.github.com/en/enterprise-cloud@latest/rest/checks/runs#list-check-run-annotations)
- [Workflow jobs](https://docs.github.com/en/enterprise-cloud@latest/rest/actions/workflow-jobs#get-a-job-for-a-workflow-run)
- [Workflow runs](https://docs.github.com/en/enterprise-cloud@latest/rest/actions/workflow-runs#list-workflow-runs-for-a-repository)
- [Rerun failed jobs](https://docs.github.com/en/enterprise-cloud@latest/rest/actions/workflow-runs#re-run-failed-jobs-from-a-workflow-run)
- [Pull-request mergeability](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request)
- [`MergeStateStatus`](https://docs.github.com/en/graphql/reference/enums#mergestatestatus)
- [Code Scanning alerts](https://docs.github.com/en/enterprise-cloud@latest/rest/code-scanning/code-scanning#list-code-scanning-alerts-for-a-repository)
- [Copilot code review](https://docs.github.com/en/copilot/concepts/agents/code-review)
- [Automatic Copilot code review](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/configure-automatic-review)
- [Organization rules API](https://docs.github.com/en/rest/orgs/rules)

## Observed Copilot payload evidence

These public artifacts are regression fixtures, not substitutes for primary
documentation:

- [Positive suppressed-comment section](https://github.com/LCV-Ideas-Software/.github/pull/78#pullrequestreview-4889079285)
- [Alternate suppressed-comment wording](https://github.com/orgs/community/discussions/157330)
- [Service-error review](https://github.com/bootstrap-vue-next/bootstrap-vue-next/pull/3216#pullrequestreview-4365036615)
- [Quota-exhaustion review](https://github.com/jackwener/OpenCLI/pull/2012#pullrequestreview-4559017397)
