# LCV GitHub integration for Slack

This Slack-hosted workflow app receives the flat, sanitized records emitted by
the Cloudflare relay. It owns two webhook triggers and posts to two private
channels: routine organization activity to `#github-activity` (`C0BMQMW3L4E`)
and actionable failures/security alerts to `#github-alerts` (`C0BMUK793NV`). The
deployed production app is `LCV GitHub integration` (`A0BMWBGES20`).

The committed manifest is the production manifest. It imports both workflows,
binds their immutable private-channel IDs, and intentionally omits every
channel-provisioning scope. Slack's live manifest validator requires the exact
`chat:write`, `chat:write.public`, and `channels:read` scope set for the
built-in `SendMessage` function. The app is already a member of both private
destination channels; fixed channel IDs, exact trigger mappings,
HMAC/destination/freshness validation, and CODEOWNERS compensate for the broader
built-in scope. Channel provisioning code and its temporary trigger are not
retained in production.

The webhook trigger URLs are credentials. They must be written directly to
Cloudflare Secrets Store and must never be committed, logged, or stored as a
GitHub variable.

Every relay record is also authenticated with a separate HMAC secret. The
Cloudflare Worker signs a canonical list of flat fields, and the first Slack
workflow step validates the signature, destination, and five-minute freshness
window before formatting or posting anything. During staged overlap, the old
current value exists only in the hosted Cloudflare and Slack stores. The
reviewed `NEXT` value is sourced independently from both protected GitHub
environments, `cloudflare-production` and `slack-production`, and written to
both hosted `NEXT` slots without readback or logging. A read-only HMAC
checkpoint proves the two protected source values are equal before the Slack job
mutates the app.

Trigger HTTP success is not delivery proof. After validation, the
`report_github_relay_progress` function first records an authenticated
`send_started` boundary and returns the validated message as a data dependency
for Slack's built-in `SendMessage`. A second invocation receives the supported
`SendMessage.message_context.message_ts` output and posts an idempotent delivery
receipt. The Cloudflare row becomes `delivered` only after that receipt; the
paginated monitor later associates Slack's actual `trace_id`. If the
post-message receipt is unavailable, the workflow fails and the relay keeps the
row for manual review without resending the GitHub event.

The monitor posts at most 25 normalized traces per authenticated report. Its
checkpoint and report phases have separate 10-second and 15-second deadlines. If
the relay commits D1 finalization but the response is lost, or returns HTTP 408,
a 5xx or invalid JSON, one replay of the identical signed report returns the
journaled error count and checkpoint; it does not repeat an error observation.

The relay signs its current D1 attempt into the workflow. At the send-boundary
callback, D1 atomically leases that attempt to Slack's
`event.function_execution_id`: a retry from the same function execution can
confirm a lost response, while a second workflow execution cannot receive the
message output and therefore cannot reach `SendMessage`. The activity monitor
reports the same signed relay attempt and the step's `function_execution_id`. An
Activities `Error` from this callback is ambiguous because D1 may already have
committed `send_started`; it is never pre-send retry proof. Only an
authenticated failure of the signed validator step, which runs strictly before
the callback and `SendMessage`, may authorize a retry. A competing or stale
trace cannot release the execution owner.

The validator also issues a five-minute, domain-separated progress token bound
to `delivery_id`, destination, relay attempt, and the original relay timestamp.
The progress function must verify that token before it can sign either callback,
so invoking the custom function independently cannot manufacture delivery
evidence. During a staged rotation, current or `NEXT` may authenticate the
inbound relay, but the validator issues the progress token only with the
distinct staged `NEXT` key. Both progress callbacks therefore use `NEXT`.

The Worker control plane and activity monitor both verify only staged `NEXT`. A
current-authenticated execution becomes correlatable at its first `NEXT`
progress step without recovering old current into GitHub. If an execution never
produces authenticated `NEXT` progress, it stays unresolved and cannot authorize
an automatic retry. A later contract requires a separately reviewed drain and
canary gate before promotion or removal.

Production deployment is serialized inside one `GitHub Slack Integration`
workflow and one exact `main` SHA. Its required predecessor checks the Slack
candidate's formatting, lint, types, tests and dependency audit alongside the
Worker before either production job can run. Its dependent Slack deploy job runs
only after D1 migration, sealed-contract verification, Cloudflare `NEXT`
staging, and Worker deployment succeed, so it cannot race them. The separate
Slack workflow is verification and monitor only; manual dispatch there is
monitor-only. Migration `0006_seal_slack_delivery_protocol.sql` preserved the
historical `e0131a7/0005` activation tuple, irreversibly closed confirmation and
installed permanent update, insert and delete guards. Every later deployed
Worker requires that sealed anchor, while `WORKER_VERSION.tag` remains the
current exact-SHA provenance and is not written into the historical tuple. This
job deploys the Slack app, updates both existing protected trigger IDs in place
from their versioned definitions without printing the CLI response, and verifies
the exact protected trigger inventory. The temporary HMAC activator and
`/slack/protocol/activate` route have been removed; there is no public protocol
mutation or delivery-recovery path. Migration
`0007_journal_slack_reconciliation_reports.sql` adds the response journal
without inferring historical error receipts or altering the sealed activation
tuple. Journals become eligible for deletion after 24 hours and the next
finalized report removes them.

The manifest therefore allows outbound HTTPS only to
`github-slack-alerts.lcv.workers.dev`. The progress function retries the same
signed receipt at most once; it never calls `SendMessage` itself and never
includes the human-facing message in the control request.

The signed `occurred_at` value remains ISO 8601 in transit. Only after HMAC
validation does the app render it for people as `dd/MM/aaaa às HH:mm:ss`, using
the fixed IANA zone `Etc/GMT+3` (the POSIX/IANA sign convention is inverted, so
`+3` means UTC−03:00). The technical timezone suffix is deliberately omitted
from the user-facing text. The app does not use Slack's viewer-localized
`<!date>` syntax. Slack's own timestamp beside the message is native UI metadata
and is not changed by this app.

## Audited esbuild security override

Slack's latest `deno_slack_hooks@1.5.0` build hook imports `esbuild@0.24.2`,
which is reported by `GHSA-67mh-4wv8-2f99`. The project's
[Deno import map](https://docs.deno.com/runtime/reference/deno_json/#dependencies)
remaps that exact upstream specifier to the reviewed patched release,
`esbuild@0.28.2`. The hook remains the official Slack release; no source is
forked or vendored. The regenerated lockfile contains no vulnerable esbuild
version, and the reviewed hook still invokes only `build()` and `stop()`. Within
the complete frozen production closure, it also pins the exact subset of 13
`deno_slack_hooks@1.5.0` source files exercised by Slack CLI production
operations: `get-hooks`, `get-manifest`, `build`, and `get-trigger`. The
candidate gate checks all four entry points with `--frozen`; production passes
`--skip-update`, so update and local-run hooks are intentionally outside this
graph. The Deno configuration sets `lock.frozen=true`, `nodeModulesDir="none"`,
and `vendor=false`, so Slack CLI hook subprocesses cannot silently extend the
reviewed lock or substitute local package/vendor content during deployment. The
two verification workflows select `deno.jsonc` explicitly, and the audit rejects
competing Deno configs or package workspaces at the app, `slack/`, and
repository-root levels. All 26 esbuild platform artifacts retain their reviewed
integrities. The audited import-map surface is exactly the three Slack aliases
plus the one esbuild override. The deployment job also sets
`SLACK_SKIP_UPDATE=1`, and a fail-closed contract locks the verified CLI
asset/version step plus the exact four application operations and their
`--skip-update` arguments.

`deno task --config=deno.jsonc --frozen check` also runs the official pinned
build hook against the complete app in an isolated temporary directory. It fails
unless the hook exits successfully, the manifest declares exactly the two
reviewed callback IDs, the corresponding bundles are the only emitted function
files, both bundles parse as JavaScript, and each module exposes the callable
default handler required by the Slack runtime. Because the official build may
finish through Deno's native bundler before reaching the compatibility fallback,
the same gate directly executes the pinned official `EsbuildBundler` for the two
exact `source_file` entries from the source manifest and reapplies the output,
syntax, and handler checks. It then removes both temporary outputs. This proof
runs in both pull-request and merge-group verification, before any production
deployment. Together these paths exercise the official Slack CLI
[`build` hook contract](https://docs.slack.dev/tools/slack-cli/reference/hooks/).

`deno task --config=deno.jsonc --frozen audit` is fail-closed in both execution
modes. Candidate events (`pull_request` and `merge_group`) must receive no
GitHub token and verify the checked-in hook pin, exact 13-file
`deno_slack_hooks@1.5.0` subset within the complete frozen production closure,
import-map override, package integrity, every esbuild platform package, reviewed
source hash, esbuild call set, and zero-advisory audit locally. Trusted events
(`push`, `schedule`, and `workflow_dispatch`) require a GitHub token and
additionally verify the live release, annotated tag, commit, remote source, and
latest stable release. A token in candidate mode, a missing token in trusted
mode, a missing or ranged override, any vulnerable lock residue, any
low-or-higher advisory, a newer stable hook release, or any changed assumption
fails the check. The workflow repeats the trusted verification every day at
07h17. When Slack publishes a stable hook with corrected esbuild, update the
official hook pin and remove the exact override in the same reviewed change.

From a POSIX shell, candidate mode is reproduced without a credential:

```sh
env -u GITHUB_TOKEN GITHUB_EVENT_NAME=merge_group deno task --config=deno.jsonc --frozen audit
```

Trusted mode requires `GITHUB_TOKEN` to be supplied by the trusted job and is
reproduced without rendering that value:

```sh
GITHUB_EVENT_NAME=workflow_dispatch deno task --config=deno.jsonc --frozen audit
```
