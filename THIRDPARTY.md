# Third-Party Components

Scope of this inventory: every **direct** dependency declared by a manifest committed to this
repository, every GitHub Action invoked directly by the versioned workflows, every third-party
script loaded at runtime by a page this repository publishes, and the third-party brand assets
vendored by the published pages.

The versioned inventory is the repository's **dependency graph** (Insights → Dependency graph),
which GitHub maintains from the committed manifest, lockfile and workflow files and exports as an
SBOM on request. Exact versions and immutable commit pins live only in `package.json`,
`package-lock.json` and the workflow files, where Dependabot updates them; this document
deliberately does not repeat them, so it can never drift from those sources. Transitive
dependencies are pinned by the committed lockfile. The official GitHub Dependency Review action
evaluates manifest and lockfile changes on every pull request, the Enterprise license-compliance
rule validates licenses, and the public-site workflows install the committed npm lockfile with
lifecycle scripts disabled and run npm signature and advisory checks. The repository intentionally
has no parallel scanner, pin auditor, containerized Zizmor runtime, or policy wrapper of its own.

Licenses below were read from each package's own published manifest or from its upstream
repository, not inferred.

## Repository root — `package.json`

| Component  | License           | Scope       | Source                                   |
| ---------- | ----------------- | ----------- | ---------------------------------------- |
| commonmark | BSD-2-Clause      | development | https://www.npmjs.com/package/commonmark |
| prettier   | MIT               | development | https://www.npmjs.com/package/prettier   |
| wrangler   | MIT OR Apache-2.0 | development | https://www.npmjs.com/package/wrangler   |

## GitHub Actions

The table lists each external Action repository invoked directly by the
versioned workflows.

| Component                          | License                                                                       | Source                                              | Purpose                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| `actions/checkout`                 | [MIT](https://github.com/actions/checkout/blob/main/LICENSE)                  | https://github.com/actions/checkout                 | Read repository content and complete Git history                          |
| `actions/setup-node`               | [MIT](https://github.com/actions/setup-node/blob/main/LICENSE)                | https://github.com/actions/setup-node               | Install the Node.js runtime used by public-site validation and deployment |
| `cloudflare/wrangler-action`       | [Apache-2.0](https://github.com/cloudflare/wrangler-action/blob/main/LICENSE) | https://github.com/cloudflare/wrangler-action       | Deploy the organization site to Cloudflare Pages                          |
| `github/codeql-action`             | [MIT](https://github.com/github/codeql-action/blob/main/LICENSE)              | https://github.com/github/codeql-action             | Upload the Scorecard SARIF to code scanning                               |
| `actions/dependency-review-action` | [MIT](https://github.com/actions/dependency-review-action/blob/main/LICENSE)  | https://github.com/actions/dependency-review-action | Review dependency changes on pull requests                                |
| `linear/linear-release-action`     | [MIT](https://github.com/linear/linear-release-action/blob/main/LICENSE)      | https://github.com/linear/linear-release-action     | Create repository releases in the corresponding Linear pipeline           |
| `actions/configure-pages`          | [MIT](https://github.com/actions/configure-pages/blob/main/LICENSE)           | https://github.com/actions/configure-pages          | Configure the GitHub Pages build                                          |
| `actions/deploy-pages`             | [MIT](https://github.com/actions/deploy-pages/blob/main/LICENSE)              | https://github.com/actions/deploy-pages             | Deploy the trusted GitHub Pages artifact                                  |
| `actions/upload-pages-artifact`    | [MIT](https://github.com/actions/upload-pages-artifact/blob/main/LICENSE)     | https://github.com/actions/upload-pages-artifact    | Package and upload the public-site artifact                               |
| `actions/upload-artifact`          | [MIT](https://github.com/actions/upload-artifact/blob/main/LICENSE)           | https://github.com/actions/upload-artifact          | Retain the Scorecard SARIF artifact                                       |
| `ossf/scorecard-action`            | [Apache-2.0](https://github.com/ossf/scorecard-action/blob/main/LICENSE)      | https://github.com/ossf/scorecard-action            | Assess supply-chain posture                                               |
| `zizmorcore/zizmor-action`         | [MIT](https://github.com/zizmorcore/zizmor-action/blob/main/LICENSE)          | https://github.com/zizmorcore/zizmor-action         | Audit GitHub Actions and upload SARIF                                     |

`github/codeql-action` is MIT-licensed, while the CodeQL CLI bundle selected by
the Action is separately governed by the
[GitHub CodeQL Terms and Conditions](https://github.com/github/codeql-cli-binaries/blob/main/LICENSE.md)
and the Enterprise GitHub Code Security entitlement.

## Vendored GitHub brand asset — inline `mark-github-16`

The two inline SVG paths in `site/index.html` are byte-for-byte copies of the
official `mark-github-16.svg` path from Primer Octicons `v19.33.0`, at immutable
commit `cc4e12df6ff8292447ba9141eaa2a6f6e1c59a85` and Git blob
`0e55a8ef2db1913cb35f81ae09ffdb58b5422319`.

| Component                            | Version             | Code license and brand terms                                                                                                                                                                        | Scope                                                                                            | Immutable source                                                                                          |
| ------------------------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| GitHub Invertocat (`mark-github-16`) | Octicons `v19.33.0` | Octicons code: MIT; GitHub mark: [GitHub Logo Policy](https://docs.github.com/en/site-policy/other-site-policies/github-logo-policy) and [Brand Toolkit](https://brand.github.com/foundations/logo) | organization link in the primary navigation; GitHub followers indicator in the organization card | https://github.com/primer/octicons/blob/cc4e12df6ff8292447ba9141eaa2a6f6e1c59a85/icons/mark-github-16.svg |

### Octicons MIT license notice

The following is the complete, unmodified `LICENSE` text from immutable Octicons
commit `cc4e12df6ff8292447ba9141eaa2a6f6e1c59a85` (Git blob
`aa1fa80ed83cf856fb31c22ba56557c42ca84488`, SHA-256
`da259c8bd0de62713ccdcf88910aebca810644f98c2c912bad814fc79ea778df`):

```text
MIT License

Copyright (c) 2026 GitHub Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Separate GitHub mark terms

The Octicons repository directs users of GitHub logos to the GitHub logo
guidelines; its MIT code license does not replace the separate trademark and
brand conditions for the mark. The primary-navigation use accompanies an
outbound link to the GitHub organization. The organization-card use is a
non-interactive metric indicator identifying GitHub as the source and context
of the adjacent follower count. Both remain secondary to the LCV Ideas &
Software identity and do not imply GitHub affiliation or endorsement.

At this revision, `svg.github-mark` fixes both marks to pure white (`#fff`), one
of the explicitly permitted colors and the highest-contrast option on their
dark backgrounds. The path geometry, proportions and aspect ratio are the
official asset; no gradient, shadow, distortion or other effect is applied.

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

| Component         | Variant                                 | Terms                                                                                    | Scope                     | Immutable source                                                                                        |
| ----------------- | --------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------- |
| Mercado Pago logo | `MP_RGB_HANDSHAKE_color_horizontal.png` | Proprietary — Mercado Pago brand terms, _Versión Marzo 2025_, shipped inside the package | published on sponsor page | https://http2.mlstatic.com/storage/pog-cm-admin/calm-assets/Logos%20Mercado%20Pago%202025--fb6f16c9.zip |

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
read _Pagamento processado por Mercado Pago_. No sponsorship, endorsement, partnership, or
affiliation is implied or claimed.

### Compliance with the published rules, verified at this SHA

| Rule                                                                  | Source              | State at this SHA                                               |
| --------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------- |
| RGB assets are for digital use, web pages included                    | package terms sheet | rendered by `site/sponsor/index.html`                           |
| PNG may be used at the supplied size or smaller, never enlarged       | package terms sheet | supplied 1049×426, rendered 69×28                               |
| Do not condense, stretch, or deform; keep the iso-to-logo proportion  | brand page          | 1049 ÷ 426 = 2.4624; 69 ÷ 28 = 2.4643                           |
| Do not alter colours or typography, and apply no shadows or effects   | brand page          | file byte-identical, and `.mp-logo` carries no shadow or effect |
| Colour versions may be placed on a white background                   | brand page          | `.mp-logo` sets `background: #ffffff`, fully opaque             |
| Never on institutional cyan, institutional blue, or non-brand colours | brand page          | the opaque badge is the only surface behind the mark            |

Byte identity settles the stored artwork, not what the browser paints. The last three rows are
therefore evidenced from the page's own rules rather than from the file digest: `.mp-logo` applies
no `box-shadow`, `filter`, `opacity`, or other effect, and its background is fully opaque, so the
dark panel gradient behind the panel never shows through under the mark.

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
