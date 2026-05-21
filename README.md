<p align="center">
  <img src="profile/assets/lcv-ideas-software-logo.svg" alt="LCV Ideas &amp; Software" width="520" />
</p>

# `.github` — LCV Ideas &amp; Software

[![Pages](https://github.com/LCV-Ideas-Software/.github/actions/workflows/pages.yml/badge.svg)](https://github.com/LCV-Ideas-Software/.github/actions/workflows/pages.yml)
[![Cloudflare Pages](https://github.com/LCV-Ideas-Software/.github/actions/workflows/cloudflare-pages.yml/badge.svg)](https://github.com/LCV-Ideas-Software/.github/actions/workflows/cloudflare-pages.yml)
[![Public Format](https://github.com/LCV-Ideas-Software/.github/actions/workflows/format-public.yml/badge.svg)](https://github.com/LCV-Ideas-Software/.github/actions/workflows/format-public.yml)
[![CodeQL](https://github.com/LCV-Ideas-Software/.github/actions/workflows/codeql.yml/badge.svg)](https://github.com/LCV-Ideas-Software/.github/actions/workflows/codeql.yml)
[![license: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](./LICENSE)
Institutional repository for the organization profile and shared community-health defaults across LCV Ideas & Software repositories.

**Status.** Active institutional repository. Current release: **not versioned**. See the version-history table below for the full change history.

This repository hosts the **organization profile** rendered at <https://github.com/LCV-Ideas-Software> and any community health files (issue templates, code of conduct, contributing guides, etc.) shared as defaults across the organization.

- The org-profile content lives in [`profile/README.md`](./profile/README.md). GitHub renders it on the organization landing page automatically.
- The static organization site lives in [`site/`](./site/) and is deployed from that directory as the root of the Cloudflare Pages project `org-site`, whose canonical public domain is <https://www.lcv.dev>.
- The sponsor landing page lives in [`site/sponsor/`](./site/sponsor/) and renders MercadoPago.js V2 Card Payment Brick secure fields backed by the dedicated `sponsor-motor` Worker at `https://sponsor-motor.lcv.app.br`.
- Dependabot covers GitHub Actions plus the root npm toolchain used for public-site formatting checks.
- Per-repository community health files (e.g. `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`) defined here apply org-wide unless the individual repository overrides them.

The version history at a glance:

| Change  | Notes                                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------- |
| Current | Active institutional repository for the org profile, static organization site, sponsor page, and shared community defaults. |

For product-specific documentation, see each repository in the [organization listing](https://github.com/orgs/LCV-Ideas-Software/repositories).

## Repository conventions

- **License**: [AGPL-3.0-or-later](./LICENSE). Network-service trigger applies: running a modified fork as a public service obligates you to publish modifications.
- **Notices**: see [NOTICE](./NOTICE) and [THIRDPARTY](./THIRDPARTY.md).
- **Security disclosure**: see [SECURITY.md](./SECURITY.md).
- **Code of conduct**: see [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
- **Contributing**: see [CONTRIBUTING.md](./CONTRIBUTING.md).
- **Sponsorship**: see the repo's `Sponsor` button or [central sponsor page](https://www.lcv.dev/sponsor).
- **Action pinning**: all GitHub Actions are pinned by full SHA per supply-chain hardening baseline.
- **Code owners**: [.github/CODEOWNERS](.github/CODEOWNERS).

## Links

- Site: [https://www.lcv.dev](https://www.lcv.dev)
- GitHub: [https://github.com/LCV-Ideas-Software/.github](https://github.com/LCV-Ideas-Software/.github)
- Sponsors: [https://github.com/sponsors/LCV-Ideas-Software](https://github.com/sponsors/LCV-Ideas-Software)

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE), [NOTICE](./NOTICE), and [THIRDPARTY](./THIRDPARTY.md).

---

<p align="center"><span style="font-size: 1.5em;"><strong>Copyright © 2026 LCV Ideas &amp; Software</strong></span><br><sub>LEONARDO CARDOZO VARGAS TECNOLOGIA DA INFORMACAO LTDA<br>Rua Pais Leme, 215 Conj 1713 - Pinheiros<br>São Paulo - SP - CEP 05424-150<br>CNPJ: 66.584.678/0001-77 - IM: 3039854</sub></p>
