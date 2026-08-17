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
  -> authenticated send-boundary receipt to D1
  -> Slack SendMessage function
  -> private #github-activity OR private #github-alerts
  -> authenticated delivery receipt with Slack message_context.message_ts
  -> paginated Slack activity reconciliation attaches trace_id
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
Immediately before each POST, the relay adds a fixed `destination`, the current
durable D1 `relay_attempt`, an epoch-second `relay_timestamp`, and an HMAC-SHA256
`relay_signature` over the canonical flat fields. The first step of each Deno
workflow validates:

1. the HMAC with current or the separately staged `SLACK_RELAY_SIGNING_SECRET_NEXT`;
2. the expected destination for that trigger;
3. a five-minute freshness window with at most 60 seconds of future clock skew;
4. the final link as HTTPS on `github.com`.

Only then does the coded workflow authenticate the send boundary with
`POST /slack/progress` and call Slack's `SendMessage` function. The next step
posts an idempotent HMAC receipt containing the GitHub `delivery_id`, fixed
destination, and Slack `message_context.message_ts`. Trigger acceptance remains
`accepted_by_trigger`; only the post-message receipt creates `delivered`.
The send-boundary CAS binds that signed attempt to the Slack
`event.function_execution_id`. A retry by the same execution can confirm a lost
response, but a different workflow execution is rejected before it receives the
message output. The safe-retry delivery transition and trace-applied marker are
committed together in one D1 batch.
The activity monitor later attaches Slack's actual `trace_id` without sending
raw workflow inputs to Cloudflare. It accepts signed validator or progress
inputs only when their original `relay_timestamp` is also inside the same
five-minute/60-second window around that Slack step activity's own timestamp;
an old valid HMAC cannot be replayed into a later trace.

Slack's activity result supplies the custom function's `function_execution_id`.
The monitor carries that identifier plus the signed `relay_attempt`, channel,
and message timestamp in its reconciliation report. The current checkpoint
advertises `reconciliation_version: 5`, a nullable `resume_from_us`, and a fair
page of at most 25 pending trace IDs with the total and global oldest
observation. The v5 HMAC binds `preserve`, `resume`, or `complete`, normalized
traces, and pending/debt hydration records. A bounded 100-page execution
atomically persists `resume_from_us` as the checkpoint D1 actually committed
after clamping. The next schedule resumes inclusively there instead of replaying
the normal overlap, and a completed scan clears the resume state. A
non-advancing acknowledgement fails closed.

The monitor also hydrates at most two pending or suffix-only trace IDs per
natural run, with at most two in-memory cursor pages for each, using
`apps.activities.list` without temporal bounds. The signed hydration record
marks whether that ID was actually fetched; only attempted IDs advance the
fairness timestamp. Activities are deduplicated before normalization. Migration
`0009_track_slack_trace_hydration.sql` retains
only bounded trace metadata, never raw activities or Slack cursors. Pending
hydration prevents checkpoint advancement. Seven-day retention expiry or the
page bound becomes durable debt: an owned pending trace moves atomically to
`manual_review`; unowned debt keeps health red without inventing an owner.

During rollout a v4 checkpoint remains readable, but the v5 Worker rejects
authenticated v4, v3 and v2 reports so an in-flight old monitor cannot mutate
delivery, checkpoint, or scan state after the upgrade. A checkpoint without a
version still identifies the older v2 Worker. D1 may release a retry only from
an authenticated terminal failure
of the signed validator, before any send boundary, bound to the exact relay
attempt and validator `function_execution_id`. Any persisted send lease or
`send_started` fact blocks that retry and forces manual review. A competing
workflow or older-attempt trace cannot release, attach to, or make purgable the
current delivery.

The validator emits a domain-separated progress token bound to the validated
`delivery_id`, destination, relay attempt, and original timestamp. Both progress steps must
verify it, so an independently invoked Slack custom function cannot sign
arbitrary evidence. During key overlap current or `NEXT` may authenticate the
inbound relay, but only the separately staged `NEXT` key can issue the progress
token or either callback. The GitHub monitor therefore needs only `NEXT` to
correlate a current-authenticated execution after its first progress step. An
execution that never produces authenticated `NEXT` progress remains unresolved
and cannot authorize an automatic retry.

The old current value exists only in the Cloudflare Secrets Store and deployed
Slack app; it is encrypted and cannot be recovered for GitHub. Before this
expand rollout, one newly generated value must be stored under the final name
`SLACK_RELAY_SIGNING_SECRET` in both protected GitHub environments,
`cloudflare-production` and `slack-production`. The rollout treats that GitHub
value as a write-only source for each hosted runtime's distinct `NEXT` slot.
After migrations and sealed-contract validation, Cloudflare `NEXT` is staged
and the new Worker is deployed active under the immutable historical seal. The
protected Slack job then proves its signer against the Worker's read-only HMAC
checkpoint before writing Slack `NEXT`, deploying the app, or updating either
trigger. The temporary activation signer was removed after the receipt protocol
was sealed; no post-Slack activation step exists.
Both hosted stores retain current during expand, but only the Slack validator
accepts it for inbound relay compatibility; the Worker control plane and monitor
accept `NEXT` only. GitHub deliberately does not recover or store current.
Neither value is committed, stored as a repository variable, passed in argv, or
logged.

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
| Alerts DLQ      | removida da configuração (ADR-002 decisão 8); recurso na Cloudflare pende de exclusão |
| Activity Queue  | `github-slack-activity`                                           |
| Activity DLQ    | `github-slack-activity-dlq`                                       |
| Secrets Store   | `df90c0935ba1460899c3c2c457548a90`                                |

The public receiver is an explicit exception for external GitHub ingress, not
a Worker-to-Worker transport. GitHub cannot invoke a Cloudflare Service
Binding. The Worker keeps its single production `workers.dev` route, disables
all versioned and aliased preview URLs, and uses only direct Cloudflare
bindings for D1, Queues, and Secrets Store. Relay source must never call an
intra-Cloudflare application through `workers.dev` or `pages.dev`.

Five Secrets Store entries are bound to the Worker:

| Binding                               | Secret name                              | Purpose                                                       |
| ------------------------------------- | ---------------------------------------- | ------------------------------------------------------------- |
| `GITHUB_WEBHOOK_SECRET`               | `github-slack-alerts-webhook-secret`     | Authenticate GitHub deliveries.                               |
| `SLACK_ALERTS_WORKFLOW_WEBHOOK_URL`   | `github-slack-alerts-workflow-url`       | Invoke the alerts trigger.                                    |
| `SLACK_ACTIVITY_WORKFLOW_WEBHOOK_URL` | `github-slack-activity-workflow-url`     | Invoke the activity trigger.                                  |
| `SLACK_RELAY_SIGNING_SECRET`          | `github-slack-relay-signing-secret`      | Old signer retained for in-flight verification during expand. |
| `SLACK_RELAY_SIGNING_SECRET_NEXT`     | `github-slack-relay-signing-secret-next` | Signer selected by `SLACK_RELAY_SIGNING_ACTIVE_SLOT=next`.    |

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
- `functions/report_relay_progress.ts` records the authenticated send
  boundary, passes the validated message to `SendMessage`, and records its
  resulting `message_context.message_ts` idempotently;
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
both `SLACK_RELAY_SIGNING_SECRET` and `SLACK_RELAY_SIGNING_SECRET_NEXT` during
this documented expand rollout, and require `SLACK_DEBUG` to remain absent.
The list endpoint proves names only; the rollout therefore sets `NEXT` on every
run before redeploying rather than treating metadata as proof of its value.
Never create a plaintext `.env` for production credentials.

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
5. Verify a signed event through each destination before bootstrap is
   considered complete.

Normal `slack deploy` runs must not implicitly create, update, delete or print
triggers. The workflow uses `--hide-triggers`, so source deployment updates
function and workflow code without replacing the two production triggers. It
then updates each existing protected trigger ID in place from its corresponding
versioned definition. The CLI response is captured and deleted without being
printed because it can contain the bearer webhook URL. The exact inventory must
still pass before deployment completes, so a missing, swapped, partial or stale mapping
fails closed.

### Controlled trigger rotation

Rotate a trigger only for suspected exposure, an explicit Slack requirement,
or a definition change that cannot safely preserve the existing trigger ID.
Compatible input-mapping changes use the protected in-place update above.
Rotate one destination at a time:

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

4. Generate one controlled GitHub event for that destination. Confirm exactly
   one channel message, D1 `delivered` with the matching
   `slack_message_ts`, and the correlated clean Slack activity trace.
5. Delete the old Slack trigger only after the new path is verified. If
   verification fails, atomically restore the old URL while it still exists.

This sequence avoids a no-trigger window and prevents trigger churn during
routine app deployments. See [Creating webhook triggers][slack-webhook-trigger]
and the [Slack CLI trigger reference][slack-trigger].

### Staged relay HMAC overlap

The Slack validator accepts current and distinct `NEXT` inbound relay
signatures. After either verifier authenticates a relay, the validator issues
its progress authorization only with `NEXT`; the progress function accepts only
that authorization and signs every new callback with `NEXT`. The Worker control
plane and GitHub monitor both verify only active `NEXT`. This receipt-protocol
expand therefore correlates current-authenticated in-flight records through
their first `NEXT` progress step without recovering old current into GitHub:

1. before merge, generate one new value and store the same value under the
   final GitHub secret name `SLACK_RELAY_SIGNING_SECRET` in both protected
   production environments;
2. keep the old hosted current values unchanged and do not attempt to read them;
3. the Cloudflare job lists every Secrets Store page, proves the exact current
   metadata, refuses conflicting `NEXT` metadata, and creates or byte-identically
   rewrites `NEXT` before deploying the Worker with active slot `next`;
4. after the sealed Worker deploy, the protected Slack job proves that its
   GitHub-environment value can authenticate against the Worker's active
   `NEXT`, before making any Slack mutation;
5. the Slack job sets hosted `NEXT`, verifies its name, redeploys the app, and
   verifies both protected triggers;
6. every new progress callback and the monitor sign only with the new GitHub
   value mapped to `NEXT`; both hosted stores retain current, but only
   the Slack validator accepts it as an inbound verifier and current alone
   cannot create new progress evidence;
7. only a separate reviewed contract may promote that same value to hosted
   current, prove the old-key drain and authorized canaries, remove the old
   verifier and `NEXT`, and remove the temporary Cloudflare GitHub copy.

The Cloudflare metadata comment is only a fingerprint label, not proof of the
encrypted value, so the script always rewrites existing matching `NEXT` by its
discovered ID. The Slack list API likewise returns names only, so its script
always performs the set operation. Neither script accepts a secret in argv or
prints it. Without drain and canary evidence, key removal and a zero-loss claim
remain blocked.

## Deployment order

### Completed one-time activation (historical)

The following bootstrap sequence records how the receipt protocol reached its
reviewed production anchor. It is historical evidence, not a procedure that can
be replayed: migration `0006_seal_slack_delivery_protocol.sql` permanently
closed the confirmation window and removed the activation endpoint and script.

1. Create repository variable `SLACK_GITHUB_INTEGRATION_ENABLED` with value
   `false`. This keeps production deployment, monitoring, and redelivery jobs
   fail-closed while bootstrap is incomplete; verification jobs remain usable.
2. Create private `#github-activity` and `#github-alerts`; verify their IDs are
   `C0BMQMW3L4E` and `C0BMUK793NV` respectively and ensure the Deno app can post
   to both.
3. Finalize and verify the source-controlled Slack manifest, workflows,
   triggers and channel IDs with
   `deno task --config=deno.jsonc --frozen check`.
4. Store `SLACK_SERVICE_TOKEN` as a secret in the protected
   `slack-production` environment and `SLACK_GITHUB_INTEGRATION_APP_ID` plus
   `SLACK_WORKSPACE_ID` as repository variables. Set the app variable to
   `A0BMWBGES20`. Slack service tokens are long-lived and non-rotatable; revoke
   and replace the token immediately if it is exposed.
5. Generate a new relay signing value and provision the same value under
   `SLACK_RELAY_SIGNING_SECRET` in both protected GitHub environments. Do not
   expose it in output or attempt to recover the old hosted current value.
6. For a fresh bootstrap, generate a distinct temporary current value and set it
   as the Slack hosted `SLACK_RELAY_SIGNING_SECRET`; deploy the app and create
   the two production triggers exactly once. An existing installation keeps its
   already-hosted current value unchanged and does not recover it into GitHub.
7. Create the four remote Secrets Store entries interactively. The HMAC values
   must match their GitHub and Slack counterparts respectively.
8. Prepare the exact-main workflow for the authorized gate flip in step 16. It
   first validates the deployed activation tuple, then applies D1 migrations,
   stages the protected GitHub signer as Cloudflare
   runtime `NEXT`, and deploys the Worker with active slot `next` only after all
   checks pass. Migration `0004` started the receipt-aware delivery protocol
   closed; migration `0005` adds live receipt correlation and the single
   source-pinned upgrade from deployed `afe525/0004` to the reviewed target;
   the new primary, DLQ and scheduled consumers must not cross the Slack send
   boundary or mutate D1 attempt/manual-review state while it is closed.
9. In the same workflow and exact SHA, let the dependent Slack job stage that
   GitHub signer as Slack runtime `NEXT`, redeploy the app, and prove the exact
   two-trigger inventory. The fixed-purpose HMAC activator derived an immutable
   pseudorandom `activation_id` from the exact SHA and schema revision under the
   `NEXT` key, bound that tuple to the Worker's immutable version tag, proved
   the expanded D1 schema, and completed either the initial inactive-to-target
   CAS or the sole reviewed `afe525/0004` to target/`0005` bridge. A lost
   response permitted one byte-identical confirmation request; no new tuple was
   permitted. Only then were signed real canaries run against both Slack
   triggers, requiring the actual
   channel messages plus clean Slack activity traces. A successful trigger POST
   is insufficient.
10. Store the GitHub webhook HMAC value in Cloudflare Secrets Store. Do not keep
    a second Actions copy: no workflow is authorized to configure or mutate the
    organization webhook. Keep the organization webhook inactive while the
    Cloudflare secret is being changed.
11. Register the private organization-owned GitHub App
    `lcv-slack-webhook-recovery`, disable its own webhook and OAuth user
    authorization, and grant only organization `Webhooks: read and write`.
    Leave every optional repository permission at `No access`; GitHub's
    mandatory `Metadata: read` remains. Install the App on
    `LCV-Ideas-Software`, restricted to the `.github` repository. The protected
    `webhook-recovery` environment provides environment variable
    `SLACK_REDELIVERY_APP_CLIENT_ID` and environment secret
    `SLACK_REDELIVERY_APP_PRIVATE_KEY` only to the redelivery controller. No App
    ID or client secret is used. The workflow
    restricts the installation token to the current
    repository and validates the exact App slug and a positive installation ID
    before use.
12. Under an explicitly authorized human maintenance window, configure exactly
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
13. Store the resulting positive numeric hook ID as repository variable
    `SLACK_RELAY_ORG_HOOK_ID`. Keep the hook inactive until the GitHub and
    Cloudflare copies of the HMAC secret and every downstream binding are
    verified.
14. Set `SLACK_GITHUB_INTEGRATION_ENABLED=false`. On a verified `main`, enable
    `GitHub Slack Webhook Redelivery` if it is disabled, and confirm that a
    previously successful scheduled recovery remains inside the three-day
    GitHub delivery-retention window with the controller's safety margin. If no
    such run exists, stop for human reconciliation; never invent or seed a
    checkpoint. Keeping the gate false prevents a scheduled recovery from
    running before the read-only audit.
15. The authorized human activates the replacement through the official REST
    API with a token from the same dedicated App installation, then immediately dispatches
    `GitHub Slack Webhook Redelivery` with its default `audit` operation. Its
    GET-only audit works while the production gate is false, mints an
    installation token downscoped to `Webhooks: read`, and must prove there is
    exactly one installation-visible hook whose ID, active state, URL, JSON
    content type, TLS verification, and complete 14-event set match this
    contract. A 404 or ambiguous inventory stops the rollout; return the hook to
    inactive and do not recreate or mutate it from Actions.
16. Change `SLACK_GITHUB_INTEGRATION_ENABLED` from `false` to `true`, explicitly
    dispatch the `redeliver` operation, then run the
    redelivery, relay, and Slack-app workflows and confirm their scheduled jobs
    are no longer skipped by the gate.
17. A healthy control-plane audit does not prove delivery. Run real issue and
    failed-workflow canaries and require correlated GitHub delivery, Worker,
    D1, Slack activity, and private-channel evidence for both destinations.

During that one-time historical hook replacement, any failed check required the
gate to return to `false` and the authorized human to deactivate the replacement
with the same App installation credential. The legacy hook could be reactivated
only while its ownership and preserved state were still explicitly verified;
both hooks could never remain active together. This is historical procedure,
not a rollback path for the current GET-only single-hook contract. The sealed
delivery protocol has no reopening transition.

The gate controls the production jobs in GitHub Actions; it does not disable an
already deployed Worker or the GitHub organization webhook. Disabling live
ingestion therefore requires an intentional webhook action as well.

### Continuous deployment

- `.github/workflows/slack-github-integration.yml` checks formatting, lint,
  types, tests and every low-or-higher dependency advisory. It contains no
  privileged `workflow_run` trigger and no production deploy job. A separate daily schedule at
  07h17 repeats the dependency and latest-hook audit without deploying or
  running the 15-minute production monitor. It does not recreate triggers.
- `.github/workflows/github-slack-integration.yml` verifies the recovery
  controller, Worker, and Slack app formatting, lint, types, tests and candidate
  dependency audit in the same required predecessor. When production automation
  is enabled, the dependent `prove_remote_d1` job first applies migrations
  `0001` through `0009`, exercises the seal guards, and cleans up an owned
  disposable remote D1. Only after both jobs succeed does production apply
  pending D1 migrations. Migration
  `0006_seal_slack_delivery_protocol.sql` validates the exact historical
  `e0131a758123cf210d9cc9e7e537b72dc0441a90/0005` activation tuple inside its
  transaction, closes confirmation once, and installs permanent update, insert
  and delete guards. Migration
  `0008_resume_bounded_slack_activity_scan.sql` adds the nullable singleton
  resume watermark without changing that sealed tuple or an existing
  checkpoint. A post-migration validator then requires that sealed tuple,
  all final guards, no transient activation guards and zero duplicate
  execution-ID groups before any hosted replacement. The job stages Cloudflare
  runtime `NEXT` and deploys the relay from `main` with
  `--tag "$GITHUB_SHA"` when the gate is `true`.
  Its dependent `deploy_slack` job first proves the protected
  `slack-production` signer against the deployed Worker's read-only HMAC
  checkpoint. It then stages Slack runtime `NEXT` and deploys the same checked-out SHA with an explicitly addressed,
  checksum-verified Slack CLI, then updates the existing activity and alert
  trigger IDs in place from their respective versioned definitions. It captures
  and deletes both CLI responses without displaying them. The job then verifies
  both protected trigger IDs against the exact app and workspace. It streams the
  structured
  `workflows.triggers.list` response directly into a bounded fail-closed
  validator, which requires exactly the two protected IDs, webhook types,
  workflow callback IDs, app ownership, names and 16 input mappings. The
  response is never logged or stored because it contains bearer URLs. There is
  no activation call after inventory: the one-shot endpoint and signer were
  removed when the contract was sealed. No `always()` condition bypasses deploy
  failure. The same protected GitHub secret is
  supplied to both jobs only as the source for runtime `NEXT`; the old hosted
  current value is never available to Actions.
  The monitor job has a 321-minute bound: this covers the calculated 290-minute
  and 10-second network worst case for its 100 pages, one bounded `Retry-After`
  retry per page, a 10-second checkpoint request and up to 402 disjoint trace
  or hydration chunks of 25 items. Each report has a 15-second deadline and one byte-exact
  replay after a transport failure, HTTP 408, any 5xx, or invalid JSON, bounded
  to 5 seconds, plus more than 30 minutes for
  setup and local processing. It normally completes in seconds; the
  larger cap prevents Slack throttling from killing every run before durable
  reconciliation completes while still bounding each relay phase independently.
  Every deployed revision must observe the same sealed historical anchor. The
  current `WORKER_VERSION.tag` remains required as lowercase 40-character
  provenance, but it is not substituted for the immutable activation revision.
  Slack-source paths trigger this same workflow, so the compatible Worker is
  always deployed before the Slack app and neither deploy can race the other.
- `.github/workflows/github-slack-webhook-redelivery.yml` runs its scheduled or
  manually dispatched recovery only while the same gate is `true`. Its default
  manual `audit` operation remains available while the gate is false so the
  control plane can be proven before enabling automation. Every run first audits the sole
  active exact organization hook with GET requests; it never sends a periodic
  ping.
- `.github/workflows/slack-github-integration.yml` accepts the manual
  `operation: monitor` input to run the same production activity check on
  demand; it has no deploy operation. A manual rollout dispatches the combined
  Worker workflow on `main` and preserves the same job dependency chain.
- `scripts/github-slack-hook-audit.mjs`, invoked by redelivery, is deliberately
  GET-only. It proves the GitHub-App-installation-visible organization-hook inventory and exact
  target contract without accepting a webhook secret or exposing any mutation
  method. Organization-hook configuration and state changes remain native,
  explicit human operations outside GitHub Actions.
- Pull requests run verification only. A production rollout requires the
  combined Worker workflow on `main`; the Slack deployment cannot run in
  parallel or from a direct push/dispatch of the monitor workflow.

The completed activation is retained only as an immutable D1 audit anchor:
revision `e0131a758123cf210d9cc9e7e537b72dc0441a90`, schema
`0005_reconcile_live_slack_receipts`, its original server timestamp and HMAC
activation ID, with `confirmation_open = 0`. Migration `0006` seals those exact
values and permanent triggers reject update, insert/replace or deletion of the
singleton. Runtime authorization and readiness require that sealed anchor and
the complete receipt schema. `WORKER_VERSION.tag` must still be a valid deployed
SHA for provenance, but may differ from the historical anchor. The former
workflow preflight, activation step, HMAC request parser and
`/slack/protocol/activate` endpoint no longer exist; the path returns the generic
404 response and there is no public protocol status or mutation API.

Slack's official guidance for these mechanisms is available in [Deploying to
Slack][slack-deploy], [Slack CLI CI/CD authorization][slack-cli-auth], and
[Creating workflows][slack-workflows].

The latest upstream `deno_slack_hooks@1.5.0` imports `esbuild@0.24.2`, affected
by `GHSA-67mh-4wv8-2f99`. The [Deno import map][deno-config] remaps that one exact upstream
specifier to the reviewed patched version, `esbuild@0.28.1`; the official Slack
hook remains unmodified and no source is forked or vendored. The audit script
fails closed unless the mapping is exact, the lockfile contains only the
corrected esbuild graph, `deno audit` reports zero advisories, and the hook is
still the latest stable GitHub release with the exact tag, annotated-tag object,
commit `b6719c18a18a39ca44fa1b311c3bada28dc3df35`, source lock hash, package
integrity, and reviewed `build()`/`stop()` call set. A later stable Slack hook
with corrected esbuild must replace the override in the same reviewed change.
Within the complete frozen production closure, the audit requires exactly the
13 `deno_slack_hooks@1.5.0` source files reached by the production `get-hooks`,
`get-manifest`, `build`, and `get-trigger` entry points; candidate verification
checks all four roots. Update and local-run hooks are excluded
because production always uses `--skip-update` and never invokes them. The Deno
configuration sets `lock.frozen=true`, `nodeModulesDir="none"`, and
`vendor=false`, so hook subprocesses cannot silently add a missing dependency
or substitute local package/vendor content during deployment. The import-map
surface is limited to the exact three Slack aliases and single esbuild
override, and every esbuild platform package must retain its reviewed `0.28.1`
integrity. Both verification workflows explicitly select `deno.jsonc`; the
audit rejects a competing `deno.json`, `package.json` workspace, or Deno
workspace at the app, `slack/`, or repository-root boundary. The
deployment job additionally sets
`SLACK_SKIP_UPDATE=1`; a contract test locks the verified CLI asset/version
step and the exact four application invocations with their `--skip-update`
arguments. The
candidate and merge-group gate additionally executes the official pinned build
hook against the complete app in an isolated temporary directory. It requires
the manifest to declare exactly the two reviewed callback IDs, the matching
function bundles to be the only emitted bundles, both bundles to parse as
JavaScript, and each module to expose the callable default handler required by
the Slack runtime before deployment can become eligible. Since that build may
complete through Deno's native bundler, the gate also invokes the pinned
official `EsbuildBundler` directly for the two exact `source_file` entries from
the source manifest and reapplies the inventory, syntax, and handler checks.
It then deletes both temporary outputs, following Slack's documented
[CLI hook contract][slack-hooks].
Deploys do not use the Slack CLI's broad `--force` warning override.

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

The GitHub-to-Queue leg is intentionally at-least-once and D1 deduplicates
normal repeats by `delivery_id`. A Worker whose D1 protocol anchor is absent,
open or inconsistent keeps the primary and DLQ consumers on bounded Queue
backoff, and its recovery cron performs no delivery-state mutation. The Slack
leg has explicit evidence states:

| State                 | Meaning                                                                                                                                                                         | Automatic resend                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `accepted_by_slack`   | Expand/contract compatibility value. Historical rows in this state are quarantined with `legacy_unverified = 1`; new rows written briefly by the old Worker remain nonterminal. | Only with authenticated signed-validator failure and no send boundary. |
| `accepted_by_trigger` | Slack returned HTTP 2xx plus exact JSON `ok: true`; the asynchronous workflow may still fail.                                                                                   | Only with authenticated signed-validator failure and no send boundary. |
| `send_started`        | Slack successfully crossed the authenticated step immediately before `SendMessage`.                                                                                             | Never.                                                                 |
| `delivered`           | The post-`SendMessage` callback supplied an authenticated, unique Slack `message_context.message_ts`.                                                                           | Never.                                                                 |
| `manual_review`       | Evidence is ambiguous, conflicting, the known loss, or post-boundary.                                                                                                           | Never without the fixed audited known-loss release.                    |

The Queue message is acknowledged at `accepted_by_trigger`, but that state is
nonterminal for delivery accounting. A row can return to `pending` only when a
complete Slack trace contains workflow start, terminal error and an explicit
authenticated failure of the signed validator, with no send boundary. Merely
omitting a boundary event is not negative proof. Success without an authenticated
receipt, any post-boundary failure, incomplete trace evidence and state
conflicts are fail-closed `manual_review` cases. A valid late delivery receipt
may resolve such a row because it supplies positive `message_context.message_ts`
evidence; no negative inference can do so.

The same rule begins at the trigger request. Configuration and signature
failures before any POST, HTTP 429, redirects, and definite non-timeout 4xx
rejections are retryable. A network exception after the POST begins, HTTP 408,
any 5xx, a 2xx body without exact `ok: true`, or a stale `sending` row cannot
prove that Slack did not start a workflow. Those states move to
`manual_review`; neither the primary Queue, DLQ nor five-minute recovery cron
sends them again merely because time passed. A fresh authenticated send-boundary
callback may continue that same live workflow, but its error is ambiguous
because D1 may already have committed `send_started`. The monitor may return a
row to `pending` only after a complete terminal error trace contains an
authenticated signed-validator failure and no send boundary. A persisted
`send_started` row is never released for retry.

`GET /healthz` returns HTTP 200 with status `ready` only when the exact sealed
receipt-aware protocol anchor and all permanent guards are present, the D1 `deliveries` schema is
queryable, the `relay_state` singleton has valid Queue
and Slack-activity checkpoints, no delivery is in `manual_review` or
`dead_letter`, and no current `accepted_by_slack`, `accepted_by_trigger`, or
`send_started` row has exceeded its 20-minute reconciliation deadline. The
current HMAC value and both Slack trigger values must validate. A ready reply
adds only `legacy_unverified: true|false`: the historical quarantine stays
visible but does not fail readiness, and no count or identifier is exposed.
The known lost ID remains `manual_review` and therefore keeps HTTP 503 until
its explicit recovery release. Any failed check or exception returns the same
generic `unavailable` response.

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
- only receipt-confirmed `delivered` rows are deleted after 30 days, and only
  when their applied terminal success or boundary-error trace also predates the
  durable activity checkpoint minus its 20-minute overlap. The boundary-error
  case covers a committed delivery receipt whose reply was lost. Trigger acceptances,
  legacy-unverified and manual-review rows are retained;
- the scheduled Slack monitor obtains an authenticated D1 watermark, queries
  `apps.activities.list` at `info` level every 15 minutes, follows pagination
  cursors in ascending timestamp order for at most 100 pages per execution,
  and normally uses a 20-minute overlap. A bounded prefix remains red after it
  atomically records the relay-acknowledged checkpoint as `resume_from_us`; the
  next schedule resumes inclusively there, and only a complete scan clears that
  state and restores the overlap. An empty scan retains the prior evidence
  watermark, or the initial
  lower-bound anchor, rather than advancing to wall clock. D1 atomically clamps
  each proposed watermark behind the earliest nonlegacy live attempt until a
  trace is correlated. A retry retains its old trace binding until authenticated
  progress or trace evidence proves the next Slack execution; incomplete
  correlated traces are persisted before the watermark advances, so an
  arbitrarily late-indexed terminal observation cannot be skipped and cannot forget an earlier
  successful send-boundary step. The monitor correlates a delivery only from a
  validator input whose 15-field relay HMAC verifies under the monitor's
  available key, or from a progress input whose `NEXT` authorization token
  verifies. A relay admitted by hosted current becomes correlatable at its first
  `NEXT` progress step; rejected or unauthenticated trigger inputs are ignored.
  A terminal error is retryable only when that authenticated trace also contains
  an explicit signed-validator failure; absence of a boundary event alone
  remains ambiguous. An error from the send-boundary callback never proves that
  `SendMessage` did not run and never overrides a local `send_started` marker;
- only bounded `delivery_id`, `trace_id`, outcome, send-boundary flag,
  explicit signed-validator-failure proof bit, channel/message evidence, and
  microsecond timestamps leave the
  monitor. The complete activities
  collection and private step inputs are never logged or posted to D1. Reports
  contain at most 25 traces. Trace mutations remain individually idempotent; one
  D1 batch then atomically commits the report's novel terminal-error receipts,
  clamped checkpoint and immutable response journal. Replaying the same signed
  body after a lost HTTP response returns its original result, while a later
  overlapping report cannot announce the same error again. Migration `0007`
  deliberately infers no receipt for historical errors: only an authenticated
  post-migration report establishes novelty. Per-trace receipts follow their
  traces. Replay journals become eligible for deletion after 24 hours and are
  removed by the next finalized report. The watermark advances only after
  every page and normalized trace is durably accepted;
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

### Migration and historical backfill

Migration `0004_confirm_slack_delivery.sql` was deliberately expand-only. It
retains the old `accepted_at` column and permits `accepted_by_slack`, so the
previously deployed Worker can continue to read, update and health-check D1
between migration and its replacement. Historical `accepted_by_slack` rows
remain in that compatibility state with `accepted_at = NULL` and
`legacy_unverified = 1`; they are visible as aggregate debt but are neither a
readiness failure, blindly resent nor purged. A separately reviewed contract
migration may remove the old column/value only after rollout and inventory.
The audited pre-migration snapshot contained 6,836 ordinary historical rows;
the final inventory must add any old-Worker acceptances created before the new
Worker completes rollout.
An expand trigger also intercepts every later old-Worker transition to
`accepted_by_slack`, clears `accepted_at`, preserves the trigger timestamp and
marks the row `legacy_unverified = 1`, so it cannot be treated as receipt proof
or blindly delivered by the new Worker. The migration adds a protocol flag with
default false and one-way activation/confirmation triggers. Migration
`0005_reconcile_live_slack_receipts.sql` adds unique execution and Slack-message
ownership constraints, stores channel/message evidence on traces, and replaces
the original trigger with the single source-pinned `afe525/0004` to reviewed
target/`0005` bridge. Activation succeeds only after the store proves the
trace/recovery tables and all current triggers; the CAS persists the activation
ID, exact Worker revision, schema revision, and server activation time.
Concurrent identical target requests
produce one mutation and `applied`/`already_applied` responses; no divergent
tuple can reuse the latch. Migration `0006_seal_slack_delivery_protocol.sql`
then validates that exact production tuple transactionally, changes only
`confirmation_open` from `1` to `0`, removes the transitional activation
triggers and installs permanent update, insert and delete guards. The historical
revision is deliberately preserved and cannot be rewritten to a later deployed
SHA. There is no downgrade, replacement or reopening path. Migration
`0007_journal_slack_reconciliation_reports.sql` adds per-trace novelty receipts
without fabricating a historical acknowledgement and stores the exact result
of each authenticated report. Trace updates remain individually
idempotent; only novel-error reservation, checkpoint clamping and response
journaling finalize atomically in one D1 batch. The HMAC `report_signature` is
the immutable report ID, so an identical replay recovers its original result.
Report journals become eligible for deletion after 24 hours, beyond request
freshness, and the next finalized report removes them; receipts remain tied to
trace retention. If reconciliation stops, no new journal is created and the
existing rows remain until processing resumes.
An observed successful Slack trace for one of the ordinary legacy rows may
attach its trace ID, but it remains `accepted_by_slack` with
`legacy_unverified = 1`; it does not become readiness-blocking
`manual_review` and is not promoted to `delivered` without the actual channel
message and timestamp.
The confirmed missing delivery
`de345e40-95b1-11f1-8d38-fac15f0bb4cd` becomes `manual_review` with the bounded
reason `known_slack_workflow_timeout_message_absent`.

A legacy row may be backfilled as `delivered` only from positive evidence of
exactly one matching private-channel message and its Slack timestamp. Zero
matches permit automatic retry only when a complete terminal error trace
contains an authenticated signed-validator failure and no send
boundary. Zero without that proof, multiple matches, a truncated trace, or any
trace after the boundary remains `manual_review`. The known
missing message requires a separately authorized new send; GitHub webhook
redelivery is not a repair because its original `delivery_id` is already the
D1 key.

The recovery mechanism is deliberately restricted to that ID and the
`activity` destination. Before any mutation, record two distinct comments on
Issue #171: one with operational proof that the ID is absent from the channel,
and one explicitly authorizing that exact ID/destination. After reviewing both
permalinks, an operator may perform exactly one insert:

```sql
INSERT INTO slack_delivery_recovery_audit (
  delivery_id, destination, absence_proof_reference,
  authorization_reference, absence_proof_sha256, authorization_sha256,
  authorized_by, authorized_at, released_at
) VALUES (
  'de345e40-95b1-11f1-8d38-fac15f0bb4cd', 'activity',
  '<issue-171-absence-proof-comment-url>',
  '<distinct-issue-171-authorization-comment-url>',
  '<sha256-of-exact-absence-comment-body>',
  '<sha256-of-exact-authorization-comment-body>',
  '<authorized-github-login>', <epoch-ms>, <same-epoch-ms>
);
```

D1 validates the fixed ID/destination, distinct numeric comment permalinks,
distinct lowercase SHA-256 fingerprints of the exact reviewed comment bodies,
actor and equal timestamps, then uses an exact CAS from
`manual_review` + `known_slack_workflow_timeout_message_absent` +
`legacy_unverified = 1` to `pending`. The primary-key audit row makes release
one-time and remains after eventual delivery retention. No public endpoint or
generic selector exists. Do not execute this insert until the post-merge
negative checks and explicit authorization exist. After release, require the
normal authenticated `delivered` receipt and correlated trace; otherwise the
gate remains open.

### Authorized canary exit gate

No deployment is proven by trigger HTTP alone. After the orchestrated
Cloudflare migration, sealed-contract validation and active Worker deployment, Slack app deployment,
exact trigger verification and confirmed sealed protocol anchor, first run an
authorized staging negative before the send boundary. Next, an explicitly authorized canary
must create one unique event per destination and prove all of the following:

1. exactly one message containing the unique `delivery_id` exists in the fixed
   private destination channel;
2. D1 progressed through `accepted_by_trigger` and `send_started` to
   `delivered`, with the exact `slack_message_ts` from that message;
3. the fully paginated monitor attached the matching Slack `trace_id` and
   advanced its durable checkpoint;
4. primary Queues and DLQs contain no canary residue and no new
   `manual_review` exists. Before known-loss recovery, `GET /healthz` must remain
   the generic HTTP 503 solely because the confirmed lost ID is still in
   `manual_review`; a read-only D1 check must prove there is no second readiness
   blocker;
5. an authorized staging negative case before the send boundary is retryable,
   while a simulated post-boundary ambiguity enters `manual_review` without a
   second channel message.

Only after those checks may the separately authorized known-loss release above
be executed. Its exit evidence is the same single-message, receipt, trace,
Queue/DLQ set, with the recovery-audit row still present. Only after that exact
ID reaches authenticated `delivered`, no other debt exists and `/healthz`
returns HTTP 200 `ready` is the overall rollout gate closed.

Both protected GitHub environments contain the same reviewed value under
`SLACK_RELAY_SIGNING_SECRET`. Deployments map it to the external `NEXT` slot in
Cloudflare and Slack; the protected monitor maps that GitHub name to
`SLACK_RELAY_SIGNING_SECRET_NEXT` and explicitly selects `next`. The old Slack
current value remains an inbound verifier for
in-flight records; the old Cloudflare binding remains staged but is not accepted
by the Worker control plane. Neither old value is required or recoverable in
GitHub.

## Verification checklist

1. Confirm the official GitHub app remains installed and no native repository
   subscription is producing duplicate channel traffic.
2. Confirm the final Slack manifest has both workflows, app ID `A0BMWBGES20`,
   immutable channel IDs `C0BMQMW3L4E` and `C0BMUK793NV`, and no bootstrap-only
   `groups:write` scope.
3. Confirm exactly two production webhook triggers exist and ordinary app
   deploys do not change their IDs or URLs.
4. Confirm the same new signer was provisioned under `SLACK_RELAY_SIGNING_SECRET`
   in both protected GitHub environments before merge, with no value in logs,
   argv, repository variables, or source. Confirm the rollout stages and
   rewrites external `NEXT` before each hosted deploy and keeps external current.
5. Confirm `GET /healthz` reports `ready` only with the sealed protocol anchor,
   a usable D1 schema and singleton, no `manual_review` or
   `dead_letter` records, all five declared Secrets Store bindings present, and
   valid current HMAC/trigger values. It may expose only the aggregate
   `legacy_unverified` boolean beyond `status`.
6. Ping the organization webhook and confirm its signed HTTP success.
7. Generate one controlled discussion event and confirm exactly one message in
   private `#github-activity`.
8. Generate one controlled failed workflow event and confirm exactly one
   message in private `#github-alerts`.
9. Confirm each event reaches D1 `delivered` with the channel's exact
   `slack_message_ts`, then confirm the paginated monitor attaches the matching
   Slack `trace_id`.
10. Replay the same GitHub delivery ID and confirm ordinary D1 deduplication.
11. Tamper with a relay signature, destination and timestamp in local tests and
    confirm the Slack custom function rejects each case.
12. Review D1 for `dead_letter` and `manual_review`, both DLQs, the Slack monitor,
    and GitHub webhook redelivery on every daily audit.
13. Do not remove or overwrite external current in this expand. A later reviewed
    contract must prove the dual-key drain and real canary sequence before
    promoting `NEXT` to current or removing either verifier.

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
- [Slack cursor pagination][slack-pagination]
- [Slack message context and `message_ts`][slack-message-context]
- [Logging Slack function and app behavior][slack-logging]
- [Cloudflare Workers best practices][cloudflare-workers]
- [Cloudflare Queues dead-letter queues][cloudflare-dlq]
- [Cloudflare D1 migrations][cloudflare-d1]
- [Cloudflare D1 batch transactions][cloudflare-d1-batch]
- [Cloudflare Secrets Store bindings][cloudflare-secrets]
- [Cloudflare Smart Placement][cloudflare-placement]
- [Deno configuration and import maps][deno-config]
- [Slack CLI hook contract][slack-hooks]

[cloudflare-d1]: https://developers.cloudflare.com/d1/reference/migrations/
[cloudflare-d1-batch]: https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
[cloudflare-dlq]: https://developers.cloudflare.com/queues/configuration/dead-letter-queues/
[cloudflare-placement]: https://developers.cloudflare.com/workers/configuration/placement/
[cloudflare-secrets]: https://developers.cloudflare.com/secrets-store/integrations/workers/
[cloudflare-workers]: https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
[deno-config]: https://docs.deno.com/runtime/reference/deno_json/#dependencies
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
[slack-hooks]: https://docs.slack.dev/tools/slack-cli/reference/hooks/
[slack-message-context]: https://docs.slack.dev/reference/types/message_context-type/
[slack-pagination]: https://docs.slack.dev/apis/web-api/pagination/
[slack-slash-commands]: https://docs.slack.dev/interactivity/implementing-slash-commands/
[slack-trigger]: https://docs.slack.dev/tools/slack-cli/reference/commands/slack_trigger/
[slack-webhook-trigger]: https://docs.slack.dev/tools/deno-slack-sdk/guides/creating-webhook-triggers/
[slack-workflows]: https://docs.slack.dev/tools/deno-slack-sdk/guides/creating-workflows/
