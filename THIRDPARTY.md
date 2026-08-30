# Third-Party Components

Scope of this inventory: every **direct** dependency declared by a manifest committed to this
repository, every third-party script loaded at runtime by a page this repository publishes, and
every third-party brand asset vendored into this repository and served by its published site.

Transitive dependencies are not listed individually; they are pinned by the committed lockfiles.
Dependabot covers each declared ecosystem, and the official GitHub Dependency Review action evaluates
manifest and lockfile changes. The public-site workflows install the committed npm lockfile with
lifecycle scripts disabled and run npm signature and advisory checks. GitHub Actions are listed below,
pinned by full commit SHA, recorded in `.github/workflows/actions.lock`, and updated through Dependabot.
The repository intentionally has no parallel scanner, pin auditor, containerized Zizmor runtime, or
policy wrapper of its own.

Versions and licenses below were read from each package's own published manifest or from its
upstream repository, not inferred. Versions are the ones actually resolved by the committed
lockfile, not the ranges declared in the manifest: the root `package.json` requests `commonmark`
as `0.31.2`, `prettier` as `^3.9.6`, and `wrangler` as `4.125.0`; the lockfile resolves those
same versions.

## Repository root — `package.json`

| Component  | Version | License           | Scope       | Source                                   |
| ---------- | ------- | ----------------- | ----------- | ---------------------------------------- |
| commonmark | 0.31.2  | BSD-2-Clause      | development | https://www.npmjs.com/package/commonmark |
| prettier   | 3.9.6   | MIT               | development | https://www.npmjs.com/package/prettier   |
| wrangler   | 4.125.0 | MIT OR Apache-2.0 | development | https://www.npmjs.com/package/wrangler   |

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
| `github/codeql-action`             | v4.37.9 | `cdf488f595d80d6e07e03d4674febd5ab45fa938` | [MIT](https://github.com/github/codeql-action/blob/cdf488f595d80d6e07e03d4674febd5ab45fa938/LICENSE)                     | Initialize and analyze CodeQL and upload Scorecard SARIF                  |
| `actions/dependency-review-action` | v5.0.0  | `a1d282b36b6f3519aa1f3fc636f609c47dddb294` | [MIT](https://github.com/actions/dependency-review-action/blob/a1d282b36b6f3519aa1f3fc636f609c47dddb294/LICENSE)         | Review dependency changes on pull requests and merge groups               |
| `actions/create-github-app-token`  | v3.2.0  | `bcd2ba49218906704ab6c1aa796996da409d3eb1` | [MIT](https://github.com/actions/create-github-app-token/blob/bcd2ba49218906704ab6c1aa796996da409d3eb1/LICENSE)         | Mint a short-lived repository-scoped token for native Dependabot auto-merge |
| `linear/linear-release-action`     | v0.17.1 | `3f31fcf14c110cc53579fcc3575a26d469c413b4` | [MIT](https://github.com/linear/linear-release-action/blob/3f31fcf14c110cc53579fcc3575a26d469c413b4/LICENSE)             | Create repository releases in the corresponding Linear pipeline           |
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

## Vendored brand asset — `site/sponsor/assets/mercadopago-oficial.png`

This is a trademark surface, not a software-license surface. The file carries no open-source
license, and the absence of one is not a defect to be repaired by attaching a license: its use is
governed by the mark owner's own brand terms, recorded below.

| Component          | Variant                                    | Terms                                                                                | Scope                     | Immutable source                                                                                            |
| ------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Mercado Pago logo  | `MP_RGB_HANDSHAKE_color_horizontal.png`    | Proprietary — Mercado Pago brand terms, *Versión Marzo 2025*, shipped inside the package | published on sponsor page | https://http2.mlstatic.com/storage/pog-cm-admin/calm-assets/Logos%20Mercado%20Pago%202025--fb6f16c9.zip |

### Provenance is proven, not asserted

The committed file is byte-identical to the file of the same name inside the official package:

- committed file: SHA-256 `863719a51c238ef136f6ad53b9c25e3589846e06930bce6c6df5282cd4c1340f`, 35,745 bytes, 1049×426
- official package: SHA-256 `bc096531b45de70a4e005bbff5183fb2a5b46a1aca6966c7be1610e5461c71b1`, retrieved 30 August 2026 from the brand page https://www.mercadopago.com.br/mp/logo-oficial
- matching path inside the package: `Logos Mercado Pago 2025/Uso digital - RGB/PNGs/MP_RGB_HANDSHAKE_color_horizontal.png`

The horizontal colour variant is the one the brand page designates as the primary version and
recommends for most cases.

### Basis for use

The brand page is Mercado Pago's own official distribution point for the mark and states that the
materials are supplied so that the logo can be used correctly on third-party sites and
communications. The package's own terms sheet restricts the RGB folder to digital use and names web
pages among the intended cases.

Use here is descriptive. The logo identifies the payment processor that actually processes the
contribution; it links to `https://www.mercadopago.com.br`; and its `title` and `aria-label` both
read *Pagamento processado por Mercado Pago*. No sponsorship, endorsement, partnership, or
affiliation is implied or claimed.

### Compliance with the published rules, verified at this SHA

| Rule                                                                  | Source              | State at this SHA                                              |
| --------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------- |
| RGB assets are for digital use, web pages included                     | package terms sheet | rendered by `site/sponsor/index.html`                          |
| PNG may be used at the supplied size or smaller, never enlarged        | package terms sheet | supplied 1049×426, rendered 69×28                              |
| Do not condense, stretch, or deform; keep the iso-to-logo proportion   | brand page          | 1049 ÷ 426 = 2.4624; 69 ÷ 28 = 2.4643                          |
| Do not alter colours or typography, and apply no shadows or effects    | brand page          | file is byte-identical to the official one                     |
| Colour versions may be placed on a white background                    | brand page          | `.mp-logo` sets `background: rgba(255, 255, 255, 0.92)`        |
| Never on institutional cyan, institutional blue, or non-brand colours  | brand page          | none of those is used behind the mark                          |

The asset is vendored rather than hot-linked because Mercado Pago's CDN answers HTTP 403 to
requests for it from outside its own properties, so the published page cannot reference it
remotely.

### One published rule could not be checked

The brand page describes a minimum size and a maximum reduction, but presents both only as a
figure. On 30 August 2026 that figure's URL served the same image as the logo-versions figure —
confirmed by downloading both at two resolutions and comparing digests, which matched. No numeric
minimum is therefore published at the official source. The binding rule from the package's own
terms sheet, which states no minimum and forbids only enlargement, is satisfied.

Copyright © 2026 Mercado Pago Instituição de Pagamento Ltda., CNPJ 10.573.521/0001-91. The mark
belongs to its owner; nothing in this repository transfers, licenses, or sublicenses it.

## This repository

The original content of this repository owned by LCV Ideas & Software is
proprietary to it. Copyright © 2026 LCV Ideas & Software. All rights reserved. See
[LICENSE](./LICENSE) and [NOTICE](./NOTICE). Contributor-owned material may be
incorporated only under the separate documented written terms and local gate
defined in [INBOUND.md](./INBOUND.md), and must be listed here or in NOTICE
before merge.

The components listed above remain subject to their respective licenses and
terms; the repository's proprietary terms do not replace or restrict those
licenses or claim ownership of that material.
