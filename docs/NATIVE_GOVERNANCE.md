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

- `.github-private`
- `admin-app`
- `calculadora-app`
- `mainsite-app`
- `mtasts-motor`
- `oraculo-financeiro`
- `sponsor-motor`
- `ultrabrain-mcp`

<!-- native-active-repositories:end -->

The `astrologo-app`, `cross-review`, and `maestro-app` repository rulesets
remain `disabled` until their own migration evidence is complete. The `.github`
status-check ruleset remains active, but its queue is disabled after the first
inert canary proved two merge-group gaps: Scorecard rejected the synthetic ref,
and the Slack workflow verifier called GitHub without a token. The queue can be
promoted again only after both producers are fixed and a fresh inert canary
proves all eleven declared contexts.

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
