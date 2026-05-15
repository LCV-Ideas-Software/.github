<p align="center">
  <img src="./assets/lcv-ideas-software-logo.svg" alt="LCV Ideas &amp; Software" width="320">
</p>

<h1 align="center">LCV Ideas &amp; Software</h1>

<p align="center">
  <em>Independent software studio building public web apps, operator tooling, and AI agent infrastructure on Cloudflare's edge.</em>
</p>

<p align="center">
  <a href="https://github.com/LCV-Ideas-Software"><img src="https://img.shields.io/badge/org-verified-38bdf8.svg" alt="verified org"></a>
  <a href="https://www.lcv.dev"><img src="https://img.shields.io/badge/homepage-www.lcv.dev-2563eb.svg" alt="www.lcv.dev"></a>
  <img src="https://img.shields.io/badge/location-Brazil-34d399.svg" alt="Brazil">
  <img src="https://img.shields.io/badge/repos-14%20public-7dd3fc.svg" alt="14 public repos">
  <img src="https://img.shields.io/badge/edge-Cloudflare%20Pages%20%2B%20Workers-f59e0b.svg" alt="Cloudflare">
  <img src="https://img.shields.io/badge/AI-5%20agent%20stack-34d399.svg" alt="5-agent AI stack">
  <a href="https://www.lcv.dev/sponsor"><img src="https://img.shields.io/badge/sponsor-%E2%9D%A4-ff69b4.svg" alt="Sponsor LCV Ideas & Software"></a>
</p>

LCV Ideas &amp; Software is a vibe coding independente studio. It builds AI-assisted public-facing web applications, editorial tooling, infrastructure services, sponsor infrastructure, and developer utilities — all on a shared Cloudflare edge stack (Pages + Workers + D1) integrated with leading AI providers (Claude, Codex, Gemini, DeepSeek, Grok). Org homepage: **[www.lcv.dev](https://www.lcv.dev)**.

---

## What we build

A small, opinionated portfolio organized in three layers, all sharing the same Cloudflare edge runtime and a single unified D1 database:

1. **Public products** — consumer-facing web apps with AI assistance, deployed on Cloudflare Pages with Worker backends.
2. **Operator infrastructure** — the single-tenant control plane and supporting services that govern the public products.
3. **Developer tooling** — open-source MCP servers and editorial workbenches built around multi-agent AI convergence.

Every repository is published on GitHub under the `LCV-Ideas-Software` organization and ships with its own public surface or operational endpoint under custom domains zones (custom domains, HTTPS-enforced). Everything is delivered under strict **multi-peer cross-review discipline** with caller self-review prohibited, version-pinned baselines, CodeQL Default Setup, Secret Scanning push protection, and SHA-pinned GitHub Actions.

---

## Repositories

### 🌐 Public-facing applications

| Repository | Live | What it does |
| --- | --- | --- |
| [**mainsite-app**](https://github.com/LCV-Ideas-Software/mainsite-app) | [reflexosdaalma.blog](https://www.reflexosdaalma.blog) | *Reflexos da Alma* — public personal blog + companion services. React 19 + Vite 8 SPA on Cloudflare Pages + Hono Worker. Post reader with smart polling, comments and ratings with GCP NL sentiment moderation, Gemini AI public chatbot, share-by-email, SSR OG and JSON-LD metadata, R2 media. Sponsor/payment handling lives outside MainSite in `sponsor-motor`. |
| [**astrologo-app**](https://github.com/LCV-Ideas-Software/astrologo-app) | [astrologo-app.lcv.dev](https://astrologo-app.lcv.dev) | *Astrólogo* — birth chart generator and esoteric analysis via Gemini AI. React 19 + Vite 8 on Cloudflare Pages with D1 backing store. Deterministic astrometric calculation + AI narrative; throttling, optional auth, share-by-email. |
| [**calculadora-app**](https://github.com/LCV-Ideas-Software/calculadora-app) | [calculadora-app.lcv.dev](https://calculadora-app.lcv.dev) | *Calculadora Financeira* — international FX simulator (credit card vs. multi-currency account) with AI-driven contextual analysis. React 19 + Vite 8 on Cloudflare Pages + D1. Integrates PTAX (BCB), Spot (AwesomeAPI), and Gemini AI. Modeled on Itaú's published methodology. |
| [**oraculo-financeiro**](https://github.com/LCV-Ideas-Software/oraculo-financeiro) | [oraculo-financeiro-app.lcv.dev](https://oraculo-financeiro-app.lcv.dev) | *Oráculo Financeiro* — IPCA-indexed fixed-income analysis dashboard (LCI/CDB IPCA+, Tesouro IPCA+) with Gemini contextual insights. React 19 + Vite 8 on Cloudflare Pages + D1 + Cron Worker for daily IPCA rate pre-warming. |

### 🛠️ Operator infrastructure

| Repository | Live | What it does |
| --- | --- | --- |
| [**admin-app**](https://github.com/LCV-Ideas-Software/admin-app) | [admin-app.lcv.dev](https://admin-app.lcv.dev) | Operator admin dashboard for the multi-app Cloudflare workspace. Single-tenant by design. React 19 + Vite 8 on Pages + Hono Worker, gated by Cloudflare Access (Zero Trust JWT). Modules include post editor, AI model selection, DNS CRUD, Pages and Workers lifecycle, MTA-STS, TLS-RPT ingestion, and operational telemetry. |
| [**mtasts-motor**](https://github.com/LCV-Ideas-Software/mtasts-motor) | [mtasts-motor.lcv.dev](https://mtasts-motor.lcv.dev) | Cloudflare Worker serving dynamic [MTA-STS](https://datatracker.ietf.org/doc/html/rfc8461) policies from a D1 backing store. Designed for multi-domain operators behind the `mta-sts.<domain>` subdomain convention (RFC 8461). |
| [**sponsor-motor**](https://github.com/LCV-Ideas-Software/sponsor-motor) | [sponsor-motor.lcv.app.br](https://sponsor-motor.lcv.app.br) | Dedicated Cloudflare Worker for the organization sponsor flow. Processes Mercado Pago Checkout Transparente orders through the official backend SDK, records minimal `sponsor_*` audit data in `Claudflare DB1`, validates signed webhooks, and backs the secure sponsor page at [www.lcv.dev/sponsor](https://www.lcv.dev/sponsor). |

### 🤖 Developer tooling

| Repository | Live | What it does |
| --- | --- | --- |
| [**ultrabrain-mcp**](https://github.com/LCV-Ideas-Software/ultrabrain-mcp) | [ultrabrain-mcp.lcv.dev](https://ultrabrain-mcp.lcv.dev) | LCV-created local MCP reasoning gate for structured engineering thought, validation, branch synthesis, quality metrics, bias checks, prompts, resources, and review readiness. Published as [`@lcv-ideas-software/ultrabrain-mcp`](https://www.npmjs.com/package/@lcv-ideas-software/ultrabrain-mcp). |
| [**cross-review**](https://github.com/LCV-Ideas-Software/cross-review) | [cross-review.lcv.dev](https://cross-review.lcv.dev) | API-first MCP stdio server for multi-model cross-review using official provider APIs for OpenAI, Anthropic, Google Gemini, DeepSeek, xAI Grok and Perplexity. No CLI execution; automated releases publish npmjs.com and GitHub Packages artifacts as [`@lcv-ideas-software/cross-review`](https://www.npmjs.com/package/@lcv-ideas-software/cross-review). |
| [**maestro-app**](https://github.com/LCV-Ideas-Software/maestro-app) | [maestro-app.lcv.dev](https://maestro-app.lcv.dev) | *Maestro Editorial AI* — portable Windows editorial workbench (Tauri 2 + React 19) for protocol-driven AI drafting, source verification, and multi-agent editorial convergence using Claude, Codex, Gemini, and DeepSeek. Resumable sessions, NDJSON diagnostic logs, runtime data stays local. |

### Archived / discontinued

| Repository | Status | Note |
| --- | --- | --- |
| [**apphub**](https://github.com/LCV-Ideas-Software/apphub) | Archived | Discontinued because it no longer provided useful organizational value. The organization website at [www.lcv.dev](https://www.lcv.dev) is now the canonical public entry point. |
| [**adminapps**](https://github.com/LCV-Ideas-Software/adminapps) | Archived | Discontinued after all admin surfaces were consolidated into [admin-app](https://github.com/LCV-Ideas-Software/admin-app). Continuing `adminapps` no longer makes operational sense. |
| [**cross-review-v1**](https://github.com/LCV-Ideas-Software/cross-review-v1) | Archived 2026-05-15 | Discontinued in favor of [`cross-review`](https://github.com/LCV-Ideas-Software/cross-review). The CLI-only MCP server was the first incarnation; the API-first rewrite under the canonical package name is the implementation going forward. npm `@lcv-ideas-software/cross-review-v1@1.12.11` remains published for historical use but is marked deprecated and receives no further updates. |
| [**grok-cli**](https://github.com/LCV-Ideas-Software/grok-cli) | Archived 2026-05-15 | Discontinued. The npm package `@lcv-ideas-software/grok-cli` is published through version `1.6.5` and marked deprecated on npm; the GitHub repository is read-only. Existing installs continue to function as-is. |
| [**deepseek-cli**](https://github.com/LCV-Ideas-Software/deepseek-cli) | Archived 2026-05-15 | Discontinued. The npm package `@lcv-ideas-software/deepseek-cli` is published through version `0.3.3` and marked deprecated on npm; the GitHub repository is read-only. Existing installs continue to function as-is. |

---

## Shared platform

```
Frontend     React 19 + Vite 8 + TypeScript
Runtime      Cloudflare Pages (static + SSR) + Cloudflare Workers (Hono)
Database     Cloudflare D1   (single shared Claudflare DB1)
Storage      Cloudflare R2   (Cloudflare R2 bucket)
Auth         Cloudflare Access (Zero Trust JWT) — operator surfaces
AI           Claude Code · ChatGPT Codex · Gemini CLI · DeepSeek · Grok
Email        Resend
Sponsorship  sponsor-motor + Mercado Pago Checkout Transparente Orders API
Anti-abuse   Cloudflare Turnstile + GCP Natural Language
Desktop      Tauri 2  (Maestro)
```

- **One database.** All consumer products and the operator control plane share `Claudflare DB1`. Cross-app reads use Cloudflare bindings in-place, never public URLs between sibling apps.
- **One bucket.** `Cloudflare R2` (R2) is shared by `mainsite-app` and `admin-app`. Magic-byte sniffing, allowlisted MIME types, 10 MB cap, SVG-sandboxed legacy fallback.
- **Defense in depth.** Cloudflare Access gates *who* enters admin surfaces; CSP gates *what* the browser can execute on public surfaces; Turnstile gates form anti-abuse; GCP Natural Language scores comment moderation.

---

## Engineering practices

- **Ultrabrain + cross-review before every merge.** No substantive engineering change is closed without `ultrabrain` reasoning plus the `cross-review` MCP gate. The caller can never review its own work; reviewer/relator self-review is invalid by policy.
- **4-gate quality.** Every code change passes eslint + biome + prettier + cross-review before commit, tag, release, deploy, or publish.
- **Structured reasoning is mandatory.** Planning and implementation passes through the LCV `ultrabrain` MCP server before execution. Hard gate, not a suggestion.
- **CodeQL Default Setup everywhere.** Advanced Setup requires explicit operator authorization. Branch protection on `main` requires `Analyze (javascript-typescript)` to pass.
- **Conservative branch baseline.** Single deploy branch (`main`); `preview → main` automation via auto-merge with retry polling on required checks.
- **Anti-drift smoke.** `cross-review` self-tests check that README, runtime version and CHANGELOG heading stay in lockstep on every push.
- **Memory parity** across Claude Code, ChatGPT Codex, and Gemini Code Assist. New directives propagate to all three active agent ecosystems before being considered shipped.
- **SHA-pinned GitHub Actions.** Supply-chain hardening baseline. `wrangler` is always invoked at `latest` in CI.

---

## Licensing

| License | Repositories |
| --- | --- |
| [AGPL-3.0-or-later](https://www.gnu.org/licenses/agpl-3.0.html) | `mainsite-app`, `astrologo-app`, `calculadora-app`, `oraculo-financeiro`, `apphub`, `admin-app`, `adminapps`, `mtasts-motor`, `maestro-app`, `sponsor-motor` |
| [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) | `ultrabrain-mcp`, `cross-review`, `cross-review-v1` (archived), `deepseek-cli` (archived), `grok-cli` (archived) |

The AGPL-3.0 **network-service trigger** applies to the AGPL repositories: running a modified fork as a public service obligates publication of the modifications under the same license. Each repository ships a `THIRDPARTY.md` inventory and a `NOTICE` (where applicable). Forks are welcome under the respective license terms.

---

## Conventions

- **Security**: GitHub Secret Scanning, Code Scanning (CodeQL), and Dependabot are active across all repositories. Vulnerability disclosures follow each repository's `SECURITY.md`.
- **Contributing**: Each repository carries its own `CONTRIBUTING.md`. PRs require green CI gates locally before submission.
- **Code of Conduct**: Contributor Covenant 2.1. See each repository's `CODE_OF_CONDUCT.md`.

---

## Contact and support

- **Homepage**: [www.lcv.dev](https://www.lcv.dev)
- **GitHub**: opening issues on the relevant repository is the canonical channel.
- **Email**: [lcv@lcv.dev](mailto:lcv@lcv.dev) for general topics.
- **Phone**: [+55 (21) 3955-0883](tel:+552139550883)
- **Sponsorship**: support the work through the secure sponsor page → [www.lcv.dev/sponsor](https://www.lcv.dev/sponsor).

---

<p align="center"><span style="font-size: 1.5em;"><strong>© LCV Ideas &amp; Software</strong></span><br><sub>LEONARDO CARDOZO VARGAS TECNOLOGIA DA INFORMACAO LTDA<br>Rua Pais Leme, 215 Conj 1713&nbsp;&nbsp;- Pinheiros<br>São Paulo - SP<br>CEP 05.424-150<br>CNPJ: 66.584.678/0001-77<br>IM 05.424-150</sub></p>
