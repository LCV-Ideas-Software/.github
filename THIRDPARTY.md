# Third-Party Components

Scope of this inventory: every **direct** dependency declared by a manifest committed to this
repository, plus every third-party script loaded at runtime by a page this repository publishes.

Transitive dependencies are not listed individually; they are pinned by the committed lockfiles
(`package-lock.json`, `workers/github-slack-relay/package-lock.json`,
`slack/github-integration/deno.lock`) and audited by Dependency Review, `npm audit`,
`deno task audit` and the weekly OSV-Scanner sweep. GitHub Actions and container images are not
listed here either: they are pinned by immutable commit SHA or image digest and audited daily by
`GitHub Actions Pin Audit`.

Versions and licenses below were read from each package's own published manifest or from its
upstream repository, not inferred.

## Repository root — `package.json`

| Component | Version | License           | Scope       | Source                                 |
| --------- | ------- | ----------------- | ----------- | -------------------------------------- |
| prettier  | ^3.9.6  | MIT               | development | https://www.npmjs.com/package/prettier |
| wrangler  | 4.120.1 | MIT OR Apache-2.0 | development | https://www.npmjs.com/package/wrangler |

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

| Component  | Version | License | Scope   | Source                    |
| ---------- | ------- | ------- | ------- | ------------------------- |
| @slack/sdk | 2.15.2  | MIT     | runtime | https://jsr.io/@slack/sdk |
| @slack/api | 2.9.3   | MIT     | runtime | https://jsr.io/@slack/api |

Licenses confirmed from the upstream repositories that publish these JSR packages:
[`slackapi/deno-slack-sdk`](https://github.com/slackapi/deno-slack-sdk) and
[`slackapi/deno-slack-api`](https://github.com/slackapi/deno-slack-api), both MIT.

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

The SDK must execute from the payment provider's origin for PCI scope reasons, so pinning or
vendoring either script is not available to this repository.

## This repository

Licensed under [AGPL-3.0-or-later](./LICENSE). See [NOTICE](./NOTICE) for copyright.
