# Achados da revisão da PR #201, verificados um a um

Dois revisores automáticos passaram sobre o ADR-002 e o plano: Copilot (13 threads) e Codex (18 threads, que são 9 achados triplicados pelos três `@codex review`). Consolidados, são **14 achados distintos**. Verifiquei cada um contra a fonte antes de aceitar — bot não é autoridade. **Os 14 procedem.**

Este documento não é lista de remendos. Cada achado está agrupado pela raiz que o produziu, porque a instrução do operador foi comparar cada conserto com o quadro geral, e três das cinco raízes só aparecem quando os achados são lidos juntos.

---

## Raiz 1 — o desenho especificou o software e nunca especificou a implantação

**Achados:** credencial do Slack (Copilot 4, Codex 8); segredo do `/status` (Codex 9); remoção da fila de descarte (Codex 2).

O que a fonte diz:

- `wrangler.jsonc:37-63` liga cinco segredos. O tipo gerado confirma: `worker-configuration.d.ts:8-12` lista `GITHUB_WEBHOOK_SECRET`, `SLACK_ALERTS_WORKFLOW_WEBHOOK_URL`, `SLACK_ACTIVITY_WORKFLOW_WEBHOOK_URL`, `SLACK_RELAY_SIGNING_SECRET`, `SLACK_RELAY_SIGNING_SECRET_NEXT`. **Nenhum token de bot. Nenhum segredo de status.**
- O que roda hoje posta num webhook de workflow: `src/index.ts:1297-1299` escolhe o binding, `:1344` faz o POST, e `:1376` testa o sucesso por `confirmation?.ok !== true` — **sem `ts`, sem código de erro**.
- ADR-002 §7 linha 101 assume `chat.postMessage`, e §8 linha 113 lista 14 códigos de erro que **só existem na Web API**.
- Decisão 8 do operador manda remover a fila de descarte. `wrangler.jsonc:78` ainda a configura, e `:86-91` ainda a consome.

**Consequência que só se vê no quadro geral:** a Tarefa 3, que eu ia executar agora, classifica um protocolo que este sistema não sabe falar. Escrevê-la seria casca vazia — 14 códigos de erro para uma resposta que nunca terá nenhum deles. As Tarefas 3, 5 e 7 não são escrevíveis antes de o transporte ser decidido.

**Estado do canal, lido em 16/08:** a última entrega do relay foi em **14/08/2026 15:43:12**, pelo bot `B0BMUJDLSF3` ("LCV GitHub integration") — o app que eu excluí. Às **16:51:39** de 14/08 um bot **diferente** entrou no canal, "LCV Ideas Software GitHub Alerts" (`U0BR6NL2B9N`), convidado pelo operador. Se a URL de webhook antiga ainda resolve é **não verificado**: só um POST provaria, e POST é ação para fora.

## Raiz 2 — cinco dos nove eventos do escopo nunca chegam ao ingress

**Achados:** contrato do webhook da organização (Codex 3 — **ninguém mais viu**); normalização dos eventos novos (Copilot 10, Codex 4); o teste diz oito e o escopo tem nove (Copilot 9).

- `scripts/github-slack-hook-audit.mjs:6-12` congela `HOOK_EVENTS` sem `security_advisory`, `repository_advisory`, `security_and_analysis`, `secret_scanning_alert_location` e `secret_scanning_scan`; `:184-196` (`sameEvents`) exige igualdade **exata** de conjunto e rejeita qualquer assinatura diferente.
- `src/domain.ts:1064-1104` normaliza `dependabot_alert`, `code_scanning_alert` e `secret_scanning_alert`. Todo o resto cai no `default` e vira `event_not_supported`.

**Consequência no quadro geral:** o §3 do ADR promete nove eventos; a tubulação entrega quatro. Mexer só na allowlist do Worker não muda nada — o evento nem sai do GitHub. São **duas** superfícies a mais que o plano nunca listou: a assinatura do webhook da organização e o script que a audita.

## Raiz 3 — o desenho nomeia mecanismos que nenhuma tarefa implementa

**Achados:** reenfileirar `falhou` externo (Copilot 8, Codex 1); limpeza por retenção (Copilot 5, Codex 6); marco para o delta de estacionadas (Copilot 11, Codex 5).

- ADR-002 §4 linha 52 exige, com todas as letras: *"e reenfileira linhas `falhou` por causa externa"*. O `staleRows` do plano (linha 567) filtra `state = 'pending'`. Um `not_in_channel` vira `falhou` não estacionado e **nada nunca mais o alcança** — sem superfície de operador, o alerta está perdido. Isto quebra a promessa central.
- `ROW_RETENTION_MS` é escolhido na Tarefa 1 e **nenhuma tarefa posterior o consome**. Sem apagamento, a janela de deduplicação de 30 dias é ficção e o D1 cresce sem limite.
- O `/status` expõe contagem; delta exige um valor anterior, e nem o esquema nem a Tarefa 8 o guardam.

**Consequência no quadro geral:** a instância C′ do §6 — o achado que um peer me deu na segunda rodada — **continua sem resolução**. Ela foi movida do desenho para o plano, e no plano ninguém a implementa. É a mesma mecânica que produziu as 60 emendas do ADR-001: declarar resolvido o que só foi renomeado.

## Raiz 4 — o aviso não chega ao endereço escolhido, e o ADR afirma que chega

**Achado:** mecanismo do e-mail do vigia (Copilot 3, Codex 7).

Verbatim de [notificações de execução de workflow](https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/notifications-for-workflow-runs):

> *"If a different user updates the cron syntax, in the `schedule` event in the workflow file, subsequent notifications will be sent to that user instead."*
> *"If a scheduled workflow is disabled and then re-enabled, notifications will be sent to the user who re-enabled the workflow rather than the user who last modified the cron syntax."*

A decisão 2 do ADR (§5, linha 61) diz que o endereço é *"escolhido, não herdado de quem editou o agendamento por último"*. **A documentação diz exatamente o contrário.** O destinatário é a conta que mexeu no cron por último, e o endereço é ajuste daquela conta, não do YAML.

**Consequência no quadro geral, e ela é a mais desconfortável:** o §6 marca a instância G como *"Resolvido pela decisão 2"*. Não está resolvida. O ADR comete, na instância G, precisamente o erro que ele mesmo nomeia na instância F′ — *"confundir 'há um mecanismo' com 'está resolvido'"*.

## Raiz 5 — três citações fabricadas, e a regra 1 não as impediu

**Achado:** citações que não existem na fonte (Copilot 1 e 2).

Varri **todas** as nove citações do ADR contra as fontes:

| Local | Veredito |
|---|---|
| §1 linha 17 (duas citações) | **FABRICADAS** |
| §1 linha 19 | **FABRICADA** |
| §6 linha 83 (duas citações) | verbatim confirmadas |
| §7 linha 97 (duas) | verbatim confirmadas |
| §7 linha 99 | verbatim confirmada |
| §7 linha 101 | verbatim confirmada |
| §7 linha 103 | fragmento fiel de frase real |

As três fabricadas têm assinatura comum: são frases do **sumarizador** do WebFetch, não da página — *"The provided content does not mention…"*. Nenhuma fonte escreve assim sobre si mesma.

**Consequência no quadro geral:** eu cumpri a regra 1 como ela está escrita — citei. O que citei foi o resumo, não a fonte. A regra precisa de cláusula operacional: **uma citação só entra se eu conseguir apontar a string exata dentro do corpo buscado**; caso contrário entra como inferência, declarada. Sem essa cláusula a regra continua passável por fora e falsa por dentro.

Observação de aplicabilidade em §7 linha 97: a citação é real, mas a conclusão que tirei dela descreve uma configuração que esta branch **não tem** — `wrangler.jsonc:78` tem fila de descarte. A frase vale para o estado que a decisão 8 vai criar, não para o de hoje, e o texto não diz isso.

---

## Achados internos ao plano

- **Tarefa 4 não compila como escrita** (Copilot 7): importa `AlertRow`, que nenhuma tarefa define, e o corpo mostrado termina sem `toAlertRow`, `get` e `counts`, que a interface promete e os testes usam.
- **O plano ainda instrui a importar `adaptSqliteToD1`** (Copilot 6 e 13): a linha 496 registra a correção feita na Tarefa 2, mas o bloco de código da linha 489-493 continua mostrando a chamada inexistente. Correção registrada em prosa e não aplicada ao código é correção pela metade.
- **`MAX_SEND_ATTEMPTS` mudou de critério sem dizer** (Copilot 12): a decisão 7 e o §10 dizem que o teto sai de **medição**; a Tarefa 1 o derivou de restrição (`< max_retries: 5`). A derivação é defensável, mas trocar o critério fixado pelo operador exige dizer que se trocou.

---

## A leitura global: somados, os consertos propostos acrescentam dez peças

Cada bot propõe o conserto local do seu achado: *"add a query and cron path for non-parked failed rows"*, *"add a durable acknowledged checkpoint"*, *"add a bounded cleanup query"*, *"add the bot-token binding"*, *"add an explicit notification mechanism"*. Somados, são **cerca de dez peças novas** num sistema cujo desenho inteiro se justifica por ser pequeno.

Foi assim que o ADR-001 chegou a 60 emendas. Nenhuma delas era irracional sozinha.

A regra 5 manda preferir apagar componente a somar guarda. Aplicada ao conjunto — não a cada achado —, ela encontra **uma deleção que dissolve cinco achados**.

### A deleção: o estado `falhou` não precisa existir

Hoje o desenho tem três estados mais uma coluna `parked`, e usa quatro das seis combinações: `pendente`, `enviado`, `falhou`+externo, `falhou`+intrínseco. A distinção externo/intrínseco existe para decidir **quem é reenfileirado**.

Mas ela não sobrevive à pergunta "o que o operador faz de diferente?". Nos dois casos a resposta é a mesma: **um aviso, e depois silêncio até um humano agir.** Não há superfície de comando; a única ação possível é o operador consertar o mundo (repor o bot no canal, corrigir o renderizador) e o sistema voltar a tentar. E o sistema não tem como saber quando o mundo mudou.

Se toda linha não entregue permanece `pendente` e é retentada com recuo longo, para sempre:

| Peça que desaparece | Achado que ela ia consertar |
|---|---|
| o estado `falhou` | — |
| a coluna `parked` | — |
| a segunda consulta e o segundo caminho do cron | reenfileirar `falhou` externo (Copilot 8, Codex 1) |
| o marco durável do delta | delta de estacionadas (Copilot 11, Codex 5) |
| `PERMANENT_SEND_ERRORS`, os 14 códigos | classificador da Tarefa 3 |
| `ROW_INTRINSIC_ERRORS` | — |
| `MAX_SEND_ATTEMPTS` e a medição que o justifica | teto sem medição (Copilot 12) |
| a regra "429 não conta contra o teto" (decisão 7) | — |

O vigia passa a ter **uma** condição: a idade da linha `pendente` mais velha. Sem delta, sem marco, sem nível. Um alarme que fica aceso até um humano agir não é o vermelho permanente da instância C — a instância C era um alarme aceso **por motivo alheio**, mascarando um problema novo. Com idade e contagem na mesma mensagem, uma linha nova travada move o número; ela não se esconde atrás da velha.

### O que a deleção custa, dito sem maquiagem

1. **Uma linha impossível é retentada para sempre.** Custo real: uma chamada por linha por intervalo de recuo. No volume medido — 9 alertas por hora — é desprezível. Custo verdadeiro: o alarme fica aceso até o humano agir, que é o que um alarme deve fazer.
2. **A amplificação de duplicata perde seu teto explícito.** Na prática ela continua limitada: um envio que deu certo com resposta perdida gera uma cópia, e a tentativa seguinte vê `ok:true` e encerra. Amplificação sem fim exigiria perder **toda** resposta, e nesse regime as cópias também não chegam ao canal.
3. **Decisões 7 e 8 do operador mudam de sentido**, e §8 do ADR encolhe para duas linhas. Isso é emenda a desenho ratificado, não edição de plano.

### E o efeito colateral que reorganiza a raiz 1

Se o classificador é apenas *"`ok:true` é enviado; qualquer outra coisa tenta de novo"*, ele funciona **igual nos dois transportes**: `src/index.ts:1376`, que roda hoje em produção contra o webhook de workflow, já testa exatamente `confirmation?.ok !== true`.

Ou seja: os 14 códigos de erro eram a única coisa que amarrava o desenho ao `chat.postMessage`. Sem eles, **o transporte deixa de bloquear o código** — decide apenas se existe `ts` para guardar, e nenhum caminho do desenho lê `ts` (§9 aposentou `chat.delete` e a varredura de verificação, que seriam seus dois leitores).

## O que isto significa para a sequência

As Tarefas 3, 5 e 7 estão **bloqueadas** pela raiz 1 — ou deixam de estar, se a deleção acima for aprovada. Tudo o mais é meu para consertar sem esperar: as três citações, a cláusula operacional da regra 1, a aplicabilidade de §7, a decisão 2 do §5 e a instância G do §6, o reenfileiramento de `falhou` externo, a limpeza por retenção, o marco do delta, as duas superfícies da raiz 2, e os três achados internos do plano.
