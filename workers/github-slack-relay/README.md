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
validator accepts `SLACK_RELAY_SIGNING_SECRET` and, only during a controlled
zero-loss rotation, optional `SLACK_RELAY_SIGNING_SECRET_NEXT`.

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

The Worker accepts a Slack trigger delivery only after both HTTP 2xx and a JSON
response containing `ok: true`. D1 then moves the row to
`accepted_by_slack`. This state proves only that Slack accepted the trigger. It
does not prove that the Deno authentication function or downstream
`SendMessage` step completed. Require a real channel message and a successful
Slack activity trace for canaries and incident closure.

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

Four Secrets Store secrets are required:

| Worker binding                        | Secret name                          |
| ------------------------------------- | ------------------------------------ |
| `GITHUB_WEBHOOK_SECRET`               | `github-slack-alerts-webhook-secret` |
| `SLACK_ALERTS_WORKFLOW_WEBHOOK_URL`   | `github-slack-alerts-workflow-url`   |
| `SLACK_ACTIVITY_WORKFLOW_WEBHOOK_URL` | `github-slack-activity-workflow-url` |
| `SLACK_RELAY_SIGNING_SECRET`          | `github-slack-relay-signing-secret`  |

The relay-signing value must match Slack app environment
`SLACK_RELAY_SIGNING_SECRET`. During a rotation, Slack temporarily also stores
the staged value in `SLACK_RELAY_SIGNING_SECRET_NEXT`; this does not add a fifth
Cloudflare secret.

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
use bounded exponential backoff. Primary Queue exhaustion moves the record to
its destination DLQ; the DLQ consumer persists `dead_letter` before
acknowledging the Queue message.

The system is intentionally at-least-once. D1 prevents normal duplicate GitHub
deliveries, but a crash after Slack returns `ok: true` and before D1 commits
`accepted_by_slack` can cause a duplicate Deno workflow execution. The visible
`delivery_id` is the correlation key.

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

1. verifies the webhook redelivery controller and Worker;
2. checks dependency signatures and advisories;
3. verifies committed bindings, type-checks, runs tests, and creates a strict
   dry-run bundle;
4. applies remote D1 migrations;
5. deploys the verified Worker revision.

It does not create Slack channels, Slack triggers, Secrets Store values, or the
GitHub organization webhook.

Repository variable `SLACK_GITHUB_INTEGRATION_ENABLED` is the fail-closed
production automation gate. Keep it `false` throughout bootstrap while IDs,
secrets, triggers, D1 migrations, both real channel canaries, and the
organization webhook are established. Change it to `true` only after all those
checks pass. At `true`, it permits the relay deploy, Slack-app deploy and
monitor, and organization-webhook redelivery jobs; their verification jobs do
not depend on the gate. The variable does not disable an already deployed
Worker or webhook.

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

## Zero-loss HMAC rotation

Rotate the downstream relay-signing key independently from trigger URLs:

1. Generate the new value without logging it.
2. Set Slack app environment `SLACK_RELAY_SIGNING_SECRET_NEXT` to the new value;
   keep `SLACK_RELAY_SIGNING_SECRET` unchanged, then redeploy the Slack app.
   Do not treat an `env set` change as active in the hosted function until the
   deployment completes.
3. Atomically update Cloudflare secret `github-slack-relay-signing-secret` to
   the new value through the interactive Secrets Store prompt. New dispatches
   now use the new key while Slack accepts old and new signatures.
4. Wait at least five minutes and drain or account for both primary Queues.
5. Run real canaries and require channel messages plus clean Slack activity
   traces. D1 `accepted_by_slack` is not sufficient.
6. Promote the new value to Slack `SLACK_RELAY_SIGNING_SECRET`, remove
   `SLACK_RELAY_SIGNING_SECRET_NEXT`, redeploy the Slack app, and repeat the
   canaries.

Never remove the old validator before the Queue drain and never remove `NEXT`
before the post-cutover canaries succeed.

## Operations and recovery

`GET /healthz` returns HTTP 200 `ready` only when the `deliveries` schema is
queryable, the `relay_state` singleton exists with a valid integer timestamp,
no row is in `manual_review`, both HMAC secrets meet the minimum length, and
both Slack trigger bindings contain structurally valid URLs. A failed check or
exception returns the same generic HTTP 503 `unavailable`. The endpoint does
not expose counts, payloads, resource identifiers, Queue state, binding values,
or secret metadata. Worker logs contain aggregate recovery counters and generic
failure categories, never request bodies, HMACs, or trigger URLs.

The five-minute scheduled handler:

- deletes `accepted_by_slack` rows older than 30 days;
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
with Slack's documented URL-encoded request format and fails on recent workflow
errors. Its complete response remains private; only a validated Slack error
code can reach the job log. The same check can be dispatched with
`operation: monitor`. For interactive diagnosis, use
`slack activity` against the deployed app. Slack activity payloads may contain
private workflow inputs, so CI withholds raw API responses.

GitHub itself does not automatically retry organization webhook failures. The
scheduled `GitHub Slack Webhook Redelivery` workflow checks every 15 minutes,
first verifies the sole active exact organization hook through GET requests
only, groups attempts by GUID, accepts GitHub's documented HTTP 200-399 success
classification, and redelivers unresolved attempts within the three-day
retention window. It never sends a scheduled ping. Its checkpoint advances only
after the complete run succeeds. Pagination accepts only the exact named and
numeric canonical paths for the configured organization and hook, and
reconstructs each request from the returned cursor instead of following a
`Link` URL blindly.

The controller reads the hook ID from repository variable
`SLACK_RELAY_ORG_HOOK_ID`, stores its epoch-millisecond checkpoint in repository
variable `SLACK_RELAY_LAST_REDELIVERY`, and authenticates with
`LCV_AUTOMATION_TOKEN` from the protected `cloudflare-production` environment.
That classic PAT needs `admin:org_hook`, repository access, and an active SAML
SSO authorization for `LCV-Ideas-Software`. Regenerating it or changing its
scopes requires a fresh **Configure SSO** authorization; replacing the
environment secret alone does not restore organization access.

## Official references

- [Using GitHub in Slack](https://docs.github.com/en/integrations/how-tos/slack/use-github-in-slack)
- [GitHub webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
- [GitHub webhook signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [GitHub organization webhook redelivery](https://docs.github.com/en/webhooks/using-webhooks/automatically-redelivering-failed-deliveries-for-an-organization-webhook)
- [Authorizing a personal access token for use with SSO](https://docs.github.com/en/enterprise-cloud@latest/authentication/authenticating-with-single-sign-on/authorizing-a-personal-access-token-for-use-with-single-sign-on)
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
