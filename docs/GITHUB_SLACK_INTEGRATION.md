# GitHub and Slack integration

This document is the source of truth for the LCV Ideas & Software
GitHub-to-Slack integration. The system is code-controlled, uses two private
channels, and separates routine repository activity from actionable failures
and security events.

## Operating model

| Component                        | Responsibility                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Official GitHub app for Slack    | Remains installed for GitHub link unfurls, account-linked mentions, and commands explicitly invoked by the operator. It is not the automated organization activity feed. |
| GitHub organization webhook      | Emits the selected organization-wide event families for current and future repositories.                                                                                 |
| Cloudflare relay                 | Authenticates GitHub, normalizes and sanitizes events, persists delivery state, and routes records through destination-specific queues.                                  |
| Source-controlled Slack Deno app | Authenticates relay records again, formats them, and posts them to the fixed private channel for that destination.                                                       |
| GitHub Actions                   | Verifies and deploys both applications, monitors Slack workflow activity, and recovers failed GitHub webhook deliveries.                                                 |

The official GitHub app is deliberately not subscribed to repositories for the
automated feed. GitHub documents repository subscriptions only through
interactive `/github subscribe` commands in Slack; neither GitHub nor Slack
publishes a supported API for managing those app-owned subscriptions. Slack
also defines slash commands as user invocations submitted from the message
composer. Sending text such as `/github subscribe ...` through `chat.postMessage`
or another messaging API creates an ordinary message and does not invoke the
command. Automation must never pretend otherwise.

If a historical native subscription is suspected, the operator can inspect it
interactively with `/github subscribe list` in the affected channel and remove
it with the documented `/github unsubscribe` command. This is an exceptional
cleanup action, not part of deployment. See [Using GitHub in Slack][github-slack]
and [Implementing slash commands][slack-slash-commands].

## End-to-end architecture

```text
GitHub organization webhook
  -> POST /github/webhook
  -> verify GitHub HMAC, organization, repository and event
  -> normalize and sanitize; persist a D1 inbox row
  -> github-slack-activity OR github-slack-alerts Queue
  -> destination Slack webhook trigger
  -> Deno custom function verifies downstream HMAC, destination and freshness
  -> Slack SendMessage function
  -> private #github-activity OR private #github-alerts
```

There is no manually assembled Slack workflow. The two workflows, their custom
authentication function, and both webhook-trigger definitions live under
`slack/github-integration/` and are deployed as the Slack-hosted app
`LCV GitHub integration`.

The two destinations are fixed in code and cannot be selected by a GitHub
payload:

| Destination | Private channel    | Routed events                                                                                                                                                                              |
| ----------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `activity`  | `#github-activity` | Default-branch pushes; pull requests; pull-request reviews and review comments; issues and issue comments; releases; discussions and discussion comments; successful/inactive deployments. |
| `alerts`    | `#github-alerts`   | Problematic completed Actions workflows; error/failure deployments; Dependabot, code-scanning, and secret-scanning alert lifecycle events, including resolution and reopening events.      |

Archived repositories, repositories outside `LCV-Ideas-Software`, unsupported
actions, successful workflows, transient deployment states, and
non-default-branch pushes are acknowledged without being queued. For
`deployment_status`, `error` and `failure` route to alerts, `success` and
`inactive` route to activity, and all other states are ignored. Discussion
events are intentionally included in the organization webhook and activity
route.

## Trust boundaries

### GitHub to Cloudflare

- `POST /github/webhook` is the only ingestion route.
- `X-Hub-Signature-256` is verified with the GitHub webhook secret before JSON
  parsing.
- The body is bounded to GitHub's documented 25 MB webhook ceiling.
- Organization ownership, repository ownership, archived state, event name and
  relevant lifecycle action are validated before persistence.
- Raw payloads are never stored. Secret values and locations, code-scanning
  locations, comment bodies, review bodies, diffs, commit messages and author
  email addresses are omitted.
- D1 uses `X-GitHub-Delivery` as the durable deduplication key.

### Cloudflare to Slack

Possession of a Slack trigger URL is not sufficient to forge a channel message.
Immediately before each POST, the relay adds a fixed `destination`, an
epoch-second `relay_timestamp`, and an HMAC-SHA256 `relay_signature` over the
canonical flat fields. The first step of each Deno workflow validates:

1. the HMAC with `SLACK_RELAY_SIGNING_SECRET`;
2. the expected destination for that trigger;
3. a five-minute freshness window with at most 60 seconds of future clock skew;
4. the final link as HTTPS on `github.com`.

Only then does the coded workflow call Slack's `SendMessage` function. The
active signing value exists in two encrypted locations: Cloudflare Secrets
Store and `SLACK_RELAY_SIGNING_SECRET` in the deployed Slack app environment.
During a controlled zero-loss rotation, Slack may also hold the optional
`SLACK_RELAY_SIGNING_SECRET_NEXT`. Neither value is ever committed.

### Human-facing date and time

The Worker preserves the source timestamp as ISO 8601 in `occurred_at`, and
that exact technical value remains part of the HMAC input. After successful
authentication, the Slack app alone renders it as `dd/MM/aaaa às HH:mm:ss`,
using `Intl.DateTimeFormat` with locale `pt-BR` and fixed IANA zone
`Etc/GMT+3`. The POSIX/IANA sign convention is inverted, so `+3` means
UTC−03:00. The technical timezone suffix is deliberately omitted from the
user-facing text. Invalid, ambiguous or absent values become
`Data e hora do evento: não informadas` and are never echoed.

The app deliberately does not use Slack's `<!date>` syntax because Slack
renders that syntax in each viewer device's timezone. The native timestamp that
Slack displays beside a message remains controlled by Slack and is not modified
by the integration. See [Slack message date formatting][slack-date-formatting]
and the [IANA time-zone database overview][iana-time-zones].

## Cloudflare resources

| Resource        | Name or identifier                                                |
| --------------- | ----------------------------------------------------------------- |
| Worker          | `github-slack-alerts`                                             |
| Public receiver | `https://github-slack-alerts.lcv.workers.dev/github/webhook`      |
| D1 database     | `github-slack-alerts-db` / `cf070eb0-32d9-4ee0-9516-d469833cdc77` |
| Alerts Queue    | `github-slack-alerts`                                             |
| Alerts DLQ      | `github-slack-alerts-dlq`                                         |
| Activity Queue  | `github-slack-activity`                                           |
| Activity DLQ    | `github-slack-activity-dlq`                                       |
| Secrets Store   | `df90c0935ba1460899c3c2c457548a90`                                |

The public receiver is an explicit exception for external GitHub ingress, not
a Worker-to-Worker transport. GitHub cannot invoke a Cloudflare Service
Binding. The Worker keeps its single production `workers.dev` route, disables
all versioned and aliased preview URLs, and uses only direct Cloudflare
bindings for D1, Queues, and Secrets Store. Relay source must never call an
intra-Cloudflare application through `workers.dev` or `pages.dev`.

Four Secrets Store entries are bound to the Worker:

| Binding                               | Secret name                          | Purpose                                  |
| ------------------------------------- | ------------------------------------ | ---------------------------------------- |
| `GITHUB_WEBHOOK_SECRET`               | `github-slack-alerts-webhook-secret` | Authenticate GitHub deliveries.          |
| `SLACK_ALERTS_WORKFLOW_WEBHOOK_URL`   | `github-slack-alerts-workflow-url`   | Invoke the alerts trigger.               |
| `SLACK_ACTIVITY_WORKFLOW_WEBHOOK_URL` | `github-slack-activity-workflow-url` | Invoke the activity trigger.             |
| `SLACK_RELAY_SIGNING_SECRET`          | `github-slack-relay-signing-secret`  | Authenticate relay records inside Slack. |

The two trigger URLs are bearer credentials. They must be entered through an
interactive prompt, never through `--value`, a repository file, a GitHub
variable, command output, or a log.

## Source-controlled Slack app

The Deno app has these stable components:

- `workflows/github_activity.ts` posts authenticated activity to the immutable
  ID of private `#github-activity`;
- `workflows/github_alert.ts` posts authenticated alerts to the immutable ID of
  private `#github-alerts`;
- `functions/validate_relay_message.ts` verifies HMAC, destination, freshness
  and URL, then emits bounded Slack mrkdwn;
- `triggers/github_activity_webhook.ts` and
  `triggers/github_alert_webhook.ts` define the two webhook triggers;
- `manifest.ts` imports both workflows and contains exactly `chat:write`,
  `chat:write.public`, and `channels:read`. Slack's live manifest validator
  requires that set for the built-in `send_message` function, including when
  both fixed destinations are private and the app is already a member. Exact
  channel IDs, trigger mappings, HMAC/destination/freshness validation, and
  CODEOWNERS compensate for the broader built-in scope; channel-provisioning
  scopes and discovery code remain absent.

The production Slack identities are fixed and must not be replaced by names or
newly discovered resources during deployment:

| Slack resource             | Production ID |
| -------------------------- | ------------- |
| `LCV GitHub integration`   | `A0BMWBGES20` |
| Private `#github-activity` | `C0BMQMW3L4E` |
| Private `#github-alerts`   | `C0BMUK793NV` |

Repository variables retain the non-secret production inventory:
`SLACK_GITHUB_INTEGRATION_APP_ID`, `SLACK_WORKSPACE_ID`,
`SLACK_GITHUB_ACTIVITY_TRIGGER_ID`, and `SLACK_GITHUB_ALERT_TRIGGER_ID`. The
trigger URLs are bearer credentials and must never be stored in those
variables.

During one-time bootstrap, the two private channels are created and their
immutable IDs are inserted into the workflow source. Any temporary bootstrap
manifest with an empty workflow list, channel placeholders, or `groups:write`
must be replaced before production. The `Slack GitHub Integration` workflow
fails closed if any of those bootstrap artifacts remain.

The deployed custom function reads `SLACK_RELAY_SIGNING_SECRET` from Slack's
encrypted app environment. Set it interactively, using the same value stored in
Cloudflare Secrets Store:

```text
slack env set SLACK_RELAY_SIGNING_SECRET \
  --app "$SLACK_APP_ID" \
  --team "$SLACK_WORKSPACE_ID" \
  --token "$SLACK_SERVICE_TOKEN" \
  --skip-update
```

Omit the value so the CLI prompts for it. See [Using environment variables with
the Deno Slack SDK][slack-app-env]. After any `slack env set` or
`slack env unset`, redeploy the app before treating the change as effective.
This ordering is required by Slack's documented setup flow and was also
verified against this app with Slack CLI 4.6.0: a value changed after the prior
deployment was not visible to the hosted function until `slack deploy` ran
again.

The Slack CLI requires Deno for this app. Before reading or changing the hosted
environment, confirm that `deno --version` succeeds in the same shell. Without
Deno on `PATH`, the CLI can fall back to local behavior and misleadingly report
zero variables even while the remote app still has its encrypted value. Verify
the remote state with the explicit production app and workspace IDs and expect
exactly `SLACK_RELAY_SIGNING_SECRET`; `SLACK_RELAY_SIGNING_SECRET_NEXT` is valid
only during a documented rotation and `SLACK_DEBUG` must remain absent. Never
create a plaintext `.env` for production credentials.

## Trigger lifecycle

Webhook triggers are infrastructure credentials, not deployment artifacts.
Slack describes CLI-defined triggers as static triggers that are created once.
The production policy is therefore:

1. Deploy the final Slack app and workflows.
2. Create exactly one production trigger for each checked-in definition:

   ```text
   slack trigger create \
     --trigger-def triggers/github_activity_webhook.ts \
     --app "$SLACK_APP_ID" \
     --team "$SLACK_WORKSPACE_ID" \
     --token "$SLACK_SERVICE_TOKEN" \
     --skip-update

   slack trigger create \
     --trigger-def triggers/github_alert_webhook.ts \
     --app "$SLACK_APP_ID" \
     --team "$SLACK_WORKSPACE_ID" \
     --token "$SLACK_SERVICE_TOKEN" \
     --skip-update
   ```

3. Store each non-secret trigger ID in the repository variables
   `SLACK_GITHUB_ACTIVITY_TRIGGER_ID` and `SLACK_GITHUB_ALERT_TRIGGER_ID`.
4. Enter each returned trigger URL directly into its Cloudflare Secrets Store
   entry through an interactive prompt.
5. Verify a signed event through each destination before activation is
   considered complete.

Normal `slack deploy` runs must not create, update, delete or print triggers.
The workflow uses `--hide-triggers`, so source deployment updates function and
workflow code while the two production URLs remain stable. Do not run
`slack trigger update` on every deployment.

### Controlled trigger rotation

Rotate a trigger only for suspected exposure, an explicit Slack requirement,
or an intentional incompatible trigger-definition change. Rotate one
destination at a time:

1. Create the replacement trigger while the old trigger remains valid.
2. Locate the existing Cloudflare secret ID with a metadata-only Secrets Store
   listing.
3. Atomically replace that secret's value through Wrangler's interactive
   prompt; never pass `--value`:

   ```text
   wrangler secrets-store secret update \
     df90c0935ba1460899c3c2c457548a90 \
     --secret-id <existing-secret-id> \
     --scopes workers \
     --remote
   ```

4. Generate one controlled GitHub event for that destination. Confirm the
   channel message, D1 `accepted_by_slack` state, and clean Slack activity log.
5. Delete the old Slack trigger only after the new path is verified. If
   verification fails, atomically restore the old URL while it still exists.

This sequence avoids a no-trigger window and prevents trigger churn during
routine app deployments. See [Creating webhook triggers][slack-webhook-trigger]
and the [Slack CLI trigger reference][slack-trigger].

### Zero-loss relay HMAC rotation

The Slack validator accepts signatures made with the current
`SLACK_RELAY_SIGNING_SECRET` and, only while a rotation is staged, the optional
`SLACK_RELAY_SIGNING_SECRET_NEXT`. Rotate without dropping queued or in-flight
records:

1. Generate a new high-entropy value without printing or committing it.
2. Set `SLACK_RELAY_SIGNING_SECRET_NEXT` to the new value in the deployed Slack
   app. Keep the current value unchanged, then run `slack deploy` and verify
   that the deployment completed before changing the Worker signer.
3. Atomically update Cloudflare secret `github-slack-relay-signing-secret` to
   the new value through the interactive Secrets Store prompt. From this point,
   newly dispatched records use the new signer while Slack accepts both keys.
4. Wait at least five minutes and confirm that both primary queues are drained
   or that all older work has completed.
5. Generate a real canary event for each affected destination. Require both the
   actual channel message and a successful Slack activity trace. A trigger
   acknowledgement and D1 `accepted_by_slack` alone do not prove that
   `SendMessage` completed.
6. Promote the new value into Slack `SLACK_RELAY_SIGNING_SECRET`, remove
   `SLACK_RELAY_SIGNING_SECRET_NEXT` with `slack env unset`, and run
   `slack deploy` again. An environment mutation alone is not a completed
   cutover for the hosted runtime.
7. Run another real canary and recheck Queue, DLQ, D1 and Slack activity state.

Never replace the Slack current key before staging and deploying `NEXT`, never
remove `NEXT` before the drain and canary, and never enable the GitHub
organization webhook until the initial end-to-end canaries have proved both
channel paths.

## Deployment order

### One-time activation

1. Create repository variable `SLACK_GITHUB_INTEGRATION_ENABLED` with value
   `false`. This keeps production deployment, monitoring, and redelivery jobs
   fail-closed while bootstrap is incomplete; verification jobs remain usable.
2. Create private `#github-activity` and `#github-alerts`; verify their IDs are
   `C0BMQMW3L4E` and `C0BMUK793NV` respectively and ensure the Deno app can post
   to both.
3. Finalize and verify the source-controlled Slack manifest, workflows,
   triggers and channel IDs with `deno task --frozen check`.
4. Store `SLACK_SERVICE_TOKEN` as a secret in the protected
   `slack-production` environment and `SLACK_GITHUB_INTEGRATION_APP_ID` plus
   `SLACK_WORKSPACE_ID` as repository variables. Set the app variable to
   `A0BMWBGES20`. Slack service tokens are long-lived and non-rotatable; revoke
   and replace the token immediately if it is exposed.
5. Deploy the Slack app, set its signing-secret environment value, then create
   the two production triggers exactly once.
6. Create the four remote Secrets Store entries interactively. The HMAC values
   must match their GitHub and Slack counterparts respectively.
7. Apply D1 migrations and deploy the Cloudflare relay only after all checks
   pass.
8. Run signed real canaries against both Slack triggers and require the actual
   channel messages plus clean Slack activity traces. A successful trigger POST
   is insufficient.
9. Store the GitHub webhook HMAC value in Cloudflare Secrets Store. Do not keep
   a second Actions copy: no workflow is authorized to configure or mutate the
   organization webhook. Keep the organization webhook inactive while the
   Cloudflare secret is being changed.
10. Register the private organization-owned GitHub App
    `lcv-slack-webhook-recovery`, disable its own webhook and OAuth user
    authorization, and grant only organization `Webhooks: read and write`.
    Leave every optional repository permission at `No access`; GitHub's
    mandatory `Metadata: read` remains. Install the App on
    `LCV-Ideas-Software`, restricted to the `.github` repository, and store its
    Client ID as environment variable `SLACK_REDELIVERY_APP_CLIENT_ID` plus its
    generated PEM as environment secret `SLACK_REDELIVERY_APP_PRIVATE_KEY` in
    protected environment `cloudflare-production`. No App ID or client secret
    is used. The workflow restricts the installation token to the current
    repository and validates the exact App slug and a positive installation ID
    before use.
11. Under an explicitly authorized human maintenance window, configure exactly
    one App-owned organization webhook with the official REST API and an
    installation token minted for `lcv-slack-webhook-recovery`. Do not create it
    through the settings UI, a PAT, an OAuth token, or another App: creator
    boundaries can make that hook invisible to the installation token used by
    audit and recovery. If a legacy user-owned hook exists, first set the
    production gate to `false`, deactivate it with its owning credential, and
    create the replacement inactive with `POST /orgs/{org}/hooks` using the
    dedicated App installation token. Target `<worker-url>/github/webhook`,
    require JSON and TLS verification, and select exactly these events: workflow
    runs, deployment statuses, Dependabot, code-scanning and secret-scanning
    alerts, pushes, pull requests, pull-request reviews and comments, issues and
    comments, releases, discussions, and discussion comments. No GitHub Actions
    workflow may create, update, activate, deactivate, delete, or ping an
    organization webhook.
12. Store the resulting positive numeric hook ID as repository variable
    `SLACK_RELAY_ORG_HOOK_ID`. Keep the hook inactive until the GitHub and
    Cloudflare copies of the HMAC secret and every downstream binding are
    verified.
13. Set `SLACK_GITHUB_INTEGRATION_ENABLED=false`. On a verified `main`, enable
    `GitHub Slack Webhook Redelivery` if it is disabled, and confirm that a
    previously successful scheduled recovery remains inside the three-day
    GitHub delivery-retention window with the controller's safety margin. If no
    such run exists, stop for human reconciliation; never invent or seed a
    checkpoint. Keeping the gate false prevents a scheduled recovery from
    running before the read-only audit.
14. The authorized human activates the replacement through the official REST
    API with a token from the same dedicated App installation, then immediately dispatches
    `GitHub Slack Webhook Redelivery` with its default `audit` operation. Its
    GET-only audit works while the production gate is false, mints an
    installation token downscoped to `Webhooks: read`, and must prove there is
    exactly one installation-visible hook whose ID, active state, URL, JSON
    content type, TLS verification, and complete 14-event set match this
    contract. A 404 or ambiguous inventory stops the rollout; return the hook to
    inactive and do not recreate or mutate it from Actions.
15. Change `SLACK_GITHUB_INTEGRATION_ENABLED` from `false` to `true`, explicitly
    dispatch the `redeliver` operation, then run the
    redelivery, relay, and Slack-app workflows and confirm their scheduled jobs
    are no longer skipped by the gate.
16. A healthy control-plane audit does not prove delivery. Run real issue and
    failed-workflow canaries and require correlated GitHub delivery, Worker,
    D1, Slack activity, and private-channel evidence for both destinations.

If any check fails after activation, immediately return the gate to `false` and
have the authorized human deactivate the replacement with the same App
installation credential. If rollback is required, reactivate the preserved
legacy hook only with its owning human credential. Never leave both hooks active
or partially verified live ingestion enabled. Delete the legacy hook only after
the App-owned replacement and both delivery destinations are proven.

The gate controls the production jobs in GitHub Actions; it does not disable an
already deployed Worker or the GitHub organization webhook. Disabling live
ingestion therefore requires an intentional webhook action as well.

### Continuous deployment

- `.github/workflows/slack-github-integration.yml` checks formatting, lint,
  types, tests and every low-or-higher dependency advisory, then deploys the
  Deno app from `main` with the current Slack CLI and the service token when
  `SLACK_GITHUB_INTEGRATION_ENABLED` is `true`. A separate daily schedule at
  07h17 repeats the dependency and latest-hook audit without deploying or
  running the 15-minute production monitor. It does not recreate triggers.
  After deployment, the official Slack CLI verifies both protected trigger IDs
  against the exact app and workspace. It streams the structured
  `workflows.triggers.list` response directly into a bounded fail-closed
  validator, which requires exactly the two protected IDs, webhook types,
  workflow callback IDs, app ownership, names and 15 input mappings. The
  response is never logged or stored because it contains bearer URLs.
- `.github/workflows/github-slack-integration.yml` verifies the recovery
  controller and Worker, applies D1 migrations, and deploys the relay from
  `main` when the same gate is `true`.
- `.github/workflows/github-slack-webhook-redelivery.yml` runs its scheduled or
  manually dispatched recovery only while the same gate is `true`. Its default
  manual `audit` operation remains available while the gate is false so the
  control plane can be proven before activation. Every run first audits the sole
  active exact organization hook with GET requests; it never sends a periodic
  ping.
- `.github/workflows/slack-github-integration.yml` accepts the manual
  `operation: monitor` input to run the same production activity check on
  demand; its default manual operation remains `deploy`.
- `scripts/github-slack-hook-audit.mjs`, invoked by redelivery, is deliberately
  GET-only. It proves the GitHub-App-installation-visible organization-hook inventory and exact
  target contract without accepting a webhook secret or exposing any mutation
  method. Organization-hook configuration and state changes remain native,
  explicit human operations outside GitHub Actions.
- Pull requests run verification only. Production deployment requires a push to
  `main` or an explicit dispatch on `main`.

Slack's official guidance for these mechanisms is available in [Deploying to
Slack][slack-deploy], [Slack CLI CI/CD authorization][slack-cli-auth], and
[Creating workflows][slack-workflows].

The latest upstream `deno_slack_hooks@1.5.0` transitively pins
`esbuild@0.24.2`. Its moderate `GHSA-67mh-4wv8-2f99` development-server
advisory is temporarily accepted because the exact reviewed hook source calls
only `build()` and `stop()`; the affected server is not reachable. The audit
script fails closed unless this is the sole low-or-higher advisory and the hook
is still the latest stable GitHub release, with the exact tag, annotated-tag
object, commit
`b6719c18a18a39ca44fa1b311c3bada28dc3df35`, source lock hash, package
integrity, and call set all remain exact. The code-level deadline is
`2026-11-01T00:00:00Z`, which is 31/10/2026 às 21:00:00 in the program's fixed
UTC−03:00 timezone. The exception must be removed sooner if Slack publishes a
fixed hook. Deploys do not use the Slack CLI's broad `--force` warning
override.

Wrangler is an exact development dependency in the relay manifest and lockfile.
CI requires npm's effective registry to remain the official
`https://registry.npmjs.org/` default before installing that reviewed graph
with `npm ci`, verifies registry signatures, and fails on any low-or-higher
advisory. Dependabot checks the npm ecosystem daily; a Wrangler update must
include its lockfile and regenerated `worker-configuration.d.ts`, then pass
this same deterministic verification before merge.

CI uses Wrangler's native `types --check` contract for the committed bindings
and strict deployment mode so an unexpected remote configuration change blocks
publication for human review.

## Delivery state, monitoring and recovery

The relay is intentionally at-least-once. D1 deduplicates normal repeats, but a
crash after Slack accepts the trigger and before D1 commits the result can
produce a duplicate workflow execution. Keep `delivery_id` visible in every
message for correlation.

`accepted_by_slack` has a deliberately narrow meaning: the trigger POST returned
HTTP 2xx and a JSON body containing `ok: true`. It does not prove that the Deno
custom function validated the message or that the downstream `SendMessage`
step completed. Those outcomes are verified with Slack app activity logs.

`GET /healthz` returns HTTP 200 with the generic status `ready` only when the D1
`deliveries` schema is queryable, the `relay_state` singleton exists with a
valid integer timestamp, no delivery is in `manual_review`, and all four
Secrets Store bindings validate. The two HMAC secrets must meet the minimum
length and both Slack values must be valid trigger URLs. Any failed check or
exception returns the same generic HTTP 503 `unavailable` response without
exposing counts, identifiers, binding values, or secret metadata.

Monitoring and recovery are layered:

- alerts and activity have separate primary Queues and DLQs;
- consumers are serial and share a D1 rate limiter with alerts taking priority;
- the Worker honors `Retry-After`, retries with backoff, and moves exhausted
  Queue attempts through destination-specific DLQs;
- a five-minute Worker cron recovers due or stale D1 states and retains records
  requiring intervention as `manual_review` after 25 successful
  `claimForSlack` dispatch claims. This is a processing-claim ceiling, not a
  guarantee that 25 Slack HTTP POSTs occurred; a claimed cycle can fail while
  reading configuration or generating the signature before any POST;
- accepted rows are retained for 30 days; unresolved and manual-review rows are
  not automatically deleted;
- the scheduled Slack monitor queries `apps.activities.list` every 15 minutes
  with Slack's documented URL-encoded request format and fails if Slack
  recorded workflow errors during the preceding 20 minutes. It never logs the
  activities collection; on an API rejection it emits only a strictly
  validated Slack error code;
- the operator can inspect richer hosted logs with `slack activity`;
- `.github/workflows/github-slack-webhook-redelivery.yml` scans the organization
  webhook every 15 minutes after a GET-only exact-configuration/active-state
  audit, groups attempts by GUID, treats HTTP 200-399 as a successful GitHub
  delivery, and redelivers unresolved attempts within GitHub's three-day
  window;
- the webhook recovery workflow evaluates successful scheduled runs newest
  first and uses the newest candidate whose exact recovery step is proven
  completed and successful. A well-formed run whose job did not execute is not a
  checkpoint; malformed, duplicated or contradictory evidence aborts. A
  15-minute safety margin stays inside GitHub's moving three-day retention
  boundary. The built-in `GITHUB_TOKEN` grants only `actions: read` and
  `contents: read`; no repository variable is written.

GitHub can canonicalize a paginated `/orgs/{name}/...` request into an
`/organizations/{id}/...` URL in the `Link` header. The recovery controller
accepts only those two exact path identities for the configured organization
and hook, keeps `api.github.com` as the mandatory origin, and copies only the
opaque cursor into a newly constructed request URL.

The recovery workflow uses the official, SHA-pinned
`actions/create-github-app-token` action because the built-in `GITHUB_TOKEN`
cannot administer organization webhooks. The dedicated GitHub App has only
organization `Webhooks: read and write`; all other optional permissions, its own
webhook and OAuth user authorization remain disabled. Manual audit tokens are
downscoped to read. Scheduled or explicitly requested recovery tokens are
downscoped to write, last no more than one hour, and are revoked by the action at
job completion. The App Client ID is a protected environment variable and the
PEM is a protected environment secret; neither is copied into the repository.
GitHub's `Webhooks: write` permission also technically permits broader hook
administration because the API has no redelivery-only grant. The dedicated App,
current-repository token restriction, protected `main` environment, exact App
identity check, and reviewed controller compensate for that unavoidable
granularity; the controller exposes no create, update, delete or ping request.

Before the controller's delivery scan, the recovery path uses `GITHUB_TOKEN`
with `actions: read` and `contents: read` to enumerate successful scheduled runs
from the preceding three-day GitHub delivery-retention window. It examines
candidates newest first until it proves the exact recovery step completed
successfully and uses that run's start time as a continuity guard. A well-formed
skipped or otherwise non-executed candidate is not a checkpoint; missing proof
ends in a closed failure, while malformed, duplicated or contradictory history
aborts immediately. Each failed GUID must retain exactly one original delivery;
truncated lineage, an exhausted attempt limit or an unclassified response code
also fails closed. Before any POST, the controller performs one complete lineage
revalidation, intersects it with the initial oldest-first candidates, and
mutates at most ten targets per run. The remaining targets are explicitly
deferred to later schedules, bounding API use without hiding backlog. It never
invents an automatic seed or persistent repository-variable checkpoint that
could conceal a coverage gap.

See [`apps.activities.list`][slack-activities], [Slack app activity logging][slack-logging],
and [GitHub's automatic redelivery design][github-redelivery].

## Verification checklist

1. Confirm the official GitHub app remains installed and no native repository
   subscription is producing duplicate channel traffic.
2. Confirm the final Slack manifest has both workflows, app ID `A0BMWBGES20`,
   immutable channel IDs `C0BMQMW3L4E` and `C0BMUK793NV`, and no bootstrap-only
   `groups:write` scope.
3. Confirm exactly two production webhook triggers exist and ordinary app
   deploys do not change their IDs or URLs.
4. Confirm `GET /healthz` reports `ready` only with a usable D1 schema and
   singleton, no `manual_review` records, and all four valid secret bindings,
   while exposing no resource details.
5. Ping the organization webhook and confirm its signed HTTP success.
6. Generate one controlled discussion event and confirm exactly one message in
   private `#github-activity`.
7. Generate one controlled failed workflow event and confirm exactly one
   message in private `#github-alerts`.
8. Confirm each event reaches D1 `accepted_by_slack`, then confirm the matching
   Deno function and `SendMessage` step succeeded in Slack activity logs.
9. Replay the same GitHub delivery ID and confirm ordinary D1 deduplication.
10. Tamper with a relay signature, destination and timestamp in local tests and
    confirm the Slack custom function rejects each case.
11. Review D1 for `dead_letter` and `manual_review`, both DLQs, the Slack monitor,
    and GitHub webhook redelivery on every daily audit.
12. During any signing-key rotation, prove the dual-key drain and real canary
    sequence before removing `SLACK_RELAY_SIGNING_SECRET_NEXT`.

## Official references

- [Integrating GitHub with Slack][github-slack-install]
- [Using GitHub in Slack][github-slack]
- [Customizing GitHub notifications in Slack][github-slack-notifications]
- [Permissions for GitHub in Slack][github-slack-permissions]
- [GitHub webhook events and payloads][github-events]
- [Validating GitHub webhook deliveries][github-hmac]
- [Automatically redelivering failed organization webhook deliveries][github-redelivery]
- [REST API endpoints and creator ownership for organization webhooks][github-org-webhooks]
- [Authenticating with a GitHub App in Actions][github-app-auth]
- [Installing an organization-owned GitHub App][github-app-install]
- [Implementing Slack slash commands][slack-slash-commands]
- [Formatting dates in Slack messages][slack-date-formatting]
- [Creating Slack workflows][slack-workflows]
- [Creating Slack custom functions][slack-custom-functions]
- [Creating Slack webhook triggers][slack-webhook-trigger]
- [Deploying to Slack][slack-deploy]
- [Authorizing Slack CLI for CI/CD][slack-cli-auth]
- [Using environment variables with the Deno Slack SDK][slack-app-env]
- [`apps.activities.list`][slack-activities]
- [Logging Slack function and app behavior][slack-logging]
- [Cloudflare Workers best practices][cloudflare-workers]
- [Cloudflare Queues dead-letter queues][cloudflare-dlq]
- [Cloudflare D1 migrations][cloudflare-d1]
- [Cloudflare Secrets Store bindings][cloudflare-secrets]

[cloudflare-d1]: https://developers.cloudflare.com/d1/reference/migrations/
[cloudflare-dlq]: https://developers.cloudflare.com/queues/configuration/dead-letter-queues/
[cloudflare-secrets]: https://developers.cloudflare.com/secrets-store/integrations/workers/
[cloudflare-workers]: https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
[github-events]: https://docs.github.com/en/webhooks/webhook-events-and-payloads
[github-hmac]: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
[github-org-webhooks]: https://docs.github.com/en/rest/orgs/webhooks
[github-app-auth]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/making-authenticated-api-requests-with-a-github-app-in-a-github-actions-workflow
[github-app-install]: https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app
[github-redelivery]: https://docs.github.com/en/webhooks/using-webhooks/automatically-redelivering-failed-deliveries-for-an-organization-webhook
[github-slack]: https://docs.github.com/en/integrations/how-tos/slack/use-github-in-slack
[github-slack-install]: https://docs.github.com/en/integrations/how-tos/slack/integrate-github-with-slack
[github-slack-notifications]: https://docs.github.com/en/integrations/how-tos/slack/customize-notifications
[github-slack-permissions]: https://docs.github.com/en/integrations/reference/slack-permissions
[iana-time-zones]: https://data.iana.org/time-zones/tz-link.html
[slack-activities]: https://docs.slack.dev/reference/methods/apps.activities.list/
[slack-app-env]: https://docs.slack.dev/tools/deno-slack-sdk/guides/using-environment-variables/
[slack-cli-auth]: https://docs.slack.dev/tools/slack-cli/guides/authorizing-the-slack-cli/
[slack-custom-functions]: https://docs.slack.dev/tools/deno-slack-sdk/guides/creating-custom-functions/
[slack-deploy]: https://docs.slack.dev/tools/deno-slack-sdk/guides/deploying-to-slack/
[slack-date-formatting]: https://docs.slack.dev/messaging/formatting-message-text/#date-formatting
[slack-logging]: https://docs.slack.dev/tools/deno-slack-sdk/guides/logging-function-and-app-behavior/
[slack-slash-commands]: https://docs.slack.dev/interactivity/implementing-slash-commands/
[slack-trigger]: https://docs.slack.dev/tools/slack-cli/reference/commands/slack_trigger/
[slack-webhook-trigger]: https://docs.slack.dev/tools/deno-slack-sdk/guides/creating-webhook-triggers/
[slack-workflows]: https://docs.slack.dev/tools/deno-slack-sdk/guides/creating-workflows/
