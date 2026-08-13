# Third-Party Components

Scope of this inventory: every **direct** dependency declared by a manifest committed to this
repository, plus every third-party script loaded at runtime by a page this repository publishes.

Transitive dependencies are not listed individually; they are pinned by the committed lockfiles, and
each lockfile is audited by a different set of tools rather than by all of them:
`package-lock.json` and `workers/github-slack-relay/package-lock.json` by Dependency Review,
`npm audit` and the weekly OSV-Scanner sweep; `slack/github-integration/deno.lock` by
`deno task audit` alone — the OSV collector selects only `package-lock.json` and `Cargo.lock`
(`.github/workflows/oss-advisory-watch.yml:126-129`), so the Deno graph never reaches that scanner. GitHub Actions are not listed here either: they
are pinned by immutable commit SHA and audited daily by `GitHub Actions Pin Audit`. The single
container image committed here, in `.github/zizmor/Dockerfile`, is pinned by immutable digest and
watched daily by the `docker` Dependabot ecosystem; the pin auditor does not cover it, because it
audits `docker://` references declared by Docker Actions rather than `FROM` lines in a Dockerfile.

Versions and licenses below were read from each package's own published manifest or from its
upstream repository, not inferred. Versions are the ones actually resolved by the committed
lockfiles, not the ranges declared in the manifests: the root `package.json` requests `prettier`
as `^3.9.6` and resolves it to `3.9.6`; the structural workflow policy parser is pinned exactly as
`yaml@2.9.0`.

## Repository root — `package.json`

| Component | Version | License           | Scope       | Source                                 |
| --------- | ------- | ----------------- | ----------- | -------------------------------------- |
| prettier  | 3.9.6   | MIT               | development | https://www.npmjs.com/package/prettier |
| wrangler  | 4.120.1 | MIT OR Apache-2.0 | development | https://www.npmjs.com/package/wrangler |
| yaml      | 2.9.0   | ISC               | development | https://www.npmjs.com/package/yaml     |

## GitHub-to-Slack relay — `workers/github-slack-relay/package.json`

| Component   | Version | License           | Scope       | Source                                    |
| ----------- | ------- | ----------------- | ----------- | ----------------------------------------- |
| @types/node | 26.1.2  | MIT               | development | https://www.npmjs.com/package/@types/node |
| fast-check  | 4.9.0   | MIT               | development | https://www.npmjs.com/package/fast-check  |
| typescript  | 7.0.2   | Apache-2.0        | development | https://www.npmjs.com/package/typescript  |
| vitest      | 4.1.10  | MIT               | development | https://www.npmjs.com/package/vitest      |
| wrangler    | 4.120.1 | MIT OR Apache-2.0 | development | https://www.npmjs.com/package/wrangler    |

The Worker itself ships no runtime dependency: every entry above is a development tool, and the
deployed bundle is built from this repository's own source.

## Slack workflow app — `slack/github-integration/deno.jsonc`

| Component        | Version | License | Scope   | Source                                     |
| ---------------- | ------- | ------- | ------- | ------------------------------------------ |
| @slack/sdk       | 2.15.2  | MIT     | runtime | https://jsr.io/@slack/sdk                  |
| @slack/api       | 2.9.3   | MIT     | runtime | https://jsr.io/@slack/api                  |
| deno_slack_hooks | 1.5.0   | MIT     | build   | https://deno.land/x/deno_slack_hooks@1.5.0 |
| esbuild          | 0.28.1  | MIT     | build   | https://www.npmjs.com/package/esbuild      |

Licenses confirmed from the upstream repositories that publish these JSR packages:
[`slackapi/deno-slack-sdk`](https://github.com/slackapi/deno-slack-sdk) and
[`slackapi/deno-slack-api`](https://github.com/slackapi/deno-slack-api), both MIT.

`deno_slack_hooks` is not a JSR import: it is the Slack CLI build hook, executed directly from
`slack/github-integration/.slack/hooks.json:3` as
`deno run -q --allow-read --allow-net https://deno.land/x/deno_slack_hooks@1.5.0/mod.ts`. Its
version is pinned in that URL. Within the complete frozen production closure, the lock carries the
exact integrity hashes for the 13 `deno_slack_hooks@1.5.0` source files reached by the production
`get-hooks`, `get-manifest`, `build`, and `get-trigger` roots, including the executed `mod.ts` entry
point and its `flags.ts` dependency. Update and local-run hooks remain deliberately
outside this graph because every production CLI invocation uses `--skip-update` and the workflow
never invokes `doctor`, `upgrade`, or `run`. Its license comes from the upstream repository that
publishes it, [`slackapi/deno-slack-hooks`](https://github.com/slackapi/deno-slack-hooks), MIT.
The official hook imports vulnerable `esbuild@0.24.2`; the project's Deno import map remaps that
exact specifier to the reviewed patched release, `0.28.1`. The lockfile contains only the corrected
package graph. Candidate verification type-checks all four production hook entry points with the
frozen lock; `deno.jsonc` also makes that lock fail-closed for hook processes launched by the Slack
CLI, disables local `node_modules` and vendored resolution, and limits the import-map surface to
the three Slack aliases plus the one esbuild override. Both workflows select that config explicitly;
the audit rejects competing Deno configs or package workspaces at every ancestor inside the checkout
and verifies the reviewed integrity of all 26 platform packages. The daily trusted audit continues to verify
the unmodified Slack hook source.
Candidate verification also executes the pinned official `EsbuildBundler` directly against the
two exact `source_file` entries declared by the source manifest, because the complete official
build can finish through Deno's native bundler before reaching that fallback. Both generated
modules must parse and expose the callable default handler expected by Slack.

`deno.lock` additionally pins `@slack/api@2.9.0` as a transitive dependency of `@slack/sdk@2.15.2`;
it is not imported directly by this repository.

## Externally hosted scripts — `site/sponsor/index.html`

The sponsor page loads official Mercado Pago browser scripts directly from Mercado Pago's own
origin. Neither is **vendored** into this repository, neither carries a version pin addressable from
here, and both are governed by Mercado Pago's terms rather than by an open-source license.

The two are not interchangeable and are not equally required. `MercadoPago.js V2` is the SDK that
builds the Card Payment Brick secure fields and, as a side effect of constructing
`new MercadoPago(publicKey, ...)`, sets `window.MP_DEVICE_SESSION_ID` automatically. `security.js`
is loaded with `output="deviceId"` and only populates `window.deviceId`, which the page uses as the
**fallback** device identifier — the precedence is explicit at `site/sponsor/index.html:1306-1307`,
where `window.MP_DEVICE_SESSION_ID` wins and the manual value is used only when it is absent.

| Component                  | Version               | License                    | Scope   | Source                                     |
| -------------------------- | --------------------- | -------------------------- | ------- | ------------------------------------------ |
| MercadoPago.js V2          | v2 endpoint, unpinned | Proprietary — Mercado Pago | runtime | https://sdk.mercadopago.com/js/v2          |
| Mercado Pago `security.js` | v2 endpoint, unpinned | Proprietary — Mercado Pago | runtime | https://www.mercadopago.com/v2/security.js |

What is verifiable here is the shape of the integration, not a justification for it: both scripts
are fetched at runtime from unversioned provider endpoints, so neither carries a version this
repository can pin, and neither is vendored.

## This repository

Licensed under [AGPL-3.0-or-later](./LICENSE). See [NOTICE](./NOTICE) for copyright.
