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
window before formatting or posting anything. The same secret is stored only in
Cloudflare Secrets Store, the encrypted Slack app environment, and the protected
`slack-production` GitHub environment used by the activity monitor.

Trigger HTTP success is not delivery proof. After validation, the
`report_github_relay_progress` function first records an authenticated
`send_started` boundary and returns the validated message as a data dependency
for Slack's built-in `SendMessage`. A second invocation receives
`SendMessage.message_timestamp` and posts an idempotent delivery receipt. The
Cloudflare row becomes `delivered` only after that receipt; the paginated
monitor later associates Slack's actual `trace_id`. If the post-message receipt
is unavailable, the workflow fails and the relay keeps the row for manual review
without resending the GitHub event.

The validator also issues a five-minute, domain-separated progress token bound
to `delivery_id`, destination, and the original relay timestamp. The progress
function must verify that token before it can sign either callback, so invoking
the custom function independently cannot manufacture delivery evidence. During a
staged rotation, current or `NEXT` may authenticate the inbound relay, but the
validator issues the progress token only with the distinct staged `NEXT` key.
Both progress callbacks therefore use `NEXT`.

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
only after D1 migration, Cloudflare `NEXT` staging, and Worker deployment
succeed, so it cannot race them. The separate Slack workflow is verification and
monitor only; manual dispatch there is monitor-only. The expanded Worker keeps
delivery closed and applies only bounded Queue backoff until this job has
deployed the Slack app and verified the exact protected trigger inventory. A
final fixed-purpose script derives an immutable pseudorandom `activation_id`
from the exact SHA and schema revision under the staged `NEXT` key, then
HMAC-authenticates that exact tuple with `NEXT`. The Worker requires the SHA to
equal `WORKER_VERSION.tag`, proves the expanded D1 schema, and allows its sole
false-to-true protocol transition. If the response is lost after that CAS, the
script repeats the byte-identical request once and accepts only
`already_applied` for the same persisted tuple. This is idempotent confirmation,
not a second activation or replay. A different ID, revision, schema, key, or a
request after the reviewed contract closes confirmation fails closed. The
activation path cannot select or recover a delivery.

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

## Temporary dependency-audit exception

Slack's latest `deno_slack_hooks@1.5.0` build hook transitively pins
`esbuild@0.24.2`, which is reported by `GHSA-67mh-4wv8-2f99`. The advisory
affects esbuild's development server; the reviewed hook source invokes only
`build()` and `stop()` and does not make that server reachable.

`deno task --frozen audit` is fail-closed in both execution modes. Candidate
events (`pull_request` and `merge_group`) must receive no GitHub token and
verify the checked-in hook pin, package integrity, reviewed source hash, esbuild
call set, advisory output, and exception window locally. Trusted events (`push`,
`schedule`, and `workflow_dispatch`) require a GitHub token and additionally
verify the live release, annotated tag, commit, remote source, and latest stable
release. A token in candidate mode, a missing token in trusted mode, any
additional low-or-higher advisory, a newer stable hook release, or any changed
assumption fails the check. The workflow repeats the trusted verification every
day at 07h17. The code-level deadline is `2026-11-01T00:00:00Z`, which is
31/10/2026 às 21:00:00 in the program's fixed UTC−03:00 timezone. The exception
must be removed as soon as Slack publishes a hook release using esbuild 0.25.0
or newer.

From a POSIX shell, candidate mode is reproduced without a credential:

```sh
env -u GITHUB_TOKEN GITHUB_EVENT_NAME=merge_group deno task --frozen audit
```

Trusted mode requires `GITHUB_TOKEN` to be supplied by the trusted job and is
reproduced without rendering that value:

```sh
GITHUB_EVENT_NAME=workflow_dispatch deno task --frozen audit
```
