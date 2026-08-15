# Runbook — alertas do GitHub no Slack (`#github-alerts`)

Escopo: o dispatcher do ADR-001 (`workers/github-slack-relay`, destino único `alerts`).
A atividade normal do GitHub NÃO passa por aqui — ela é entregue pela app oficial
"GitHub for Slack" no `#github-activity` (decisão de desenho híbrido, issue #192).

Datas e horários neste runbook são de Brasília (UTC−03:00).

## 1. O sistema está ligado?

O dispatcher tem três modos, na variável `DISPATCH_MODE` do `wrangler.jsonc`:

| Modo | O que acontece |
|---|---|
| `off` | Nada é enviado ao Slack. O ingress continua aceitando e persistindo tudo; as linhas se acumulam em `queued` e o alarme `queued_backlog_stale` aparece. Estado de repouso e também a degradação de emergência. |
| `shadow` | Igual a `off` para o Slack (nenhum envio), mas as linhas percorrem a mecânica inteira e terminam registradas. Serve para comparar volume com o caminho legado. |
| `primary` | Envia de verdade. |

Trocar de modo é **deploy de configuração**, não mudança de código.

## 2. "Um alerta não chegou. E agora?"

Siga nesta ordem. Cada passo diz o que fazer com o resultado.

**Passo 1 — o evento chegou ao Worker?**
Procure o GUID da entrega (`X-GitHub-Delivery`) no painel de webhooks do repositório de
origem, em Settings → Webhooks → Recent Deliveries. Se o GitHub registra falha de entrega,
o problema é anterior ao dispatcher: use *Redeliver* ali mesmo. O GUID é estável entre
redelivery, e o dispatcher deduplica por ele — reenviar é seguro.

**Passo 2 — o dispatcher tem a linha?**
Consulte `GET /status` do Worker. Ele devolve, por estado, quantas linhas existem, a idade
da mais antiga não-terminal e os contadores de reparo. Se todos os contadores estão zerados,
o evento não chegou a ser aceito — volte ao passo 1.

**Passo 3 — em que estado a linha está?** O significado de cada um:

| Estado | Significa | O que fazer |
|---|---|---|
| `queued` | Aceita, ainda não enviada | Se o modo é `off`, é esperado. Se é `primary` e a idade passa de 30 min, o alarme `queued_backlog_stale` já disparou: veja o passo 4. |
| `sending` | Envio em andamento, com lease de 90 s | Aguarde. Lease expirado vira `ambiguous` sozinho. |
| `ambiguous` | Não se sabe se o Slack recebeu | O resolver procura a mensagem no histórico e decide. **Não reenvie por conta própria** — é exatamente o caso em que reenviar cria duplicata. |
| `delivered` | Entregue, com `ts` como prova canônica | Nada a fazer. |
| `manual` | Precisa de decisão humana | Veja o passo 5. |
| `dead_letter` | O envio caiu em voo e a fila esgotou | Recuperável pelo menu do operador (passo 5). |
| `closed_manual` | Encerrada sem envio, por decisão registrada | Nada a fazer. |

**Passo 4 — nada está sendo enviado.** Verifique, nesta ordem: o modo é `primary`?
O token do bot ainda é válido (`SLACK_DISPATCH_BOT_TOKEN` no Secrets Store)? O bot continua
sendo membro do `#github-alerts`? Um bot removido do canal produz `not_in_channel`, que é
falha determinística e manda a linha direto para `manual`.

**Passo 5 — usar o menu do operador.** Todas as ações são assinadas e auditadas, e cada
comando vale **uma única vez** (uma repetição responde `409 already_applied`).

`POST /dispatch/operator`, corpo assinado com a chave de assinatura do relay:

| Ação | Quando usar | Efeito |
|---|---|---|
| `resend` | A linha está em `manual` ou `dead_letter` e você aceita o risco de duplicata | Volta para `queued` e republica; a verificação pós-reenvio é armada automaticamente |
| `close_manual` | A linha está em `manual` e o alerta perdeu validade | Encerra com a justificativa registrada, sem enviar |
| `mark_delivered` | Você tem prova de que a mensagem está no canal (o `ts` dela) | Registra a prova canônica. O canal precisa ser o `#github-alerts`; qualquer outro é recusado |
| `sweep` | Você viu uma duplicata que o sistema não reparou | Rearma a verificação para o próximo passe do cron |

## 3. Alarmes: o que cada um significa

O job observacional roda a cada 5 minutos e emite estes identificadores. **Hoje eles saem
como log estruturado do Worker** (visíveis na observabilidade do Cloudflare) — a entrega
ativa para um canal humano é item declarado da fase F3 e ainda não existe. Até lá, a
verificação é por consulta ao `/status`.

| Alarme | Significa | Primeira ação |
|---|---|---|
| `manual_present` | Alguma linha espera decisão humana | Passo 5 |
| `dead_letter_present` | Envio caiu em voo e a fila esgotou | Passo 5, ação `resend` |
| `ambiguous_stale` | Uma linha ambígua passa de 30 min sem resolução | Veja se o Slack ou o `conversations.history` está degradado; o resolver reagenda sozinho com recuo progressivo |
| `queued_backlog_stale` | Fila parada há mais de 30 min | Em `off`, é o estado esperado da degradação. Em `primary`, veja o passo 4 |
| `repaired_duplicates_increased` | O sistema apagou uma cópia duplicada | Informativo; a auditoria registra os dois `ts` |
| `duplicate_deletion_unreconciled` | Uma deleção foi pedida ao Slack e o registro do reparo não fechou | Confira no canal se a cópia sumiu; se sumiu, é só o registro que falta |
| `verification_abandoned` | A verificação parou de reagendar após muitas varreduras sem progresso | Use `sweep` para reiniciar; se repetir, o canal tem volume alto demais para a janela de varredura |

## 4. Emergência: parar os envios agora

Troque `DISPATCH_MODE` para `off` e faça o deploy. Nada se perde: o ingress continua
aceitando e persistindo cada GUID, as linhas se acumulam em `queued` (alarmadas), e ao
voltar para `primary` o cron republica sozinho, sem passo manual.

## 5. O que o sistema NUNCA faz sozinho

Ler esta lista evita meio diagnóstico:

- **Não reenvia mensagem automaticamente.** Nenhuma. Todo reenvio é comando humano assinado
  e marcado como possível duplicata. Se você vê uma segunda cópia, ela veio de um reenvio
  autorizado ou de materialização tardia do Slack — nunca de decisão da máquina.
- **Não marca entrega sem prova.** `delivered` exige o `ts` devolvido pelo Slack.
- **Não conclui ausência sem esgotar a busca.** Página malformada, varredura parcial ou
  histórico indisponível resultam em "inconclusivo", nunca em "não foi entregue".
- **Não apaga nada do D1 legado.** As tabelas antigas seguem congeladas e são lidas para
  impedir entrega dupla pelos dois caminhos.

## 6. Limites conhecidos

- A verificação pós-reenvio cobre +15 min e +24 h. Uma duplicata que apareça depois disso
  é detectável por `sweep`, mas não automaticamente.
- Sob muitas linhas ambíguas simultâneas, o tempo até uma delas ser estacionada em `manual`
  cresce com o tamanho da fila. O alarme `ambiguous_stale` aparece muito antes disso.
- O canal é limitado a cerca de uma mensagem por segundo; rajadas são espaçadas em 6,1 s.
