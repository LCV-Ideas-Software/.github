# github-slack-alerts

Cloudflare Worker que entrega os alertas de segurança do GitHub da
organização **LCV-Ideas-Software** em um único canal do Slack
(`#github-alerts`), pelo desenho de dois estados do
[ADR-002](../../docs/adr/ADR-002-alertas-v2.md). O pipeline legado de
atividade (app de workflow do Slack + filas próprias) foi **aposentado em
17/08/2026**; a atividade da organização é coberta pelo app oficial GitHub
for Slack.

## O desenho, em uma tela

- **Dois estados**: `pending` → `sent`. Nada é terminal; o sistema nunca
  desiste de uma linha pendente, e o custo de regime de uma linha travada é
  no máximo uma cópia por dia.
- **Fronteira de aceitação**: um evento está aceito quando o INSERT durável
  em `alert_delivery` respondeu sucesso ao GitHub. Antes disso, 503 e a
  recuperação é do GitHub; depois, 202 sempre.
- **Um único agendador**: o carimbo (`attempts`, `updated_ms`,
  `next_due_ms`, num UPDATE condicional que pina prazo E versão observada)
  pertence ao papel de agendador — o cron a cada passe, o ingress uma vez
  no aceite. **Publica só quem carimba.**
- **Recuo**: `recuo(n) = min(24h, 5min × 3^(n-1))`.
- **Fila sem retentativa de plataforma**: `max_retries: 0`, sem fila de
  descarte, lote 1. O consumidor sempre retorna; a reentrega é bloqueada
  pela releitura da linha. A fila é otimização de latência — a fonte de
  verdade é a linha no D1, e a fila pode ser purgada a qualquer momento sem
  perda.
- **Consumidor**: monta a mensagem NO ENVIO (renderizador puro sobre o
  payload normalizado), posta com `chat.postMessage` e só marca `sent` com
  `ok:true` do Slack.
- **Vigia**: workflow agendado (15 em 15 min) lê `/alerts/status` e falha
  de propósito se a pendente mais velha passar de 1 hora.

## Rotas

| Rota | Método | Autenticação | Papel |
|---|---|---|---|
| `/github/webhook` | POST | HMAC (`X-Hub-Signature-256`, segredo ≥32 bytes) | Ingress das 8 famílias de segurança |
| `/alerts/status` | GET | header `x-alerts-status-secret` (≥32 bytes) | `pending`, `sent` e idade da pendente mais velha, num retrato SQL único |
| `/healthz` | GET | pública | Prontidão v2: segredos legíveis (com pisos) + sonda de esquema em trabalho constante |

As oito famílias aceitas (allowlist em `src/domain.ts`): `workflow_run`
(conclusões-problema, com autoexclusão por repositório+caminho),
`dependabot_alert`, `code_scanning_alert`, `secret_scanning_alert`,
`repository_advisory`, `security_and_analysis`,
`secret_scanning_alert_location`, `secret_scanning_scan`.

## Segredos (Cloudflare Secrets Store)

| Binding | Segredo | Regra |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | `github-slack-alerts-webhook-secret` | ≥32 bytes |
| `SLACK_BOT_TOKEN` | `github-slack-alerts-bot-token` | escopo mínimo `chat:write` |
| `ALERTS_STATUS_SECRET` | `github-slack-alerts-status-secret` | ≥32 bytes; o MESMO valor vive no environment `alerts-watchdog` do GitHub |

## Recuperação do webhook da organização (redelivery)

O workflow `.github/workflows/github-slack-webhook-redelivery.yml` audita as
entregas do webhook da organização e reenvia as que falharam. A leitura de
continuidade das execuções usa o built-in `GITHUB_TOKEN` com apenas
`actions: read` e `contents: read`; a mutação de reenvio autentica como o
GitHub App dedicado, cujo par de credenciais o protected
`webhook-recovery` environment provides — `SLACK_REDELIVERY_APP_CLIENT_ID`
(variável) e `SLACK_REDELIVERY_APP_PRIVATE_KEY` (secret) — e nenhum outro
job declara. Before scanning deliveries, o controlador valida a
configuração inteira e falha fechado; o reenvio automático respeita o teto
por GUID e nunca muta variáveis do repositório num reenvio falho.

## Desenvolvimento

```sh
npm ci
npm run types:check   # wrangler types --check
npm run typecheck     # tsc --noEmit
npm test              # vitest
npm run build         # wrangler deploy --dry-run --strict
```

O deploy é exclusivo do GitHub Actions
(`.github/workflows/github-slack-integration.yml`): verify → prova da
migração num D1 remoto descartável → apply das migrações → deploy com
`--tag $GITHUB_SHA`. A migração `0011` apagou as tabelas do pipeline
legado (dados arquivados antes, fora do repositório).
