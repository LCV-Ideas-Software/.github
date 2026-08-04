# LCV GitHub integration for Slack

This Slack-hosted workflow app receives the flat, sanitized records emitted by
the Cloudflare relay. It owns two webhook triggers and posts to two private
channels: routine organization activity and actionable failures/security alerts.

The committed manifest is the production manifest. It imports both workflows,
binds their immutable private-channel IDs, and intentionally omits the
bootstrap-only `groups:write` scope. Channel provisioning code and its temporary
trigger are not retained in the production source.

The webhook trigger URLs are credentials. They must be written directly to
Cloudflare Secrets Store and must never be committed, logged, or stored as a
GitHub variable.

Every relay record is also authenticated with a separate HMAC secret. The
Cloudflare Worker signs a canonical list of flat fields, and the first Slack
workflow step validates the signature, destination, and five-minute freshness
window before formatting or posting anything. The same secret is stored only in
Cloudflare Secrets Store and the encrypted Slack app environment.

The signed `occurred_at` value remains ISO 8601 in transit. Only after HMAC
validation does the app render it for people as
`dd/MM/aaaa às HH:mm:ss
(Horário Oficial de Brasília, UTC−03:00)`, using the
fixed IANA zone `Etc/GMT+3` (the POSIX/IANA sign convention is inverted, so `+3`
means UTC−03:00). It deliberately does not use Slack's viewer-localized
`<!date>` syntax. Slack's own timestamp beside the message is native UI metadata
and is not changed by this app.

## Temporary dependency-audit exception

Slack's latest `deno_slack_hooks@1.5.0` build hook transitively pins
`esbuild@0.24.2`, which is reported by `GHSA-67mh-4wv8-2f99`. The advisory
affects esbuild's development server; the reviewed hook source invokes only
`build()` and `stop()` and does not make that server reachable.

`deno task --frozen audit` is fail-closed. It permits only that one reviewed
moderate advisory and verifies the exact hook tag, annotated-tag object, commit,
remote source hash, package integrity, reviewed esbuild call set, and latest
stable GitHub release. Any additional low-or-higher advisory, a newer stable
hook release, or any changed assumption fails the check. The workflow repeats
this verification every day at 07h17. The exception expires on 01/11/2026 and
must be removed as soon as Slack publishes a hook release using esbuild 0.25.0
or newer.
