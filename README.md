<p align="center">
  <img src="profile/assets/lcv-ideas-software-logo.svg" alt="LCV Ideas &amp; Software" width="520" />
</p>

# `.github` — LCV Ideas &amp; Software

[![Pages](https://github.com/LCV-Ideas-Software/.github/actions/workflows/pages.yml/badge.svg)](https://github.com/LCV-Ideas-Software/.github/actions/workflows/pages.yml)
[![Cloudflare Pages](https://github.com/LCV-Ideas-Software/.github/actions/workflows/cloudflare-pages.yml/badge.svg)](https://github.com/LCV-Ideas-Software/.github/actions/workflows/cloudflare-pages.yml)
[![CodeQL](https://github.com/LCV-Ideas-Software/.github/actions/workflows/codeql.yml/badge.svg)](https://github.com/LCV-Ideas-Software/.github/actions/workflows/codeql.yml)
[![license: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](./LICENSE)
Institutional repository for the organization profile and shared community-health defaults across LCV Ideas & Software repositories.

**Status.** Active institutional repository. Current release: **not versioned** — it publishes surfaces rather than a numbered artifact. Notable changes are recorded in [`CHANGELOG.md`](./CHANGELOG.md).

This repository hosts the **organization profile** rendered at <https://github.com/LCV-Ideas-Software> and any community health files (issue templates, code of conduct, contributing guides, etc.) shared as defaults across the organization.

- The org-profile content lives in [`profile/README.md`](./profile/README.md). GitHub renders it on the organization landing page automatically.
- The static organization site lives in [`site/`](./site/) and is deployed from that directory as the root of the Cloudflare Pages project `org-site`, whose canonical public domain is <https://www.lcv.dev>.
- The sponsor landing page lives in [`site/sponsor/`](./site/sponsor/) and renders MercadoPago.js V2 Card Payment Brick secure fields backed by the dedicated `sponsor-motor` Worker at `https://sponsor-motor.lcv.app.br`.
- Dependabot checks GitHub Actions, npm, Deno, and the pinned Zizmor container daily and automatically rebases its pull requests. GitHub Actions updates are evaluated immediately; the other ecosystems apply a seven-day cooldown to ordinary version updates. Security updates are never delayed.
- The Pages workflow uses GitHub's official Pages Actions and includes the public-site formatting, npm provenance-signature, and advisory checks in its artifact build.
- Pull requests reach `main` only through squash and GitHub's native merge queue after authorized human admission; no repository-owned auto-merge or governance controller is used.
- Per-repository community health files (e.g. `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`) defined here apply org-wide unless the individual repository overrides them.
- The organization-wide GitHub-to-Slack alert relay lives in [`workers/github-slack-relay`](./workers/github-slack-relay); its architecture and operating procedure are documented in [`docs/GITHUB_SLACK_INTEGRATION.md`](./docs/GITHUB_SLACK_INTEGRATION.md).

The full change history lives in [`CHANGELOG.md`](./CHANGELOG.md), grouped by date and linked to the pull request that carried each change.

For product-specific documentation, see each repository in the [organization listing](https://github.com/orgs/LCV-Ideas-Software/repositories).

## Repository conventions

- **License**: [AGPL-3.0-or-later](./LICENSE). Network-service trigger applies: running a modified fork as a public service obligates you to publish modifications.
- **Notices**: see [NOTICE](./NOTICE) and [THIRDPARTY](./THIRDPARTY.md).
- **Security disclosure**: see [SECURITY.md](./SECURITY.md).
- **Code of conduct**: see [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
- **Contributing**: see [CONTRIBUTING.md](./CONTRIBUTING.md).
- **Sponsorship**: see this repository's `Sponsor` button or [central sponsor page](https://www.lcv.dev/sponsor/).
- **Action pinning**: all external GitHub Actions are pinned by full commit SHA per supply-chain hardening baseline.
- **Code owners**: [.github/CODEOWNERS](.github/CODEOWNERS).

## Links

- Site: [https://www.lcv.dev](https://www.lcv.dev)
- GitHub organization: [LCV-Ideas-Software](https://github.com/LCV-Ideas-Software)
- Repository: [.github](https://github.com/LCV-Ideas-Software/.github)
- Sponsors: [https://github.com/sponsors/LCV-Ideas-Software](https://github.com/sponsors/LCV-Ideas-Software)

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE), [NOTICE](./NOTICE), and [THIRDPARTY](./THIRDPARTY.md).

---

<p align="center"><strong>Copyright © 2026 LCV Ideas &amp; Software</strong><br><sub>LEONARDO CARDOZO VARGAS TECNOLOGIA DA INFORMACAO LTDA<br>Rua Pais Leme, 215 Conj 1713 - Pinheiros<br>São Paulo - SP - CEP 05424-150<br>CNPJ: 66.584.678/0001-77 - IM: 3039854</sub></p>
