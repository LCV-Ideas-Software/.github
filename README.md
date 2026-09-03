<p align="center">
  <img src="profile/assets/lcv-ideas-software-logo.svg" alt="LCV Ideas &amp; Software" width="520" />
</p>

# `.github` — LCV Ideas &amp; Software

[![Pages](https://github.com/LCV-Ideas-Software/.github/actions/workflows/pages.yml/badge.svg)](https://github.com/LCV-Ideas-Software/.github/actions/workflows/pages.yml)
[![Cloudflare Pages](https://github.com/LCV-Ideas-Software/.github/actions/workflows/cloudflare-pages.yml/badge.svg)](https://github.com/LCV-Ideas-Software/.github/actions/workflows/cloudflare-pages.yml)
[![license: proprietary](https://img.shields.io/badge/license-proprietary-lightgrey.svg)](./LICENSE)
Institutional repository for the organization profile and shared community-health defaults across LCV Ideas & Software repositories.

**Status.** Active institutional repository. Current release: **not versioned** — it publishes surfaces rather than a numbered artifact. Notable changes are recorded in [`CHANGELOG.md`](./CHANGELOG.md).

This repository hosts the **organization profile** rendered at <https://github.com/LCV-Ideas-Software> and any community health files (issue templates, code of conduct, contributing guides, etc.) shared as defaults across the organization.

- The org-profile content lives in [`profile/README.md`](./profile/README.md). GitHub renders it on the organization landing page automatically.
- The static organization site lives in [`site/`](./site/) and is deployed with the official Wrangler Action as the root of the Cloudflare Pages project `org-site`, whose canonical public domain is <https://www.lcv.dev>.
- The sponsor landing page lives in [`site/sponsor/`](./site/sponsor/) and renders MercadoPago.js V2 Card Payment Brick secure fields backed by the dedicated `sponsor-motor` Worker at `https://sponsor-motor.lcv.app.br`.
- Dependabot checks GitHub Actions and npm weekly, groups minor and patch updates per ecosystem, and automatically rebases its pull requests. Official Actions under `actions/*` and `github/*` are evaluated immediately; third-party GitHub Actions and npm apply a seven-day cooldown to ordinary version updates. The cooldown does not apply to security updates.
- The Pages workflow uses GitHub's official Pages Actions and includes the public-site formatting, npm provenance-signature, and advisory checks in its artifact build.
- CodeQL runs through GitHub's code scanning default setup, without a workflow file. Dependency Review, Zizmor, and OpenSSF Scorecard invoke their official Actions directly, pinned by full commit SHA. Repository-owned SARIF gates, policy manifests, lockfiles, workflow-contract validators, and scanner wrappers are intentionally absent.
- Linear Release uses Linear's official Action, pinned to the immutable commit of `v0.17.2`, to mirror every `main` commit into the continuous `.github-org` pipeline. This does not introduce a numbered artifact or an organization-wide controller; it records only this repository's own releases. The upstream installer verifies the downloaded CLI against a published SHA-256 checksum before executing it.
- Pull requests reach `main` only through squash, under the Enterprise rulesets. Dependabot pull requests receive GitHub's native auto-merge from `.github/workflows/dependabot-auto-merge.yml`, a repository-local workflow that runs no Action and uses a fine-grained personal access token stored as the Dependabot secret `DEPENDABOT_AUTOMERGE_TOKEN`; GitHub performs the merge only once every rule and check is satisfied. There is no merge queue, GitHub App, or organization-wide controller.
- Per-repository community health files (e.g. `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`) defined here apply org-wide unless the individual repository overrides them.

Organization-wide operational systems, reusable actions, controllers, schedulers, canaries, and
private runbooks are intentionally absent from this public institutional repository. Their
implementation and operation belong in `github-operations`. The workflows retained here act only
on this repository's own pull requests, public institutional surfaces, and security posture; they
are not organization-wide control systems.

Changes from 11/08/2026 onward are recorded in [`CHANGELOG.md`](./CHANGELOG.md), grouped by date, each linked to the pull request that carried it or, for changes that are repository settings rather than files, to the issue holding their execution trail. Earlier work is not summarized there; the commit history remains its record.

For product-specific documentation, see each repository in the [organization listing](https://github.com/orgs/LCV-Ideas-Software/repositories).

## Repository conventions

- **License**: proprietary — **All rights reserved**. Public visibility exists for GitHub's special `.github` features and grants no rights beyond those provided by the applicable [GitHub Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service) through the platform.
- **Notices**: see [NOTICE](./NOTICE) and [THIRDPARTY](./THIRDPARTY.md).
- **Security disclosure**: see [SECURITY.md](./SECURITY.md).
- **Code of conduct**: see [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
- **Contributing**: see [CONTRIBUTING.md](./CONTRIBUTING.md).
- **Inbound rights for this repository**: see [INBOUND.md](./INBOUND.md).
- **Support**: see [SUPPORT.md](./SUPPORT.md).
- **Sponsorship**: see this repository's `Sponsor` button or [central sponsor page](https://www.lcv.dev/sponsor/).
- **Action pinning**: all external GitHub Actions are pinned by full commit SHA per supply-chain hardening baseline.
- **Code owners**: [.github/CODEOWNERS](.github/CODEOWNERS).

## Links

- Site: [https://www.lcv.dev](https://www.lcv.dev)
- GitHub organization: [LCV-Ideas-Software](https://github.com/LCV-Ideas-Software)
- Repository: [.github](https://github.com/LCV-Ideas-Software/.github)
- Sponsors: [https://github.com/sponsors/lcv-ideas-software](https://github.com/sponsors/lcv-ideas-software)

## License

Copyright © 2026 LCV Ideas & Software. The original content of this
repository owned by LCV Ideas & Software is proprietary and **all rights are
reserved**. Third-party and
contributor-owned material remains subject to its own documented terms.
Public visibility permits viewing and forking through GitHub as provided by
the applicable GitHub Terms of Service; it does not grant an additional
public license. See the
[GitHub Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service),
[LICENSE](./LICENSE), [NOTICE](./NOTICE), and
[THIRDPARTY](./THIRDPARTY.md).

---

<p align="center"><strong>Copyright © 2026 LCV Ideas &amp; Software</strong><br><sub>LEONARDO CARDOZO VARGAS TECNOLOGIA DA INFORMACAO LTDA<br>Rua Pais Leme, 215 Conj 1713 - Pinheiros<br>São Paulo - SP - CEP 05424-150<br>CNPJ: 66.584.678/0001-77 - IM: 3039854</sub></p>
