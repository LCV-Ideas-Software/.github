# Third-Party Components

Scope of this inventory: every **direct** dependency declared by a manifest committed to this
repository, plus every third-party script loaded at runtime by a page this repository publishes.

Transitive dependencies are not listed individually; they are pinned by the committed lockfiles.
Dependabot covers each declared ecosystem, and the official GitHub Dependency Review action evaluates
manifest and lockfile changes. The reconciler workflow installs the committed npm lockfile with
lifecycle scripts disabled; this document does not claim a separate native `npm audit` CI gate. GitHub
Actions are not listed here: they are pinned by full commit SHA and updated through Dependabot. The
repository intentionally has no parallel scanner, pin auditor, containerized Zizmor runtime, or policy
wrapper of its own.

Versions and licenses below were read from each package's own published manifest or from its
upstream repository, not inferred. Versions are the ones actually resolved by the committed
lockfiles, not the ranges declared in the manifests: the root `package.json` requests `prettier`
as `^3.9.6` and resolves it to `3.9.6`; the organization workflow controllers'' tests use the
exact `yaml@2.9.0` parser.

## Repository root — `package.json`

| Component                     | Version | License           | Scope       | Source                                                      |
| ----------------------------- | ------- | ----------------- | ----------- | ----------------------------------------------------------- |
| @linear/sdk                   | 90.0.0  | MIT               | runtime     | https://www.npmjs.com/package/@linear/sdk                   |
| @octokit/auth-app             | 8.3.0   | MIT               | runtime     | https://www.npmjs.com/package/@octokit/auth-app             |
| @octokit/core                 | 7.0.7   | MIT               | runtime     | https://www.npmjs.com/package/@octokit/core                 |
| @octokit/plugin-paginate-rest | 15.0.0  | MIT               | runtime     | https://www.npmjs.com/package/@octokit/plugin-paginate-rest |
| zod                           | 4.4.3   | MIT               | runtime     | https://www.npmjs.com/package/zod                           |
| prettier                      | 3.9.6   | MIT               | development | https://www.npmjs.com/package/prettier                      |
| wrangler                      | 4.120.1 | MIT OR Apache-2.0 | development | https://www.npmjs.com/package/wrangler                      |
| yaml                          | 2.9.0   | ISC               | development | https://www.npmjs.com/package/yaml                          |

`@linear/sdk` is Linear's official TypeScript SDK. The three `@octokit` packages are official GitHub
client components. `zod` is the exact-pinned third-party schema validator used at provider boundaries.

## GitHub-to-Slack relay — `workers/github-slack-relay/package.json`

| Component   | Version | License           | Scope       | Source                                    |
| ----------- | ------- | ----------------- | ----------- | ----------------------------------------- |
| @types/node | 26.2.0  | MIT               | development | https://www.npmjs.com/package/@types/node |
| fast-check  | 4.9.0   | MIT               | development | https://www.npmjs.com/package/fast-check  |
| typescript  | 7.0.2   | Apache-2.0        | development | https://www.npmjs.com/package/typescript  |
| vitest      | 4.1.10  | MIT               | development | https://www.npmjs.com/package/vitest      |
| wrangler    | 4.120.1 | MIT OR Apache-2.0 | development | https://www.npmjs.com/package/wrangler    |

The Worker itself ships no runtime dependency: every entry above is a development tool, and the
deployed bundle is built from this repository's own source.

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
