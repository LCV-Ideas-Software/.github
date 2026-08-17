# GitHub → Slack: integração de alertas de segurança

Este documento descreve a integração VIVA entre o GitHub da organização
**LCV-Ideas-Software**, a Cloudflare e o Slack, no desenho de dois estados
do [ADR-002](adr/ADR-002-alertas-v2.md). O pipeline anterior (app de
workflow do Slack hospedado, assinatura de relay com slots NEXT, protocolo
de entrega em D1) foi **aposentado em 17/08/2026**: o job de deploy do app,
o workflow de monitoração, o código do Worker, as tabelas D1 (arquivadas
antes do DROP na migração `0011`) e os scripts de provisão saíram; o app
`A0BMWBGES20` não é mais hospedado no Slack. A **atividade** da organização
(pushes, PRs, issues, releases, discussões) é coberta pelo app oficial
GitHub for Slack; este caminho entrega apenas **segurança**.

## Arquitetura, de ponta a ponta

```text
webhook da organização (8 famílias, HMAC)
  -> Worker github-slack-alerts (Cloudflare)
     INSERT durável em alert_delivery (fronteira de aceitação)
  -> carimbo CAS da 1ª tentativa (attempts=1, next_due=+recuo(1),
     pinando prazo E versão observada) e publicação {v:2, delivery_id}
  -> fila github-slack-alerts (max_retries: 0, lote 1, sem DLQ)
  -> consumidor: relê a linha, monta a mensagem NO ENVIO e posta
     chat.postMessage no #github-alerts (C0BMUK793NV)
  -> ok:true => sent; qualquer outra coisa => pendente com last_error
cron */5: recarimba toda linha devida (recuo(n) = min(24h, 5min*3^(n-1)))
          e apaga sent com mais de 30 dias
vigia */15 (GitHub Actions): lê /alerts/status e falha ALTO se a pendente
          mais velha passar de 1 hora
```

As oito famílias aceitas: `workflow_run` (conclusões-problema, com
autoexclusão por repositório+caminho dos workflows do próprio relay),
`dependabot_alert`, `code_scanning_alert`, `secret_scanning_alert`,
`repository_advisory`, `security_and_analysis`,
`secret_scanning_alert_location`, `secret_scanning_scan`. O auditor
`scripts/github-slack-hook-audit.mjs` prova que o hook da organização
assina exatamente essa lista, e `test/alerts/scope.test.ts` prende a
paridade entre o auditor, a allowlist e os normalizadores.

## Fronteiras de confiança

- **GitHub → Cloudflare**: HMAC `X-Hub-Signature-256` com segredo ≥32
  bytes, verificação em tempo constante ANTES de qualquer parse; corpo
  limitado a 25 MB em streaming.
- **Cloudflare → Slack**: `chat.postMessage` com token de bot de escopo
  mínimo (`chat:write`); o bot precisa ser MEMBRO do canal privado. A
  mensagem nunca carrega valores de segredos, localizações cruas ou
  comentários de resolução — o normalizador os omite por construção.
- **Datas para humanos**: dd/MM/aaaa às HH:mm:ss em UTC−03:00; ausência é
  explícita ("Data e hora do evento: não informadas"), nunca silêncio.

## Recursos Cloudflare

| Recurso | Nome | Notas |
|---|---|---|
| Worker | `github-slack-alerts` | deploy exclusivo via Actions, `--tag $GITHUB_SHA` |
| D1 | `github-slack-alerts-db` | tabela `alert_delivery` + `d1_migrations` |
| Fila | `github-slack-alerts` | `max_retries: 0`, lote 1, concorrência 1, sem DLQ; a fila é descartável — a fonte de verdade é a linha |
| Secrets Store | `github-slack-alerts-webhook-secret`, `github-slack-alerts-bot-token`, `github-slack-alerts-status-secret` | os dois segredos NOSSOS têm piso de 32 bytes |

## Vigia e status

`/alerts/status` responde `pending`, `sent` e a idade da pendente mais
velha num retrato SQL único, atrás do header `x-alerts-status-secret`
(≥32 bytes; o MESMO valor vive no environment `alerts-watchdog` como
`ALERTS_STATUS_SECRET`). O vigia roda a cada 15 minutos com UM contador de
tiques consecutivos sem saúde no cache do Actions (`ok`/`bad:n`): falha
não-404 alarma no 2º tique; 404 alarma a partir do 8º (janela de rollout de
2 h) e, do teto em diante, em todo tique; um 200 só é saúde com o corpo
inteiro coerente. O e-mail de falha do job é o aviso.

`/healthz` é público e responde só `ready`/`unavailable`: exige o tag de
versão do deploy, os três segredos legíveis (com os pisos) e a tabela
respondendo a uma sonda de trabalho constante (`LIMIT 1`).

## Recuperação do webhook da organização (redelivery)

O workflow `.github/workflows/github-slack-webhook-redelivery.yml` audita a
continuidade das entregas e reenvia as falhas. A leitura de continuidade
usa o built-in `GITHUB_TOKEN` com apenas `actions: read` e
`contents: read`. Before the controller's delivery scan, a configuração
inteira é validada e o controlador falha fechado. A mutação de reenvio
autentica como o GitHub App dedicado, cujo par de credenciais o protected
`webhook-recovery` environment provides — `SLACK_REDELIVERY_APP_CLIENT_ID`
(variável) e `SLACK_REDELIVERY_APP_PRIVATE_KEY` (secret) — e nenhum outro
job os declara. O reenvio automático respeita o teto de tentativas por
GUID; um reenvio falho não muta variável nenhuma do repositório.

## Pipeline de deploy

`.github/workflows/github-slack-integration.yml`:

1. **Verify** — auditorias npm, testes dos controladores
   (`node --test scripts/...`), e o gate completo do Worker
   (`types:check`, `tsc`, `vitest`, `build --dry-run`).
2. **Prove remote D1** — `scripts/verify-slack-relay-d1-remote.mjs` aplica
   a cadeia INTEIRA de migrações num D1 remoto descartável e afirma o
   esquema final exato do v2 (mais o roundtrip e o CHECK de dois estados),
   com prazo fail-closed e reaper de descartáveis obsoletos
   (`slack-d1-disposable-reaper.yml`).
3. **Deploy** — aplica as migrações no banco real e publica o Worker.

## Runbook

- **Rotação do segredo do /status**: gerar valor ≥32 bytes e gravar NOS
  DOIS lados (Secrets Store + environment `alerts-watchdog`); a janela de
  dessincronia custa no máximo um tique do vigia.
- **Rotação do token do bot**: novo token `chat:write` no Secrets Store;
  conferir com `auth.test`; o bot precisa continuar membro do
  `#github-alerts` (`channel_not_found` = convite ausente — `/invite` no
  canal resolve, e as pendentes drenam sozinhas no recuo seguinte).
- **Fila**: pode ser purgada a qualquer momento sem perda — o cron
  republica toda linha devida.
- **Backlog/incidente**: a linha em `alert_delivery` é a verdade; `pending`
  com `last_error` diz exatamente o que o Slack respondeu.

## Referências oficiais

- [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postmessage)
- [Webhooks de organização do GitHub](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
- [Cloudflare Queues](https://developers.cloudflare.com/queues/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
