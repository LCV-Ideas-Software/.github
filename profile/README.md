<p align="center">
  <img src="./assets/lcv-ideas-software-logo.svg" alt="LCV Ideas &amp; Software" width="520" />
</p>

<h1 align="center">LCV Ideas &amp; Software</h1>

<p align="center">
  <em>Independent software studio building public web apps, operator tooling, and AI agent infrastructure on Cloudflare's edge.</em>
</p>

<p align="center">
  <a href="https://github.com/LCV-Ideas-Software"><img src="https://img.shields.io/badge/org-verified-38bdf8.svg" alt="verified org"></a>
  <a href="https://www.lcv.dev"><img src="https://img.shields.io/badge/homepage-www.lcv.dev-2563eb.svg" alt="www.lcv.dev"></a>
  <img src="https://img.shields.io/badge/location-Brazil-34d399.svg" alt="Brazil">
  <img src="https://img.shields.io/badge/repos-11%20public-7dd3fc.svg" alt="11 public repos">
  <img src="https://img.shields.io/badge/edge-Cloudflare%20Pages%20%2B%20Workers-f59e0b.svg" alt="Cloudflare">
  <img src="https://img.shields.io/badge/AI-6%20agent%20stack-34d399.svg" alt="6-agent AI stack">
  <a href="../SECURITY.md"><img src="https://img.shields.io/badge/security-CodeQL%20%2B%20private%20reporting-brightgreen.svg" alt="security policy"></a>
  <a href="../LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="AGPL-3.0-or-later"></a>
  <a href="https://www.lcv.dev/sponsor/"><img src="https://img.shields.io/badge/sponsor-%E2%9D%A4-ff69b4.svg" alt="Sponsor LCV Ideas & Software"></a>
</p>

LCV Ideas &amp; Software is an independent vibe-coding studio. It builds AI-assisted public-facing web applications, editorial tooling, infrastructure services, sponsor infrastructure, and developer utilities — primarily on a Cloudflare edge stack (Pages + Workers + D1) integrated with leading AI providers (Claude, Codex, Gemini, DeepSeek, Grok, Perplexity). Public homepage: **[www.lcv.dev](https://www.lcv.dev)**.

---

## Change History

**Status.** Active organization profile. Current release: **not versioned**. See the version-history table below for the full change history.

The version history at a glance:

| Change  | Notes                                                                                                 |
| ------- | ----------------------------------------------------------------------------------------------------- |
| Current | Organization profile and repository catalog for LCV Ideas & Software public repositories and services. |

---

## What we build

A small, opinionated portfolio organized in three layers, with its web services centered on Cloudflare's edge:

1. **Public products** — consumer-facing web apps with AI assistance, deployed on Cloudflare Pages with Worker backends.
2. **Operator infrastructure** — the single-tenant control plane and supporting services that govern the public products.
3. **Developer tooling** — open-source MCP servers and editorial workbenches built around multi-agent AI convergence.

The organization maintains 11 active public repositories, including its institutional `.github` repository. Product and tooling repositories expose public project surfaces or operational endpoints over HTTPS on custom domains. Engineering work follows strict **multi-peer cross-review discipline** with caller self-review prohibited, version-pinned baselines, CodeQL Advanced Setup on public code repositories, Secret Scanning push protection, and SHA-pinned external GitHub Actions.

---

## Repositories

### 🌐 Public-facing applications

| Repository                                                                         | Product / project page                                                   | What it does                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**mainsite-app**](https://github.com/LCV-Ideas-Software/mainsite-app)             | [www.reflexosdaalma.blog](https://www.reflexosdaalma.blog/)               | _Reflexos da Alma_ — public content site + companion services. React 19 + Vite 8 SPA on Cloudflare Pages + Hono Worker. Post reader with smart polling, comments and ratings with GCP NL sentiment moderation, Gemini AI public chatbot, share-by-email, SSR OG and JSON-LD metadata, R2 media. Sponsor/payment handling lives outside MainSite in `sponsor-motor`.     |
| [**astrologo-app**](https://github.com/LCV-Ideas-Software/astrologo-app)           | [mapa-astral.lcv.app.br](https://mapa-astral.lcv.app.br/)                 | _Oráculo Celestial_ — birth chart generator and esoteric analysis via Gemini AI. React 19 + Vite 8 on Cloudflare Pages with D1 backing store. Deterministic astrometric calculation + AI narrative; throttling, optional auth, share-by-email.                                                                                                                               |
| [**calculadora-app**](https://github.com/LCV-Ideas-Software/calculadora-app)       | [calculadora.lcv.app.br](https://calculadora.lcv.app.br/)                 | _Calculadora Financeira_ — international FX simulator (credit card vs. multi-currency account) with AI-driven contextual analysis. React 19 + Vite 8 on Cloudflare Pages + D1. Integrates PTAX (BCB), Spot (AwesomeAPI), and Gemini AI. Modeled on Itaú's published methodology.                                                                                     |
| [**oraculo-financeiro**](https://github.com/LCV-Ideas-Software/oraculo-financeiro) | [oraculo-financeiro.lcv.app.br](https://oraculo-financeiro.lcv.app.br/)   | _Oráculo Financeiro_ — IPCA-indexed fixed-income analysis dashboard (LCI/CDB IPCA+, Tesouro IPCA+) with Gemini contextual insights. React 19 + Vite 8 on Cloudflare Pages + D1 + Cron Worker for daily IPCA rate pre-warming.                                                                                                                                        |

### 🛠️ Operator infrastructure

| Repository                                                               | Product / service endpoint                                   | What it does                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [**admin-app**](https://github.com/LCV-Ideas-Software/admin-app)         | [admin.lcv.app.br](https://admin.lcv.app.br/)                | Operator admin dashboard for the multi-app Cloudflare workspace. Single-tenant by design. React 19 + Vite 8 on Pages + Hono Worker, gated by Cloudflare Access (Zero Trust JWT). Modules include post editor, AI model selection, DNS CRUD, Pages and Workers lifecycle, MTA-STS, TLS-RPT ingestion, and operational telemetry.      |
| [**mtasts-motor**](https://github.com/LCV-Ideas-Software/mtasts-motor)   | [mtasts-motor.lcv.dev](https://mtasts-motor.lcv.dev)         | Cloudflare Worker serving dynamic [MTA-STS](https://datatracker.ietf.org/doc/html/rfc8461) policies from a D1 backing store. Designed for multi-domain operators behind the `mta-sts.<domain>` subdomain convention (RFC 8461).                                                                                                      |
| [**sponsor-motor**](https://github.com/LCV-Ideas-Software/sponsor-motor) | [sponsor-motor.lcv.app.br](https://sponsor-motor.lcv.app.br/) | Dedicated Cloudflare Worker for the organization sponsor flow. Processes Mercado Pago Checkout Transparente orders through the official backend SDK, records minimal `sponsor_*` audit data in `bigdata_db`, validates signed webhooks, and backs the secure sponsor page at [www.lcv.dev/sponsor](https://www.lcv.dev/sponsor/). |

### 🤖 Developer tooling

| Repository                                                                 | Project page                                             | What it does                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**ultrabrain-mcp**](https://github.com/LCV-Ideas-Software/ultrabrain-mcp) | [ultrabrain-mcp.lcv.dev](https://ultrabrain-mcp.lcv.dev) | LCV-created local MCP reasoning gate for structured engineering thought, validation, branch synthesis, quality metrics, bias checks, prompts, resources, and review readiness. Published as [`@lcv-ideas-software/ultrabrain-mcp`](https://www.npmjs.com/package/@lcv-ideas-software/ultrabrain-mcp).                                                       |
| [**cross-review**](https://github.com/LCV-Ideas-Software/cross-review)     | [cross-review.lcv.dev](https://cross-review.lcv.dev)     | API-first MCP stdio server for multi-model cross-review using official provider APIs for OpenAI, Anthropic, Google Gemini, DeepSeek, xAI Grok and Perplexity. No CLI execution; automated releases publish npmjs.com and GitHub Packages artifacts as [`@lcv-ideas-software/cross-review`](https://www.npmjs.com/package/@lcv-ideas-software/cross-review). |
| [**maestro-app**](https://github.com/LCV-Ideas-Software/maestro-app)       | [maestro-app.lcv.dev](https://maestro-app.lcv.dev)       | _Maestro Editorial AI_ — portable Windows editorial workbench (Tauri 2 + React 19) supporting Claude, Codex, Gemini, DeepSeek, Grok, and Perplexity. Sessions, editorial artifacts, and NDJSON diagnostics remain local; configuration can optionally use Cloudflare D1 and Secrets Store.                                                             |

### 🏛️ Organization infrastructure

| Repository                                                          | Visibility | What it does                                                                                                                               |
| ------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [**.github**](https://github.com/LCV-Ideas-Software/.github)        | Public     | Organization profile, community-health defaults, policy documentation, public Pages/Sponsors surfaces, and the GitHub-to-Slack relay.      |

### Archived / discontinued

| Repository                                                                   | Status              | Note                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`apphub`**                   | Archived · private            | Discontinued because it no longer provided useful organizational value. The organization website at [www.lcv.dev](https://www.lcv.dev) is now the canonical public entry point.                                                                                                                                                                                                                |
| **`adminapps`**                | Archived · private            | Discontinued after all admin surfaces were consolidated into [admin-app](https://github.com/LCV-Ideas-Software/admin-app). Continuing `adminapps` no longer makes operational sense.                                                                                                                                                                                                           |
| **`cross-review-v1`**          | Archived · private · 15/05/2026 | Discontinued in favor of [`cross-review`](https://github.com/LCV-Ideas-Software/cross-review). The CLI-only MCP server was the first incarnation; the API-first rewrite under the canonical package name is the implementation going forward. npm `@lcv-ideas-software/cross-review-v1@1.12.11` remains published for historical use but is marked deprecated and receives no further updates. |
| **`grok-cli`**                 | Archived · private · 15/05/2026 | Discontinued. The npm package `@lcv-ideas-software/grok-cli` is published through version `1.6.5` and marked deprecated on npm; the private GitHub repository is read-only. Existing installs continue to function as-is.                                                                                                                                                                              |
| **`deepseek-cli`**             | Archived · private · 15/05/2026 | Discontinued. The npm package `@lcv-ideas-software/deepseek-cli` is published through version `0.3.3` and marked deprecated on npm; the private GitHub repository is read-only. Existing installs continue to function as-is.                                                                                                                                                                          |

---

## Shared platform

```
Frontend     React 19 + Vite 8 + TypeScript
Runtime      Cloudflare Pages (static + SSR) + Cloudflare Workers (Hono)
Database     Cloudflare D1 (`bigdata_db` for product services; dedicated infrastructure databases)
Storage      Cloudflare R2 (`mainsite-media`, shared by MainSite and Admin)
Auth         Cloudflare Access (Zero Trust JWT) — operator surfaces
AI           Claude Code · ChatGPT Codex · Gemini CLI · DeepSeek · Grok · Perplexity
Email        Resend
Sponsorship  sponsor-motor + Mercado Pago Checkout Transparente Orders API
Anti-abuse   Cloudflare Turnstile + GCP Natural Language
Desktop      Tauri 2  (Maestro)
```

- **D1 separation.** Consumer products and the operator control plane share `bigdata_db`; optional Maestro remote configuration uses `maestro_db`; the GitHub-to-Slack relay uses `github-slack-alerts-db`. Cross-app reads use Cloudflare bindings in-place, never public URLs between sibling apps.
- **One media bucket.** `mainsite-media` is shared by `mainsite-app` and `admin-app`. Upload handling uses magic-byte sniffing, allowlisted MIME types, a 10 MiB cap, and a sandboxed legacy SVG fallback.
- **Defense in depth.** Cloudflare Access gates _who_ enters admin surfaces; CSP gates _what_ the browser can execute on public surfaces; Turnstile gates form anti-abuse; GCP Natural Language scores comment moderation.

---

## Engineering practices

- **Structured reasoning and independent review.** Substantive operator-authored engineering changes use `ultrabrain` for structured reasoning and the `cross-review` MCP for independent review before they are declared complete. Caller/reviewer self-review is invalid. This is an operator-process control, not a required GitHub merge check.
- **Repository-specific quality gates.** Each change must pass the checks defined by the affected repository — formatting, linting, type checking, tests, builds, and security checks as applicable. Toolchains vary; there is no universal four-check chain.
- **CodeQL Advanced Setup.** Every active repository maintains an explicit `.github/workflows/codeql.yml` with the languages relevant to that repository. CodeQL is a required check on both pull request and `merge_group` revisions; its analyzer job enforces zero SARIF findings because native code-scanning merge protection does not cover merge-queue groups.
- **Native PR governance.** A pull request is required for every change to the default branch. Squash is the only merge method; eligible PRs use native auto-merge and the merge queue, with required checks repeated on the synthetic revision before GitHub creates a signed, single-parent squash. Default branches cannot be deleted or force-pushed, review conversations that exist must be resolved, and no actor has a ruleset bypass.
- **`cross-review` anti-drift checks.** In the `cross-review` repository, push CI verifies package/runtime version consistency and the expected release markers in `README.md`, `SECURITY.md`, and `CHANGELOG.md`.
- **Agent-instruction parity.** Program-wide directives are mirrored across the active agent environments as an operator process; GitHub does not enforce this parity.
- **Supply-chain baseline.** Organization policy requires external GitHub Actions to be pinned by full commit SHA. Cloudflare deployment workflows intentionally resolve `wrangler@latest` in an isolated prefix and verify package signatures and audit results before execution.

---

## Licensing

| License                                                         | Repositories                                                                                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [AGPL-3.0-or-later](https://www.gnu.org/licenses/agpl-3.0.html) | `.github`, `mainsite-app`, `astrologo-app`, `calculadora-app`, `oraculo-financeiro`, `apphub`, `admin-app`, `adminapps`, `mtasts-motor`, `maestro-app`, `sponsor-motor` |
| [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)       | `ultrabrain-mcp`, `cross-review`, `cross-review-v1` (archived), `deepseek-cli` (archived), `grok-cli` (archived)                                             |

The AGPL-3.0 **network-service trigger** applies to the AGPL repositories: running a modified fork as a public service obligates publication of the modifications under the same license. Public software repositories ship a `THIRDPARTY.md` inventory and a `NOTICE` (where applicable). Forks are welcome under the respective license terms.

---

## Conventions

- **Security**: Secret Scanning, push protection, and Dependabot security updates are enabled across every active repository. CodeQL Advanced Setup runs in all public repositories containing code; the empty internal `.github-private` configuration repository has no analyzable source. Vulnerability disclosures follow each public repository's `SECURITY.md`.
- **Contributing**: Every public repository carries its own `CONTRIBUTING.md`. PRs are optional; when used, contributors should run the repository-specific checks before submission. Direct signed pushes to `main` remain permitted.
- **Code of Conduct**: Every public repository follows Contributor Covenant 3.0 through its own `CODE_OF_CONDUCT.md`.

---

## Contact and support

- **Homepage**: [www.lcv.dev](https://www.lcv.dev)
- **GitHub**: opening issues on the relevant repository is the canonical channel.
- **Email**: [lcv@lcv.dev](mailto:lcv@lcv.dev) for general topics.
- **Phones**: [+55 (21) 3955-0883](https://wa.me/552139550883) / [+55 (21) 99152-4643](https://wa.me/5521991524643)
- **Sponsorship**: support the work through the secure sponsor page → [www.lcv.dev/sponsor](https://www.lcv.dev/sponsor/).

## Repository conventions

- **License**: [AGPL-3.0-or-later](../LICENSE). Network-service trigger applies: running a modified fork as a public service obligates you to publish modifications.
- **Notices**: see [NOTICE](../NOTICE) and [THIRDPARTY](../THIRDPARTY.md).
- **Security disclosure**: see [SECURITY.md](../SECURITY.md).
- **Code of conduct**: see [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md).
- **Contributing**: see [CONTRIBUTING.md](../CONTRIBUTING.md).
- **Sponsorship**: see the relevant repository's `Sponsor` button or [central sponsor page](https://www.lcv.dev/sponsor/).
- **Action pinning**: all external GitHub Actions are pinned by full commit SHA per supply-chain hardening baseline.
- **Code owners**: [.github/CODEOWNERS](../.github/CODEOWNERS).

## Links

- Site: [https://www.lcv.dev](https://www.lcv.dev)
- GitHub organization: [LCV-Ideas-Software](https://github.com/LCV-Ideas-Software)
- Organization profile source: [.github](https://github.com/LCV-Ideas-Software/.github)
- Sponsors: [https://github.com/sponsors/LCV-Ideas-Software](https://github.com/sponsors/LCV-Ideas-Software)

## License

AGPL-3.0-or-later. See [LICENSE](../LICENSE), [NOTICE](../NOTICE), and [THIRDPARTY](../THIRDPARTY.md).

---

<p align="center"><strong>Copyright © 2026 LCV Ideas &amp; Software</strong><br><sub>LEONARDO CARDOZO VARGAS TECNOLOGIA DA INFORMACAO LTDA<br>Rua Pais Leme, 215 Conj 1713 - Pinheiros<br>São Paulo - SP - CEP 05424-150<br>CNPJ: 66.584.678/0001-77 - IM: 3039854</sub></p>
