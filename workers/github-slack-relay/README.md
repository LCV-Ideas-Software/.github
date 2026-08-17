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

**ADR-002 (16/08/2026): um destino só — `alerts` — e OITO eventos.** Os
eventos de atividade saíram da allowlist de propósito: o app oficial
"GitHub for Slack" os cobre no `#github-activity`, e este Worker entrega
exclusivamente o que o oficial não sabe entregar. Um evento fora da lista
morre no ingress com `event_not_supported` (202), sem linha e sem
publicação. A webhook payload cannot supply a Slack channel, destination or
trigger URL.

| Evento aceito | Condição |
| --- | --- |
| `workflow_run` | conclusão em `action_required`, `cancelled`, `failure`, `stale`, `startup_failure`, `timed_out`; exclui, por **repositório+caminho**, o vigia e o deploy do relay |
| `dependabot_alert` | ações de ciclo de vida relevantes |
| `code_scanning_alert` | ações de ciclo de vida relevantes |
| `secret_scanning_alert` | ações de ciclo de vida relevantes |
| `repository_advisory` | `published`, `reported` |
| `security_and_analysis` | presença do registro `changes` (o evento não tem `action`) |
| `secret_scanning_alert_location` | `created` |
| `secret_scanning_scan` | `completed` |

`security_advisory` (o feed global) **não** entra: a disponibilidade
documentada é `app` — webhook de organização não o recebe. Repositórios
arquivados ou fora de `LCV-Ideas-Software` não são aceitos. Os
normalizadores dos eventos de atividade permanecem no código como legado
declarado, inalcançáveis pela allowlist.

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
- the current durable D1 `relay_attempt`;
- an epoch-second `relay_timestamp`;
- a lowercase HMAC-SHA256 `relay_signature`.

The signature input is exactly this UTF-8 JSON string, preserving field order
and JavaScript JSON escaping:

```text
JSON.stringify([source,severity,repository,title,details,actor,branch,url,occurred_at,delivery_id,event,action,destination,relay_attempt,relay_timestamp])
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
| `relay_attempt`   | Current durable D1 dispatch-attempt number.          |
| `relay_timestamp` | Epoch seconds at dispatch time.                      |
| `relay_signature` | HMAC-SHA256 over the canonical fields.               |

HTTP 2xx plus JSON `ok: true` moves the D1 row only to
`accepted_by_trigger`. That state is nonterminal and is never treated as proof
of a channel message. Before `SendMessage`, the Slack workflow records an
authenticated `send_started` boundary. After `SendMessage`, it posts an
idempotent HMAC receipt containing the `delivery_id`, fixed destination and
Slack `message_context.message_ts`; only that receipt moves the row to
`delivered`.
The send-boundary callback also binds the signed relay attempt to exactly one Slack
`function_execution_id`. The owning execution may idempotently confirm a lost
response; a competing workflow execution receives no message and cannot cross
`SendMessage`.
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
| Alerts DLQ     | removida da configuração (ADR-002 decisão 8); o recurso na Cloudflare pende de exclusão (§12) |
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
uses it for progress, reconciliation and monitor signatures. The old hosted current remains
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
later make it retryable only with an authenticated failure of the signed
validator step and no successful send boundary.
Primary Queue exhaustion moves a nonambiguous record to its destination DLQ;
an ambiguous `sending` record never becomes retryable merely because it aged.

The GitHub-to-Queue leg is intentionally at-least-once. Once Slack accepts a
trigger, the Queue message is acknowledged but the D1 row remains
nonterminal. Neither the Queue consumer nor the scheduled recovery loop resends
`accepted_by_trigger` or `send_started`: the asynchronous Slack workflow may
already have reached `SendMessage`. A complete Slack trace can return an
`accepted_by_trigger` row to `pending` only when it contains explicit proof that
the signed validator step failed and no successful send boundary exists. A
persisted `send_started` row always dominates a stale pre-send claim and becomes
`manual_review`; a missing boundary event or an Activities `Error` from the
send-boundary callback is not proof. Every other ambiguity becomes
`manual_review`.

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
4. when the production gate is enabled, proves migrations `0001` through `0009`
   and the seal guards in an owned disposable remote D1, and cleans it up;
5. applies production D1 migrations, then requires the exact sealed historical
   `e0131a7/0005` protocol anchor, all three permanent guards, no transient
   activation guards and no duplicate execution owners;
6. stages Cloudflare runtime `NEXT` and deploys the verified Worker revision
   with active slot `next`;
7. in a dependent job on the same SHA, proves the `slack-production` signer
   against the deployed relay before any Slack mutation, stages Slack runtime
   `NEXT`, deploys the Slack app and verifies the protected triggers.

Migration `0004_confirm_slack_delivery.sql` started the receipt-aware delivery
protocol closed. Migration `0005_reconcile_live_slack_receipts.sql` added live
Activities receipt correlation and permitted exactly one transition from the
deployed `afe525/0004` contract to the reviewed target `0005` contract.
Migration `0006_seal_slack_delivery_protocol.sql` accepts only the exact live
target tuple, changes only `confirmation_open` from `1` to `0`, removes the two
transient activation guards and installs permanent update, insert and delete
guards. Its source and destination assertions are part of the same D1 migration
transaction, so tuple or schema drift aborts before Worker replacement.
Migration `0007_journal_slack_reconciliation_reports.sql` adds exact
authenticated-report replay without inferring historical error receipts.
Migration `0008_resume_bounded_slack_activity_scan.sql` adds one singleton
resume watermark for bounded Slack activity catch-up; its initial value is
`NULL`, so migration does not skip or reclassify historical evidence.
Trace updates stay individually idempotent; novel-error reservation, checkpoint
clamping, scan-state transition and immutable response journaling alone finalize
atomically in one D1 batch. Report journals become eligible for deletion after
24 hours and are removed by the next finalized report, while receipts follow
the trace lifetime.

The Worker reads immutable `WORKER_VERSION.tag`, which the deploy command binds
to the current 40-character `GITHUB_SHA`, as runtime provenance. Delivery
authorization instead requires the historical `e0131a7/0005` tuple to remain
sealed and guarded; later deployed SHAs do not rewrite that audit anchor. An
absent, open, changed or partially guarded anchor keeps Queue and recovery paths
fail-closed. Old-Worker writes to `accepted_by_slack` remain schema-compatible
but the expand quarantine trigger marks them `legacy_unverified = 1`.

After the Worker deploy succeeds, the dependent protected Slack job uses the
same checkout and SHA and first proves its signer against the Worker's read-only
HMAC checkpoint. It then stages Slack `NEXT`, deploys the app, and verifies the
exact two production triggers. There is no final activation call. The temporary
HMAC parser, store mutation, Deno script and `/slack/protocol/activate` route
were removed after the contract was sealed; that path now receives the generic
404 response and no public protocol status, mutation, delivery selector or
recovery capability exists.

It does not create Slack channels, Slack triggers, or the GitHub organization
webhook. Its two fixed-purpose provisioning scripts create or idempotently
rewrite only the runtime `NEXT` signer after proving exact metadata.

Repository variable `SLACK_GITHUB_INTEGRATION_ENABLED` is the fail-closed
production automation gate. Keep it `false` while IDs, secrets, triggers, and
the organization webhook are prepared. Change it to `true` only for the
authorized serialized rollout. The sealed historical anchor remains active
across later runtime revisions. At `true`, the variable permits the relay
deploy, Slack-app deploy, monitor, and organization-webhook redelivery jobs;
the unprivileged `verify` job does not depend on the gate; the remote D1 proof
and production jobs do. Run the real channel
canaries immediately after a material deployment, and return the gate to `false` on any
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
Routine Slack app deployments use `--hide-triggers` and must not implicitly
create, delete or display triggers. The protected workflow then updates each
existing fixed trigger ID from its corresponding versioned definition. It
captures and deletes the CLI response without displaying it because that output
can contain the bearer webhook URL, and it requires the exact two-trigger
inventory before deployment completes.

Compatible input-mapping changes use that protected in-place update. Rotate a
trigger only for exposure, a Slack requirement, or a change that cannot safely
preserve its ID, and only through a controlled overlap:

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
verify only `NEXT`. This expand set the Worker signer and monitor to `next` only
after Cloudflare `NEXT` was staged; its sealed D1 anchor now remains invariant
across Slack app and trigger updates. A
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
protocol has its exact sealed historical anchor and all permanent guards, the `deliveries` schema is
queryable, the `relay_state` singleton contains valid Queue and Slack activity
checkpoints, no row is in `manual_review` or `dead_letter`, and no
current `accepted_by_slack`, `accepted_by_trigger`, or `send_started` row has
exceeded its reconciliation deadline. The configured current and distinct
`NEXT` HMAC bindings, active signer selection, and both Slack
trigger bindings must validate. The v2 alerts path belongs to the same
readiness class: `SLACK_BOT_TOKEN` and `ALERTS_STATUS_SECRET` must be readable
and non-empty, and the `alert_delivery` table must answer the single-statement
snapshot served by `/alerts/status`. The ready reply contains only the boolean
`legacy_unverified`, making quarantined historical debt visible without making
it a readiness failure or exposing a count or identifier. A failed check or
exception returns the same HTTP 503 `unavailable`.

The five-minute scheduled handler:

- deletes only receipt-confirmed `delivered` rows older than 30 days;
- recovers due `pending`, `enqueueing`, `queued`, and `dead_letter` records;
- moves stale `sending` rows to `manual_review` as ambiguous, without resending;
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
at `info` level, follows `response_metadata.next_cursor` for at most 100 pages
per execution, and starts from an authenticated D1 checkpoint with a 20-minute
overlap. If an earlier bounded execution has not caught up, it instead resumes
inclusively from the relay-acknowledged D1 watermark. The monitor never stores
a Slack cursor between scheduled runs because Slack may reject a cursor that is
no longer valid. If more than 100 pages share the exact watermark timestamp,
the monitor remains fail-closed rather than skipping activities. A pending
trace keeps the resume watermark at its start so the next run refetches the
authenticated start together with its terminal suffix. The Worker uses
Cloudflare Smart Placement so reconciliation executes near the D1 primary
instead of paying cross-region latency for every trace. An empty query keeps
its previous evidence boundary (or anchors the initial lower bound); it never
advances to wall-clock time. D1 additionally clamps every proposed advance
behind the earliest nonlegacy live attempt until a trace is correlated. It
retains an earlier trace binding across a retry until authenticated progress
proves the next Slack execution, while every live attempt continues clamping
the watermark. It persists correlated incomplete traces before advancing the
checkpoint and extracts only bounded `delivery_id`, `trace_id`, outcome,
timestamps, the signed relay attempt, the relevant authenticated Slack step
execution ID, the send-boundary flag and the explicit signed-validator-failure
proof bit. A validator-only retry binds its exact attempt to the validator
execution ID and is rejected if a send lease or `send_started` fact exists.
Post-boundary evidence must match the persisted send owner. Thus a competing or
stale trace cannot release or become the correlation for a newer attempt. A delivery is
correlated only after the 15-field relay signature verifies under an available
monitor key or the derived `NEXT` progress authorization verifies, and the
signed relay timestamp is
within the validator's five-minute/60-second window around the Slack step
activity itself. Rejected or replayed trigger inputs are ignored. Raw activities
and private workflow inputs are never sent to D1 or logged. Reports contain at
most 25 normalized traces plus hydration records in total. Trace mutations are
individually idempotent, after which one D1
batch atomically commits novel terminal-error receipts, the clamped checkpoint
and an immutable response journal. Replaying the same signed body after a lost
HTTP response returns exactly the original result; a later overlapping report
cannot announce the same error again. Migration `0007` deliberately infers no
receipt for historical errors: only an authenticated post-migration report
establishes novelty. Per-trace receipts follow their traces. Replay journals
become eligible for deletion after 24 hours and are removed by the next
finalized report. A complete scan clears the resume watermark. A bounded prefix
stores `resume_from_us` as the checkpoint D1 actually committed after clamping,
in the same batch as the final report's normalized traces and journal. Earlier
25-trace chunks each commit in their own atomic D1 batch. The next scheduled
execution therefore cannot replay the normal overlap forever. A response that
does not acknowledge progress fails closed and is never described as a
successful advance. A
terminal error with an authenticated failure of the signed validator step and
no send boundary is the sole automatic resend case. An Activities `Error` from
the send-boundary callback remains ambiguous even when no callback success was
observed: the Worker may have committed the `send_started` CAS before the HTTP
confirmation was lost. That error never authorizes a retry. Only the earlier
validator failure proves that neither the callback nor its dependent
`SendMessage` ran. Success without a receipt, any post-boundary failure, missing
proof, incomplete evidence or a conflicting trace fails closed.

The current checkpoint response advertises `reconciliation_version: 5`, the
nullable `resume_from_us`, and a fair, bounded page of at most 25 pending
`trace_id` values with the total count and global oldest observation. V5 HMACs
bind the scan-state transition, hydration records and the v4 trace evidence.
Each natural run hydrates at most two trace IDs, with at most two cursor pages
per trace; those `apps.activities.list` requests use `trace_id` without temporal
bounds and never persist Slack cursors. Each signed hydration record states
whether that ID was actually fetched; only attempted IDs advance the fairness
timestamp, while newly observed IDs remain first in the pending rotation. Exact
activity deduplication happens before normalization. A pending hydration is durable in D1 and prevents the
activity checkpoint from advancing until the trace normalizes or becomes debt.
The seven-day retention boundary and an exhausted hydration-page bound fail
closed: an owned pending trace moves atomically to `manual_review`, while
unowned debt remains health-blocking without inventing an owner.

A v4 checkpoint remains readable during rollout, but once the v5 Worker is
live every authenticated v4, v3 or v2 report receives
`reconciliation_upgrade_required` without mutating delivery, checkpoint or scan
state. A checkpoint without a version identifies the old v2 Worker during its
earlier rollout. The exact successful two-step workflow topology predating
durable receipts is recognized only for overlap compatibility and is never
adopted as evidence for a current D1 delivery.

Retention is also checkpoint-aware: a receipt-confirmed row is purged only when
its applied terminal trace predates both the 30-day cutoff and the durable
activity checkpoint minus the 20-minute overlap. That trace may be successful,
or may be a boundary-confirmed error after the delivery receipt committed but
its response was lost. A still-queryable Slack trace therefore cannot outlive
the D1 delivery correlation it names.

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
activation ID and schema revision. Migration
`0005_reconcile_live_slack_receipts.sql` replaces that trigger with the
source-pinned `afe525/0004` to target `0005` bridge and retains the one-way
confirmation trigger. Migration `0006_seal_slack_delivery_protocol.sql`
validated the exact resulting tuple, closed confirmation irreversibly, removed
both transient guards and installed permanent update, insert and delete guards.
Migration `0007_journal_slack_reconciliation_reports.sql` then added the
bounded reconciliation journal without fabricating historical error receipts
or changing the sealed activation tuple. Migration
`0008_resume_bounded_slack_activity_scan.sql` then added the nullable singleton
resume watermark without changing that tuple or existing checkpoints. Migration
`0009_track_slack_trace_hydration.sql` adds the pending/debt trace registry and
its fair-scan index without storing raw Slack activities or expiring cursors.
If a successful Slack trace is observed for an ordinary legacy row, D1 may
attach that trace ID but preserves `accepted_by_slack` and
`legacy_unverified = 1`; the trace alone is neither delivery proof nor a reason
to create readiness-blocking manual debt.
The migration places the known missing delivery
`de345e40-95b1-11f1-8d38-fac15f0bb4cd` in `manual_review`. Legacy backfill may
set `delivered` only from positive evidence of exactly one matching channel
message and its Slack timestamp. Zero matches are retryable only with a complete
trace containing an authenticated signed-validator failure and no successful
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
- [Slack cursor pagination](https://docs.slack.dev/apis/web-api/pagination/)
- [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Cloudflare Secrets Store bindings](https://developers.cloudflare.com/secrets-store/integrations/workers/)
- [Cloudflare Queues dead-letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [Cloudflare Smart Placement](https://developers.cloudflare.com/workers/configuration/placement/)
