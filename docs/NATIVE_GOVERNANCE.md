# Native pull-request governance

LCV Ideas & Software delegates merge authorization to GitHub rulesets, required
checks, and merge queues. Repository automation may request native auto-merge,
but it cannot decide that a pull request is safe and it never bypasses a rule.

## Enforcement model

The organization ruleset targets every repository's default branch without a
bypass actor. It requires:

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
command snippet. The signatures preserve the existing `won't fix` decisions
for organization-mandated `permissions: write-all`, verified Wrangler `@latest`,
zero mandatory human approvals, no CII badge program, and fuzzing not applicable
to this repository's content. `BranchProtectionID` is a temporary bootstrap
signature and must be removed after the native protection canary makes that
historical finding disappear. A new or changed rule, path, message or command
fails the required job.

## Native auto-merge arming

The `native-auto-merge` action runs only after a `CodeQL` `workflow_run` that
originated from a pull request. A `workflow_run` executes trusted default-branch
code and can use the existing `LCV_AUTOMATION_TOKEN` from the protected
`dependabot-automation` environment even when the upstream pull request belongs
to Dependabot.

The action never checks out pull-request code or downloads its artifacts. It
re-reads the pull request, binds the operation to its current head SHA and
allowed immutable author identity, and invokes only:

```text
gh pr merge <number> --repo <owner/repository> --auto --match-head-commit <sha>
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
At the final boundary it repeats that effective-rules GET, then reads and
validates the PR again immediately before `gh`. This narrows state and policy
races; `--match-head-commit`
is the atomic HEAD precondition supplied by GitHub. A base-branch change after
the last PR read is an API limitation rather than an asserted atomic guarantee;
GitHub disables already-enabled auto-merge when the base changes, and the
automation never treats that behavior as permission to bypass branch rules.

It never uses `--admin`, never chooses a merge method, never approves a review,
never requests a rebase, and never calls the REST merge endpoint. On a branch
that requires a merge queue, GitHub either enables auto-merge while requirements
are pending or adds the exact head to the queue after they pass.

The consumer migration adds `ready_for_review` to every CodeQL workflow before
native enforcement is promoted. A draft that becomes ready then produces a
fresh trusted `workflow_run`; a new push likewise produces a new CodeQL run and
re-arms auto-merge for the new immutable head. A repository without that trigger
is not eligible for canary promotion.

## Bot feedback

Copilot and the ChatGPT Codex connector are optional reviewers. No workflow
waits for their presence, completion, file coverage, or a textual clean marker.
Actual inline review conversations are governed by GitHub's native required
conversation-resolution rule. The automation does not parse natural-language
review bodies or issue comments.

## Configuration reconciliation

The native-governance reconciler is configuration-only. From signed `main` and
the protected `github-administration` environment it:

1. inventories every active, non-archived organization repository;
2. fails closed if an active repository has no declared required-check policy;
3. reconciles squash-only, auto-merge, branch deletion, and pull-request
   settings;
4. reconciles the organization zero-tolerance ruleset; and
5. reconciles separate repository status-check and merge-queue rulesets.

Its scheduled run is only a drift-repair mechanism. It never opens, approves,
rebases, enqueues, merges, or deletes a pull request or branch.

## Rollout and rollback

New or changed rulesets are first materialized without enforcement. Promotion to
`active` happens only after the declared checks have been observed on both a
pull-request head and a merge-group head, in the order organization, status
checks, then queue. Normal rollback reverses only the queue state; the
organization and status-check rulesets remain active, and the armer refuses to
act without an active queue. There is no automated direct-merge fallback.
Operators must keep manual merging frozen while a queue is disabled. A full
demotion, when explicitly required, proceeds queue, status checks, then
organization so protection is removed in the least permissive order.

Before installing the consumer workflow, each repository must have a
`dependabot-automation` environment restricted to `main` and containing
`LCV_AUTOMATION_TOKEN`. The eleven existing public consumers already satisfy
that boundary; `.github-private` requires an explicit protected-environment
bootstrap before its canary. A newly discovered active repository that is not
declared in policy aborts reconciliation before any mutation, while the
organization baseline continues to target current and future repositories.

The legacy trusted gate, scheduled merge controller, Dependabot direct merger,
polling, review parser, workflow-provenance mirror, and automatic rebase commands
are retired rather than reused.

## Official references

- [Merging with a merge queue](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request-with-a-merge-queue)
- [`workflow_run` event and security boundary](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
- [Automating Dependabot with Actions](https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/automate-dependabot-with-actions)
- [Rules available in rulesets](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [Code-scanning merge-protection limitations](https://docs.github.com/en/enterprise-cloud@latest/code-security/concepts/code-scanning/merge-protection)
- [Automatic Copilot code review](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/configure-automatic-review)
