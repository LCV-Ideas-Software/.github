<p align="center">
  <img src="assets/lcv-ideas-software-logo.svg" alt="LCV Ideas &amp; Software" width="220">
</p>

# LCV Ideas & Software

[![org: LCV Ideas & Software](https://img.shields.io/badge/org-LCV%20Ideas%20%26%20Software-101827.svg)](https://github.com/LCV-Ideas-Software)
[![stack: React 19 + Vite 8](https://img.shields.io/badge/stack-React%2019%20%2B%20Vite%208-61dafb.svg)](https://react.dev/)
[![runtime: Cloudflare Pages + Workers](https://img.shields.io/badge/runtime-Cloudflare%20Pages%20%2B%20Workers-orange.svg)](https://workers.cloudflare.com/)
[![AI: Gemini · Claude · Codex](https://img.shields.io/badge/AI-Gemini%20%C2%B7%20Claude%20%C2%B7%20Codex-blueviolet.svg)](https://ai.google.dev/)
[![license: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](./LICENSE)

**LCV Ideas & Software** is a software organization maintained by Leonardo Cardozo Vargas. It develops AI-assisted public-facing web applications, editorial tooling, infrastructure services, and developer utilities — all built on a shared Cloudflare edge stack (Pages + Workers + D1) and integrated with leading AI providers (Gemini, Claude, Codex).

## What we build

All projects share a common stack and infrastructure philosophy: Cloudflare Pages for static/SPA deploys, Cloudflare Workers (Hono) for edge APIs, a single Cloudflare D1 database (`bigdata_db`) as the shared backing store, and AI provider integrations (Gemini 2.5 Pro, Claude, Codex) for contextual intelligence surfaces. Licenses are AGPL-3.0-or-later. GitHub Actions are SHA-pinned. Secret Scanning, CodeQL, and Dependabot are active across all repositories.

## Repositories

### 🌐 Public-facing applications

| Repository | Description |
| --- | --- |
| [**mainsite-app**](https://github.com/LCV-Ideas-Software/mainsite-app) | *Reflexos da Alma* — public personal blog + companion services. React 19 + Vite 8 SPA on Cloudflare Pages + Hono Worker API. Features: post reader with smart polling, comments/ratings with GCP NL sentiment moderation, Gemini AI chatbot, share-by-email, donations (SumUp + PIX), SSR OG/JSON-LD, R2 media. |
| [**astrologo-app**](https://github.com/LCV-Ideas-Software/astrologo-app) | *Astrólogo* — birth chart generator and esoteric analysis via Gemini AI. React 19 + Vite 8 on Cloudflare Pages with D1 backing store. Deterministic astrometric calculation + AI narrative in prose. Includes rate limiting, optional auth, and share-by-email. |
| [**oraculo-financeiro**](https://github.com/LCV-Ideas-Software/oraculo-financeiro) | *Oráculo Financeiro* — IPCA-indexed fixed-income analysis dashboard (LCI/CDB IPCA+, Tesouro IPCA+) with Gemini AI contextual insights. React 19 + Vite 8 on Cloudflare Pages + D1 + Cron Worker for daily IPCA rate pre-warming. |
| [**calculadora-app**](https://github.com/LCV-Ideas-Software/calculadora-app) | *Calculadora Financeira* — international exchange rate simulator (Cartão de Crédito vs. Conta Global) with AI-driven analysis. React 19 + Vite 8 on Cloudflare Pages + D1. Integrates PTAX (BCB), Spot (AwesomeAPI), and Gemini AI. |
| [**apphub**](https://github.com/LCV-Ideas-Software/apphub) | Cloudflare Pages portal hub. Static landing + PWA dispatcher routing visitors to the sub-application fleet via a configurable card-grid UI backed by D1. |

### 🛠️ Admin + operations

| Repository | Description |
| --- | --- |
| [**admin-app**](https://github.com/LCV-Ideas-Software/admin-app) | Operator admin dashboard for the multi-app Cloudflare workspace. React 19 + Vite 8 on Pages + Hono Worker, protected by Cloudflare Access (Zero Trust JWT). Covers: post editor, AI model selection, financial reports (SumUp), DNS CRUD, Pages/Workers lifecycle, MTA-STS, TLS-RPT ingestion, and operational telemetry. |
| [**adminapps**](https://github.com/LCV-Ideas-Software/adminapps) | React-based admin micro-modules on Cloudflare Pages. Composable card-grid UI for compliance surfaces (license panel, third-party attribution). |

### 🤖 AI tooling + developer utilities

| Repository | Description |
| --- | --- |
| [**cross-review-mcp**](https://github.com/LCV-Ideas-Software/cross-review-mcp) | MCP server orchestrating cross-review between Claude Code, ChatGPT Codex, and Gemini CLI. Enforces multi-agent editorial convergence discipline on AI-assisted drafting workflows. |
| [**maestro-app**](https://github.com/LCV-Ideas-Software/maestro-app) | *Maestro Editorial AI* — portable Windows editorial workbench (Tauri 2 + React 19) for protocol-driven AI drafting, source verification, and multi-agent editorial convergence. Integrates Claude, Codex, and Gemini with structured session management and NDJSON diagnostic logs. |

### ⚙️ Infrastructure services

| Repository | Description |
| --- | --- |
| [**mtasts-motor**](https://github.com/LCV-Ideas-Software/mtasts-motor) | Cloudflare Worker serving dynamic [MTA-STS](https://datatracker.ietf.org/doc/html/rfc8461) policies from a D1 backing store. Designed for multi-domain operators behind the `mta-sts.<domain>` subdomain convention (RFC 8461). |

## Shared stack

```
Frontend     React 19 + Vite 8 + TypeScript
Runtime      Cloudflare Pages (static + SSR) + Cloudflare Workers (Hono)
Database     Cloudflare D1  (shared bigdata_db)
Storage      Cloudflare R2
Auth         Cloudflare Access (Zero Trust JWT)
AI           Gemini 2.5 Pro · Claude Code · ChatGPT Codex
Email        Resend
Payments     SumUp + PIX
Desktop      Tauri 2  (Maestro)
```

## Organization conventions

- **License**: All repositories are licensed under [AGPL-3.0-or-later](./LICENSE). The network-service trigger applies — running a modified fork as a public service obligates publication of modifications.
- **Security**: GitHub Secret Scanning, Code Scanning (CodeQL), and Dependabot are active across all repositories. Vulnerability disclosures follow each repository's `SECURITY.md`.
- **Action pinning**: All GitHub Actions are pinned by full SHA (supply-chain hardening baseline).
- **Contributing**: Each repository carries its own `CONTRIBUTING.md`. PRs require green CI gates locally before submission.
- **Code of Conduct**: Contributor Covenant 2.1. See each repository's `CODE_OF_CONDUCT.md`.
- **Sponsorship**: Support the work via GitHub Sponsors → [github.com/sponsors/lcv-leo](https://github.com/sponsors/lcv-leo).

## License

Copyright (C) 2026 Leonardo Cardozo Vargas.

This repository (`.github`) is licensed under the GNU Affero General Public License, version 3 or later. See [LICENSE](./LICENSE) for the full text.
