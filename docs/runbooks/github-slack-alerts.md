# Runbook — alertas do GitHub no Slack (`#github-alerts`)

Escopo: o dispatcher do ADR-001 (`workers/github-slack-relay`, destino único `alerts`).
A atividade normal do GitHub NÃO passa por aqui — ela é entregue pela app oficial
"GitHub for Slack" no `#github-activity` (decisão de desenho híbrido, issue #192).

Datas e horários neste runbook são de Brasília (UTC−03:00).

## 0. Em que fase o sistema está — leia antes de qualquer coisa

O ADR-001 corta em fases (§6.8): F1 → F2 → F3 → F4. **Hoje o repositório está em
F1, com `DISPATCH_MODE=off` no `wrangler.jsonc`.** A fase muda o significado de
quase tudo que vem abaixo, então cada seção separa os dois regimes:

- **Antes do corte do F3 (hoje):** o desenho é que quem entrega os alertas seja o
  **caminho legado** — tabela `deliveries`, job de fila sem marcador, envio pelo
  Slack Workflow —, com o dispatcher inerte, sem sequer criar linha em
  `dispatch_outbox` no modo `off`.

  > ⚠️ **Desde 14/08/2026, 16:38, esse caminho não entrega mais nada.** O app do
  > Slack que hospedava o gatilho do Workflow foi apagado, e o egresso legado
  > morreu com ele: toda tentativa devolve `slack_trigger_http_500_ambiguous` e a
  > linha é estacionada em `manual_review`. Em 15/08/2026 as duas filas
  > (`github-slack-alerts` e `github-slack-activity`) foram **pausadas** e os
  > workflows `Slack GitHub Integration` e `GitHub Slack Webhook Redelivery`
  > desabilitados, por decisão do operador, para só voltarem com a implementação
  > nova. **A atividade** passou a ser entregue pela app oficial "GitHub for
  > Slack" no `#github-activity`. **Os alertas não têm caminho vivo** — a app
  > oficial não assina alerta de segurança nenhum (Dependabot, code scanning,
  > secret scanning, advisories) nem filtra workflow por conclusão, que é
  > exatamente a classe parada. Registro completo na issue #192.
  >
  > Consequência operacional para quem lê este runbook hoje: os passos 1 e 2
  > continuam valendo para **descobrir** o que aconteceu com um alerta, e a
  > resposta atual para todos eles é a mesma — aceito, persistido em
  > `deliveries`, não entregue. Não há ação de operador que o entregue antes do
  > corte para o dispatcher.
- **Depois do corte do F3** (`DISPATCH_MODE=primary` e consumidores legados
  desligados): quem entrega é o dispatcher, e só então as tabelas, os estados e
  os alarmes descritos aqui pertencem ao caminho vivo.

Para saber em que fase você está, leia `DISPATCH_MODE` no `wrangler.jsonc` da
revisão implantada.

## 1. O sistema está ligado?

O dispatcher tem três modos, na variável `DISPATCH_MODE` do `wrangler.jsonc`.
O que cada um faz **depende da fase**:

| Modo | Antes do corte do F3 (hoje) | Depois do corte do F3 |
|---|---|---|
| `off` | **Os alertas continuam sendo entregues**, pelo caminho legado. O dispatcher não faz nada e não cria linha em `dispatch_outbox`. **Não é parada de emergência** — veja a seção 4. | Depende de F3 ou F4, e a diferença importa. **Entre o F3 e o F4:** o insert no outbox é condicionado a `primary` (`src/index.ts:1470`), então em `off` o evento cai no insert legado e publica um job de fila **sem marcador** — não nasce linha em `dispatch_outbox`, nada se acumula em `queued` e `queued_backlog_stale` não enxerga esses eventos. Não é a degradação do ADR; veja a seção 4. **Depois do F4** (regime B, §6.8/R20, quando o caminho legado não existe mais): nada é enviado ao Slack, o ingress persiste cada GUID em `dispatch_outbox`, as linhas se acumulam em `queued` e o alarme `queued_backlog_stale` aparece. Estado de repouso e degradação de emergência. |
| `shadow` | Os alertas continuam sendo entregues pelo caminho legado. Além disso cada alerta ganha uma linha espelho (`shadow=1`) que percorre a mecânica inteira **sem nenhuma chamada ao Slack** (§9.A1) e termina registrada como `delivered` sem `ts`. Serve para comparar volume com o caminho legado. | Estágio do F2; não se usa depois do corte. |
| `primary` | O dispatcher passa a aceitar e entregar os alertas, e o caminho legado deixa de recebê-los. Só deve ser ligado no passo (1) do F3, depois do preflight de pertencimento do bot. | Modo normal de operação. |

Trocar de modo é **deploy de configuração**, não mudança de código.

## 2. "Um alerta não chegou. E agora?"

Siga nesta ordem. Cada passo diz o que fazer com o resultado.

**Passo 1 — o evento chegou ao Worker?**
Procure o GUID da entrega (`X-GitHub-Delivery`) no painel de webhooks do repositório de
origem, em Settings → Webhooks → Recent Deliveries. Se o GitHub registra falha de entrega,
o problema é anterior ao relay: use *Redeliver* ali mesmo. O GUID é estável entre
redelivery, e o relay deduplica por ele — reenviar é seguro.

**Passo 2 — o relay tem a linha desse GUID?**
`GET /status` **não** responde a essa pergunta: por desenho ele expõe apenas
agregados, sem identificadores (§6.7). Assim que existir qualquer histórico, um
contador diferente de zero não diz nada sobre o GUID que você investiga. A
consulta por GUID é feita no D1, autenticada pela sua sessão do wrangler.

Rode a partir de `workers/github-slack-relay`:

```sh
npx wrangler@latest d1 execute github-slack-alerts-db --remote \
  --command "SELECT * FROM deliveries WHERE delivery_id = 'COLE-O-GUID-AQUI'"
```

Qual tabela é a autoritativa depende da fase (seção 0):

- **Antes do corte do F3:** `deliveries` é a tabela do caminho vivo. Linha
  presente = o alerta foi aceito e é o caminho legado que o entrega. Em modo
  `off` não haverá nada em `dispatch_outbox` para esse GUID; em `shadow` haverá
  uma linha `shadow=1`, que **não** é prova de entrega ao Slack.
- **Depois do corte do F3:** `dispatch_outbox` é a tabela do caminho vivo:

```sh
npx wrangler@latest d1 execute github-slack-alerts-db --remote \
  --command "SELECT delivery_id, destination, shadow, state, attempt_count, resolver_attempts, slack_channel_id, slack_message_ts, verify_scans_remaining, verify_after_ms, last_error, created_ms, updated_ms FROM dispatch_outbox WHERE delivery_id = 'COLE-O-GUID-AQUI'"
```

O histórico da decisão — toda transição, todo veredicto do resolver e toda ação
de operador, com a evidência que a fundamentou — está no diário:

```sh
npx wrangler@latest d1 execute github-slack-alerts-db --remote \
  --command "SELECT seq, from_state, to_state, actor, at_ms, evidence_json FROM dispatch_audit WHERE delivery_id = 'COLE-O-GUID-AQUI' ORDER BY seq"
```

Nenhuma linha em nenhuma das duas tabelas = o evento não chegou a ser aceito:
volte ao passo 1 e use *Redeliver*. **Essa inferência só vale para entregas com
menos de 30 dias:** linhas já entregues de `deliveries` são apagadas depois disso
(seção 5), então para um GUID mais velho a ausência não prova nada — e o *Redeliver*
dele deixa de ser protegido pela deduplicação, que é exatamente a consulta a essa
linha.

**Passo 3 — em que estado a linha está?** Vale para linhas de `dispatch_outbox`,
isto é, para o caminho do dispatcher. O significado de cada estado:

| Estado | Significa | O que fazer |
|---|---|---|
| `queued` | Aceita, ainda não enviada | Se o modo é `off`, é esperado. Se é `primary` e a idade passa de 30 min, o alarme `queued_backlog_stale` já disparou: veja o passo 4. |
| `sending` | Envio em andamento, com lease de 90 s | Aguarde. Lease expirado vira `ambiguous` sozinho — **só com o modo diferente de `off`**: a normalização de lease e o resolver são gateados por `mode !== "off"` (`src/dispatch/wiring.ts:436`). Em `off` a linha permanece em `sending` até o modo voltar. |
| `ambiguous` | Não se sabe se o Slack recebeu | O resolver procura a mensagem no histórico e decide. **Não reenvie por conta própria** — é exatamente o caso em que reenviar cria duplicata. |
| `delivered` | Entregue, com `ts` como prova canônica | Nada a fazer. |
| `manual` | Precisa de decisão humana | Veja o passo 5. |
| `dead_letter` | Um envio caiu em voo (crash entre a reivindicação e o resultado) e a fila esgotou | Recuperável pelo menu do operador (passo 5). |
| `closed_manual` | Encerrada sem envio, por decisão registrada | Nada a fazer. |

**Passo 4 — nada está sendo enviado.**

*Antes do corte do F3:* o caminho vivo é o legado, então `DISPATCH_MODE` não é a
causa. Verifique, nesta ordem: a fila `github-slack-alerts` está pausada (seção
4)? O segredo `SLACK_ALERTS_WORKFLOW_WEBHOOK_URL` ainda aponta para um gatilho
válido? O gatilho do Workflow no app legado continua existindo?

*Depois do corte do F3:* o modo é `primary`? O token do bot ainda é válido
(`SLACK_DISPATCH_BOT_TOKEN` no Secrets Store)? O bot continua sendo membro do
`#github-alerts`? Um bot removido do canal produz `not_in_channel`, que é falha
determinística e manda a linha direto para `manual`.

**Passo 5 — usar o menu do operador.** Todas as ações são assinadas e auditadas, e cada
comando vale **uma única vez** (uma repetição responde `409 already_applied`).

`POST /dispatch/operator`, corpo assinado com a chave de assinatura do relay:

| Ação | Quando usar | Efeito |
|---|---|---|
| `resend` | A linha está em `manual` ou `dead_letter` e você aceita o risco de duplicata | Volta para `queued` e republica; a verificação pós-reenvio é armada automaticamente. Em modo `off` a mensagem é confirmada sem envio (R20): a linha só sai quando o modo voltar para `primary` |
| `close_manual` | A linha está em `manual` e o alerta perdeu validade | Encerra com a justificativa registrada, sem enviar |
| `mark_delivered` | A linha está em `manual` e você tem prova de que a mensagem está no canal (o `ts` dela) | Registra a prova canônica. Exige o estado `manual` (`src/index.ts:1182`) — em qualquer outro estado responde `409 delivery_state_conflict`. O canal precisa ser o `#github-alerts`; qualquer outro é recusado |
| `sweep` | Você viu uma duplicata que o sistema não reparou, ou precisa limpar `verification_abandoned` | Rearma a verificação para o próximo passe do cron |

### 2.1 Como montar a requisição assinada

Não existe utilitário no repositório: este é o formato exato, extraído de
`src/index.ts` (`canonicalDispatchOperatorCommand`, `parseDispatchOperatorCommand`).
Monte à mão, no incidente, com `openssl` e `node`.

Regras que a rota impõe — errar qualquer uma devolve `400 invalid_request`:

- **Chaves do corpo: conjunto EXATO**, nem uma a mais nem a menos.
  `resend`, `close_manual`, `sweep` → `action`, `delivery_id`, `evidence`,
  `request_timestamp`, `request_signature`. `mark_delivered` → essas cinco
  **mais** `slack_message_ts` e `slack_channel_id`.
- `delivery_id`: o GUID da entrega, `[A-Za-z0-9-]`, 1 a 128 caracteres.
- `evidence`: texto não vazio, no máximo 512 caracteres. Fica no diário.
- `request_timestamp`: unix **em segundos**, exatamente 10 dígitos, como
  string. Frescor: de 300 s no passado até 60 s no futuro.
- `request_signature`: 64 caracteres hex **minúsculos**.
- Corpo inteiro no máximo 128000 bytes.

O canônico assinado é um **array JSON**, nesta ordem, com a versão na primeira
posição (`dispatch_operator_action_v1`, que o separa de todo canônico legado):

```
["dispatch_operator_action_v1", action, delivery_id, evidence,
 request_timestamp, slack_message_ts, slack_channel_id]
```

As duas últimas posições são **string vazia** em toda ação que não seja
`mark_delivered` — vazias no canônico, e ausentes do corpo. A assinatura é
HMAC-SHA256 sobre os bytes UTF-8 desse canônico, com a chave de assinatura do
relay **do slot ativo** (`SLACK_RELAY_SIGNING_ACTIVE_SLOT` no `wrangler.jsonc`
diz qual: com `next`, a chave é o segredo `...-signing-secret-next` do Secrets
Store).

Exemplo completo e executável (valores de exemplo — substitua pelos reais):

```sh
WORKER_URL='https://<host-do-worker>'          # veja o wrangler.jsonc implantado
SECRET='<a-chave-do-slot-ativo>'
ACTION='sweep'
DELIVERY_ID='00000000-0000-4000-9000-000000000000'
EVIDENCE='duplicata vista no canal em 15/08 as 11:20'
TS_FIELD=''        # so mark_delivered preenche; string vazia nas demais acoes
CHANNEL_FIELD=''   # idem
REQUEST_TIMESTAMP="$(date -u +%s)"

CANONICAL="$(node -e 'const a=process.argv.slice(1);process.stdout.write(
  JSON.stringify(["dispatch_operator_action_v1",a[0],a[1],a[2],a[3],a[4],a[5]]))' \
  "$ACTION" "$DELIVERY_ID" "$EVIDENCE" "$REQUEST_TIMESTAMP" \
  "$TS_FIELD" "$CHANNEL_FIELD")"

SIGNATURE="$(printf '%s' "$CANONICAL" \
  | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)"

BODY="$(node -e 'const a=process.argv.slice(1);process.stdout.write(
  JSON.stringify({action:a[0],delivery_id:a[1],evidence:a[2],
                  request_timestamp:a[3],request_signature:a[4]}))' \
  "$ACTION" "$DELIVERY_ID" "$EVIDENCE" "$REQUEST_TIMESTAMP" "$SIGNATURE")"

curl -sS -X POST "$WORKER_URL/dispatch/operator" \
  -H 'Content-Type: application/json' --data "$BODY"
```

Para `mark_delivered`, preencha `TS_FIELD` e `CHANNEL_FIELD` (o `ts` da mensagem
e o id do `#github-alerts` configurado no Worker — qualquer outro canal é
recusado com `400 channel_not_dispatcher_owned`) e acrescente as duas chaves ao
`BODY`, além de já estarem no canônico.

Respostas: `200` aplicado; `400` corpo/campo inválido; `401 invalid_signature`;
`409 already_applied` (este comando assinado já foi aplicado — gere um novo
`request_timestamp`, que muda a assinatura); `409 delivery_state_conflict`
(a linha não está no estado que a ação exige); `503` persistência ou
autenticação indisponível.

Um cuidado no `503` do `mark_delivered`: ele também pode ser **permanente**. O `ts`
informado não é conferido contra as outras linhas antes da gravação
(`src/index.ts:1176`), e o índice `UNIQUE (destination, slack_message_ts)`
(`migrations/0010_dispatch_outbox.sql:77`) recusa um `ts` que já é a prova canônica
de outra entrega — situação comum, porque todo alerta entregue normalmente tem o
seu `ts` gravado. O `catch` da rota (`src/index.ts:1192`) responde `503` para
qualquer erro do D1, sem distinguir erro permanente de indisponibilidade. Se o
`503` se repetir, confira o `ts` antes de concluir que o D1 está fora.

## 3. Alarmes: o que cada um significa

O job observacional roda a cada 5 minutos e emite estes identificadores. **Hoje eles saem
como log estruturado do Worker** (visíveis na observabilidade do Cloudflare) — a entrega
ativa para um canal humano é item declarado da fase F3 e ainda não existe. Até lá, a
verificação é por consulta ao `/status`, que devolve, por estado, quantas linhas
existem, a idade da mais antiga não-terminal, `repaired_duplicates`,
`verification_abandoned` e `unreconciled_deletion_intents` — sempre agregados,
nunca identificadores (para investigar um GUID, veja o passo 2).

**Esta seção cobre só o `dispatch_outbox`.** Todo alarme e todo campo do `/status`
são calculados sobre essa tabela (`src/dispatch/wiring.ts:574`), e o passe encerra
sem alarme nenhum quando ela está vazia (`src/dispatch/wiring.ts:365`). Na fase de
hoje — F1, modo `off`, nenhuma linha criada no outbox (seção 1) — isso significa:
passe sempre encerrado sem trabalho, `/status` todo zerado e nenhum alarme possível.
O caminho que realmente entrega hoje, `deliveries` mais o consumidor legado, **não
tem alarme nem campo no `/status`**: a verificação dele é o painel de webhooks do
passo 1 e a consulta ao D1 do passo 2. Pelo mesmo motivo, todo reparo disparado por
`sweep` só é executado por um passe com o modo diferente de `off`
(`src/dispatch/wiring.ts:436`).

| Alarme | Significa | Primeira ação |
|---|---|---|
| `manual_present` | Alguma linha espera decisão humana | Passo 5 |
| `dead_letter_present` | Um envio caiu em voo entre a reivindicação e o resultado, e a fila esgotou. **Não é mais o sinal de indisponibilidade do Slack** (§10 H9/H15) | Passo 5, ação `resend` |
| `ambiguous_stale` | **É este o alarme de indisponibilidade prolongada do Slack** (§10 H43, corrigindo H9). Toda falha DEPOIS da reivindicação — erro de rede/TLS/DNS, o timeout de 30 s, 5xx, 3xx/4xx inesperado, 429, corpo de 200 malformado ou irreconhecível — passa a linha de `sending` para `ambiguous` e dá `ack` na mensagem; como não existe reenvio automático, as linhas se acumulam ali. A idade é contada desde a **última tentativa de envio**, não desde a criação da linha (§10 H40): 30 min sem resolução a partir daí | Veja se o Slack ou o `conversations.history` está degradado; o resolver reagenda sozinho com recuo progressivo |
| `queued_backlog_stale` | Existe linha em `queued` **e** a linha não-terminal mais antiga — de qualquer estado — passa de 30 min (`src/dispatch/observer.ts:58`). A idade é aproximada de propósito, e sempre para o lado seguro: uma linha `ambiguous` ou `manual` velha ao lado de uma `queued` recente também dispara. Cobre os adiamentos ANTERIORES à reivindicação, não a queda do Slack (§10 H43): modo `off` (depois do F4), falha de leitura do `SLACK_DISPATCH_BOT_TOKEN`, espera de ritmo (pacing) e as linhas `queued` estagnadas do R13 | Em `off` **depois do F4**, é o estado esperado da degradação (seção 1). Em `primary`, veja o passo 4 — e confira o binding do token e o `DISPATCH_MODE` antes da página de status do Slack |
| `repaired_duplicates_increased` | O sistema apagou uma cópia duplicada | Informativo; a auditoria registra os dois `ts` |
| `duplicate_deletion_unreconciled` | Pediu-se ao Slack a deleção de uma cópia duplicada e **não se sabe** o que aconteceu: a resposta não chegou (timeout, rede, corpo ilegível, 5xx) ou o registro do reparo não gravou. Uma recusa explícita do Slack (`ok:false` em HTTP 200) NÃO cai aqui — ela se reconcilia sozinha, porque a cópia continua no canal | Confira no canal. Se a cópia **continua lá**, um `sweep` (passo 5) rearma o reparo e a varredura seguinte reconcilia a intenção. Se a cópia **sumiu**, o alarme não tem como ser apagado: o contador só fecha com um marcador de mesmo `target_ts`, que é escrito apenas dentro do reparo de duplicata (`src/dispatch/outbox.ts:1498`) e portanto depende de uma varredura enxergar aquele `ts` — que não está mais no canal. Nenhuma das quatro ações do menu escreve esse marcador (`src/index.ts:372`). O alarme fica aceso pela vida do `dispatch_audit` e a partir daí mascara uma segunda ocorrência: leia `unreconciled_deletion_intents` no `/status` como contador, não como booleano |
| `verification_abandoned` | A verificação parou de reagendar após muitas varreduras sem progresso | Use `sweep` para reiniciar; se repetir, o canal tem volume alto demais para a janela de varredura |

## 4. Emergência: parar os envios agora

**Antes do corte do F3 (hoje), trocar `DISPATCH_MODE` para `off` NÃO para nada.**
`off` já é o modo em vigor e os alertas continuam saindo: o ingress cai no insert
legado, publica um job de fila **sem marcador**, e os consumidores legados — que
seguem ligados — entregam pelo Slack Workflow. Nenhuma variável do Worker pausa a
entrega de alertas nesta fase.

O que realmente para, hoje, é pausar a fila. É ação de operador no Cloudflare,
fora do código:

```sh
npx wrangler@latest queues pause-delivery github-slack-alerts
```

Uma fila pausada **continua recebendo** mensagens (documentação da Cloudflare,
"pause and purge"), e o ingress segue aceitando e persistindo cada GUID em
`deliveries` — este segundo ponto é propriedade do nosso código, verificada:
todo envio de alerta do caminho legado passa pelo consumidor da fila, e o cron
legado apenas re-enfileira, nunca envia direto. Atenção ao único limite que não
é nosso: mensagens paradas expiram pela **retenção da fila**, e o valor é por
fila, lido da API em 15/08/2026 — `github-slack-alerts` está em **86 400 s (24 h)**
e `github-slack-activity` em 345 600 s (4 dias, o padrão). Uma pausa mais longa
que isso descarta o que estiver represado **na fila**; o registro durável é a
linha em `deliveries`, e a mensagem de fila é só um ponteiro para o GUID, então
o que se perde é a entrega automática ao retomar, não o evento. Ao retomar

```sh
npx wrangler@latest queues resume-delivery github-slack-alerts
```

o represado é consumido e entregue. Pausar a fila é preferível a mexer no gatilho
do Workflow ou no segredo da URL: sem gatilho válido os envios *falham*, gastam
tentativas e podem terminar em recuperação manual do caminho legado, enquanto a
fila pausada apenas segura.

**Entre o corte do F3 e o F4**, `DISPATCH_MODE=off` ainda **não** é a degradação de
emergência do ADR, e tratá-lo como tal perde eventos de vista. O insert em
`dispatch_outbox` é condicionado a `primary` (`src/index.ts:1470`): em `off` o
ingress cai no insert legado e publica um job de fila **sem marcador**. Não nasce
linha no outbox, então nada se acumula em `queued` e `queued_backlog_stale` — que
lê só `dispatch_outbox` — não enxerga esses eventos; e como os consumidores legados
foram desligados no passo (3) do F3, ninguém consome esse job. Nesta janela, `off`
é apenas a **primeira metade** do rollback do regime A (§6.8: "flip ingress back to
old mode for NEW events AND re-enable the old consumers"): sem religar os
consumidores legados o que entrou fica parado em `deliveries`, sem alarme nenhum do
dispatcher. Para parar os envios nesta janela, pause a fila (acima); para voltar,
`DISPATCH_MODE=primary`.

**Depois do F4** — regime B do ADR (§6.8/R20), quando o caminho legado não existe
mais —, aí sim `DISPATCH_MODE=off` é a degradação de emergência: troque o modo e
faça o deploy. Nada se perde: o ingress continua aceitando e persistindo cada GUID
em `dispatch_outbox`, as linhas se acumulam em `queued` (alarmadas), e ao voltar
para `primary` o cron republica sozinho, sem passo manual.

## 5. O que o sistema NUNCA faz sozinho

Ler esta lista evita meio diagnóstico:

- **Não reenvia mensagem automaticamente.** Nenhuma. Todo reenvio é comando humano assinado
  e marcado como possível duplicata. Se você vê uma segunda cópia, ela veio de um reenvio
  autorizado ou de materialização tardia do Slack — nunca de decisão da máquina.
- **Não marca entrega sem prova, sozinho.** Nenhuma transição automática chega a
  `delivered` sem o `ts` devolvido pelo Slack. Duas exceções, ambas explícitas: a linha
  espelho (`shadow=1`) termina `delivered` sem `ts` porque nunca houve envio
  (`src/dispatch/consumer.ts:260`), e o `mark_delivered` do menu grava um `ts` digitado
  por um humano (passo 5).
- **Não conclui ausência sem esgotar a busca.** Página malformada, varredura parcial ou
  histórico indisponível resultam em "inconclusivo", nunca em "não foi entregue".
- **Não deixa uma varredura parcial regredir a prova canônica.** Uma varredura
  parcial, que enxerga só as cópias mais novas, não substitui um `ts` anterior já
  registrado (§6.3.2). Quando a varredura **esgota** o histórico ela é um censo: se o
  `ts` gravado não aparece nele, aquela mensagem não está mais no canal, e a cópia
  mais antiga observada assume como canônica mesmo sendo posterior à gravada
  (`src/dispatch/resolver.ts:788`, §10 H27).
- **Não apaga a última cópia visível.** Quando a cópia canônica não aparece na
  varredura, a mais antiga que apareceu é preservada e fica pendente para uma
  varredura futura — `chat.delete` é irreversível.
- **Não apaga o esquema legado — mas apaga linhas antigas de `deliveries`.** As tabelas
  antigas continuam no D1 e são lidas para sempre pela cerca de presença, que impede
  entrega dupla pelos dois caminhos (`src/dispatch/outbox.ts:212`). O que **é** apagado:
  `purgeDeliveredBefore` (`src/store.ts:3802`) roda um `DELETE FROM deliveries` em todo
  passe do cron, sobre as linhas em `delivered` com `delivered_at` mais velho que 30 dias
  (`DELIVERED_RETENTION_MS`, `src/index.ts:74`) cujo trace do Slack Workflow já esteja
  completo e abaixo do checkpoint de atividade. Só `deliveries` perde linha:
  `slack_workflow_traces` e `relay_state` são apenas lidas. Consequência prática: a
  memória da cerca é de 30 dias — veja o passo 2.

## 6. Limites conhecidos

- A verificação pós-reenvio cobre +15 min e +24 h. Uma duplicata que apareça depois disso
  é detectável por `sweep`, mas não automaticamente.
- Sob muitas linhas ambíguas simultâneas, o tempo até uma delas ser estacionada em `manual`
  cresce com o tamanho da fila. O alarme `ambiguous_stale` aparece muito antes disso.
- O canal é limitado a cerca de uma mensagem por segundo; rajadas são espaçadas em 6,1 s.
- **Não existe canal ativo de alarme** (§10 H26): os alarmes são log estruturado,
  e a verificação é por consulta (`/status` para agregados, D1 para um GUID).
  Escolher e ligar um canal que não dependa do dispatcher é passo declarado do F3.
