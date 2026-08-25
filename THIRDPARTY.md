# Third-Party Components

Scope of this inventory: every **direct** dependency declared by a manifest committed to this
repository, plus every third-party script loaded at runtime by a page this repository publishes.

Transitive dependencies are not listed individually; they are pinned by the committed lockfiles.
Dependabot covers each declared ecosystem, and the official GitHub Dependency Review action evaluates
manifest and lockfile changes. The public-site workflows install the committed npm lockfile with
lifecycle scripts disabled and run npm signature and advisory checks. GitHub Actions are listed below,
pinned by full commit SHA, recorded in `.github/workflows/actions.lock`, and updated through Dependabot.
The repository intentionally has no parallel scanner, pin auditor, containerized Zizmor runtime, or
policy wrapper of its own.

Versions and licenses below were read from each package's own published manifest or from its
upstream repository, not inferred. Versions are the ones actually resolved by the committed
lockfile, not the ranges declared in the manifest: the root `package.json` requests `prettier`
as `^3.9.6` and resolves it to `3.9.6`.

## Repository root — `package.json`

| Component | Version | License           | Scope       | Source                                 |
| --------- | ------- | ----------------- | ----------- | -------------------------------------- |
| prettier  | 3.9.6   | MIT               | development | https://www.npmjs.com/package/prettier |
| wrangler  | 4.123.0 | MIT OR Apache-2.0 | development | https://www.npmjs.com/package/wrangler |

## GitHub Actions

The table lists each external Action repository invoked directly by the
versioned workflows. The lockfile additionally records the exact transitive
Action references used by `actions/upload-pages-artifact` and
`zizmorcore/zizmor-action`.

| Component                          | Version | Commit SHA                                 | License                                                                                                                  | Purpose                                                                   |
| ---------------------------------- | ------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `actions/checkout`                 | v7.0.1  | `3d3c42e5aac5ba805825da76410c181273ba90b1` | [MIT](https://github.com/actions/checkout/blob/3d3c42e5aac5ba805825da76410c181273ba90b1/LICENSE)                         | Read repository content and complete Git history                          |
| `actions/setup-node`               | v7.0.0  | `820762786026740c76f36085b0efc47a31fe5020` | [MIT](https://github.com/actions/setup-node/blob/820762786026740c76f36085b0efc47a31fe5020/LICENSE)                       | Install the Node.js runtime used by public-site validation and deployment |
| `cloudflare/wrangler-action`       | v4.0.0  | `ebbaa1584979971c8614a24965b4405ff95890e0` | [Apache-2.0](https://github.com/cloudflare/wrangler-action/blob/a61fbea3226347cc885c6d1b26b3f47b48e6c0f8/LICENSE-APACHE) | Deploy the organization site to Cloudflare Pages                          |
| `github/codeql-action`             | v4.37.8 | `db488ddef3bf6cb639b32c2e9a7c0a7ea8271d28` | [MIT](https://github.com/github/codeql-action/blob/db488ddef3bf6cb639b32c2e9a7c0a7ea8271d28/LICENSE)                     | Initialize and analyze CodeQL and upload Scorecard SARIF                  |
| `actions/dependency-review-action` | v5.0.0  | `a1d282b36b6f3519aa1f3fc636f609c47dddb294` | [MIT](https://github.com/actions/dependency-review-action/blob/a1d282b36b6f3519aa1f3fc636f609c47dddb294/LICENSE)         | Review dependency changes on pull requests and merge groups               |
| `linear/linear-release-action`     | v0.16.0 | `0a25abab892a91062ebf42260dbb2ce6277aa205` | [MIT](https://github.com/linear/linear-release-action/blob/0a25abab892a91062ebf42260dbb2ce6277aa205/LICENSE)             | Create repository releases in the corresponding Linear pipeline           |
| `actions/configure-pages`          | v6.0.0  | `45bfe0192ca1faeb007ade9deae92b16b8254a0d` | [MIT](https://github.com/actions/configure-pages/blob/45bfe0192ca1faeb007ade9deae92b16b8254a0d/LICENSE)                  | Configure the GitHub Pages build                                          |
| `actions/deploy-pages`             | v5.0.0  | `cd2ce8fcbc39b97be8ca5fce6e763baed58fa128` | [MIT](https://github.com/actions/deploy-pages/blob/cd2ce8fcbc39b97be8ca5fce6e763baed58fa128/LICENSE)                     | Deploy the trusted GitHub Pages artifact                                  |
| `actions/upload-pages-artifact`    | v5.0.0  | `fc324d3547104276b827a68afc52ff2a11cc49c9` | [MIT](https://github.com/actions/upload-pages-artifact/blob/fc324d3547104276b827a68afc52ff2a11cc49c9/LICENSE)            | Package and upload the public-site artifact                               |
| `actions/upload-artifact`          | v7.0.1  | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` | [MIT](https://github.com/actions/upload-artifact/blob/043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/LICENSE)                  | Retain the Scorecard SARIF artifact                                       |
| `ossf/scorecard-action`            | v2.4.4  | `2d1146689b8cda280b9bc96326124645441f03bc` | [Apache-2.0](https://github.com/ossf/scorecard-action/blob/2d1146689b8cda280b9bc96326124645441f03bc/LICENSE)             | Assess supply-chain posture                                               |
| `zizmorcore/zizmor-action`         | v0.6.2  | `3dc1ecc9bcb9e94e9b2c709687979e1298497054` | [MIT](https://github.com/zizmorcore/zizmor-action/blob/3dc1ecc9bcb9e94e9b2c709687979e1298497054/LICENSE)                 | Audit GitHub Actions and upload SARIF                                     |

The pinned `cloudflare/wrangler-action` distribution commit contains the
packaged Action rather than the repository's license file; its immediate
source parent contains the immutable Apache-2.0 license linked above.
`github/codeql-action` is MIT-licensed, while
the CodeQL CLI bundle selected by the Action is separately governed by the
[GitHub CodeQL Terms and Conditions](https://github.com/github/codeql-cli-binaries/blob/0d65148c254764ec294892a35e644accd5677ed5/LICENSE.md)
and the Enterprise GitHub Code Security entitlement.

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

The original content of this repository is proprietary to LCV Ideas &
Software. Copyright © 2026 LCV Ideas & Software. All rights reserved. See
[LICENSE](./LICENSE) and [NOTICE](./NOTICE).

The components listed above remain subject to their respective licenses and
terms; the repository's proprietary terms do not replace or restrict those
licenses.
