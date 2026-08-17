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
2. **A amplificação de duplicata perde seu teto explícito.** ~~Na prática ela continua limitada: um envio que deu certo com resposta perdida gera uma cópia, e a tentativa seguinte vê `ok:true` e encerra. Amplificação sem fim exigiria perder **toda** resposta, e nesse regime as cópias também não chegam ao canal.~~

   **Retratado em 16/08, achado do Codex na rodada 3, e ele está certo.** A frase riscada confunde *resposta perdida* com *mensagem não entregue*. Se o Slack processa o POST e a resposta se perde **depois** disso, a mensagem aparece no canal e o Worker nunca vê `ok:true`. Repetido, isso produz cópias visíveis sem fim. Não é hipótese remota: é exatamente o caso ambíguo, e eu o descartei com uma afirmação que não tinha como provar.

   ~~**O que de fato limita, e não é um contador.** O recuo. Com recuo que cresce e satura num teto de 24 h, o número de cópias cresce como o logaritmo do tempo, não como o tempo: dezenas ao longo de uma semana, não milhares.~~

   **Segunda retratação sobre o mesmo parágrafo, em 16/08.** A frase riscada acima está errada por duas razões, apontadas independentemente pelo Copilot (seis vezes), pelo codex, pelo deepseek e pelo grok. Primeira: o recuo é logarítmico **apenas antes de saturar**; depois de fixo em 24 h, cada dia permite mais uma tentativa, e o crescimento é **linear**. Segunda, e pior: o cron da versão anterior publicava uma mensagem **nova a cada passe** para a mesma linha, criando fluxos de retentativa paralelos — de modo que o agregado nem sequer estava limitado a um fluxo diário. Eu tinha corrigido a falácia original e escrito outra no lugar.

   **O que ficou:** o recuo passa a ser aplicado por um **agendador único** (ADR-002 §4 emendado, a fila deixa de retentar), e o limite resultante é de **taxa**, não de total: cerca de uma cópia por dia em regime. A duplicação total é **ilimitada no tempo**, e isso está escrito na decisão 12 sem eufemismo.

   **Por que não repor o teto:** um teto transforma a linha em terminal, e terminal perde o alerta — que é a única coisa que a promessa proíbe. Entre duplicar com alarme aceso e perder em silêncio, a promessa já escolheu.
3. **Decisões 7 e 8 do operador mudam de sentido**, e §8 do ADR encolhe para duas linhas. Isso é emenda a desenho ratificado, não edição de plano.

### E o efeito colateral que reorganiza a raiz 1

~~Se o classificador é apenas *"`ok:true` é enviado; qualquer outra coisa tenta de novo"*, ele funciona **igual nos dois transportes**: `src/index.ts:1376`, que roda hoje em produção contra o webhook de workflow, já testa exatamente `confirmation?.ok !== true`. Ou seja: os 14 códigos de erro eram a única coisa que amarrava o desenho ao `chat.postMessage`. Sem eles, **o transporte deixa de bloquear o código**.~~

**RETRATADO no mesmo lugar, e o §3.3 abaixo é quem derruba.** O `{ok:true}` do gatilho de workflow significa apenas que o **gatilho foi aceito** — o workflow a jusante ainda pode falhar antes de postar. Tratar os dois transportes como equivalentes marcaria a linha como enviada num ponto em que a mensagem pode nunca aparecer, e perderia o alerta em silêncio. É por isso que o código de hoje grava `accepted_by_trigger` (`src/index.ts:1387`) em vez de "enviado".

O parágrafo fica riscado, e não apagado, porque ele foi um **argumento de venda** da deleção: eu disse ao operador que o transporte deixaria de bloquear o código. Isso era falso, e o que salvou a conclusão foi a decisão dele de adotar `chat.postMessage` — não o meu raciocínio.

---

## Reanálise: cada achado contra o plano global

O que segue não é a lista de remendos. Para cada achado, a coluna que importa é a última: o que a leitura global manda fazer, que quase nunca é o que o achado pede.

## Raiz 1 — três achados, e nenhum é lacuna de tarefa

Token do Slack, segredo do `/status` e remoção da fila de descarte são tratados pelos bots como três itens a acrescentar. Não são. São a mesma ausência: **o plano tem nove tarefas de código e zero tarefas de implantação.** Não existe nele nenhum lugar onde se responda "o que precisa existir fora do repositório para isto rodar".

Remendo local: três bindings. Leitura global: **uma tarefa nova, e ela é a primeira, não a última** — o inventário do que existe fora do repositório, com verificação de cada item antes de o código que depende dele entrar. Sem isso, cada um destes será redescoberto no deploy, um por vez, que é como esta série vem gastando semanas.

Itens do inventário, todos já verificados como ausentes ou errados hoje: token do bot (`worker-configuration.d.ts:8-12`), segredo do `/status` (idem), fila de descarte a remover (`wrangler.jsonc:78`, `:86-91`), assinatura do webhook da organização (raiz 2), endereço de notificação da conta dona do cron (raiz 4).

## Raiz 2 — três achados, e a lição não é "adicionar cinco casos"

O §3 promete nove eventos. Para um evento chegar ao canal ele precisa passar por **três portões**: a assinatura do webhook da organização, a allowlist do Worker, e o normalizador. O plano só mexia no segundo.

Remendo local: adicionar cinco `case`, corrigir a lista congelada, trocar "oito" por "nove" no teste. Leitura global: **um teste de alcance, dirigido por tabela sobre os nove eventos, que atravessa os três portões** — e a reconfiguração do webhook da organização entra na tarefa de implantação da raiz 1. Um décimo evento acrescentado no futuro repete o erro dos três portões se o teste não existir.

Anotado no instante em que notei, sem número que o sustente: `secret_scanning_scan` dispara a cada varredura concluída. Não medi o volume, e não vou afirmar que é alto — mas é o único evento do escopo cuja frequência não tem relação com haver algo errado, e um canal de alertas afogado é um canal que ninguém lê.

## Raiz 3 — dois achados dissolvem, um muda de natureza

Reenfileirar `falhou` externo e o marco do delta **desaparecem** com a deleção proposta acima.

A limpeza por retenção **não** desaparece — e, com a deleção, ela deixa de ser faxina e vira a única transição terminal do sistema. Se nada mais é terminal, apagar a linha é o único jeito de o sistema parar. Isso reposiciona o número: `ROW_RETENTION_MS` deixa de se justificar por espaço em disco e passa a se justificar contra a promessa.

E a resposta muda: **apagar só linhas `enviado`.** Uma linha pendente nunca é apagada, porque apagá-la é perder o alerta — exatamente o que a promessa proíbe. Uma consulta, um predicado, nenhuma decisão nova.

## Raiz 4 — o conserto não é na decisão 2, é no livro-razão do §6

Você decidiu aceitar o mecanismo documentado. O texto da decisão 2 é corrigido, mas o conserto que importa está em outro lugar: o §6 marca a instância G como *"Resolvido pela decisão 2"*, e ela não está resolvida.

Leitura global: **G sai da coluna dos resolvidos e entra na dos limites declarados**, ao lado de D e F/F′. E aí aparece o fato que nenhum achado isolado mostra: o §6 passa a ter **três** instâncias declaradamente não fechadas. As garantias do vigia são mais fracas do que a leitura do §6 sugeria, e isso precisa estar escrito onde se decide confiar nele.

## Raiz 5 — o conserto não são as três frases

Corrigir as três citações é meia hora. O que impede a repetição é a cláusula operacional na regra 1: **uma citação só entra se eu conseguir apontar a string exata dentro do corpo buscado**; se não consigo, entra como inferência declarada. Eu cumpri a regra como estava escrita — citei — e o que citei foi o resumo do buscador. A regra era passável por fora e falsa por dentro.

Segundo movimento, no §7: ele mistura "o que a plataforma faz" com "o que a nossa configuração faz". A citação da fila de descarte é verdadeira e a conclusão não vale hoje. O §7 passa a declarar a configuração que assume, e a marcar o que ainda não é verdade.

## Achados internos ao plano — nenhum deles se corrige por remendo

Tarefa 4 incompleta, `adaptSqliteToD1` ainda no bloco de código, e o critério trocado de `MAX_SEND_ATTEMPTS`: o terceiro **dissolve** com a deleção (não há teto). Os dois primeiros não se consertam por emenda porque o plano será reescrito de qualquer modo — a deleção remove tarefas inteiras, e a raiz 1 acrescenta uma na frente de todas.

A lição global, essa sim: **a primeira metade do plano foi escrita como código e a segunda como esboço, sem que nada no documento dissesse qual era qual.** Foi por isso que os dois revisores gastaram fôlego apontando defeitos em esboços. Um plano com metade em rascunho não deve ir a revisão sem que a fronteira esteja escrita.

## Rodada 3 — quatro achados novos, contra esta própria análise

O Codex revisou o documento que você está lendo e achou quatro defeitos nele. Os quatro procedem. Três atacam a deleção aprovada, e é bom que ataquem: uma deleção que não sobrevive a ataque não deveria entrar.

**3.1 — Teto para o envio ambíguo (P1).** Tratado acima, no custo 2, com a retratação no lugar onde o erro foi cometido. Resolução: o limite é o recuo saturado em 24 h mais o alarme por idade, não um contador — e repor o contador reintroduziria a perda que a promessa proíbe.

**3.2 — Caminho de reparo para linha intrinsecamente inválida (P1).** O Codex cita contra mim o meu próprio arquivo: `migrations/0010_alert_delivery.sql:25-28` afirma que reenviar a mesma linha *"nunca funciona, nem depois de o operador corrigir a causa"*. Se isso fosse verdade, "nunca desistir" deixaria essa linha pendente e inentregável para sempre.

**Verifiquei, e o errado é o meu comentário.** A linha guarda o payload **normalizado**, não a mensagem renderizada: em `src/index.ts:1318-1324` o corpo enviado é montado **no instante do envio**, a partir de `delivery.payload`. Logo, corrigir o renderizador e implantar faz a tentativa seguinte funcionar sobre a mesma linha. O comentário da migração descreve a coluna de estacionamento — que esta emenda apaga — e sai junto com ela. Sem ele, "nunca desistir" tem caminho de reparo: **consertar o código é o reparo**, e nenhuma superfície de comando é necessária.

**3.3 — Aceitação do gatilho não é entrega (P1).** Este é o mais fino dos quatro. Quando o endpoint de **workflow** do Slack devolve `{ok:true}`, ele aceitou o **gatilho**; o workflow a jusante ainda pode falhar antes de postar. É por isso que o código de hoje grava `accepted_by_trigger` (`src/index.ts:1387`) em vez de "enviado". Se eu tratasse `ok:true` como entrega naquele transporte, perderia alertas em silêncio.

**A decisão de transporte que o operador tomou hoje é o que neutraliza isto** — e só ela. Em `chat.postMessage` a resposta de sucesso traz a mensagem postada (`ok`, `channel`, `ts`, `message`), então `ok:true` **é** entrega. Fica escrito no ADR como dependência explícita: a equivalência "`ok:true` = enviado" vale para `chat.postMessage` e **é falsa** para o gatilho de workflow. Trocar o transporte no futuro sem trocar o classificador perde alertas.

**3.4 — Exclusão de workflow precisa da identidade do repositório (P2).** A decisão 1 exclui o vigia e o deploy do relay casando por `workflow_run.path`. Outro repositório com um workflow no mesmo caminho teria a falha dele suprimida em silêncio. O predicado passa a exigir **repositório + caminho**, e o teste vai junto.

## A releitura integral do PR, e a classe que os 119 revelam juntos

Por ordem do operador, o PR foi relido **por inteiro**: 19 corpos de revisão, 48 threads, 16 comentários — extração completa em disco, deduplicada: **119 achados suprimidos distintos**. A leitura em conjunto mostra o que nenhuma amostra mostrava.

**Dos 119, mais de 80 são o MESMO fenômeno repetido: texto que sobrevive à decisão que o matou.** O desenho passou por quatro gerações num único dia — três estados → dois estados → agendador duplo → agendador único — e **cada geração deixou prosa viva para trás**: o plano mandando executar três estados; os números publicando um teto revogado; a análise de custo com a aritmética já retratada; o §7 derivando limiares de uma fila que não retenta mais. Os revisores redescobriram cada fantasma a cada passe, e cada redescoberta parecia um achado novo.

**Nomeando a classe (regra 3): documento-fantasma — prosa cuja premissa morreu e que continua no imperativo.** A varredura correta quando uma decisão muda não é corrigir a linha apontada: é perguntar *"que outros textos derivam da premissa que acabou de morrer?"* e riscá-los **no mesmo commit da decisão**. Foi por não fazer isso que três documentos companheiros contradisseram o ADR por horas, e que o plano chegou a instruir um agente a reconstruir o desenho abandonado.

**Os genuinamente novos da última leva (23:36), verificados um a um:**

- **24 h é política, não plataforma** — a justificativa pelo teto de `delaySeconds` morreu quando `delaySeconds` saiu do desenho. Corrigido no ADR e nos números.
- **`CRON_STALE_AFTER_MS` morreu** — derivava da janela de 155 s de uma fila que não retenta. O predicado de tempo devido o substitui; a conta dos 15 minutos do vigia foi rederivada da curva (~20 min para falha transitória).
- **O comentário do índice reintroduzia o agendador por idade de ingresso** — corrigido: dois índices, dois leitores, com a distinção escrita.
- **O teste de `attempts` passava pelo motivo errado** — o id `id-att-0.5` era rejeitado pelo CHECK do `delivery_id` (ponto proibido), não pelo de `attempts`. Ids fixos e válidos agora; provado por mutação com a falha capturada.
- **O token carrega escopo que o desenho não usa** — `groups:history`/`groups:read` são leitura de canal privado; o desenho só posta. Redução a `chat:write` + rotação viram item 8 do §12, ação do operador.
- **O inventário dizia "falta" para o que a fonte já tem** — a tabela do §12 passou a distinguir fonte × deploy.

## A varredura do §6 sobre o código escrito (T8, passo 4 — 17/08)

Veredito instância a instância, contra a implementação real (T1–T7 + T8):

- **A — o vigia fabrica o que vigia:** FECHADA POR CÓDIGO. `isExcludedWorkflowRun` exige repositório+caminho e cobre o vigia e o deploy; teste em `scope.test.ts` prova que a falha do próprio vigia não vira linha.
- **B — a recuperação desarma a detecção:** FECHADA POR CÓDIGO E MUTAÇÃO. O vigia lê `created_ms` (via `oldestPendingCreatedMs`); nenhum método do store o escreve após o INSERT — provado por mutação (`recordFailure` + `created_ms = 0` fez o teste da matriz falhar).
- **C — vermelho permanente não carrega informação:** RESPONDIDA POR FORMA. O sinal é quantitativo (idade + contagem no `/status`); linha nova travada move os dois números. O resíduo de habituação humana segue declarado no ADR.
- **C′ — a resolução de C reintroduzia C:** INEXISTENTE POR CONSTRUÇÃO. Não há estacionamento; o banco recusa `failed` e não tem `parked` (testes de esquema).
- **D — ausência de sinal lê como saúde:** LIMITE DECLARADO, mitigado no que dá: o vigia valida corpo além do código HTTP, e resposta ilegível entra na política das duas consecutivas.
- **E — o status servido pelo vigiado:** FECHADA POR CÓDIGO. Duas verificações consecutivas sem resposta (ou ilegíveis) falham o job — decisão 3 implementada com marcador com conteúdo.
- **F/F′ — detector e fonte na mesma plataforma:** LIMITE DECLARADO, sem mudança — todo braço disponível passa pelo GitHub ou pelo Slack.
- **G — o aviso depende de uma caixa de e-mail:** LIMITE DECLARADO (3º), com a posse do cron fixada e `contato@lcv.dev` confirmado pelo operador.
- **H — o deploy do relay é execução de workflow:** FECHADA POR CÓDIGO, pela mesma exclusão repo+caminho da instância A.

E o agendador residual da plataforma (não numerado no §6 original, incorporado ao §4): a fila não retenta mais nada — `max_retries: 0` na fonte, DLQ de alertas fora dos consumers, v2 na DLQ descartada com `ack` — e o crash vira atraso de um recuo, com a linha como fonte de verdade.

## O que isto significa para a sequência

As Tarefas 3, 5 e 7 estão **bloqueadas** pela raiz 1 — ou deixam de estar, se a deleção acima for aprovada. Tudo o mais é meu para consertar sem esperar: as três citações, a cláusula operacional da regra 1, a aplicabilidade de §7, a decisão 2 do §5 e a instância G do §6, o reenfileiramento de `falhou` externo, a limpeza por retenção, o marco do delta, as duas superfícies da raiz 2, e os três achados internos do plano.
