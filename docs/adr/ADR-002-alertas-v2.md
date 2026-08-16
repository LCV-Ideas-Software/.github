# ADR-002 — Entrega de alertas do GitHub no Slack (implementação nova)

**Estado:** aprovado pelo operador em 16/08/2026; **emendado em 16/08/2026** após a revisão automática da PR #201 (Copilot e Codex, 14 achados distintos, todos verificados na fonte e todos procedentes).
**Substitui:** ADR-001 (dispatcher com outbox), abandonado por decisão do operador em 16/08/2026.
**Data:** 16/08/2026. Horários deste documento são de Brasília (UTC−03:00).

**O que a emenda mudou, em uma linha cada** — detalhe e evidência em `docs/superpowers/plans/2026-08-16-alertas-v2-achados-revisao.md`:

- **§1** — três frases apresentadas como citação não existiam nas fontes; retratadas e substituídas por inferência de enumeração, declarada.
- **§4 e §8** — o sistema deixa de decidir *por que* um envio foi recusado: some o estado `falhou`, some a coluna de estacionamento, some a tabela de códigos permanentes e some o teto de tentativas. Dois estados.
- **§5** — decisões 2, 7 e 8 emendadas; decisões 11 e 12 acrescentadas.
- **§6** — a instância G sai de "resolvida" e vira o terceiro limite declarado; C e C′ deixam de precisar de resolução, porque a peça que as criava foi apagada.
- **§7** — passa a separar o que a plataforma faz do que **a nossa configuração de hoje** faz, e a marcar o que ainda não é verdade.
- **§11** — a regra 1 ganha cláusula operacional; sem ela, era passável por fora e falsa por dentro.
- **§12** — nova: o que precisa existir fora do repositório. O plano tinha nove tarefas de código e zero de implantação.

---

## 1. Por que existe

O app oficial "GitHub for Slack" entrega quase tudo. Este sistema existe **apenas** para o que ele não sabe entregar, e para nada além disso.

O que o app oficial assina, verbatim da documentação do GitHub ([personalizar notificações](https://docs.github.com/en/integrations/how-tos/slack/customize-notifications)): por padrão issues, pull requests, commits na branch padrão, releases publicadas e status de deployment; opcionalmente revisões, execuções de workflow, branches, comentários, commits em qualquer branch e discussions.

Duas lacunas, ambas verificadas em fonte primária em 16/08/2026.

**Retratação, registrada onde o erro foi cometido.** A versão anterior desta seção trazia três frases entre aspas, apresentadas como verbatim das fontes. **Elas não existem em nenhuma das duas.** Eram frases do sumarizador da ferramenta de busca — reconhecíveis pela forma, *"The provided content does not mention…"*, que nenhuma fonte usa para falar de si mesma. O achado é do Copilot na revisão da PR #201, e procede. As duas lacunas continuam verdadeiras; o que não era verdade é que a documentação as tivesse enunciado. A regra que deveria ter impedido isso ganhou cláusula operacional em §11.

**Alerta de segurança não é assinável.** O README do app ([integrations/slack](https://github.com/integrations/slack)) enumera os recursos assináveis, verbatim: `issues`, `pulls`, `commits`, `releases`, `deployments`, `workflows`, `reviews`, `comments`, `branches`, `commits:*`, `+label:"your label"`, `discussions`. Nenhum alerta de segurança aparece na lista. **Isto é inferência de enumeração fechada, não citação**: nenhuma frase diz "não entregamos alertas de segurança"; o que existe é uma lista onde eles não estão. A confirmação empírica está logo abaixo, e é mais forte que a documental — o próprio app postou as assinaturas ativas dos 12 repositórios, e elas contêm exatamente esses nomes.

**Execução de workflow não filtra por conclusão.** Os filtros que o mesmo README documenta para `workflows` são quatro, verbatim: **name** (*"Name of your workflow"*), **event** (*"The event on which the workflow is triggered"*), **actor** (*"The person who triggered or responsible for running of the workflow"*) e **branch** (*"The branch on which the workflow is running"*). Não há filtro por conclusão. Mesma natureza de evidência: enumeração fechada. Ou seja, "me avise só quando falhar" não é expressável.

Estado real das assinaturas em 16/08/2026 16:55, lido da confirmação que o próprio app postou no `#github-activity` para cada um dos 12 repositórios:

```
issues, pulls, commits:'*', releases, deployments, reviews, comments,
branches, discussions, workflows:{event:"pull_request" branch:your-default-branch}
```

O app aplicou por conta própria um filtro em `workflows`: apenas execuções disparadas por `pull_request`, na branch padrão. Execuções agendadas, disparadas por push e de merge queue não são entregues por ele para nenhum dos 12 repositórios.

## 2. A promessa, e o que ela compra

**Nunca perder um alerta. Uma duplicata é aceitável.**

Essa segunda metade não é concessão: é o que torna a retentativa um recurso de recuperação **total**. Com ela, toda incerteza se resolve reenviando, e o sistema nunca precisa responder "chegou ou não chegou?" — que é a pergunta que gerou as 60 emendas do ADR-001, a varredura do histórico do Slack, a deleção irreversível de mensagem e o menu assinado de operador que existia para desfazer o que a máquina não devia fazer sozinha.

## 3. Escopo

**Entra:** alerta do Dependabot, de code scanning, de secret scanning (incluindo os sub-eventos), aviso de segurança publicado, mudança de configuração de segurança, e execução de workflow cuja conclusão seja `action_required`, `cancelled`, `failure`, `stale`, `startup_failure` ou `timed_out`.

**Sai, porque o oficial entrega:** issues, pull requests, commits, releases, deployment, revisões, comentários, branches e discussions.

**Sai, por decisão deliberada** (§5, decisão 1): falhas do próprio vigia e do workflow de deploy do relay.

## 4. A forma

**Dois estados: `pendente` → `enviado`.** Não há terceiro.

A máquina **não decide por que** o Slack recusou. Uma entrega recusada continua `pendente` e será tentada outra vez, sempre, com recuo crescente. Nada aqui é terminal — a única saída além de `enviado` é o apagamento por retenção, e ele só alcança linha já entregue.

Essa decisão (§5, decisão 12) é o que apaga, de uma vez: o estado `falhou`, a coluna de estacionamento, a distinção entre causa externa e causa intrínseca, a tabela de códigos permanentes, o teto de tentativas, a medição que justificaria o teto, a segunda consulta e o segundo caminho do cron, e o valor durável que o vigia guardaria para comparar. Oito peças serviam a uma pergunta — *"por que falhou?"* — cuja resposta não mudava nada para o operador: nos dois casos ele recebe um aviso e age com as próprias mãos.

**Ingress** — mantido do que roda hoje no `main`: confere a assinatura HMAC antes de parsear, aceita só os eventos do escopo, normaliza o payload, grava a linha com o GUID da entrega do GitHub como chave, publica na fila. Não há mais noção de destino: há um canal só.

**Consumidor** — monta a mensagem **no instante do envio**, a partir do payload normalizado que a linha guarda, posta com `chat.postMessage` e grava o desfecho. Que a montagem seja no envio, e não na entrada, é o que dá caminho de reparo sem superfície de comando: corrigir o renderizador e implantar faz a tentativa seguinte funcionar **sobre a mesma linha**. É assim que o código de hoje já se comporta — `src/index.ts:1318-1324` monta o corpo a partir de `delivery.payload` no momento do POST.

**Cron** — reenfileira **toda** linha `pendente` mais velha que um limiar, incondicionalmente e de forma idempotente, sem conhecer o estado da fila. Uma consulta, um predicado. A fila é otimização de latência; **o cron é a única garantia de vivacidade** — ver §7.

**Retenção** — apaga linhas `enviado` mais velhas que o prazo. **Nunca apaga `pendente`**, porque apagar pendente é perder o alerta. Com dois estados, o apagamento é a única transição terminal do sistema, e por isso ele se justifica contra a promessa, não contra o espaço em disco.

**Status** — contagem por estado e a idade da linha pendente mais antiga, protegido por segredo compartilhado.

**Vigia** — tarefa agendada no GitHub que lê o status e falha de propósito quando há coisa parada. **Uma condição só: a idade da linha pendente mais velha.** Sem nível, sem delta, sem valor guardado entre execuções. O e-mail que o GitHub manda ao falhar é o aviso — com a ressalva de §5, decisão 2.

## 5. Decisões do operador, registradas

1. **Excluir da entrega as falhas do próprio vigia e do deploy do relay**, casando por **repositório mais caminho** do arquivo do workflow. É a única escolha deliberada de não entregar algo. Motivo em §6, instância A. *(Emendado em 16/08: casar só por caminho suprimiria, em silêncio, a falha de um workflow homônimo em qualquer outro repositório assinado — achado do Codex, rodada 3. Nome continua fora de questão: nome é renomeável.)*
2. **O e-mail de aviso vai para `contato@lcv.dev`.** *(Emendado em 16/08, e a versão anterior desta decisão era falsa.)* Ela dizia que o endereço é *"escolhido, não herdado de quem editou o agendamento por último"*. A documentação do GitHub diz o contrário, verbatim ([notificações de execução de workflow](https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/notifications-for-workflow-runs)): *"If a different user updates the cron syntax, in the `schedule` event in the workflow file, subsequent notifications will be sent to that user instead."* e *"If a scheduled workflow is disabled and then re-enabled, notifications will be sent to the user who re-enabled the workflow rather than the user who last modified the cron syntax."*

   **O mecanismo real, e o operador o aceitou conhecendo-o:** o destinatário é a conta que mexeu no cron por último, e o endereço é ajuste **daquela conta**, não do YAML. Logo o endereço não é garantido por este desenho; é garantido por uma configuração fora dele, que §12 inventaria. **A armadilha, escrita para não ser redescoberta:** quem editar o agendamento herda o aviso, e o operador deixa de recebê-lo sem que nada falhe.
3. **"Não consegui falar com o Worker" conta como problema**, após duas verificações consecutivas falharem.
4. **O vigia poder morrer em silêncio é aceito e declarado** como limitação conhecida (§6, instância D).
5. **Todos os eventos de segurança extras entram**, inclusive os sub-eventos de secret scanning que a recomendação inicial deixava de fora.
6. **Tabela nova**, não reconstrução da existente.
7. ~~**Resposta de limite de taxa do Slack não conta contra o teto de tentativas**; o valor do teto é escolhido por medição.~~ **Revogada em 16/08 pela decisão 12: não há teto.** Sem teto, não há o que o 429 não conte contra, e a medição que justificaria o valor deixa de ser necessária. Esta decisão morre inteira — as duas metades dela existiam para administrar um número que a deleção apagou.
8. **A fila de descarte é removida**, para o teto da aplicação disparar antes do teto da fila. *(Emendada em 16/08: a justificativa muda, a decisão fica.* Sem teto de aplicação, a razão passa a ser outra e mais simples — a fila de descarte é um **segundo mecanismo de entrega**, com política própria, que reentrega por fora do único caminho que o desenho reconhece. Duas máquinas entregando o mesmo alerta é a forma da qual o ADR-001 morreu. Estado de hoje: `wrangler.jsonc:78` ainda a configura e `:86-91` ainda a consome; a remoção entra em §12.*)*
9. **O status é protegido por segredo compartilhado.**
10. **A retenção da linha é declarada com a consequência escrita ao lado**: a linha guardada é a própria trava contra duplicata, então o prazo define também a janela em que um reenvio do GitHub não vira segunda mensagem. *(Emendada em 16/08: o apagamento alcança **apenas** linhas `enviado`. Uma linha `pendente` nunca é apagada, porque apagá-la é perder o alerta.)*

11. *(Acrescentada em 16/08, depois da revisão da PR #201.)* **O transporte é `chat.postMessage`, com token de bot.** O app é o "LCV Ideas Software GitHub Alerts", que já está no canal desde 14/08/2026 16:51. Verificado por `auth.test` em 16/08: `user_id` `U0BR6NL2B9N` — o mesmo que entrou no canal —, `bot_id` `B0BQ65BTHC3`, escopos concedidos `chat:write,groups:history,groups:read`.

    **Esta decisão carrega uma dependência que não pode ser esquecida** (achado do Codex, rodada 3): a equivalência **`ok:true` = entregue** vale para `chat.postMessage`, cuja resposta de sucesso traz a mensagem postada, e **é falsa** para o gatilho de workflow do Slack, que com `ok:true` apenas aceitou o gatilho — o workflow a jusante ainda pode falhar antes de postar. É por isso que o código de hoje grava `accepted_by_trigger` em `src/index.ts:1387` em vez de "enviado". **Trocar o transporte sem trocar o classificador perde alertas em silêncio.**

12. *(Acrescentada em 16/08.)* **O sistema nunca desiste de um alerta.** Toda entrega recusada continua `pendente` e é retentada com recuo crescente, indefinidamente. É a decisão que apaga as oito peças listadas em §4.

    **O custo, dito inteiro, porque ele foi contestado e a contestação procedia:** se o Slack processa o POST e a resposta se perde **depois** disso, a mensagem aparece no canal e o sistema nunca vê `ok:true` — cada retentativa produz uma cópia visível. O que limita não é um contador: é o recuo, que cresce e satura no teto documentado da plataforma (*"Messages can be delayed by up to 24 hours"*), fazendo as cópias crescerem com o logaritmo do tempo; e é o vigia, que alarma pela idade da linha muito antes de a contagem importar. Repor um teto tornaria a linha terminal, e terminal **perde** o alerta — a única coisa que a promessa proíbe. Entre duplicar com o alarme aceso e perder em silêncio, a promessa já escolheu.

## 6. A classe que este desenho precisa resistir

**O observador acoplado ao observado: o comportamento do próprio sistema corrompe o próprio sinal.** Oito instâncias, enumeradas antes de qualquer código.

**A — o vigia fabrica o que vigia.** Falha do vigia é `workflow_run` com conclusão de problema, que o ingress roteia para o canal de alertas. Um vigia vermelho produz um alerta novo e não entregável a cada tique. Registrado no ADR-001 §10 como defeito D12 do sistema aposentado. *Resolvido pela decisão 1.*

**B — a recuperação desarma a detecção.** Se a idade que o vigia lê for ancorada num campo que o cron escreve, o cron mantém a idade abaixo de qualquer limiar para sempre. O ADR-001 H40 rejeitou `updated_ms` por exatamente isso, em suas palavras "fail-DANGEROUS". *Resolução: a idade ancora no instante de ingresso, e nenhum caminho de recuperação escreve esse campo.*

**C — vermelho permanente não carrega informação.** Linha que nunca vai entrar, reenfileirada a cada passe, mantém o alarme aceso para sempre. É a cegueira de 22,6 horas do ADR-001 H44, em que o monitor já falhava de hora em hora por motivo alheio. *Resolução emendada em 16/08, e ela **não** é "C desapareceu".* Com a decisão 12, uma linha que não entra continua sendo reenfileirada e o alarme continua aceso — exatamente o que C descreve. O que muda é a **natureza do sinal**: o vigia não emite um booleano que satura, e sim dois números, a idade da linha pendente mais velha e a contagem de pendentes. Um alerta novo travado **move os dois**, mesmo que já houvesse um travado antes. Foi a saturação, não o vermelho, que produziu a cegueira de 22,6 horas do H44.

*Resíduo declarado, porque o desenho não o resolve:* um vermelho que dura semanas produz **habituação no humano**, e nenhum arranjo de números conserta isso. É limite de operação, não de software, e fica escrito aqui para não ser redescoberto como defeito.

**C′ — a resolução de C reintroduzia C, e um peer pegou.** Estacionar sem superfície de comando de operador (§5, decisão... ausente por desenho) significa que **nada, nunca, limpa a linha estacionada**. O alarme ficaria aceso para sempre por causa dela — exatamente o vermelho permanente que C existe para evitar, entrando pela porta aberta para consertá-lo. Achado do painel de revisão de pares na segunda rodada, não meu. *Resolução emendada em 16/08: **C′ deixa de existir, porque a peça que a criava foi apagada.*** Não há estacionamento, logo não há linha estacionada que nada limpa, logo não há delta a computar nem valor durável a guardar entre execuções do vigia. A resolução anterior — alarmar no delta — foi ela própria derrubada na revisão da PR #201 por Copilot e Codex, que mostraram, independentemente, que um delta exige um marco durável que nem o esquema nem o vigia tinham. Os dois estavam certos, e a resposta certa não era acrescentar o marco: era apagar o estacionamento.

*Registro do padrão, porque ele é o padrão que matou o ADR-001:* C ganhou uma resolução que criou C′; C′ ganhou uma resolução que exigia peça nova. Duas emendas encadeadas, e nenhuma delas tocava a causa — a distinção externo/intrínseco, que não mudava nada para o operador.

**D — ausência de sinal lê como saúde.** O GitHub documenta que execuções agendadas podem sumir: *"If the load is sufficiently high enough, some queued jobs may be dropped"*, e que em repositório público *"scheduled workflows are automatically disabled when no repository activity has occurred in 60 days"* ([eventos que disparam workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)). Execução que não acontece não gera artefato, logo não há onde pendurar notificação. *Aceito e declarado, decisão 4. Não sei quantificar a frequência.*

**E — o status é servido por quem está sendo vigiado.** Worker fora do ar devolve erro de transporte, não veredicto. *Resolvido pela decisão 3.*

**F — detector e fonte compartilham a plataforma.** O vigia roda no GitHub Actions e os eventos chegam por webhook do GitHub. Derivação, não citação: uma degradação do GitHub atinge os dois juntos, e o detector não consegue reportar a queda em que está. *Limite declarado, sem conserto.*

**F′ — o buraco do homem-morto foi MOVIDO, não FECHADO, e este documento diz isso com todas as letras.** Três peers independentes (codex, deepseek, grok) convergiram nisto na segunda rodada de revisão: qualquer arranjo em que os dois braços do aviso saem pelo GitHub — o e-mail do Actions e uma issue entregue pelo app oficial — cai junto numa degradação do GitHub. Deslocar a detecção para a Cloudflare não fecha o buraco; move-o. **Nenhum arranjo estudado fecha**, porque todo canal de aviso disponível depende do GitHub ou do Slack, e os dois são exatamente os lados que podem estar quebrados. O operador aceitou o limite na decisão 4 com esse entendimento. Registrado assim para que nenhuma leitura futura confunda "há um mecanismo" com "está resolvido" — que é precisamente o erro que o ADR-001 H26 cometeu e pagou.

**G — o aviso depende de uma caixa de e-mail.** ~~*Resolvido pela decisão 2, que ao menos torna o destinatário uma escolha.*~~ **Emendado em 16/08: não estava resolvido, e esta linha era o erro que o próprio F′ nomeia.** A decisão 2 não escolhe destinatário nenhum — a documentação do GitHub manda o aviso para a conta que editou o cron por último, e o endereço é ajuste daquela conta. *Terceiro limite declarado*, ao lado de D e F/F′: o aviso depende de uma configuração fora deste desenho (§12) e de ninguém mais tocar no agendamento.

**Consequência de ler as três juntas, que nenhuma instância isolada mostra:** o §6 passa a ter **três** instâncias declaradamente não fechadas — D (execução agendada some), F/F′ (detector e fonte caem juntos) e G (o aviso depende de configuração externa). As garantias do vigia são mais fracas do que a leitura anterior deste documento sugeria, e quem decidir confiar nele precisa decidir sabendo disto.

**H — o deploy do relay é uma execução de workflow.** Deploy que falha vira alerta que o deploy falhado não entrega. *Resolvido pela decisão 1.*

## 7. Fatos de plataforma que o desenho assume, todos citados

**Emenda de 16/08, sobre a forma desta seção.** Ela misturava duas coisas de natureza diferente: o que a plataforma faz, que é citável, e o que **a nossa configuração** faz, que se lê no `wrangler.jsonc`. A citação da fila de descarte era verdadeira e a conclusão que tirei dela **não vale para a configuração de hoje** — porque hoje existe fila de descarte configurada. Cada item abaixo agora diz de qual das duas naturezas é, e o que ainda não é verdade está marcado.

**A fila descarta.** Da documentação da Cloudflare ([configurar filas](https://developers.cloudflare.com/queues/configuration/configure-queues/)): *"The maximum number of retries for a message... Defaults to 3 retries"* e *"If a `dead_letter_queue` is not defined, messages that repeatedly fail processing will eventually be discarded."* É por isso que o cron não é opcional: sem ele, "nunca perder" é falso.

**Estado da configuração, que é a outra natureza, e hoje contradiz a frase acima:** `wrangler.jsonc:78` define `dead_letter_queue` para a fila de alertas e `:86-91` a consome. Logo, **hoje** a mensagem esgotada não é descartada — ela cai num segundo mecanismo de entrega, com política própria. A decisão 8 remove essa fila, e só depois disso o parágrafo anterior descreve o sistema. Enquanto não remover, o desenho tem duas máquinas entregando o mesmo alerta.

**Retenção.** Da mesma página: *"Defaults to 345600 (4 days). Must be between 60 and 1209600 (14 days)"*. A fila de alertas está configurada em 86 400 s (24 h), lido da API da Cloudflare em 16/08/2026.

**O Slack devolve `ts` e `channel` no sucesso.** Da documentação ([chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)): *"Response including the 'timestamp ID' (`ts`) and the channel-like thing where the message was posted."* O exemplo de resposta bem-sucedida traz `ok`, `channel`, `ts` e `message`, com `ts` valendo `"1503435956.000247"`.

**E o que a página NÃO diz, verificado em 16/08 procurando exatamente por isso:** não há nenhuma frase garantindo que `ts` esteja **sempre** presente numa resposta de sucesso, nem declarando campo algum como obrigatório. Há um exemplo, e exemplo não é garantia. **Consequência de desenho:** `ok:true` é o que marca `enviado`; o `ts` é gravado quando vier, e nada no sistema o lê para decidir — os dois leitores que existiriam, `chat.delete` e a varredura de verificação, estão aposentados em §9. Nenhuma validação de formato de `ts` entra: ela recusaria um envio que ocorreu, produzindo cópia e alarme, e não impediria nada que a promessa proíba.

**Ritmo.** Da documentação de [limites de taxa](https://docs.slack.dev/apis/web-api/rate-limits/): *"no more than one message per second per channel"*, com rajada permitida. O volume real de alertas está na ordem de 9 por hora, então nenhuma tabela durável de ritmo é necessária — o 429 basta.

**Volume de workflow.** 153 execuções em 24 horas nos 12 repositórios, contadas pela API do GitHub em 16/08/2026.

**Migrações aplicadas em produção param na 0009**, lido do `d1_migrations` do banco `github-slack-alerts-db` em 16/08/2026. A migração nova é a 0010.

## 8. Classificação do envio

**Emendado em 16/08 pela decisão 12. A seção inteira cabe em duas linhas:**

1. **`ok:true` marca `enviado`.**
2. **Qualquer outra coisa deixa a linha `pendente`, para a próxima tentativa.**

Não há mais lista de códigos permanentes, nem lista de transitórios, nem "tudo o mais". A tabela de 14 códigos existia para decidir *quem vira terminal*, e nada mais é terminal. Uma classificação que não altera nenhum caminho de execução é descrição, não código — e sai.

**A linha 1 depende do transporte, e essa dependência é a coisa mais frágil deste documento** (§5, decisão 11): ela é verdadeira para `chat.postMessage`, cuja resposta de sucesso contém a mensagem postada, e **falsa** para o gatilho de workflow do Slack, cujo `ok:true` significa apenas que o gatilho foi aceito. Quem trocar o transporte sem reler esta seção perde alertas em silêncio.

**O que se perde com a simplificação, dito honestamente:** um erro de configuração permanente — token revogado, bot fora do canal — passa a ser retentado como qualquer outra coisa, em vez de virar falha imediata. Não é perda real: o alerta continua indo para o mesmo lugar, o vigia alarma pela idade, e a ação do operador é idêntica nos dois desenhos. O que se ganha é não ter oito peças para descobrir algo que não muda a ação de ninguém.

**O classificador é total sobre a invocação, não sobre a resposta do Slack.** Falha ao renderizar o payload, leitura de segredo que falha, ou erro ao gravar o desfecho nunca chegam à tabela acima. O corpo do consumidor é envolvido por inteiro e nunca deixa exceção escapar para a fila.

## 9. Deliberadamente ausente

Varredura do histórico do Slack, resolver, detecção de duplicata, reparo de duplicata, `chat.delete`, varredura de verificação, prova canônica a defender, menu de operador, requisição assinada, estado ambíguo, reivindicação, lease, CAS de estado, tabela durável de ritmo.

**Acrescentados em 16/08 pela decisão 12** — peças que este documento chegou a especificar e que agora saem: o estado `falhou`, a coluna de estacionamento, a distinção entre causa externa e causa intrínseca, a tabela de códigos permanentes, a tabela de códigos transitórios, o teto de tentativas, a medição que o justificaria, a segunda consulta e o segundo caminho do cron, e o marco durável do delta do vigia. Também sai a validação de formato do `ts` (§7): guarda que recusaria um envio ocorrido.

Cada item desta lista é uma decisão, não um esquecimento. Juntos, são a origem da maior parte das 60 emendas do ADR-001.

## 10. O que não sei, e não vou afirmar

- O que acontece com a mensagem se a retenção expirar enquanto ela ainda está sendo retentada não está documentado.
- A frequência com que o GitHub descarta execuções agendadas não é publicada.

Os dois vão para medição antes de virarem número na implementação.

**Um item saiu desta lista por ter sido encontrado documentado.** Eu havia listado "o comportamento de espera entre tentativas da fila" como desconhecido, depois de ler a página de configuração. Estava na página de [batching, retries e delays](https://developers.cloudflare.com/queues/configuration/batching-retries/), que eu não tinha consultado — e a resposta muda o desenho: **a plataforma não impõe recuo próprio**. Quem escolhe é o consumidor, via `delaySeconds` em `retry()` ou `retryAll()`, com teto de *"up to 24 hours"*; cada mensagem carrega *"an `attempts` property that tracks the number of delivery attempts made"*; e o esgotamento é explícito — *"Messages that reach the configured maximum retries will be deleted from the queue, or if a dead-letter queue (DLQ) is configured, written to the DLQ instead."* Essa última citação é a prova mais forte de §7: sem o cron, "nunca perder" é falso, porque a mensagem é apagada.

Registro do erro, porque ele é do tipo que esta série paga caro: eu declarei desconhecido depois de ler **uma** página, quando o que eu sabia era que aquela página não dizia. Não saber onde está não é o mesmo que não estar documentado.

~~**Três números ainda não escolhidos**, e este documento não finge que estão: o limiar de idade que faz o cron reenfileirar, o teto de tentativas da decisão 7, e o prazo de retenção da decisão 10.~~ **Emendado em 16/08: sobraram dois**, e o terceiro não foi escolhido — deixou de existir. O teto de tentativas morreu com a decisão 7, revogada pela 12. Restam o limiar de idade do cron e o prazo de retenção, ambos fixados em `docs/superpowers/plans/2026-08-16-alertas-v2-numeros.md` com a conta ao lado.

**Registro de um erro de processo que o Copilot pegou e que procede:** a Tarefa 1 escolheu o teto de tentativas por **restrição** (ser menor que o `max_retries` da fila), quando a decisão 7 e esta seção diziam **medição**. Trocar o critério fixado pelo operador é permitido; trocá-lo sem dizer que se trocou, não. O ponto virou discutível porque o número desapareceu, mas o erro de processo aconteceu e fica escrito.

**Fora de escopo, registrado para não se perder:** 203 linhas de alerta ficaram sem entrega entre 14/08/2026 16:38 e a pausa das filas, estacionadas em `manual_review` na tabela legada, e nenhum caminho automático as alcança. Não são tratadas aqui — importá-las é acréscimo de peça, e só se decide quando o sistema existir.

## 11. Regras de construção, vinculantes

Determinadas pelo operador em 16/08/2026, derivadas do colapso do ADR-001. O plano de implementação herda cada uma.

1. Nenhuma frase sobre comportamento entra em documento ou comentário sem a linha citada que a prova. Se não dá para citar, não se escreve.

   **Cláusula operacional, acrescentada em 16/08 porque a regra falhou exatamente como estava escrita.** Uma citação só entra se for possível **apontar a string exata dentro do corpo buscado**. Não basta que uma ferramenta tenha respondido aquilo: o resumo de um buscador não é a fonte. Se a fonte enumera e a conclusão vem da ausência de um item na enumeração, isso é **inferência de enumeração fechada** e entra assim declarado, com a enumeração transcrita. Origem: três frases do §1 apresentadas como verbatim que não existiam em nenhuma das duas fontes, achado do Copilot na PR #201. Eu cumpri a regra como ela estava escrita — citei — e o que citei foi o resumo. A regra era passável por fora e falsa por dentro.
2. Antes de concluir qualquer coisa a partir de um diff, verificar o que é `HEAD`.
3. Achado que chega: nomear a classe e varrer a superfície inteira antes de tocar na linha apontada, com a família definida larga o bastante.
4. O que se nota entra na lista no instante em que se nota.
5. Toda proteção nova entra com o teste que falha sem ela; e preferir apagar um componente a acrescentar uma guarda.
6. Antes de ação irreversível, nomear o que a desfaz. Se nada desfaz, a decisão é do operador.
7. Nada que acrescente estado à máquina entra sem justificativa contra a promessa.

## 12. O que precisa existir fora do repositório

Seção nova, de 16/08. O plano de implementação tinha **nove tarefas de código e nenhuma de implantação**, e por isso três achados distintos dos revisores — token do Slack, segredo do `/status` e remoção da fila de descarte — eram, na verdade, o mesmo buraco: não havia lugar onde se respondesse "o que precisa existir fora do repositório para isto rodar". Sem esta seção, cada item seria redescoberto no deploy, um por vez.

**Regra que acompanha a seção:** nenhuma tarefa cujo código dependa de um item abaixo entra antes de o item estar verificado pelo comando ao lado. Verificação é comando, não afirmação.

| # | Item | Estado em 16/08 | Como se verifica |
|---|---|---|---|
| 1 | Token de bot no Secrets Store | **feito** — `github-slack-alerts-bot-token`, id `e73fc103b19545d8a4466671fb52e113`, escopo `workers` | `GET /accounts/{acc}/secrets_store/stores/df90c093…/secrets` |
| 2 | Binding do token no Worker | **falta** | o binding aparece em `wrangler.jsonc` e no `Env` de `worker-configuration.d.ts` |
| 3 | Segredo compartilhado do `/status`, **dos dois lados** | **falta** | binding no Worker **e** segredo no repositório, para o vigia autenticar |
| 4 | Fila de descarte removida (decisão 8) | **falta** — presente em `wrangler.jsonc:78` e `:86-91` | ausência das ocorrências nos **cinco** arquivos abaixo |
| 5 | Assinatura do webhook da organização com os nove eventos | **falta** — cinco ausentes; e **eu não consigo nem ler o estado atual** | `HOOK_EVENTS` em `scripts/github-slack-hook-audit.mjs:6-12` e a igualdade exata exigida em `:184-196` |
| 6 | Endereço de notificação da conta que edita o cron do vigia | **não verificável por mim** | ajuste da conta no GitHub; a API me devolveu 404 por falta do escopo `user` — **é ação do operador** |
| 7 | Bot presente no canal privado | **feito** — `U0BR6NL2B9N` no `#github-alerts` desde 14/08 16:51 | `auth.test` e a leitura do canal |

**O item 5 tem um bloqueio de permissão, verificado em 16/08 e não presumido.** `GET /orgs/LCV-Ideas-Software/hooks` devolveu, literal: `{"message":"Not Found","status":"404"}`, com a orientação da própria CLI: *"This API operation needs the "admin:org_hook" scope."* Ou seja, **eu não consigo nem ler** a assinatura atual, muito menos alterá-la. O item passa de "eu faço" para **ação do operador** — conceder o escopo ou reconfigurar ele mesmo. Enquanto isso não acontece, qualquer afirmação minha sobre quais eventos a organização assina hoje seria invenção, e por isso não existe nenhuma neste documento.

**O item 4 é maior do que "editar uma chave", e isso foi varrido antes de eu tocar em qualquer linha.** A fila de descarte aparece em **cinco** arquivos, e um deles é teste: `workers/github-slack-relay/wrangler.jsonc` (configuração), `src/index.ts` (o consumidor `processDeadLetterMessage` e o despacho por nome de fila), `test/queue.test.ts` (testes que exercitam esse caminho), `README.md` e `docs/GITHUB_SLACK_INTEGRATION.md` (documentação). Por isso a remoção é **tarefa própria, com teste falhando antes**, e não edição de configuração — apagar a chave e deixar o consumidor vivo produziria exatamente o silêncio que esta série já pagou caro para aprender a evitar.

**O item 5 tem uma armadilha que o item sozinho não mostra:** um evento precisa atravessar **três portões** para chegar ao canal — a assinatura do webhook da organização, a allowlist do Worker e o normalizador (`src/domain.ts:1064-1104`, que hoje só conhece três eventos). O plano mexia apenas no segundo. Por isso o portão da implementação não é "os cinco eventos foram adicionados", e sim **um teste dirigido por tabela que atravessa os três portões para cada um dos nove eventos**. Sem ele, o décimo evento repete o erro.

**Anotado no instante em que notei, sem número que o sustente:** `secret_scanning_scan` dispara a cada varredura concluída. Não medi a frequência e não vou afirmar que é alta — mas é o único evento do escopo cuja cadência não tem relação com haver algo errado, e um canal de alertas afogado é um canal que ninguém lê. Medir antes de ligar.
