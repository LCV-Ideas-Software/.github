# Third-Party Components

Scope of this inventory: every **direct** dependency declared by a manifest committed to this
repository, plus every third-party script loaded at runtime by a page this repository publishes.

Transitive dependencies are not listed individually; they are pinned by the committed lockfiles.
Dependabot covers each declared ecosystem, and the official GitHub Dependency Review action evaluates
manifest and lockfile changes. The public-site workflows install the committed npm lockfile with
lifecycle scripts disabled and run npm signature and advisory checks. GitHub Actions are not listed
here: they are pinned by full commit SHA and updated through Dependabot. The repository intentionally
has no parallel scanner, pin auditor, containerized Zizmor runtime, or policy wrapper of its own.

Versions and licenses below were read from each package's own published manifest or from its
upstream repository, not inferred. Versions are the ones actually resolved by the committed
lockfile, not the ranges declared in the manifest: the root `package.json` requests `prettier`
as `^3.9.6` and resolves it to `3.9.6`.

## Repository root — `package.json`

| Component | Version | License           | Scope       | Source                                 |
| --------- | ------- | ----------------- | ----------- | -------------------------------------- |
| prettier  | 3.9.6   | MIT               | development | https://www.npmjs.com/package/prettier |
| wrangler  | 4.121.0 | MIT OR Apache-2.0 | development | https://www.npmjs.com/package/wrangler |

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

## Accepted upstream Linear Release installer exception

The repository uses the official `linear/linear-release-action` `v0.16.0`, pinned in the workflow
and Actions lockfile to immutable commit `0a25abab892a91062ebf42260dbb2ce6277aa205`
([release](https://github.com/linear/linear-release-action/releases/tag/v0.16.0),
[commit](https://github.com/linear/linear-release-action/commit/0a25abab892a91062ebf42260dbb2ce6277aa205),
[MIT license](https://github.com/linear/linear-release-action/blob/0a25abab892a91062ebf42260dbb2ce6277aa205/LICENSE)).
The workflow also selects CLI `v0.16.0` explicitly.

The pin authenticates the Action source but not the CLI executable downloaded later by the
Action's installer. The installer currently executes that asset without validating a checksum,
signature, artifact attestation, or immutable-release guarantee. This accepted residual risk is
tracked in [`linear/linear-release-action#59`](https://github.com/linear/linear-release-action/issues/59)
and Linear's `LIN-82854`. Remove this exception only after an official release fails closed on
missing or mismatched integrity metadata; then update the exact Action commit, CLI version,
lockfile, and Actions allowlist together.

## This repository

Licensed under [AGPL-3.0-or-later](./LICENSE). See [NOTICE](./NOTICE) for copyright.
