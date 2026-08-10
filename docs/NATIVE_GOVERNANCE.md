# Native pull-request governance

LCV Ideas & Software delegates merge authorization to GitHub rulesets, required
checks, and merge queues. Repository automation may request native auto-merge,
but it cannot decide that a pull request is safe and it never bypasses a rule.

## Enforcement model

The live Enterprise policy has two active branch layers, both without a bypass
actor. `Enterprise All Branch Ruleset` targets `~ALL` branches and requires
verified signatures, CodeQL and zizmor at zero-tolerance thresholds, Code
Quality at `all`, license compliance, automatic Copilot review on new pushes
and drafts, and the declared branch-name pattern. `Enterprise Default Branch
Ruleset` targets `~DEFAULT_BRANCH`; organization and repository rulesets add
their default-branch controls. Their effective union on `main` requires:

- a pull request with squash as the only merge method and zero mandatory human
  approvals;
- every review conversation to be resolved;
- verified signatures and linear history, with deletion and force-push
  protection;
- CodeQL and zizmor code-scanning thresholds set to `all` for security and
  standard findings; and
- automatic Copilot review requests on new pushes. Copilot remains optional:
  the absence of a review is neutral, while a review thread that actually
  exists must be resolved.

Each managed repository has two independent repository rulesets: one containing
its exact required status checks, and one containing its SQUASH/ALLGREEN merge
queue. GitHub does not offer the merge-queue rule in organization rulesets, so
this repository-specific layer is reconciled centrally from
`native-governance/policy.json`. Separate declared enforcement states let a
canary or batch be promoted without activating every queue at once, and let an
incident disable a queue without removing its mandatory checks.

Every pull-request CI producer named in that policy must emit its check for
both pull-request and merge-group revisions. In `.github`, the two Slack
integration verifiers therefore run on every pull request instead of relying
on path filters that could make a required check disappear.

Required CodeQL, zizmor, dependency-review, and repository CI workflows run for
both `pull_request` and `merge_group`. CodeQL and zizmor enforce zero findings
inside their own analyzer jobs. This is required because GitHub's native code
scanning merge-protection rule does not apply to merge-queue groups.

The queue ruleset therefore requires the GitHub Actions analyzer wrappers, not
the GHAS summary checks from app `57789`: those summaries protect the PR head
through the organization `code_scanning` rule but are not emitted for the
synthetic merge-group revision.

The `.github` Scorecard job also runs before merge and rejects every result that
does not match an auditable exception signature. A rule ID alone is not enough:
the matcher also binds the recorded message, path and, for Wrangler, exact
command snippet. The durable dependency signatures preserve the explicit
`won't fix` decisions for organization-mandated `permissions: write-all` and
verified Wrangler `@latest`. The relay Worker has property-based tests over its
untrusted webhook boundary, so `FuzzingID` is remediated rather than waived.

Repository-level Scorecard heuristics are bound separately to the declared
native-governance policy. Trusted `push`, `schedule`, and `workflow_dispatch`
runs accept only the complete `BranchProtectionID` warning set produced by the
zero-human-approval rules, the complete `CodeReviewID` result with zero approved
changesets, and the exact `CIIBestPracticesID` result recording that this
organization does not participate in the external badge program. Candidate
runs cannot use those trusted-event signatures. The tokenless local candidate
scan has one exact bootstrap `BranchProtectionID` signature because upstream
v2.4.4 cannot inspect live rules in that mode. Any additional warning, changed
message body, score outside Scorecard's official 0–10 domain, unexpected path,
nonzero review numerator, new rule, or code finding fails the job.

### Feature-branch pre-scan

GitHub's rules API defines the all-branch Code Scanning rule in terms of CodeQL
and zizmor results for the commit and the reference being updated. The workflows
intentionally scan `main`, pull requests to `main`, merge groups, and explicit
`workflow_dispatch`; a normal feature-branch push cannot create its own result
before the ref update is accepted. GitHub does not document a universal
code-scanning creation exemption. Under the current live Enterprise ruleset,
however, the rule suite for an allowed ephemeral ref with `before_sha` equal to
all zeroes passes before analysis, while an existing-ref update without both
tools fails. Contributors therefore use this measured no-bypass protocol for
every subsequent feature-branch commit:

1. Create an ephemeral scan branch whose allowed name points directly to the
   final signed commit, for example
   `git push origin HEAD:refs/heads/fix/native-scan-<short-sha>`.
2. Use the existing `workflow_dispatch` entry points to dispatch both
   `codeql.yml` and `zizmor.yml` on that ref with
   `gh workflow run ... --ref <scan-branch>`.
3. Wait for both workflow runs to succeed and query the repository's
   code-scanning analyses. The inventory must contain the exact SHA from both
   tools, `CodeQL` and `zizmor`; a workflow conclusion alone is insufficient.
4. Push that unchanged commit to the real feature branch. Any new commit starts
   the protocol again because results are SHA-bound.
5. Re-read the real ref, then delete the ephemeral scan branch. Never retain a
   scan ref, reuse an older analysis, bypass a ruleset, or push a different SHA.

This is the same path for people and local coding agents. It does not require a
fork and does not widen any workflow trigger beyond the explicit trusted
dispatch that already exists.

## Native auto-merge arming

The `native-auto-merge` action normally runs after a pull-request `CodeQL`
`workflow_run`. A `workflow_run` executes trusted default-branch code and can
use the existing
`LCV_AUTOMATION_TOKEN` from the protected `dependabot-automation` environment
even when the upstream pull request belongs to Dependabot.

The action never checks out pull-request code or downloads its artifacts. It
re-reads the pull request, binds the operation to its current head SHA and
well-formed GitHub author identity. Author policy does not create a second
allowlist: every user or bot can receive native auto-merge by default once the
PR is open, non-draft, targets `main`, has the exact observed SHA, and its head
branch belongs to the same repository. Forks and malformed API identities stay
ineligible. The action then invokes only:

```text
gh pr merge <number> --repo <owner/repository> --auto --squash --match-head-commit <sha>
```

Before that request, the action loads `native-governance/policy.json` by a URL
relative to its own module. A local consumer and an `owner/repository/path@sha`
consumer therefore read the policy from the same checked-out or immutable
action revision, never from a moving branch or a pull-request artifact. An
undeclared repository is ineligible. Every required check name and GitHub App
ID declared for that repository must appear in the effective rules for `main`;
additional effective checks may only harden the boundary. Before GraphQL, the
action reads `GET /repos/{owner}/{repo}/rules/branches/main`; missing, disabled,
incomplete or malformed enforcement stops without calling GraphQL or `gh`.
Every applicable pull-request rule must independently preserve squash-only
merges, zero general approvals, no code-owner or last-push approval, no
nonempty team-reviewer requirement, and conversation resolution. A separate
effective Copilot rule must keep `review_on_push` enabled. This prevents a more
restrictive overlapping ruleset from silently reintroducing human approval or
removing the automatic review request while another correctly shaped rule
still exists.
It also inventories every required check run for the exact head and requires a
successful GitHub Actions App result for every policy name/App-ID pair. GitHub's
`filter=latest` check-run inventory can still return one latest run from each
check suite. The controller first limits that inventory to runs associated by
GitHub with the exact pull-request number, head SHA, `main` base, and same
repository. This excludes the temporary `workflow_dispatch` pre-scan while an
opened draft and a later `ready_for_review` run can legitimately repeat a pair
on the same commit. `filter=latest` already collapses attempts within one check
suite. Across distinct associated suites, any active run keeps reconciliation
pending and any terminal conclusion outside GitHub's accepted
`success`/`skipped`/`neutral` set fails closed; at least one associated run must
be exactly `success`. A later independent suite therefore cannot hide an older
failure merely by completing later. Malformed entries, repeated IDs, stale or
foreign associations, and missing pairs cannot produce a successful gate:
malformed or repeated relevant entries throw, while absent exact associations
remain pending. This is a deliberately stricter controller boundary; GitHub
does not document a global `completed_at` winner across independent suites with
the same name.
The same bounded REST inventory observes the exact-head dynamic Copilot review
run by its GitHub bot database ID, event, workflow name, internal path, and pull
request association. If that run exists, reconciliation remains pending until
it completes; a failed ordinary review run fails closed. If it does not exist,
bot absence stays neutral after the quiet window.
Only after checks and review state remain unchanged and non-blocking for a
120-second quiet window may the action continue. Polling is bounded to 12
minutes and the trusted job has a 30-minute timeout. Idempotent REST GET and
GraphQL query reads retry only bounded transient failures, including GitHub's
documented HTTP-200 GraphQL rate-limit response, with a fresh timeout per
attempt. GraphQL mutations and the `gh` request are never blindly retried;
an ambiguous response is reconciled from exact native state and any privilege
is removed before the error escapes.
At the final boundary it repeats that effective-rules GET, then reads and
validates the PR again immediately before `gh`. This narrows state and policy
races; `--match-head-commit`
is the atomic HEAD precondition supplied by GitHub. A base-branch change after
the last PR read is an API limitation rather than an asserted atomic guarantee;
GitHub disables already-enabled auto-merge when the base changes, and the
automation never treats that behavior as permission to bypass branch rules.

It never uses `--admin`, never approves a review, never requests a rebase, and
never calls the REST merge endpoint. It explicitly requests the only permitted
merge method, `--squash`, so the same command is deterministic before and after
queue enforcement. On a branch that requires a merge queue, GitHub either
enables auto-merge while requirements are pending or adds the exact head to the
queue after they pass.

The consumer migration adds `ready_for_review` to every CodeQL workflow before
native enforcement is promoted. A draft that becomes ready then produces a
fresh trusted `workflow_run`; a new push likewise produces a new CodeQL run and
re-arms auto-merge for the new immutable head. A repository without that trigger
is not eligible for canary promotion.

## Bot feedback

Copilot and the ChatGPT Codex connector are optional reviewers. In ordinary
CodeQL-triggered arming, no workflow requires either bot to appear and absence
is neutral. When they do produce feedback, the action binds only the bots'
immutable GitHub database IDs and
fully traverses the GitHub GraphQL cursor connections for issue comments,
reviews, review threads, and each thread's comments. It validates stable counts,
IDs, cursors, pull-request identity, head, timestamps, and thread ownership.
Concurrent legitimate changes restart the bounded snapshot and quiet window;
malformed, truncated, over-limit, or inconsistent API data still fails closed.
An exact-head bot review is canonical only in GitHub's `COMMENTED` state:
`PENDING` keeps reconciliation pending, while approval, change-request,
dismissal, or unknown state blocks as format/policy drift. It blocks every
unresolved bot-authored review thread, including outdated or collapsed threads,
every exact-head Copilot `Suppressed comments (N)` section with `N > 0`, and a
current-head Codex issue-comment review unless it matches the observed clean
headline and structural contract. The clean-headline allowlist contains only
exact variants observed from the canonical bot; arbitrary suffixes, changed
markers, and unknown response formats remain blocking instead of being guessed
from natural language.

The 120-second quiet window and a final identical fingerprint reread protect the
normal arming path. An outstanding requested-reviewer entry for the immutable
Copilot bot keeps both ordinary arming and the queue checkpoint pending until
GitHub records the corresponding review outcome. GitHub's
`all_external_contributors` approval policy applies
before a job-level sender filter, so direct Copilot or Codex review/comment
listeners would create `action_required` workflow runs and are intentionally
absent. Instead, a trusted `pull_request_target: review_requested` wake-up runs
default-branch code without checking out the candidate head. It accepts only
the immutable Copilot reviewer ID, an exact same-repository PR head, `main` as
base, and its own live workflow-run identity. It immediately removes any queue
or auto-merge privilege and repeats that hold before every reconciliation read.
The explicit request is complete only after a fresh `COMMENTED` Copilot review
is submitted on the exact head strictly after that trusted run began; an equal
second-resolution timestamp remains pending. A fresh active
dynamic review run keeps the hold pending; a dynamic run alone never substitutes
for the submitted review. GitHub may emit the canonical review without a
dynamic Actions run, so a fresh, structurally valid, finding-free review remains
the authoritative result in that fallback. When the auxiliary dynamic run
fails, ordinary arming and the queue checkpoint accept that canonical review
only if it was submitted strictly after the latest failed run attempt began;
the controller validates `run_attempt` and uses `run_started_at`, so a rerun
cannot inherit the original attempt's older `created_at` fence. An older or
equal-timestamp review cannot mask a later failure. The explicit request also
uses the current attempt start to decide whether a run is active after its
trusted request-run fence. Without the corresponding later review, the failed
dynamic run continues to fail closed.

The Action exposes a `merge-group-feedback-gate` operation for a final read-only
checkpoint. Its first live canary proved that GitHub's commit-to-pull-request
REST endpoint returns no association while a synthetic commit is still in the
queue; the endpoint only became useful after a successful squash had made that
commit the final pull-request commit. The corrected component therefore uses
the official GraphQL merge-queue model. It paginates
`Repository.mergeQueue(branch: "main").entries`, requires the live
`Repository.ref` to point at the event's exact synthetic SHA, and requires
exactly one entry whose `headCommit` and `baseCommit` match the required
`head_sha` and `base_sha` webhook fields. The entry and its cross-linked pull
request must remain open, non-draft, same-repository, based on `main`, at queue
position 1, and waiting for checks. The live queue configuration must remain
`ALLGREEN`, `SQUASH`, and one-entry for both build and merge groups.
Because the GraphQL schema makes entry commits and association links nullable,
the inventory preserves explicit null metadata on unrelated queued entries
instead of rejecting or dropping those nodes. It still requires exactly one
entry with the event's synthetic head SHA, then requires that entry's exact
base SHA, queue link, complete pull request identity, and backlinks. Missing,
partial, malformed, or duplicated event-entry identity therefore fails closed.

The gate then revalidates the real pull-request head through the REST API,
inventories requested reviewers, dynamic Copilot runs, and the complete
paginated review/thread/Suppressed state, and waits through the 120-second quiet
window. It does not read required checks or native auto-merge state, so it
cannot deadlock on its own context, and it has no PAT or mutation path. The
queue/ref association, exact PR identity, and feedback fingerprint must remain
identical on the final reread or the required merge-group context fails.

Activation is deliberately split across two signed pull requests around one
signed component release. The first bootstrap publishes this corrected
component and keeps the existing required
`Test native auto-merge` context limited to candidate tests; it does **not**
invoke the broken `native-auto-merge/v2.1.0` queue gate. After that bootstrap is
squash-merged and a new annotated, signed, immutable component release exists,
a separate minimal pull request will activate the new SHA and serve as the
first real GraphQL gate canary. No candidate/local Action is invoked with an
explicitly mapped token to approve its own merge-group revision.

That activation keeps candidate tests and the checkpoint on separate
GitHub-hosted runners. The candidate job checks out the proposed revision with
persisted credentials disabled. It receives no PAT or repository secret, and
its test steps do not explicitly map `github.token` or `GITHUB_TOKEN`. It is not
token-free: the organization policy deliberately requires
`permissions: write-all`, so the candidate-defined workflow retains the
runner's ephemeral `GITHUB_TOKEN` and OIDC surface. A clean dependent job keeps
the required display name, fails unless candidate tests succeeded, checks out no
candidate content, and passes its ephemeral `github.token` only to the signed
read-only component. No PAT, repository secret, workspace, environment file,
Action cache, artifact, or candidate runner process crosses that job boundary.
The required workflow definition and context remain candidate-defined under the
current rules, so this is defense in depth rather than required-workflow
provenance. Strong provenance would require a ruleset-required workflow or an
independent App/check producer and is outside this no-ruleset-change rollout.

The controller also rereads the same checks-and-reviews fingerprint immediately
after requesting auto-merge. If that post-arm state differs, fails, or becomes
blocking, it removes the resulting native privilege and verifies that neither
auto-merge nor a queue entry remains. Removal handles queue and auto-merge state
independently, attempts both even after an ambiguous mutation response, and
retries a mutation only when a fresh exact-state read still proves the privilege
exists.

After the ordinary CodeQL-triggered candidate passes repository-policy and
effective-rules validation, the controller removes any prior merge privilege
before its first feedback read and repeats that hold before every reconciliation
read. Blocking, unsuccessful, and throwing reconciliation paths verify that the
privilege remains absent instead of relying on the failing run alone to revoke
it. A clear snapshot is rearmed only after the final rules, PR identity, and
feedback rereads remain unchanged.

GitHub does not expose an atomic precondition that couples the review snapshot
to the queue mutation. The quiet windows, final rereads, native conversation
rule, and pre-review hold minimize that platform-level race; the merge-group
checkpoint narrows it further after the separately released component is
activated. The bootstrap itself makes no claim that the final checkpoint is
already active.
Neither stage claims it is mathematically impossible for feedback to arrive
after the last required check turns green and before GitHub completes the
merge.

## Configuration reconciliation

The native-governance reconciler is configuration-only. From signed `main` and
the protected `github-administration` environment it:

1. inventories every active, non-archived organization repository;
2. fails closed if an active repository has no declared required-check policy;
3. reconciles squash-only, auto-merge, branch deletion, and pull-request
   settings;
4. reconciles the organization zero-tolerance ruleset; and
5. reconciles separate repository status-check and merge-queue rulesets.

The organization ruleset targets `~ALL` repositories with repository-rename
protection disabled because GitHub rejects rename protection combined with the
`~ALL` selector. Branch, pull-request, signature, scanning, and review rules
remain unchanged and apply to every current and future repository.
The pull-request rule also omits the disabled `dismissal_restriction` object
because the organization rules API normalizes that no-op field away.
Reread verification accepts only an absent restriction or the exact disabled,
empty-actor form; an enabled or otherwise changed restriction is treated as
drift and reconciled.

Its scheduled run is only a drift-repair mechanism. It never opens, approves,
rebases, enqueues, merges, or deletes a pull request or branch.

## Rollout and rollback

New or changed rulesets are first materialized without enforcement. When a
repository already has merge-group evidence, promotion to `active` follows the
order organization, status checks, then queue only after the declared checks
have been observed on both revisions. A repository's first merge-group canary
is the explicit bootstrap exception: after every pull-request check succeeds,
the status-check ruleset is activated first and the queue is activated solely
for an inert canary. If any declared merge-group context is missing or does not
succeed, the queue is disabled immediately while the organization and status
checks remain active. A successful canary completes the promotion. Normal
rollback likewise reverses only the queue state, and the armer refuses to act
without an active queue. There is no automated direct-merge fallback.
Operators must keep manual merging frozen while a queue is disabled. A full
demotion, when explicitly required, proceeds queue, status checks, then
organization so protection is removed in the least permissive order.

The reconciliation mutation job has a separate repository-variable kill
switch: `LCV_NATIVE_RECONCILE_ENABLED` must equal `true`; absence and every
other value fail closed while the required test job continues to run. Before
the first canary, the operator verifies that this variable is `true`. If the
canary fails, the operator first sets `LCV_NATIVE_RECONCILE_ENABLED=false`,
and a live reread must confirm the exact value `false`. The operator lists the
workflow runs and cancels every non-terminal `queued`, `in-progress`, `waiting`,
`pending`, or `requested` run, then rereads until no non-terminal run remains;
only then may the repository queue be disabled. A signed policy rollback
changes that repository's `queue_enforcement` to `disabled`.

The policy rollback pull request is the sole queue-disabled merge exception.
After its exact signed head has every declared check successful, zero open
security alerts, and every review thread resolved, the operator may request the
native squash with:

```text
gh pr merge <number> --repo <owner/repository> --auto --squash --match-head-commit <sha>
```

It never uses `--admin`; all other merges remain frozen. After the rollback is
present on verified `main` and a live reread confirms the queue remains
disabled, the operator restores `LCV_NATIVE_RECONCILE_ENABLED=true`. Disabling
only the live queue is never a valid rollback because drift reconciliation
would reactivate the policy-declared queue.

The current declared rollout keeps the organization baseline active. The
following repository status-check and merge-queue rulesets are active after
their consumer migrations and the private plus public merge-group canaries:

<!-- native-active-repositories:start -->

- `.github`
- `.github-private`
- `admin-app`
- `astrologo-app`
- `calculadora-app`
- `cross-review`
- `maestro-app`
- `mainsite-app`
- `mtasts-motor`
- `oraculo-financeiro`
- `sponsor-motor`
- `ultrabrain-mcp`

<!-- native-active-repositories:end -->

Every policy repository listed above declares both its status-check ruleset and
merge queue active. The final `maestro-app` promotion is applied only after its
reusable CodeQL gate migration is merged and green on `main`. Reconciliation is
then followed by a documentation-only inert canary: all nine declared contexts
must succeed on the synthetic `merge_group` head, or the documented fail-closed
rollback disables that repository's queue again. Keeping the canary inert
isolates GitHub Actions behavior from application runtime changes.

Every promotion also begins with a live inventory of open pull requests. If a
repository has an eligible pull request whose CodeQL run completed before the
rulesets became active, the operator must re-run CodeQL for that exact head
after activation and verify that the native armer places it in the queue. The
current six-repository batch was declared only after that inventory returned
zero open pull requests in every promoted repository.

Before installing the consumer workflow, each repository must have a
`dependabot-automation` environment restricted to `main` and containing
`LCV_AUTOMATION_TOKEN`. The eleven existing public consumers already satisfy
that boundary; `.github-private` requires an explicit protected-environment
bootstrap before its canary. A newly discovered active repository that is not
declared in policy aborts reconciliation before any mutation, while the
organization baseline continues to target current and future repositories.

For that explicit bootstrap, an authorized operator dispatches `Native
Governance` from signed `main` with `bootstrap_repository` set to the declared
repository name. The protected `github-administration` job accepts only the
fixed operator identity, verifies the repository against `policy.json`, checks
that the target `dependabot-automation` environment has exactly the `main`
branch policy, streams the central token through standard input, and verifies
only the resulting secret metadata. It never creates a repository secret or
prints the token. A dispatch with an empty bootstrap input performs ordinary
configuration reconciliation instead.

The legacy trusted gate, scheduled direct-merge controller, Dependabot direct
merger, workflow-provenance mirror, and automatic rebase commands are retired
rather than reused.

## Official references

- [Merging with a merge queue](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request-with-a-merge-queue)
- [`merge_group` event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group)
- [Pull requests associated with a commit](https://docs.github.com/en/rest/commits/commits#list-pull-requests-associated-with-a-commit)
- [`workflow_run` event and security boundary](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
- [REST workflow-run attempts and timestamps](https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2026-03-10)
- [REST check-run inventory and `filter=latest`](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)
- [Pull-request review and comment events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_review)
- [GraphQL cursor pagination](https://docs.github.com/en/enterprise-cloud@latest/graphql/guides/using-pagination-in-the-graphql-api)
- [Workflow approval for outside contributors](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#controlling-changes-from-forks-to-workflows-in-public-repositories)
- [GraphQL pull-request mutations](https://docs.github.com/en/graphql/reference/mutations)
- [Automating Dependabot with Actions](https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/automate-dependabot-with-actions)
- [Rules available in rulesets](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [Code-scanning merge-protection limitations](https://docs.github.com/en/enterprise-cloud@latest/code-security/concepts/code-scanning/merge-protection)
- [Automatic Copilot code review](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/configure-automatic-review)
