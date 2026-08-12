# GitHub Slack relay

`github-slack-alerts` is the central Cloudflare Worker for the
`LCV-Ideas-Software` GitHub-to-Slack event feed. It receives one signed GitHub
organization webhook and delivers bounded records to the source-controlled
Deno app in `slack/github-integration/`. The Slack app owns two static webhook
triggers and posts to two fixed private channels:

- routine organization activity to `#github-activity` (`C0BMQMW3L4E`);
- actionable failures and security events to `#github-alerts` (`C0BMUK793NV`).

The deployed Slack app is `LCV GitHub integration` (`A0BMWBGES20`). These IDs
are production identities, not values to rediscover or replace during routine
deployment.

The official GitHub app for Slack remains installed only for link unfurls and
commands explicitly invoked by the operator. It is not subscribed as the
automated event feed. GitHub and Slack expose no supported API for automating
the GitHub app's `/github subscribe` state, and messages sent through Slack APIs
do not execute slash commands.

See [the integration source of truth](../../docs/GITHUB_SLACK_INTEGRATION.md)
for activation order, Slack app deployment, trigger rotation and the complete
operations checklist.

## Event routing

The destination is derived from the event type and lifecycle action. A webhook
payload cannot supply a Slack channel, destination or trigger URL.

| Destination | Accepted event families                                                                                                                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `alerts`    | Problematic completed `workflow_run`; `deployment_status` with state `error` or `failure`; relevant `dependabot_alert`, `code_scanning_alert`, and `secret_scanning_alert` lifecycle actions.                                                       |
| `activity`  | Default-branch `push`; `deployment_status` with state `success` or `inactive`; relevant `pull_request`, `pull_request_review`, `pull_request_review_comment`, `issues`, `issue_comment`, `release`, `discussion`, and `discussion_comment` actions. |

Problematic workflow conclusions are `action_required`, `cancelled`, `failure`,
`stale`, `startup_failure`, and `timed_out`. Successful workflows, transient
deployment states, non-default-branch pushes, unsupported actions, archived
repositories, and repositories outside `LCV-Ideas-Software` are not queued.
For deployments, every state other than `error`, `failure`, `success`, or
`inactive` is ignored.
Resolution events for security alerts remain visible as informational records;
reopening events are incidents.

Discussion and discussion-comment events are intentional first-class activity
events. They must be selected when the organization webhook is created.

## Inbound security

- `POST /github/webhook` is the only ingestion route.
- The production `workers.dev` route is an explicit external-ingress
  exception: GitHub cannot invoke a Cloudflare Service Binding. Preview URLs
  are disabled, and relay source must never call another Cloudflare
  application through `workers.dev` or `pages.dev`.
- The request stream is cancelled above exactly 25,000,000 bytes, GitHub's
  documented webhook ceiling.
- `X-Hub-Signature-256` is verified with HMAC-SHA256 before JSON parsing.
- Organization, repository owner, archived state, delivery ID and event name
  are validated before normalization.
- A valid `ping` is acknowledged without persistence or Slack delivery.
- D1 deduplicates `X-GitHub-Delivery` before Queue publication.
- The raw GitHub payload is never stored or queued.

Secret values and locations, code-scanning locations, manifest paths,
resolution comments, issue and pull-request bodies, comment and review bodies,
diffs, commit messages, author email addresses and raw release asset metadata
are omitted. Remaining text is normalized, control characters are removed,
Slack control syntax is escaped, lengths are bounded, and investigation links
are constrained to HTTPS `github.com` URLs.

## Downstream Slack authentication

The two Slack trigger URLs are bearer credentials, but knowing a URL does not
authorize a message. Immediately before every trigger POST, the Worker adds:

- the persisted internal `destination`;
- an epoch-second `relay_timestamp`;
- a lowercase HMAC-SHA256 `relay_signature`.

The signature input is exactly this UTF-8 JSON string, preserving field order
and JavaScript JSON escaping:

```text
JSON.stringify([source,severity,repository,title,details,actor,branch,url,occurred_at,delivery_id,event,action,destination,relay_timestamp])
```

The Deno app's first workflow step validates the signature, expected
destination, five-minute freshness window and GitHub-only URL. It then passes a
bounded formatted message to Slack's native `SendMessage` function. The Slack
validator accepts `SLACK_RELAY_SIGNING_SECRET` and, only while a separately
controlled transition is staged, `SLACK_RELAY_SIGNING_SECRET_NEXT`. The Worker
control plane and monitor both verify only staged `NEXT`.
After current or `NEXT` admits an inbound relay, the Slack validator re-keys its
progress authorization to `NEXT`, so every new callback and monitor trace is
verifiable without recovering old current into GitHub. This expand makes no
removal or zero-loss claim without a proved drain.

`occurred_at` remains ISO 8601 inside the canonical signed record. At the final
human-presentation boundary, the Deno app converts a valid value to
`dd/MM/aaaa às HH:mm:ss` with the fixed IANA zone `Etc/GMT+3`; by the POSIX/IANA
sign convention, `+3` here means UTC−03:00. The technical timezone suffix is
not displayed to the user. An invalid, ambiguous or absent value is not echoed.
This does not alter Slack's native message timestamp.

Each trigger receives a flat string-only object with every key present:

| Key               | Meaning                                              |
| ----------------- | ---------------------------------------------------- |
| `source`          | GitHub subsystem, such as Actions or Dependabot.     |
| `severity`        | `critical`, `high`, `medium`, `low`, or `info`.      |
| `repository`      | `organization/repository`.                           |
| `title`           | Bounded headline.                                    |
| `details`         | Sanitized bounded description.                       |
| `actor`           | GitHub login when available.                         |
| `branch`          | Branch or ref when available.                        |
| `url`             | HTTPS `github.com` investigation URL.                |
| `occurred_at`     | ISO-8601 source timestamp when available.            |
| `delivery_id`     | GitHub delivery identifier and D1 deduplication key. |
| `event`           | GitHub webhook event name.                           |
| `action`          | GitHub lifecycle action.                             |
| `destination`     | Fixed internal enum: `alerts` or `activity`.         |
| `relay_timestamp` | Epoch seconds at dispatch time.                      |
| `relay_signature` | HMAC-SHA256 over the canonical fields.               |

HTTP 2xx plus JSON `ok: true` moves the D1 row only to
`accepted_by_trigger`. That state is nonterminal and is never treated as proof
of a channel message. Before `SendMessage`, the Slack workflow records an
authenticated `send_started` boundary. After `SendMessage`, it posts an
idempotent HMAC receipt containing the `delivery_id`, fixed destination and
Slack `message_timestamp`; only that receipt moves the row to `delivered`.
The paginated activity monitor subsequently associates Slack's actual
`trace_id` with the same delivery. A canary is complete only when the one
channel message, D1 receipt and Slack trace agree.

## Bound resources

The checked-in `wrangler.jsonc` contains resource identifiers and bindings, but
no secret values:

| Resource       | Name or identifier                                                |
| -------------- | ----------------------------------------------------------------- |
| Worker         | `github-slack-alerts`                                             |
| D1             | `github-slack-alerts-db` / `cf070eb0-32d9-4ee0-9516-d469833cdc77` |
| Alerts Queue   | `github-slack-alerts`                                             |
| Alerts DLQ     | `github-slack-alerts-dlq`                                         |
| Activity Queue | `github-slack-activity`                                           |
| Activity DLQ   | `github-slack-activity-dlq`                                       |
| Secrets Store  | `df90c0935ba1460899c3c2c457548a90`                                |

Five Secrets Store bindings are declared:

| Worker binding                        | Secret name                              |
| ------------------------------------- | ---------------------------------------- |
| `GITHUB_WEBHOOK_SECRET`               | `github-slack-alerts-webhook-secret`     |
| `SLACK_ALERTS_WORKFLOW_WEBHOOK_URL`   | `github-slack-alerts-workflow-url`       |
| `SLACK_ACTIVITY_WORKFLOW_WEBHOOK_URL` | `github-slack-activity-workflow-url`     |
| `SLACK_RELAY_SIGNING_SECRET`          | `github-slack-relay-signing-secret`      |
| `SLACK_RELAY_SIGNING_SECRET_NEXT`     | `github-slack-relay-signing-secret-next` |

The old current relay-signing value must match Slack app environment
`SLACK_RELAY_SIGNING_SECRET`. Before merge, the same newly generated value must
be stored under `SLACK_RELAY_SIGNING_SECRET` in both protected GitHub production
environments. The rollout writes that value to each hosted runtime's distinct
`NEXT` slot, deploys the Worker with `SLACK_RELAY_SIGNING_ACTIVE_SLOT=next`, and
uses it for activation and monitor signatures. The old hosted current remains
stored during expand, but only Slack accepts it for inbound in-flight relay
compatibility; the Worker control plane accepts `NEXT` only. It is never read
back into GitHub.

Create or update values only through Wrangler's interactive prompt. Never use
`--value` or put values in `.dev.vars`, command history, GitHub variables, logs
or source files. The value-free `.dev.vars.example` documents only the binding
names.

## Queueing and delivery semantics

Alerts and activity use separate primary Queues and DLQs. Consumers have batch
size one and concurrency one, while a shared D1 limiter reserves outbound Slack
slots globally. Alerts visible when a slot is reserved take priority over
activity. Starts are at least 6.1 seconds apart, satisfying the stricter Slack
webhook-trigger limit used by this integration.

HTTP 429 honors `Retry-After` and extends the global cooldown. Other failures
that are proven to precede a trigger POST, redirects, and definite 4xx
rejections use bounded exponential backoff. A network exception after the POST
starts, HTTP 408, any 5xx, a 2xx without exact `ok: true`, or a stale D1
`sending` state is ambiguous: the Slack workflow may exist, so the row moves to
`manual_review` without a blind trigger POST. A fresh authenticated workflow
callback may continue that same execution, and a complete terminal trace may
later make it retryable only with an explicit failed validator or pre-send step
and no successful send boundary.
Primary Queue exhaustion moves a nonambiguous record to its destination DLQ;
an ambiguous `sending` record never becomes retryable merely because it aged.

The GitHub-to-Queue leg is intentionally at-least-once. Once Slack accepts a
trigger, the Queue message is acknowledged but the D1 row remains
nonterminal. Neither the Queue consumer nor the scheduled recovery loop resends
`accepted_by_trigger` or `send_started`: the asynchronous Slack workflow may
already have reached `SendMessage`. A complete Slack trace can return a row to
`pending` only when it contains explicit proof that the validator or pre-send
step failed and no successful send boundary exists. A missing boundary event is
not proof. Every other ambiguity becomes `manual_review`.

## Validation

Wrangler is an exact development dependency in this package and its lockfile.
CI and local validation install only that reviewed graph from the effective
official npm registry, verify package signatures and advisories, and then run
the checked-in tasks:

```powershell
npm ci
npm audit signatures
npm audit --audit-level=low
npm exec -- wrangler --version
npm run check
npm run db:migrate:local
```

`npm run check` uses Wrangler's native `types --check` mode to verify that the
committed `worker-configuration.d.ts` still matches `wrangler.jsonc`, then runs
strict TypeScript checking, Vitest, and a strict Wrangler dry-run bundle.
Run `npm run types:generate` intentionally whenever a reviewed Wrangler or
configuration update changes the generated bindings. Those bindings are the
source of truth for `Env`; there is no handwritten environment interface.

Production verification and deployment are owned by
`.github/workflows/github-slack-integration.yml`. The workflow:

1. verifies the webhook redelivery controller, Worker and complete Slack app
   candidate in the same required predecessor;
2. checks npm and Deno dependency signatures and advisories;
3. verifies committed bindings, formats, lints, type-checks, runs both test
   suites, and creates a strict Worker dry-run bundle;
4. applies remote D1 migrations, reads the activation tuple, and refuses to
   replace an already activated Worker with another SHA;
5. stages Cloudflare runtime `NEXT` and deploys the verified Worker revision
   with active slot `next` but delivery
   still closed;
6. in a dependent job on the same SHA, stages Slack runtime `NEXT`, deploys the
   Slack app, verifies the protected triggers, and activates delivery.

Migration `0004_confirm_slack_delivery.sql` starts the receipt-aware delivery
protocol closed. The new Worker reads its immutable `WORKER_VERSION.tag`, which
the deploy command binds to the exact 40-character `GITHUB_SHA`. While the
protocol is closed, primary and DLQ consumers use bounded Queue backoff without
reading or mutating a delivery, reserving a Slack slot, increasing the D1
attempt count, or issuing a trigger POST; the recovery cron also leaves durable
delivery state untouched. Old-Worker writes to `accepted_by_slack` remain
schema-compatible but an expand trigger immediately quarantines them with
`legacy_unverified = 1`.

The activation-tuple preflight accepts only the initial inactive state or an
already activated exact revision. It therefore permits an exact-SHA rerun but
blocks any later SHA before secret staging or Worker replacement. The separate
contract must remove this expand-only guard together with the activation path.

After the Worker deploy succeeds, the dependent protected Slack job uses the
same checkout and SHA, stages Slack `NEXT`, deploys the app, and verifies the
exact two production triggers. Its final step derives an immutable pseudorandom
`activation_id` from the SHA and schema revision under `NEXT`, then sends a
second domain-separated `NEXT` HMAC for that exact tuple to
`/slack/protocol/activate`. The Worker requires the staged signer and the
expected SHA to equal `WORKER_VERSION.tag`,
proves the expanded D1 tables and triggers, and performs the sole allowed
false-to-true CAS while persisting the tuple. If its response is lost, one
byte-identical retry returns read-only `already_applied`; this is idempotent
confirmation, not a second activation. A Slack deploy or inventory failure
never reaches activation; a wrong key/SHA/schema, new activation ID, changed
tuple, downgrade, or request after the contract closes confirmation fails
closed. The path has no status, delivery selector, or recovery capability.

It does not create Slack channels, Slack triggers, or the GitHub organization
webhook. Its two fixed-purpose provisioning scripts create or idempotently
rewrite only the runtime `NEXT` signer after proving exact metadata.

Repository variable `SLACK_GITHUB_INTEGRATION_ENABLED` is the fail-closed
production automation gate. Keep it `false` while IDs, secrets, triggers, and
the organization webhook are prepared. Change it to `true` only for the
authorized serialized rollout; migration `0004` independently keeps delivery
closed until exact-SHA activation. At `true`, the variable permits the relay
deploy, Slack-app deploy, monitor, and organization-webhook redelivery jobs;
their verification jobs do not depend on the gate. Run the real channel
canaries immediately after activation, and return the gate to `false` on any
failure. The variable does not disable an already deployed Worker or webhook.

## Trigger lifecycle

The source-controlled Deno app owns two static trigger definitions:

- `triggers/github_activity_webhook.ts`;
- `triggers/github_alert_webhook.ts`.

Create each production webhook trigger exactly once after the final Slack app
is deployed. Record the trigger IDs in controlled operations inventory and
write the returned URLs directly to the corresponding Secrets Store entries.
The non-secret IDs are retained in repository variables
`SLACK_GITHUB_ACTIVITY_TRIGGER_ID` and `SLACK_GITHUB_ALERT_TRIGGER_ID`; the
bearer URLs never belong in GitHub variables.
Routine Slack app deployments use `--hide-triggers` and must not create,
update, delete or display triggers. In particular, do not run
`slack trigger update` during every deployment.

Rotate a trigger only through a controlled overlap:

1. Create the replacement without deleting the old trigger.
2. Atomically update the existing Secrets Store entry by secret ID through an
   interactive `wrangler secrets-store secret update` prompt.
3. Generate a signed real canary and require the actual destination-channel
   message plus a successful Slack activity trace.
4. Delete the old trigger only after the new path is proven. Restore the old
   URL atomically if verification fails.

Never enable the GitHub organization webhook until real canaries have proven
both trigger/channel paths.

## Staged HMAC overlap

The checked-in Slack validator accepts current and staged `NEXT` inbound relay
signatures. After either one authenticates a relay, Slack issues its progress
token and callbacks only with `NEXT`; the Worker control plane and monitor also
verify only `NEXT`. This expand sets the Worker signer and monitor to `next` only
after Cloudflare `NEXT` is staged; protocol activation remains closed until
Slack `NEXT`, app deployment and trigger inventory succeed. A
current-authenticated execution becomes correlatable at its first `NEXT`
progress step. Do not overwrite either hosted current value as part of this
change.

A later reviewed contract must prove there
are no nonlegacy `sending`, `accepted_by_slack`, `accepted_by_trigger`, or
`send_started` records and no unsettled monitor traces lacking authenticated
`NEXT` progress evidence.
Only then may a separate change promote the already selected `NEXT` value to
hosted current, run one authorized canary per channel, observe the full
receipt/trace gate, and eventually remove the old slot. Without that drain
evidence, removal remains blocked.

## Operations and recovery

`GET /healthz` returns HTTP 200 `ready` only when the receipt-aware delivery
protocol has completed its one-way activation, the `deliveries` schema is
queryable, the `relay_state` singleton contains valid Queue and Slack activity
checkpoints, no row is in `manual_review` or `dead_letter`, and no
current `accepted_by_slack`, `accepted_by_trigger`, or `send_started` row has
exceeded its reconciliation deadline. The current HMAC secret and both Slack
trigger bindings must validate. The ready reply contains only the boolean
`legacy_unverified`, making quarantined historical debt visible without making
it a readiness failure or exposing a count or identifier. A failed check or
exception returns the same HTTP 503 `unavailable`.

The five-minute scheduled handler:

- deletes only receipt-confirmed `delivered` rows older than 30 days;
- recovers due `pending`, `enqueueing`, `queued`, `sending`, and `dead_letter`
  records;
- requeues stale states older than 15 minutes;
- preserves all unresolved and `manual_review` records;
- marks the row `manual_review` after 25 successful `claimForSlack` dispatch
  claims. This is a processing-claim ceiling, not a promise of 25 Slack HTTP
  POSTs: a claimed cycle can fail during configuration reads or signing before
  any POST occurs.

Useful metadata-only D1 checks are:

```sql
SELECT destination, status, COUNT(*) AS count
FROM deliveries
GROUP BY destination, status
ORDER BY destination, status;

SELECT delivery_id, destination, event_type, repository,
       attempt_count, updated_at, last_error
FROM deliveries
WHERE status IN ('dead_letter', 'manual_review')
ORDER BY updated_at ASC;
```

The separate Slack app workflow queries `apps.activities.list` every 15 minutes
at `info` level, follows every `response_metadata.next_cursor`, and starts from
an authenticated D1 checkpoint with a 20-minute overlap. An empty query keeps
its previous evidence boundary (or anchors the initial lower bound); it never
advances to wall-clock time. D1 additionally clamps every proposed advance
behind the earliest nonlegacy live attempt until a trace is correlated. It
retains an earlier trace binding across a retry until authenticated progress
proves the next Slack execution, while every live attempt continues clamping
the watermark. It persists correlated incomplete traces before advancing the checkpoint and
extracts only bounded `delivery_id`, `trace_id`, outcome, timestamps, the
send-boundary flag and the explicit pre-send-failure proof bit. A delivery is
correlated only after the 14-field relay signature verifies under an available
monitor key or the derived `NEXT` progress authorization verifies, and the
signed relay timestamp is
within the validator's five-minute/60-second window around the Slack step
activity itself. Rejected or replayed trigger inputs are ignored. Raw activities
and private workflow inputs are never sent to D1 or logged. The checkpoint
advances only after all pages and every normalized trace are durably accepted. A
terminal error with an authenticated explicit failed validator or pre-send step
and no send boundary is the sole automatic resend case. If a `send_started` CAS
committed but both callback responses were lost, the authenticated failed
pre-send step proves that its dependent `SendMessage` never executed and permits
the same safe retry. Success without a
receipt, any post-boundary failure, missing proof, incomplete evidence or a
conflicting trace fails closed.

Retention is also checkpoint-aware: a receipt-confirmed row is purged only when
its applied successful trace predates both the 30-day cutoff and the durable
activity checkpoint minus the 20-minute overlap. A still-queryable Slack trace
therefore cannot outlive the D1 delivery correlation it names.

Migration `0004_confirm_slack_delivery.sql` is expand-only: it retains the old
`accepted_at` column and `accepted_by_slack` value so the previously deployed
Worker remains operable while the new Worker is rolled out. Historical trigger
acceptances stay `accepted_by_slack` with `legacy_unverified = 1`, are exempt
from readiness, blind resend and deletion, and the response exposes only their
aggregate presence. The audited snapshot contained 6,836 such ordinary rows;
the rollout inventory must add any accepted by the old Worker before protocol
activation. The same migration installs a quarantine trigger for acceptances
written by the old Worker during that window and initializes the receipt-aware
protocol flag to false. Its one-way schema trigger prevents downgrade after the
orchestrator activates the exact deployed revision and persists its immutable
activation ID and schema revision. While the confirmation window remains open,
only the identical tuple may be confirmed read-only; a contract migration closes
that window irreversibly.
If a successful Slack trace is observed for an ordinary legacy row, D1 may
attach that trace ID but preserves `accepted_by_slack` and
`legacy_unverified = 1`; the trace alone is neither delivery proof nor a reason
to create readiness-blocking manual debt.
The migration places the known missing delivery
`de345e40-95b1-11f1-8d38-fac15f0bb4cd` in `manual_review`. Legacy backfill may
set `delivered` only from positive evidence of exactly one matching channel
message and its Slack timestamp. Zero matches are retryable only with a complete
trace containing an explicit failed validator or pre-send step and no successful
send boundary; otherwise the row stays for manual review. Recovery of the known
missing message requires two distinct Issue #171 comment references:
operational proof that the message is absent from `activity`, and explicit
authorization naming the exact delivery ID and destination. The audit also
stores distinct SHA-256 fingerprints of both reviewed comment bodies. A single
insert into `slack_delivery_recovery_audit` validates those fixed facts and performs a
one-time CAS from the exact `manual_review` reason to `pending`; the audit row
is retained. The normal path must then produce the unique receipt and trace.
There is no public recovery endpoint, generic delivery selector or blind
resend, and GitHub webhook redelivery is not a repair.

The monitor job reads the newly generated `SLACK_RELAY_SIGNING_SECRET` from the
protected `slack-production` GitHub environment, maps it to runtime
`SLACK_RELAY_SIGNING_SECRET_NEXT`, and selects `next`. The same protected value
must be present in `cloudflare-production` before merge so the combined rollout
can write both hosted `NEXT` slots. These are deployment prerequisites, not
repository variables; the old hosted current value is not recoverable in GitHub.

GitHub itself does not automatically retry organization webhook failures. The
scheduled `GitHub Slack Webhook Redelivery` workflow checks every 15 minutes,
first verifies the sole active exact organization hook through GET requests
only, groups attempts by GUID, accepts GitHub's documented HTTP 200-399 success
classification, and redelivers unresolved attempts within the three-day
retention window. It never sends a scheduled ping. Before scanning deliveries,
it evaluates successful scheduled runs newest first through the native Actions
API and accepts only the newest candidate with an exact successful recovery
step, plus a 15-minute retention margin, as a fail-closed continuity checkpoint.
Well-formed non-executed runs do not eclipse an older proven checkpoint;
malformed or contradictory evidence aborts. Every retry requires one retained
original delivery and a classified HTTP status. Before any POST, one complete
lineage refresh intersects the oldest-first candidates and limits the mutation
batch to ten; excess targets are explicitly deferred. Pagination accepts only the exact
named and numeric canonical paths for the configured organization and hook, and
reconstructs each request from the returned cursor instead of following a
`Link` URL blindly.

The controller reads the hook ID from repository variable
`SLACK_RELAY_ORG_HOOK_ID` and authenticates through the private,
organization-owned `lcv-slack-webhook-recovery` GitHub App. The workflow
validates the exact App slug and a positive installation ID before use. The
protected `webhook-recovery` environment provides
`SLACK_REDELIVERY_APP_CLIENT_ID` and the
`SLACK_REDELIVERY_APP_PRIVATE_KEY` PEM to this controller. Its only optional
permission is organization `Webhooks: read and write`; GitHub's mandatory
`Metadata: read` remains, while its own webhook, OAuth user authorization and
all other optional permissions are disabled. Manual audit tokens are downscoped
to read, while scheduled or explicitly requested recovery tokens are downscoped
to write and revoked after the job. The built-in `GITHUB_TOKEN` grants only
`actions: read` and `contents: read`; no repository variable is mutated.

## Official references

- [Using GitHub in Slack](https://docs.github.com/en/integrations/how-tos/slack/use-github-in-slack)
- [GitHub webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
- [GitHub webhook signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [GitHub organization webhook redelivery](https://docs.github.com/en/webhooks/using-webhooks/automatically-redelivering-failed-deliveries-for-an-organization-webhook)
- [Authenticating with a GitHub App in Actions](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/making-authenticated-api-requests-with-a-github-app-in-a-github-actions-workflow)
- [Slack Deno workflows](https://docs.slack.dev/tools/deno-slack-sdk/guides/creating-workflows/)
- [Slack custom functions](https://docs.slack.dev/tools/deno-slack-sdk/guides/creating-custom-functions/)
- [Slack webhook triggers](https://docs.slack.dev/tools/deno-slack-sdk/guides/creating-webhook-triggers/)
- [Slack app environment variables](https://docs.slack.dev/tools/deno-slack-sdk/guides/using-environment-variables/)
- [Slack app activity logging](https://docs.slack.dev/tools/deno-slack-sdk/guides/logging-function-and-app-behavior/)
- [`apps.activities.list`](https://docs.slack.dev/reference/methods/apps.activities.list/)
- [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Cloudflare Secrets Store bindings](https://developers.cloudflare.com/secrets-store/integrations/workers/)
- [Cloudflare Queues dead-letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
