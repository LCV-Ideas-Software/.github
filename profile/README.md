<p align="center">
  <img src="./assets/lcv-ideas-software-logo.svg" alt="LCV Ideas &amp; Software" width="320">
</p>

<h1 align="center">LCV Ideas &amp; Software</h1>

<p align="center">
  <em>Independent software studio building public web apps, operator tooling, and AI agent infrastructure on Cloudflare's edge.</em>
</p>

<p align="center">
  <a href="https://github.com/LCV-Ideas-Software"><img src="https://img.shields.io/badge/org-verified-blueviolet.svg" alt="verified org"></a>
  <a href="https://www.lcv.dev"><img src="https://img.shields.io/badge/homepage-www.lcv.dev-blue.svg" alt="www.lcv.dev"></a>
  <img src="https://img.shields.io/badge/location-Brazil-green.svg" alt="Brazil">
  <img src="https://img.shields.io/badge/repos-12%20public-informational.svg" alt="12 public repos">
  <img src="https://img.shields.io/badge/edge-Cloudflare%20Pages%20%2B%20Workers-orange.svg" alt="Cloudflare">
  <img src="https://img.shields.io/badge/AI-Claude%20%2B%20Codex%20%2B%20Gemini-7c3aed.svg" alt="multi-agent AI">
  <a href="https://github.com/sponsors/lcv-leo"><img src="https://img.shields.io/badge/sponsor-%E2%9D%A4-ff69b4.svg" alt="Sponsor on GitHub"></a>
</p>

LCV Ideas &amp; Software is a software organization maintained by **Leonardo Cardozo Vargas**. It builds AI-assisted public-facing web applications, editorial tooling, infrastructure services, and developer utilities — all on a shared Cloudflare edge stack (Pages + Workers + D1) integrated with leading AI providers (Claude, Codex, Gemini, DeepSeek). Org homepage: **[www.lcv.dev](https://www.lcv.dev)**.

---

## What we build

A small, opinionated portfolio organized in three layers, all sharing the same Cloudflare edge runtime and a single unified D1 database (`bigdata_db`):

1. **Public products** — consumer-facing web apps with AI assistance, deployed on Cloudflare Pages with Worker backends.
2. **Operator infrastructure** — the single-tenant control plane and admin micro-modules that govern the public products.
3. **Developer tooling** — open-source MCP servers and editorial workbenches built around multi-agent AI convergence.

Every repository is published on GitHub under the `LCV-Ideas-Software` organization and ships with its own Pages site under the `lcv.dev` zone (custom domains, HTTPS-enforced). Everything is delivered under a strict **trilateral cross-review discipline** (three independent top-tier AI peers — Claude, Codex, Gemini — must converge before any merge), version-pinned baselines, CodeQL Default Setup, Secret Scanning push protection, and SHA-pinned GitHub Actions.

---

## Repositories

### 🌐 Public-facing applications

| Repository | Live | What it does |
| --- | --- | --- |
| [**mainsite-app**](https://github.com/LCV-Ideas-Software/mainsite-app) | [reflexosdaalma.blog](https://www.reflexosdaalma.blog) | *Reflexos da Alma* — public personal blog + companion services. React 19 + Vite 8 SPA on Cloudflare Pages + Hono Worker. Post reader with smart polling, comments and ratings with GCP NL sentiment moderation, Gemini AI public chatbot, share-by-email, donations (SumUp + PIX), SSR OG and JSON-LD metadata, R2 media. |
| [**astrologo-app**](https://github.com/LCV-Ideas-Software/astrologo-app) | [astrologo-app.lcv.dev](https://astrologo-app.lcv.dev) | *Astrólogo* — birth chart generator and esoteric analysis via Gemini AI. React 19 + Vite 8 on Cloudflare Pages with D1 backing store. Deterministic astrometric calculation + AI narrative; throttling, optional auth, share-by-email. |
| [**calculadora-app**](https://github.com/LCV-Ideas-Software/calculadora-app) | [calculadora-app.lcv.dev](https://calculadora-app.lcv.dev) | *Calculadora Financeira* — international FX simulator (credit card vs. multi-currency account) with AI-driven contextual analysis. React 19 + Vite 8 on Cloudflare Pages + D1. Integrates PTAX (BCB), Spot (AwesomeAPI), and Gemini AI. Modeled on Itaú's published methodology. |
| [**oraculo-financeiro**](https://github.com/LCV-Ideas-Software/oraculo-financeiro) | [oraculo-financeiro-app.lcv.dev](https://oraculo-financeiro-app.lcv.dev) | *Oráculo Financeiro* — IPCA-indexed fixed-income analysis dashboard (LCI/CDB IPCA+, Tesouro IPCA+) with Gemini contextual insights. React 19 + Vite 8 on Cloudflare Pages + D1 + Cron Worker for daily IPCA rate pre-warming. |
| [**apphub**](https://github.com/LCV-Ideas-Software/apphub) | [apphub.lcv.dev](https://apphub.lcv.dev) | Cloudflare Pages portal hub. Static landing + PWA dispatcher routing visitors to the sub-application fleet via a configurable card-grid UI backed by D1. |

### 🛠️ Operator infrastructure

| Repository | Live | What it does |
| --- | --- | --- |
| [**admin-app**](https://github.com/LCV-Ideas-Software/admin-app) | [admin-app.lcv.dev](https://admin-app.lcv.dev) | Operator admin dashboard for the multi-app Cloudflare workspace. Single-tenant by design. React 19 + Vite 8 on Pages + Hono Worker, gated by Cloudflare Access (Zero Trust JWT). 13 modules: post editor, AI model selection, financial reports (SumUp), DNS CRUD, Pages and Workers lifecycle, MTA-STS, TLS-RPT ingestion, operational telemetry. |
| [**adminapps**](https://github.com/LCV-Ideas-Software/adminapps) | [adminapps.lcv.dev](https://adminapps.lcv.dev) | React-based admin micro-modules on Cloudflare Pages. Composable card-grid UI for compliance surfaces (license panel, third-party attribution). |
| [**mtasts-motor**](https://github.com/LCV-Ideas-Software/mtasts-motor) | [mtasts-motor.lcv.dev](https://mtasts-motor.lcv.dev) | Cloudflare Worker serving dynamic [MTA-STS](https://datatracker.ietf.org/doc/html/rfc8461) policies from a D1 backing store. Designed for multi-domain operators behind the `mta-sts.<domain>` subdomain convention (RFC 8461). |

### 🤖 Developer tooling

| Repository | Live | What it does |
| --- | --- | --- |
| [**cross-review-v1**](https://github.com/LCV-Ideas-Software/cross-review-v1) | [cross-review-v1.lcv.dev](https://cross-review-v1.lcv.dev) | CLI-only MCP stdio server orchestrating structured review sessions between Claude Code, ChatGPT Codex, Gemini CLI, and the embedded DeepSeek CLI. Strict-only convergence: a session is `READY` only when caller and every responded peer return `READY`. Published on npm as [`@lcv-ideas-software/cross-review-v1`](https://www.npmjs.com/package/@lcv-ideas-software/cross-review-v1). |
| [**cross-review-v2**](https://github.com/LCV-Ideas-Software/cross-review-v2) | [cross-review-v2.lcv.dev](https://cross-review-v2.lcv.dev) | API-first MCP stdio server for multi-model cross-review using official provider APIs for OpenAI, Anthropic, Gemini and DeepSeek. No CLI execution; automated releases publish npmjs.com and GitHub Packages artifacts as [`@lcv-ideas-software/cross-review-v2`](https://www.npmjs.com/package/@lcv-ideas-software/cross-review-v2). |
| [**maestro-app**](https://github.com/LCV-Ideas-Software/maestro-app) | [maestro-app.lcv.dev](https://maestro-app.lcv.dev) | *Maestro Editorial AI* — portable Windows editorial workbench (Tauri 2 + React 19) for protocol-driven AI drafting, source verification, and multi-agent editorial convergence using Claude, Codex, Gemini, and DeepSeek. Resumable sessions, NDJSON diagnostic logs, runtime data stays local. |

---

## Shared platform

```
Frontend     React 19 + Vite 8 + TypeScript
Runtime      Cloudflare Pages (static + SSR) + Cloudflare Workers (Hono)
Database     Cloudflare D1   (single shared bigdata_db)
Storage      Cloudflare R2   (mainsite-media bucket)
Auth         Cloudflare Access (Zero Trust JWT) — operator surfaces
AI           Claude Code · ChatGPT Codex · Gemini CLI · DeepSeek
Email        Resend
Payments     SumUp + PIX
Anti-abuse   Cloudflare Turnstile + GCP Natural Language
Desktop      Tauri 2  (Maestro)
```

- **One database.** All consumer products and the operator control plane share `bigdata_db`. Cross-app reads use Cloudflare bindings in-place, never public URLs between sibling apps.
- **One bucket.** `mainsite-media` (R2) is shared by `mainsite-app` and `admin-app`. Magic-byte sniffing, allowlisted MIME types, 10 MB cap, SVG-sandboxed legacy fallback.
- **Defense in depth.** Cloudflare Access gates *who* enters admin surfaces; CSP gates *what* the browser can execute on public surfaces; Turnstile gates form anti-abuse; GCP Natural Language scores comment moderation.

---

## Engineering practices

- **Trilateral cross-review before every merge.** No commit is pushed without a `cross-review-v1` or `cross-review-v2` session reaching trilateral `READY` (caller + two peers). Even doc-only changes pass through the gate. Operator directive 2026-04-26.
- **Frozen-public-surface semver** for tooling. `cross-review-v1` v1.x ships additive patches only; minor bumps are reserved for new MCP tools; major bumps require a new trilateral cross-review session.
- **Sequential thinking is mandatory.** All planning passes through `ultrathink` and/or `code-reasoning` MCP servers before execution. Hard gate, not a suggestion.
- **CodeQL Default Setup everywhere.** Advanced Setup requires explicit operator authorization. Branch protection on `main` requires `Analyze (javascript-typescript)` to pass.
- **Conservative branch baseline.** Single deploy branch (`main`); `preview → main` automation via auto-merge with retry polling on required checks.
- **Anti-drift smoke.** `cross-review-v1` and `cross-review-v2` self-tests check that README, runtime version and CHANGELOG heading stay in lockstep on every push.
- **Memory parity** across Claude Code, GitHub Copilot, and Gemini Code Assist. New directives propagate to all three agent ecosystems before being considered shipped.
- **SHA-pinned GitHub Actions.** Supply-chain hardening baseline. `wrangler` is always invoked at `latest` in CI.

---

## Licensing

| License | Repositories |
| --- | --- |
| [AGPL-3.0-or-later](https://www.gnu.org/licenses/agpl-3.0.html) | `mainsite-app`, `astrologo-app`, `calculadora-app`, `oraculo-financeiro`, `apphub`, `admin-app`, `adminapps`, `mtasts-motor`, `maestro-app` |
| [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | `cross-review-v1`, `cross-review-v2` |

The AGPL-3.0 **network-service trigger** applies to the AGPL repositories: running a modified fork as a public service obligates publication of the modifications under the same license. Each repository ships a `THIRDPARTY.md` inventory and a `NOTICE` (where applicable). Forks are welcome under the respective license terms.

---

## Conventions

- **Security**: GitHub Secret Scanning, Code Scanning (CodeQL), and Dependabot are active across all repositories. Vulnerability disclosures follow each repository's `SECURITY.md`.
- **Contributing**: Each repository carries its own `CONTRIBUTING.md`. PRs require green CI gates locally before submission.
- **Code of Conduct**: Contributor Covenant 2.1. See each repository's `CODE_OF_CONDUCT.md`.

---

## Contact and support

- **Homepage**: [www.lcv.dev](https://www.lcv.dev)
- **Public blog**: [www.reflexosdaalma.blog](https://www.reflexosdaalma.blog) (the `mainsite-app` product)
- **GitHub**: opening issues on the relevant repository is the canonical channel.
- **Email**: [github@lcvmail.com](mailto:github@lcvmail.com) for org-wide topics.
- **Sponsorship**: support the work via GitHub Sponsors → [github.com/sponsors/lcv-leo](https://github.com/sponsors/lcv-leo).

---

<p align="center"><sub>© Leonardo Cardozo Vargas — built on Cloudflare's edge, reviewed by three AI peers.</sub></p>
